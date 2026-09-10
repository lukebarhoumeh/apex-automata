import { EventEmitter } from 'events';
import { Counter } from 'prom-client';
import { Logger } from '../core/logger';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { OrderRequest } from '../exchanges/coinbase';
import { Position, PositionTracker } from './position-tracker';
import { GuardrailConfig } from '../config/loadGuardrails';
import {
  RiskStateMachine,
  RiskHaltReasonCode,
  TradingState,
  createDailyStopHalt,
  createConsecutiveLossesHalt,
  createMaxDrawdownHalt,
  isDailyHaltReason,
} from './risk-state';
import {
  RiskMath,
  RiskSnapshot,
  validatePerTradeRisk,
  computeDailyStopThresholdR,
} from './risk-math';
import { computeRiskBasedSize } from './risk/position-sizing';
import {
  evaluateEvGate,
  computeRealizedPayoffRatio,
  LIVE_GEOMETRY_HAIRCUT,
  LIVE_WIN_RATE_PRIOR,
  type EvGateInputs,
  type EvGateMode,
  type EvGateResult,
} from './risk/ev-gate';
import { FeeModel } from '../core/fee-model';
import { ACCOUNT_TRUTH_STALE, ACCOUNT_TRUTH_UNAVAILABLE } from './account/live-account-truth';
import { isMissingColumnError, isMissingTableError } from '../core/postgrest-errors';
import { ExecutionModeScope, normalizeExecutionMode } from './risk/execution-mode-scope';

/** Closed trades kept for the realized payoff (avg win / avg loss) used by the live EV gate. */
export const REALIZED_PAYOFF_WINDOW = 50;

/**
 * Structural view of `LiveAccountTruth` that RiskEngine depends on (kept minimal so
 * tests can stub it without the Advanced Trade client).
 */
export interface LiveAccountTruthSource {
  getSnapshot(): { equityUsd: number; fetchedAt: number } | null;
  isStale(): boolean;
}

// Prometheus metrics for risk engine reliability
const riskMetricsWriteFailures = new Counter({
  name: 'atlas_risk_metrics_write_failures_total',
  help: 'Total number of failed risk_metrics database writes',
});

const accountMetricsUpsertFailures = new Counter({
  name: 'atlas_account_metrics_upsert_failures_total',
  help: 'Total number of failed account_metrics upsert calls',
});

const dailyEquityWriteFailures = new Counter({
  name: 'atlas_daily_equity_write_failures_total',
  help: 'Total number of failed daily_equity database writes',
});

// #A3 (2026-05-18): pre-trade EV gate counters. Labeled by strategy +
// symbol so /metrics shows where the gate is biting hardest. Reject
// reason is collapsed into a single coarse label ('below_threshold' or
// the default-allow path tag) to keep cardinality bounded.
const evGateAccepted = new Counter({
  name: 'atlas_risk_ev_gate_accepted_total',
  help: 'Pre-trade EV gate accepted signals (including cold-start default-allow paths)',
  labelNames: ['strategy', 'symbol', 'path'] as const,
});

const evGateRejected = new Counter({
  name: 'atlas_risk_ev_gate_rejected_total',
  help: 'Pre-trade EV gate rejected signals',
  labelNames: ['strategy', 'symbol'] as const,
});

export interface RiskEngineConfig {
  supabaseUrl: string;
  supabaseKey: string;
  userId?: string;
  /**
   * If true, ignore any persisted kill switch state on startup.
   * Useful for paper mode where sessions should start clean.
   */
  ignorePersistedKillSwitch?: boolean;
  limits: {
    maxPositionSize: number;        // Max USD value per position
    maxTotalExposure: number;       // Max total USD exposure
    maxDailyLoss: number;          // Max daily loss in USD
    maxDrawdown: number;           // Max drawdown in percentage
    maxOrderSize: number;          // Max order size in USD
    minOrderSize: number;          // Min order size in USD
    maxOpenOrders: number;         // Max concurrent open orders
    maxLeverage: number;           // Max leverage allowed
  };
  killSwitches: {
    enabled: boolean;
    dailyLossLimit: number;        // Daily loss limit before shutdown
    consecutiveLossLimit: number;  // Number of consecutive losses
    errorRateLimit: number;        // Error rate percentage
    latencyLimit: number;          // Max latency in ms
  };
  riskPerTrade: number;            // Percentage of capital to risk per trade
  kellyFraction: number;           // Kelly criterion fraction (0.25 = quarter Kelly)
  guardrails: GuardrailConfig;
  /**
   * Session equity anchor for USD limits. Paper: `guardrails.account.equity_usd`.
   * Live: ignored in favour of `liveAccountTruth`'s snapshot (TASK_011) — yaml is
   * never a live fallback.
   */
  accountEquity: number;
  /**
   * Optional FeeModel used by `evaluateSignalEv` (#A3) for round-trip
   * fee computation. When omitted, the EV gate default-allows with a
   * structured warn — never silently zeros fees.
   */
  feeModel?: FeeModel;
  /**
   * Execution mode. `live` requires `liveAccountTruth` (throws
   * `ACCOUNT_TRUTH_UNAVAILABLE` otherwise) and switches the EV gate to its
   * fail-closed live semantics. Default `paper` — behaviour unchanged.
   *
   * Also scopes persisted risk state (TASK_014 P5): every boot-time restore
   * (`risk_metrics`, `daily_equity`, `account_metrics`, `risk_events`) is
   * filtered to rows of this mode and every matching persist is stamped
   * with it, so paper state never bleeds into live or vice versa.
   */
  executionMode?: 'paper' | 'live';
  /**
   * Live-only exchange account truth (TASK_011). Sizing equity is read from the
   * latest snapshot on every call (no 0.5–2× clamp); a stale snapshot blocks new
   * entries with `ACCOUNT_TRUTH_STALE`.
   */
  liveAccountTruth?: LiveAccountTruthSource;
  /** Live-only EV gate mode (`guardrails.live.ev_gate_mode`). Default `enforce`. */
  evGateMode?: EvGateMode;
  /**
   * Soft-launch safety clamps (intended for early live trading).
   * These are applied dynamically for the first N new positions opened.
   */
  softLaunch?: {
    enabled: boolean;
    maxEntryTrades: number;               // Number of position opens to treat as "soft launch"
    riskPerTradeMultiplier: number;       // Multiplies risk sizing (0.25 = quarter risk)
    maxPositionSizeMultiplier: number;    // Multiplies max position notional limits
    maxTotalExposureMultiplier: number;   // Multiplies max total exposure
    maxOrderSizeMultiplier: number;       // Multiplies max order notional
    maxDailyLossMultiplier: number;       // Multiplies daily loss guardrails/limits (stricter if < 1)
    perSymbolNotionalCapUsd?: number;     // Absolute cap on per-symbol notional during soft launch
    minOrderSizeUsd?: number;             // Absolute minimum order size override during soft launch
  };
}

export interface RiskCheck {
  passed: boolean;
  reason?: string;
  checks: {
    positionSize: boolean;
    totalExposure: boolean;
    dailyLoss: boolean;
    orderSize: boolean;
    openOrders: boolean;
    openPositions: boolean;
    killSwitch: boolean;
  };
}

export interface RiskMetrics {
  currentExposure: number;
  dailyPnL: number;
  dailyLossPercentage: number;
  maxDrawdown: number;
  openOrderCount: number;
  consecutiveLosses: number;
  errorRate: number;
  averageLatency: number;
  killSwitchActive: boolean;
  lastUpdated: Date;
}

export interface RiskEngineEvents {
  'risk:check:passed': (orderId: string) => void;
  'risk:check:failed': (orderId: string, reason: string) => void;
  'risk:limit:reached': (limit: string, value: number, threshold: number) => void;
  'risk:killswitch:triggered': (reason: string) => void;
  'risk:metrics:update': (metrics: RiskMetrics) => void;
}

/**
 * Why an in-memory risk reset happened. Logged alongside the eager
 * `risk_metrics` write so a phantom-halt investigation can tell a
 * deliberate `PAPER_RESET_RISK_STATE_ON_START` from a day-boundary
 * discard or an operator `RESUME TRADING`.
 */
export type RiskStateResetSource = 'startup_reset' | 'day_boundary' | 'manual_resume';

export class RiskEngine extends EventEmitter {
  private config: RiskEngineConfig;
  private logger: Logger;
  private supabase: SupabaseClient;
  private userId?: string;
  private positionTracker: PositionTracker;
  private metrics: RiskMetrics;
  private killSwitchActive = false;
  private dailyStartEquity = 0;
  private dailyHighEquity = 0;
  private weeklyStartEquity = 0;
  private weeklyStartTimestamp = 0;
  private equityHistory: Array<{ timestamp: number; equity: number }> = [];
  private orderHistory: Array<{ timestamp: Date; success: boolean }> = [];
  private latencyHistory: number[] = [];
  private metricsUpdateInterval: NodeJS.Timeout | null = null;
  private guardrails: GuardrailConfig;
  private accountEquity: number;
  private dailyLossLimitUsd: number;
  private weeklyLossLimitUsd: number;
  private maxDrawdownUsd: number;
  private maxPositionExposureUsd: number;
  private minOrderNotionalUsd: number;
  private rapidLossThresholdUsd: number;
  private maxOpenPositionsLimit: number;
  
  // Soft launch state
  private softLaunchEntryTrades = 0;
  
  // Per-symbol tracking
  private dailyLossPerSymbol: Map<string, number> = new Map();
  private blockedSymbols: Set<string> = new Set();
  
  // Step 5: Unified risk state machine and risk math
  private riskStateMachine: RiskStateMachine;
  private riskMath: RiskMath;
  private dailyStopThresholdR: number;

  // #A3 (2026-05-18): pre-trade EV gate
  private feeModel: FeeModel | null;
  private minEvThreshold: number;

  // TASK_011: live account truth + live EV-gate semantics
  private readonly executionMode: 'paper' | 'live';
  private readonly liveAccountTruth: LiveAccountTruthSource | null;
  private readonly evGateMode: EvGateMode;
  /** Realized PnL of the most recent closed trades (newest last), bounded to REALIZED_PAYOFF_WINDOW. */
  private recentClosedTradePnls: number[] = [];

  // TASK_014 P5: execution-mode scoping of persisted risk state (same mode as above).
  private readonly modeScope: ExecutionModeScope;

  constructor(
    config: RiskEngineConfig,
    logger: Logger,
    positionTracker: PositionTracker
  ) {
    super();
    this.config = config;
    this.logger = logger;
    this.positionTracker = positionTracker;
    this.supabase = createClient(config.supabaseUrl, config.supabaseKey);
    this.userId = config.userId;
    this.modeScope = new ExecutionModeScope(normalizeExecutionMode(config.executionMode), logger);

    this.guardrails = config.guardrails;
    this.executionMode = config.executionMode ?? 'paper';
    // Both knobs are live-only: paper never consults account truth or shadow mode,
    // even if a caller passes them, so paper behaviour cannot drift.
    this.evGateMode = this.executionMode === 'live' ? (config.evGateMode ?? 'enforce') : 'enforce';
    this.liveAccountTruth = this.executionMode === 'live' ? (config.liveAccountTruth ?? null) : null;

    if (this.executionMode === 'live') {
      // Live sizes from the exchange, never from yaml. No snapshot => refuse to build.
      const snapshot = this.liveAccountTruth?.getSnapshot() ?? null;
      if (!snapshot || !Number.isFinite(snapshot.equityUsd) || snapshot.equityUsd < 0) {
        throw new Error(
          `${ACCOUNT_TRUTH_UNAVAILABLE}: RiskEngine cannot start in live mode without a Coinbase account ` +
            'snapshot (LiveAccountTruth). guardrails.account.equity_usd is paper-only and is not used as a fallback.',
        );
      }
      this.accountEquity = snapshot.equityUsd;
      this.logger.info('RiskEngine live equity anchored from Coinbase account snapshot', {
        equityUsd: snapshot.equityUsd,
        fetchedAt: snapshot.fetchedAt,
        configuredEquityIgnored: config.accountEquity,
        evGateMode: this.evGateMode,
      });
    } else {
      this.accountEquity = config.accountEquity;
    }
    const riskCfg = this.guardrails.risk;
    const accountCfg = this.guardrails.account;
    const circuitCfg = this.guardrails.circuit_breakers;

    this.dailyLossLimitUsd = Math.abs(riskCfg.daily_loss_limit) * this.accountEquity;
    this.weeklyLossLimitUsd = Math.abs(riskCfg.weekly_loss_limit) * this.accountEquity;
    this.maxDrawdownUsd = Math.abs(riskCfg.max_drawdown_limit) * this.accountEquity;
    this.maxPositionExposureUsd = this.accountEquity * riskCfg.max_position_exposure_pct;
    this.maxOpenPositionsLimit = accountCfg.max_open_positions;
    this.minOrderNotionalUsd = this.accountEquity * accountCfg.risk_per_trade * accountCfg.min_notional_buffer;
    this.rapidLossThresholdUsd = Math.abs(circuitCfg.rapid_loss_trigger) * this.accountEquity;

    // #A3 EV gate state. Threshold is in USD; default 0 rejects strictly
    // negative-EV trades. FeeModel is optional — when absent the gate
    // default-allows with a structured warn (cold-start safe).
    this.feeModel = config.feeModel ?? null;
    this.minEvThreshold = Number.isFinite(riskCfg.min_ev_threshold)
      ? Number(riskCfg.min_ev_threshold)
      : 0;
    
    // Safe defaults until async loaders complete (prevents metrics from using 0 start equity).
    this.dailyStartEquity = this.accountEquity;
    this.dailyHighEquity = this.dailyStartEquity;
    this.weeklyStartEquity = this.accountEquity;
    this.weeklyStartTimestamp = Date.now();

    this.metrics = this.initializeMetrics();
    
    // Step 5: Initialize unified risk state machine
    this.riskStateMachine = new RiskStateMachine({
      logger,
      supabaseUrl: config.supabaseUrl,
      supabaseKey: config.supabaseKey,
      userId: config.userId,
      executionMode: this.modeScope.mode,
    });
    
    // Forward state machine events
    this.riskStateMachine.on('risk:state_changed', (event) => {
      this.emit('risk:state_changed', event);
    });
    this.riskStateMachine.on('risk:killswitch:triggered', (event) => {
      this.emit('risk:killswitch:triggered', event);
    });
    this.riskStateMachine.on('risk:killswitch:deactivated', (event) => {
      this.emit('risk:killswitch:deactivated', event);
    });
    this.riskStateMachine.on('risk:day_rollover', (event) => {
      this.emit('risk:day_rollover', event);
      this.handleDayRollover();
    });
    
    // Step 5: Initialize canonical risk math
    const perTradeRiskFraction = validatePerTradeRisk(
      accountCfg.risk_per_trade,
      'guardrails.account.risk_per_trade',
      logger
    );
    
    this.riskMath = new RiskMath({
      accountEquityUsd: this.accountEquity,
      perTradeRiskFraction,
      logger,
    });
    
    // Compute daily stop threshold in R
    this.dailyStopThresholdR = computeDailyStopThresholdR(
      Math.abs(riskCfg.daily_loss_limit),
      perTradeRiskFraction
    );
    
    this.logger.info('Risk thresholds computed', {
      dailyStopThresholdR: this.dailyStopThresholdR,
      riskUnitUsd: this.riskMath.computeRiskUnit(),
    });
    
    // Trade outcome hooks (drives consecutive loss + per-symbol loss tracking)
    this.positionTracker.on('position:closed', (position: Position) => {
      this.handleClosedPosition(position);
    });
    
    // Soft launch trade counter (counts new position opens)
    this.positionTracker.on('position:opened', () => {
      if (!this.isSoftLaunchActive()) {
        return;
      }
      this.softLaunchEntryTrades += 1;
    });
    
    this.startMetricsUpdate();
    // Sequence the loaders so loadRiskState's weekly-equity reset wins over
    // loadDailyStartEquity's; otherwise the unawaited fire-and-forget order
    // races and leaves weeklyStartEquity in an unpredictable state.
    void this.loadDailyStartEquity().then(() => this.loadRiskState());
  }
  
  private isSoftLaunchActive(): boolean {
    const cfg = this.config.softLaunch;
    if (!cfg?.enabled) return false;
    if (!Number.isFinite(cfg.maxEntryTrades) || cfg.maxEntryTrades <= 0) return false;
    return this.softLaunchEntryTrades < cfg.maxEntryTrades;
  }
  
  private getSoftLaunch(): NonNullable<RiskEngineConfig['softLaunch']> | null {
    return this.isSoftLaunchActive() ? (this.config.softLaunch ?? null) : null;
  }
  
  private scaleUsd(value: number, multiplier: number | undefined): number {
    if (!Number.isFinite(value)) return 0;
    const m = (typeof multiplier === 'number' && Number.isFinite(multiplier)) ? multiplier : 1;
    return Math.max(0, value * m);
  }
  
  private getEffectiveMinOrderUsd(): number {
    const soft = this.getSoftLaunch();
    if (soft?.minOrderSizeUsd && Number.isFinite(soft.minOrderSizeUsd) && soft.minOrderSizeUsd > 0) {
      return Math.min(this.config.limits.minOrderSize, soft.minOrderSizeUsd);
    }
    return this.config.limits.minOrderSize;
  }
  
  private getEffectiveMaxPositionUsd(): number {
    const soft = this.getSoftLaunch();
    return soft ? this.scaleUsd(this.config.limits.maxPositionSize, soft.maxPositionSizeMultiplier) : this.config.limits.maxPositionSize;
  }
  
  private getEffectiveMaxOrderUsd(): number {
    const soft = this.getSoftLaunch();
    return soft ? this.scaleUsd(this.config.limits.maxOrderSize, soft.maxOrderSizeMultiplier) : this.config.limits.maxOrderSize;
  }
  
  private getEffectiveMaxTotalExposureUsd(): number {
    const soft = this.getSoftLaunch();
    return soft ? this.scaleUsd(this.config.limits.maxTotalExposure, soft.maxTotalExposureMultiplier) : this.config.limits.maxTotalExposure;
  }
  
  private getEffectiveMaxDailyLossUsd(): number {
    const soft = this.getSoftLaunch();
    return soft ? this.scaleUsd(this.config.limits.maxDailyLoss, soft.maxDailyLossMultiplier) : this.config.limits.maxDailyLoss;
  }
  
  private getEffectiveKillSwitchDailyLossUsd(): number {
    const soft = this.getSoftLaunch();
    return soft ? this.scaleUsd(this.config.killSwitches.dailyLossLimit, soft.maxDailyLossMultiplier) : this.config.killSwitches.dailyLossLimit;
  }
  
  private getEffectivePerSymbolNotionalCapUsd(): number | null {
    const soft = this.getSoftLaunch();
    if (!soft?.perSymbolNotionalCapUsd) return null;
    const cap = soft.perSymbolNotionalCapUsd;
    return (Number.isFinite(cap) && cap > 0) ? cap : null;
  }
  
  private handleClosedPosition(position: Position): void {
    const realized = Number(position.realizedPnL ?? 0);
    if (!Number.isFinite(realized)) {
      return;
    }

    // Rolling window feeding the live EV gate's realized payoff (avg win / avg loss).
    this.recentClosedTradePnls.push(realized);
    if (this.recentClosedTradePnls.length > REALIZED_PAYOFF_WINDOW) {
      this.recentClosedTradePnls.splice(0, this.recentClosedTradePnls.length - REALIZED_PAYOFF_WINDOW);
    }
    
    // Consecutive losses are based on CLOSED trade outcomes (not order placement success).
    if (realized < 0) {
      this.metrics.consecutiveLosses += 1;
      this.recordSymbolLoss(position.symbol, Math.abs(realized));
    } else {
      this.metrics.consecutiveLosses = 0;
    }
  }
  
  /**
   * Load persisted risk state from database on startup.
   * This ensures risk tracking continues across restarts.
   *
   * Every read is scoped to this session's `execution_mode` (TASK_014 P5):
   * a `risk_metrics` row written by a paper session is invisible to a live
   * boot and vice versa. Until the staged `execution_mode` migration has
   * been applied the reads fall back to today's unscoped shape (with a
   * one-time warn from ExecutionModeScope) so a paper deploy keeps working.
   */
  private async loadRiskState(): Promise<void> {
    try {
      const todayStr = new Date().toISOString().split('T')[0];

      const loadLatestMetrics = (scoped: boolean) => {
        let query = this.supabase
          .from('risk_metrics')
          .select('*')
          .order('updated_at', { ascending: false })
          .limit(1);

        if (this.userId) {
          query = query.eq('user_id', this.userId);
        }
        if (scoped) {
          query = query.eq('execution_mode', this.modeScope.mode);
        }
        return query.maybeSingle();
      };

      const { data: latestMetrics, error: metricsError } = await this.modeScope.query(
        'risk_metrics',
        'select',
        () => loadLatestMetrics(true),
        () => loadLatestMetrics(false),
      );

      if (this.modeScope.mode === 'live' && this.modeScope.isLegacy('risk_metrics')) {
        this.logger.warn('Live risk state restored WITHOUT execution_mode isolation; paper rows may be visible', {
          remediation: 'apply supabase/migrations/*_risk_state_execution_mode.sql',
        });
      }
      
      if (metricsError && metricsError.code !== 'PGRST116') {
        this.logger.warn('Failed to load risk metrics state:', metricsError);
      } else if (latestMetrics) {
        // Check if this data is from today - if not, start fresh
        const metricsDate = latestMetrics.updated_at 
          ? new Date(latestMetrics.updated_at).toISOString().split('T')[0]
          : null;

        // Tracks whether this startup discarded persisted state. Both reset
        // branches below used to be memory-only: the DB row kept advertising
        // kill_switch_active=true / consecutive_losses=N until the next 5s
        // metrics tick happened to overwrite it (and never if the engine was
        // stopped before then). Anything that reads risk_metrics or
        // risk_events directly (UI, Grafana) saw a phantom halt.
        let resetSource: RiskStateResetSource | null = null;
        
        if (metricsDate !== todayStr) {
          // Stale data from previous day - start fresh
          this.logger.info('Risk metrics from previous day detected, starting fresh', {
            storedDate: metricsDate,
            today: todayStr,
          });
          this.metrics.dailyPnL = 0;
          this.metrics.maxDrawdown = 0;
          this.metrics.consecutiveLosses = 0;
          this.metrics.errorRate = 0;
          this.metrics.currentExposure = 0;
          this.metrics.killSwitchActive = false;
          resetSource = 'day_boundary';
        } else {
          // Restore metrics from today
          this.metrics.dailyPnL = Number(latestMetrics.daily_pnl ?? 0);
          this.metrics.maxDrawdown = Number(latestMetrics.max_drawdown ?? 0);
          this.metrics.consecutiveLosses = Number(latestMetrics.consecutive_losses ?? 0);
          this.metrics.errorRate = Number(latestMetrics.error_rate ?? 0);
          this.metrics.currentExposure = Number(latestMetrics.exposure_usd ?? 0);
          this.metrics.killSwitchActive = Boolean(latestMetrics.kill_switch_active);
          
          if (this.metrics.killSwitchActive) {
            this.killSwitchActive = true;
            this.logger.warn('Restored kill switch active state from previous session');
          }
          
          this.logger.info('Restored risk state from database', {
            dailyPnL: this.metrics.dailyPnL,
            consecutiveLosses: this.metrics.consecutiveLosses,
            killSwitchActive: this.killSwitchActive,
          });
        }

        if (this.config.ignorePersistedKillSwitch) {
          if (this.metrics.killSwitchActive || this.metrics.maxDrawdown > 0 || this.metrics.consecutiveLosses > 0) {
            this.logger.warn('Resetting persisted risk state for clean session start', {
              killSwitch: this.metrics.killSwitchActive,
              maxDrawdown: this.metrics.maxDrawdown,
              consecutiveLosses: this.metrics.consecutiveLosses,
            });
          }
          this.metrics.killSwitchActive = false;
          this.killSwitchActive = false;
          this.metrics.errorRate = 0;
          this.metrics.maxDrawdown = 0;
          this.metrics.consecutiveLosses = 0;
          this.metrics.dailyPnL = 0;
          // Without this, the 7-day-ago account_metrics load below pulls a
          // stale equity (e.g. $50k from a prior session) while currentEquity
          // is the new paper $10k, and the weekly-loss check trips immediately.
          // For an ephemeral paper restart there's no meaningful "weekly"
          // history, so anchor the tracker to the current session.
          this.weeklyStartEquity = this.accountEquity;
          this.weeklyStartTimestamp = Date.now();
          resetSource = 'startup_reset';
        }

        if (resetSource) {
          await this.persistClearedRiskState(resetSource);
        }
      }

      // Load account metrics for today to get weekly tracking. Skip when
      // ignorePersistedKillSwitch is set — the reset block above already
      // anchored the weekly tracker to current equity for a clean session.
      // `account_metrics.execution_mode` already exists on prod (Sprint-9 DB
      // handoff #2 stamps + backfilled it), so both reads are mode-scoped.
      if (!this.config.ignorePersistedKillSwitch) {
        const loadTodayMetrics = (scoped: boolean) => {
          let query = this.supabase
            .from('account_metrics')
            .select('*')
            .eq('date', todayStr)
            .limit(1);
          if (this.userId) {
            query = query.eq('user_id', this.userId);
          }
          if (scoped) {
            query = query.eq('execution_mode', this.modeScope.mode);
          }
          return query.maybeSingle();
        };

        const { data: accountMetrics, error: accountError } = await this.modeScope.query(
          'account_metrics',
          'select',
          () => loadTodayMetrics(true),
          () => loadTodayMetrics(false),
        );

        if (accountError && !['PGRST116', 'PGRST205', '42P01'].includes(accountError.code)) {
          this.logger.warn('Failed to load account metrics state:', accountError);
        } else if (accountMetrics) {
          // Calculate weekly start from 7 days ago
          const weekStart = new Date();
          weekStart.setDate(weekStart.getDate() - 7);
          weekStart.setHours(0, 0, 0, 0);
          const weekStartDate = weekStart.toISOString().split('T')[0];

          const loadWeekStartEquity = (scoped: boolean) => {
            let query = this.supabase
              .from('account_metrics')
              .select('total_equity')
              .eq('date', weekStartDate)
              .limit(1);
            if (this.userId) {
              query = query.eq('user_id', this.userId);
            }
            if (scoped) {
              query = query.eq('execution_mode', this.modeScope.mode);
            }
            return query.maybeSingle();
          };

          const { data: weekStartMetrics } = await this.modeScope.query(
            'account_metrics',
            'select',
            () => loadWeekStartEquity(true),
            () => loadWeekStartEquity(false),
          );

          if (weekStartMetrics) {
            this.weeklyStartEquity = weekStartMetrics.total_equity;
            this.logger.debug('Restored weekly start equity:', this.weeklyStartEquity);
          }
        }
      }
      
    } catch (error) {
      this.logger.error('Error loading risk state:', error);
      // Don't throw - use initialized defaults
    }
  }
  
  /**
   * Get per-symbol limits from guardrails config.
   */
  private getPerSymbolLimits(symbol: string): { maxNotionalUsd: number; maxDailyLossUsd: number } | null {
    const perSymbol = this.guardrails.per_symbol;
    if (!perSymbol || !perSymbol[symbol]) {
      return null;
    }
    const limits = perSymbol[symbol];
    return {
      maxNotionalUsd: limits.max_notional_usd,
      maxDailyLossUsd: limits.max_daily_loss_usd,
    };
  }
  
  /**
   * Record a loss for a specific symbol.
   */
  public recordSymbolLoss(symbol: string, lossUsd: number): void {
    const currentLoss = this.dailyLossPerSymbol.get(symbol) || 0;
    const newLoss = currentLoss + lossUsd;
    this.dailyLossPerSymbol.set(symbol, newLoss);
    
    // Check if symbol should be blocked
    const limits = this.getPerSymbolLimits(symbol);
    if (limits && newLoss >= limits.maxDailyLossUsd) {
      if (!this.blockedSymbols.has(symbol)) {
        this.blockedSymbols.add(symbol);
        this.logger.warn(`Symbol ${symbol} blocked due to daily loss limit`, {
          dailyLoss: newLoss,
          limit: limits.maxDailyLossUsd,
        });
        this.emit('risk:symbol:blocked', symbol, newLoss, limits.maxDailyLossUsd);
      }
    }
  }
  
  /**
   * Check if a symbol is blocked from trading.
   */
  public isSymbolBlocked(symbol: string): boolean {
    return this.blockedSymbols.has(symbol);
  }
  
  /**
   * Get daily loss for a symbol.
   */
  public getSymbolDailyLoss(symbol: string): number {
    return this.dailyLossPerSymbol.get(symbol) || 0;
  }
  
  /**
   * Reset per-symbol daily tracking (call at start of day).
   */
  public resetSymbolDailyTracking(): void {
    this.dailyLossPerSymbol.clear();
    this.blockedSymbols.clear();
    this.logger.info('Per-symbol daily tracking reset');
  }

  private initializeMetrics(): RiskMetrics {
    return {
      currentExposure: 0,
      dailyPnL: 0,
      dailyLossPercentage: 0,
      maxDrawdown: 0,
      openOrderCount: 0,
      consecutiveLosses: 0,
      errorRate: 0,
      averageLatency: 0,
      killSwitchActive: false,
      lastUpdated: new Date()
    };
  }

  private startMetricsUpdate(): void {
    this.metricsUpdateInterval = setInterval(() => {
      this.updateMetrics();
    }, 5000); // Update every 5 seconds
  }

  private async loadDailyStartEquity(): Promise<void> {
    const todayStr = new Date().toISOString().split('T')[0];

    // If userId isn't provided, fall back to in-memory only
    if (!this.userId) {
      this.dailyStartEquity = await this.calculateCurrentEquity();
      this.dailyHighEquity = this.dailyStartEquity;
      this.weeklyStartEquity = this.dailyStartEquity;
      this.weeklyStartTimestamp = Date.now();
      return;
    }

    const userId = this.userId;
    const loadStartEquity = (scoped: boolean) => {
      let query = this.supabase
        .from('daily_equity')
        .select('start_equity')
        .eq('user_id', userId)
        .eq('date', todayStr);
      if (scoped) {
        query = query.eq('execution_mode', this.modeScope.mode);
      }
      return query.maybeSingle();
    };

    try {
      const { data, error } = await this.modeScope.query(
        'daily_equity',
        'select',
        () => loadStartEquity(true),
        () => loadStartEquity(false),
      );

      if (error) {
        if (error.code === 'PGRST205' || error.code === '42P01') {
          this.logger.debug('daily_equity table not available');
          this.dailyStartEquity = await this.calculateCurrentEquity();
        } else if (error.code !== 'PGRST116') {
          this.logger.warn('Failed to load daily_equity start equity:', error);
          this.dailyStartEquity = await this.calculateCurrentEquity();
        }
      } else if (data && data.start_equity !== undefined) {
        this.dailyStartEquity = Number(data.start_equity);
      } else {
        const equity = await this.calculateCurrentEquity();
        this.dailyStartEquity = equity;
        await this.saveDailyStartEquity(equity);
      }
    } catch (err) {
      this.logger.warn('Error loading daily start equity (fallback to in-memory):', err);
      this.dailyStartEquity = await this.calculateCurrentEquity();
    }

    this.dailyHighEquity = this.dailyStartEquity;
    this.weeklyStartEquity = this.dailyStartEquity;
    this.weeklyStartTimestamp = Date.now();
  }

  /**
   * Persist today's start-of-day equity, keyed by
   * `(user_id, execution_mode, date)` so paper and live keep separate
   * anchors. Pre-migration the legacy `(user_id, date)` key is used.
   */
  private async saveDailyStartEquity(equity: number): Promise<void> {
    if (!this.userId) {
      return;
    }

    const todayStr = new Date().toISOString().split('T')[0];
    const row = {
      user_id: this.userId,
      date: todayStr,
      start_equity: equity,
    };

    try {
      const { error } = await this.modeScope.query(
        'daily_equity',
        'upsert',
        () => this.supabase
          .from('daily_equity')
          .upsert(
            { ...row, execution_mode: this.modeScope.mode },
            { onConflict: 'user_id,execution_mode,date' },
          ),
        () => this.supabase
          .from('daily_equity')
          .upsert(row, { onConflict: 'user_id,date' }),
      );
      
      if (error) {
        if (error.code === 'PGRST205' || error.code === '42P01') {
          this.logger.debug('daily_equity table not available');
        } else {
          dailyEquityWriteFailures.inc();
          this.logger.error('Failed to save daily start equity:', {
            code: error.code,
            message: error.message,
          });
        }
      }
    } catch (error) {
      dailyEquityWriteFailures.inc();
      this.logger.error('Error saving daily start equity:', error);
    }
  }

  private async calculateCurrentEquity(): Promise<number> {
    // Get account balances
    // This is simplified - in production, you'd get actual balances from exchange
    const baseEquity = this.accountEquity;
    const portfolioSummary = this.positionTracker.getPortfolioSummary();
    return baseEquity + portfolioSummary.totalPnL;
  }

  /**
   * #A3 (2026-05-18): pre-trade fee-adjusted EV gate. Thin wrapper around
   * the pure `evaluateEvGate` helper so call sites get one logger +
   * counter + threshold wired in one place.
   *
   * Inputs other than (symbol, strategy, direction, entryPrice, stopPrice,
   * takeProfit, size, winRate) are filled in from the engine state
   * (feeModel, minEvThreshold) so signal handlers don't have to plumb
   * fee-routing details.
   *
   * Returns the full result struct (allowed + ev/threshold/p/feeUsd +
   * reason) so callers can route structured logs into the signal funnel.
   *
   * Counter labels: `path` = 'priced' (winRate present + EV computed),
   * 'default_allow' (one of the cold-start fallback paths), or absent
   * when rejected (rejected uses the separate `evGateRejected` counter).
   */
  public evaluateSignalEv(
    args: Omit<EvGateInputs, 'feeModel' | 'minEvThreshold' | 'mode'>,
  ): EvGateResult {
    const inputs: EvGateInputs = {
      ...args,
      feeModel: this.feeModel ?? undefined,
      minEvThreshold: this.minEvThreshold,
    };
    if (this.executionMode === 'live') {
      // TASK_011 live semantics: Beta(12,18) prior instead of allow-by-default,
      // realized payoff (fallback: TP geometry × 0.6), live tier fee legs, and the
      // configured enforce|shadow mode. Paper keeps the legacy cold-start behaviour.
      inputs.winRatePrior = args.winRatePrior ?? LIVE_WIN_RATE_PRIOR;
      inputs.geometryHaircut = args.geometryHaircut ?? LIVE_GEOMETRY_HAIRCUT;
      inputs.realizedPayoffRatio = args.realizedPayoffRatio ?? this.getRealizedPayoffRatio();
      inputs.entryLiquidity = args.entryLiquidity ?? 'taker';
      inputs.mode = this.evGateMode;
    }
    const result = evaluateEvGate(inputs, this.logger);
    const labelSymbol = args.symbol || 'unknown';
    const labelStrategy = args.strategy || 'unknown';
    if (!result.allowed) {
      evGateRejected.labels(labelStrategy, labelSymbol).inc();
    } else {
      const path = result.shadowed ? 'shadow_allow' : result.reason ? 'default_allow' : 'priced';
      evGateAccepted.labels(labelStrategy, labelSymbol, path).inc();
    }
    return result;
  }

  /**
   * Realized payoff ratio (avg win / avg loss) over the last `REALIZED_PAYOFF_WINDOW`
   * closed trades, or null when history is too thin/one-sided (EV gate then falls
   * back to TP geometry with the live haircut).
   */
  public getRealizedPayoffRatio(): number | null {
    return computeRealizedPayoffRatio(this.recentClosedTradePnls);
  }

  /**
   * Swap the FeeModel behind the EV gate (live fee-tier transitions). The previous
   * model is not mutated; callers receive the replaced instance for logging.
   */
  public setFeeModel(feeModel: FeeModel): FeeModel | null {
    const previous = this.feeModel;
    this.feeModel = feeModel;
    return previous;
  }

  /** FeeModel currently used by the EV gate (null when none was configured). */
  public getFeeModel(): FeeModel | null {
    return this.feeModel;
  }

  /** Execution mode this engine was built for. */
  public getExecutionMode(): 'paper' | 'live' {
    return this.executionMode;
  }

  /** EV gate mode in force (`enforce` for paper; `live.ev_gate_mode` in live). */
  public getEvGateMode(): EvGateMode {
    return this.evGateMode;
  }

  /**
   * Session equity anchor: the Coinbase snapshot equity at start in live,
   * `guardrails.account.equity_usd` in paper.
   */
  public getAccountEquity(): number {
    return this.accountEquity;
  }

  /** Latest live account snapshot (null in paper or before the first refresh). */
  public getLiveAccountSnapshot(): { equityUsd: number; fetchedAt: number } | null {
    return this.liveAccountTruth?.getSnapshot() ?? null;
  }

  /** True in live when the account snapshot is older than its staleness bound. */
  public isAccountTruthStale(): boolean {
    return this.liveAccountTruth ? this.liveAccountTruth.isStale() : false;
  }

  // Pre-trade risk check
  public async checkOrder(order: OrderRequest, currentPrice: number): Promise<RiskCheck> {
    const check: RiskCheck = {
      passed: true,
      checks: {
        positionSize: true,
        totalExposure: true,
        dailyLoss: true,
        orderSize: true,
        openOrders: true,
        openPositions: true,
        killSwitch: true
      }
    };

    // Reject orders with non-finite values before any further processing
    const rawSize = parseFloat(order.size || '0');
    const rawPrice = parseFloat(order.price || '0') || currentPrice;
    const rawNotional = rawSize * rawPrice;
    if (!Number.isFinite(currentPrice) || currentPrice <= 0
      || (!Number.isFinite(rawSize) && !Number.isFinite(parseFloat(order.funds || '')))
      || !Number.isFinite(rawNotional)) {
      check.passed = false;
      check.reason = `Non-finite order values rejected: size=${rawSize}, price=${rawPrice}, currentPrice=${currentPrice}`;
      check.checks.orderSize = false;
      this.logger.warn('Risk check rejected non-finite order', {
        size: order.size,
        price: order.price,
        funds: order.funds,
        currentPrice,
      });
      this.emit('risk:check:failed', order.client_oid || '', check.reason);
      return check;
    }

    const symbol = order.product_id;
    const position = this.positionTracker.getPosition(symbol);
    const exposureSim = this.simulatePositionAfterOrder(position, order, currentPrice);
    const orderValue = this.calculateOrderValue(order, currentPrice);
    const isReduceOnly = exposureSim.isReduceOnly;
    
    // Spot safety: if shorts are disabled, reject any order that would create/increase a short position.
    const shortsAllowed = Boolean(this.guardrails?.strategy?.allow_short);
    if (!shortsAllowed && exposureSim.newSide === 'short') {
      check.passed = false;
      check.reason = `Short selling is disabled; cannot create/increase short position on ${symbol}`;
      check.checks.positionSize = false;
      this.emit('risk:check:failed', order.client_oid || '', check.reason);
      return check;
    }
    
    // Check if kill switch is active (allow reduce-only exits)
    if (this.killSwitchActive && !isReduceOnly) {
      check.passed = false;
      check.reason = 'Kill switch is active (entries disabled)';
      check.checks.killSwitch = false;
      this.emit('risk:check:failed', order.client_oid || '', check.reason);
      return check;
    }

    // Live: a stale account snapshot means sizing equity is unknown — block new entries
    // (reduce-only exits stay allowed) until LiveAccountTruth refreshes successfully.
    if (this.liveAccountTruth && !isReduceOnly && this.liveAccountTruth.isStale()) {
      const snapshot = this.liveAccountTruth.getSnapshot();
      const ageSec = snapshot ? Math.round((Date.now() - snapshot.fetchedAt) / 1000) : null;
      check.passed = false;
      check.reason =
        `${ACCOUNT_TRUTH_STALE}: live account snapshot is ${ageSec === null ? 'missing' : `${ageSec}s old`} — ` +
        'entries blocked until Coinbase account truth refreshes';
      check.checks.killSwitch = false;
      this.logger.warn('Risk check blocked entry on stale account truth', {
        symbol,
        side: order.side,
        ageSec,
      });
      this.emit('risk:check:failed', order.client_oid || '', check.reason);
      return check;
    }
    
    // Check if symbol is blocked due to per-symbol daily loss limit (allow reduce-only exits)
    if (this.isSymbolBlocked(symbol) && !isReduceOnly) {
      check.passed = false;
      check.reason = `Symbol ${symbol} is blocked due to daily loss limit`;
      check.checks.dailyLoss = false;
      this.emit('risk:check:failed', order.client_oid || '', check.reason);
      return check;
    }
    
    // Reduce-only exits are allowed even when limits are breached; we still validate sizing best-effort.
    if (!isReduceOnly) {
      // Per-symbol notional limit should apply to resulting position exposure (not just order notional)
      const perSymbolLimits = this.getPerSymbolLimits(symbol);
      const softCap = this.getEffectivePerSymbolNotionalCapUsd();
      if (softCap !== null && exposureSim.newAbsNotional > softCap) {
        check.passed = false;
        check.reason = `Soft launch cap: position notional $${exposureSim.newAbsNotional.toFixed(2)} exceeds per-symbol cap $${softCap}`;
        check.checks.positionSize = false;
      } else if (perSymbolLimits && exposureSim.newAbsNotional > perSymbolLimits.maxNotionalUsd) {
        check.passed = false;
        check.reason = `Position notional $${exposureSim.newAbsNotional.toFixed(2)} exceeds ${symbol} max notional $${perSymbolLimits.maxNotionalUsd}`;
        check.checks.positionSize = false;
      }
      
      // Minimum order size
      const minOrderUsd = this.getEffectiveMinOrderUsd();
      if (orderValue < minOrderUsd) {
        check.passed = false;
        check.reason = `Order size $${orderValue.toFixed(2)} below minimum $${minOrderUsd}`;
        check.checks.orderSize = false;
      }
      
      // Open position limit only blocks orders that would open a NEW position (not adds to existing)
      const openPositions = this.positionTracker.getOpenPositions();
      if (exposureSim.opensNewPosition && openPositions.length >= this.maxOpenPositionsLimit) {
        check.passed = false;
        check.reason = `Open position limit reached (${openPositions.length}/${this.maxOpenPositionsLimit})`;
        check.checks.openPositions = false;
      }
      
      // Maximum order size
      const maxOrderUsd = this.getEffectiveMaxOrderUsd();
      if (orderValue > maxOrderUsd) {
        check.passed = false;
        check.reason = `Order size $${orderValue.toFixed(2)} exceeds maximum $${maxOrderUsd}`;
        check.checks.orderSize = false;
      }
      
      // Position size limit (absolute notional after the order)
      const maxPositionUsd = this.getEffectiveMaxPositionUsd();
      const effectiveExposureCapUsd = this.getSoftLaunch()
        ? this.scaleUsd(this.maxPositionExposureUsd, this.getSoftLaunch()!.maxPositionSizeMultiplier)
        : this.maxPositionExposureUsd;
      if (exposureSim.newAbsNotional > maxPositionUsd || exposureSim.newAbsNotional > effectiveExposureCapUsd) {
        check.passed = false;
        check.reason = `Position size would exceed limit: $${exposureSim.newAbsNotional.toFixed(2)} > $${maxPositionUsd}`;
        check.checks.positionSize = false;
      }
      
      // Total exposure (portfolio) after the order (accounting for sells reducing exposure)
      const currentExposure = this.calculateTotalExposure();
      const newExposure = Math.max(0, currentExposure - exposureSim.currentAbsNotional + exposureSim.newAbsNotional);
      const maxTotalExposureUsd = this.getEffectiveMaxTotalExposureUsd();
      if (newExposure > maxTotalExposureUsd) {
        check.passed = false;
        check.reason = `Total exposure would exceed limit: $${newExposure.toFixed(2)} > $${maxTotalExposureUsd}`;
        check.checks.totalExposure = false;
      }
      
      // Daily loss limit
      const maxDailyLossUsd = this.getEffectiveMaxDailyLossUsd();
      if (this.metrics.dailyPnL <= -maxDailyLossUsd) {
        check.passed = false;
        check.reason = `Daily loss limit reached: $${Math.abs(this.metrics.dailyPnL).toFixed(2)}`;
        check.checks.dailyLoss = false;
      }
      
      // Open orders limit
      if (this.metrics.openOrderCount >= this.config.limits.maxOpenOrders) {
        check.passed = false;
        check.reason = `Maximum open orders limit reached: ${this.metrics.openOrderCount}`;
        check.checks.openOrders = false;
      }
    }

    // Log risk check result
    if (check.passed) {
      this.emit('risk:check:passed', order.client_oid || '');
    } else {
      this.emit('risk:check:failed', order.client_oid || '', check.reason || 'Unknown');
    }

    return check;
  }

  private calculateOrderValue(order: OrderRequest, currentPrice: number): number {
    const size = this.getOrderBaseSize(order, currentPrice);
    if (!Number.isFinite(size) || size <= 0) {
      const funds = Number.parseFloat(order.funds || '0');
      return Number.isFinite(funds) ? funds : 0;
    }
    
    if (order.type === 'market') {
      return size * currentPrice;
    }
    
    const price = Number.parseFloat(order.price || '0');
    return size * price;
  }
  
  private getOrderBaseSize(order: OrderRequest, currentPrice: number): number {
    const rawSize = Number.parseFloat(order.size || '');
    if (Number.isFinite(rawSize) && rawSize > 0) {
      return rawSize;
    }
    
    // Some APIs allow market buys using quote "funds" instead of base "size"
    const rawFunds = Number.parseFloat(order.funds || '');
    if (Number.isFinite(rawFunds) && rawFunds > 0 && Number.isFinite(currentPrice) && currentPrice > 0) {
      return rawFunds / currentPrice;
    }
    
    return 0;
  }
  
  private simulatePositionAfterOrder(
    position: Position | undefined,
    order: OrderRequest,
    currentPrice: number
  ): {
    currentSide: Position['side'];
    currentSize: number;
    currentAbsNotional: number;
    newSide: Position['side'];
    newSize: number;
    newAbsNotional: number;
    opensNewPosition: boolean;
    isReduceOnly: boolean;
  } {
    const epsilon = 1e-12;
    const currentSide: Position['side'] = position?.side && position.size > 0 ? position.side : 'flat';
    const currentSize = Number.isFinite(position?.size) ? Math.max(0, position!.size) : 0;
    const priceForNotional = Number.isFinite(position?.marketPrice) && (position!.marketPrice > 0)
      ? position!.marketPrice
      : currentPrice;
    const currentAbsNotional = (currentSide === 'flat' || currentSize <= 0 || !Number.isFinite(priceForNotional) || priceForNotional <= 0)
      ? 0
      : Math.abs(currentSize * priceForNotional);
    
    const orderSize = this.getOrderBaseSize(order, currentPrice);
    const safeOrderSize = Number.isFinite(orderSize) ? Math.max(0, orderSize) : 0;
    
    let newSide: Position['side'] = currentSide;
    let newSize = currentSize;
    
    if (currentSide === 'flat' || currentSize <= 0) {
      if (safeOrderSize > 0) {
        newSide = order.side === 'buy' ? 'long' : 'short';
        newSize = safeOrderSize;
      } else {
        newSide = 'flat';
        newSize = 0;
      }
    } else if (currentSide === 'long') {
      if (order.side === 'buy') {
        newSide = 'long';
        newSize = currentSize + safeOrderSize;
      } else {
        if (safeOrderSize < currentSize - epsilon) {
          newSide = 'long';
          newSize = currentSize - safeOrderSize;
        } else if (Math.abs(safeOrderSize - currentSize) <= epsilon) {
          newSide = 'flat';
          newSize = 0;
        } else {
          newSide = 'short';
          newSize = safeOrderSize - currentSize;
        }
      }
    } else if (currentSide === 'short') {
      if (order.side === 'sell') {
        newSide = 'short';
        newSize = currentSize + safeOrderSize;
      } else {
        if (safeOrderSize < currentSize - epsilon) {
          newSide = 'short';
          newSize = currentSize - safeOrderSize;
        } else if (Math.abs(safeOrderSize - currentSize) <= epsilon) {
          newSide = 'flat';
          newSize = 0;
        } else {
          newSide = 'long';
          newSize = safeOrderSize - currentSize;
        }
      }
    }
    
    const newAbsNotional = (newSide === 'flat' || newSize <= 0 || !Number.isFinite(currentPrice) || currentPrice <= 0)
      ? 0
      : Math.abs(newSize * currentPrice);
    
    const opensNewPosition = (currentSide === 'flat' || currentSize <= 0) && newSide !== 'flat' && newSize > 0;
    
    // Reduce-only means it decreases exposure without flipping direction.
    const reducesDirection = (currentSide === 'long' && order.side === 'sell') || (currentSide === 'short' && order.side === 'buy');
    const doesNotFlip = newSide === currentSide || newSide === 'flat';
    const isReduceOnly = reducesDirection && doesNotFlip && newAbsNotional <= currentAbsNotional + epsilon;
    
    return {
      currentSide,
      currentSize,
      currentAbsNotional,
      newSide,
      newSize,
      newAbsNotional,
      opensNewPosition,
      isReduceOnly,
    };
  }

  /**
   * Get dynamic equity for position sizing (profit compounding).
   *
   * Live: the latest Coinbase account snapshot's equity, used directly — no clamp.
   * The exchange is the truth; clamping it to a yaml-derived band would re-introduce
   * the fail-open sizing this replaces. Throws `ACCOUNT_TRUTH_UNAVAILABLE` if the
   * snapshot vanished (cannot happen after a successful start).
   *
   * Paper: current equity (base + PnL) instead of the static config value.
   * Floors at 50% of initial equity to prevent over-shrinking after losses.
   * Caps at 200% of initial equity to prevent over-leveraging after big wins.
   */
  public getCurrentEquityForSizing(): number {
    if (this.liveAccountTruth) {
      const snapshot = this.liveAccountTruth.getSnapshot();
      if (!snapshot || !Number.isFinite(snapshot.equityUsd)) {
        throw new Error(`${ACCOUNT_TRUTH_UNAVAILABLE}: no live account snapshot available for sizing`);
      }
      return snapshot.equityUsd;
    }

    const currentEquity = this.dailyStartEquity + this.metrics.dailyPnL;
    const floor = this.accountEquity * 0.5;   // Never size below 50% of initial
    const ceiling = this.accountEquity * 2.0;  // Never size above 200% of initial
    
    if (!Number.isFinite(currentEquity) || currentEquity <= 0) {
      return this.accountEquity; // Fallback to static config
    }
    
    return Math.max(floor, Math.min(ceiling, currentEquity));
  }

  public computeOrderSize(productId: string, entryPrice: number, stopPrice: number, riskPerTradeOverride?: number): number {
    // Delegates to the shared `computeRiskBasedSize` helper so backtest and
    // live use the exact same formula. Soft-launch multipliers fold into
    // the inputs here, before the helper sees them.
    const sizingEquity = this.getCurrentEquityForSizing();
    const baseRiskPerTrade = riskPerTradeOverride ?? this.guardrails.account.risk_per_trade;
    const soft = this.getSoftLaunch();

    const effectiveRiskPerTrade = soft
      ? baseRiskPerTrade * (soft.riskPerTradeMultiplier ?? 1)
      : baseRiskPerTrade;

    const exposureCapUsd = soft
      ? this.scaleUsd(this.maxPositionExposureUsd, soft.maxPositionSizeMultiplier)
      : this.maxPositionExposureUsd;

    const minNotionalUsd =
      soft?.minOrderSizeUsd && Number.isFinite(soft.minOrderSizeUsd) && soft.minOrderSizeUsd > 0
        ? Math.min(this.minOrderNotionalUsd, soft.minOrderSizeUsd)
        : this.minOrderNotionalUsd;

    const result = computeRiskBasedSize({
      equity: sizingEquity,
      riskPerTrade: effectiveRiskPerTrade,
      entryPrice,
      stopPrice,
      maxPositionExposureUsd: exposureCapUsd,
      minNotionalUsd,
      sizeDecimals: 6,
    });

    return result.size;
  }

  private calculateTotalExposure(): number {
    const positions = this.positionTracker.getOpenPositions();
    return positions.reduce((total, position) => {
      return total + Math.abs(position.size * position.marketPrice);
    }, 0);
  }

  private enforceLossGuardrails(currentEquity: number): void {
    const now = Date.now();
    const dailyLoss = this.dailyStartEquity - currentEquity;
    const soft = this.getSoftLaunch();
    const dailyLimitUsd = soft ? this.scaleUsd(this.dailyLossLimitUsd, soft.maxDailyLossMultiplier) : this.dailyLossLimitUsd;
    if (!this.killSwitchActive && dailyLoss >= dailyLimitUsd) {
      this.triggerKillSwitch(
        `Daily loss guardrail tripped: -$${dailyLoss.toFixed(2)}`,
        'daily_stop'
      );
      return;
    }

    const oneWeekMs = 7 * 24 * 60 * 60 * 1000;
    if (now - this.weeklyStartTimestamp > oneWeekMs) {
      this.weeklyStartEquity = currentEquity;
      this.weeklyStartTimestamp = now;
    }

    const weeklyLoss = this.weeklyStartEquity - currentEquity;
    if (!this.killSwitchActive && weeklyLoss >= this.weeklyLossLimitUsd) {
      this.triggerKillSwitch(
        `Weekly loss guardrail tripped: -$${weeklyLoss.toFixed(2)}`,
        'weekly_stop'
      );
      return;
    }

    const absoluteDrawdown = this.accountEquity - currentEquity;
    const drawdownPct = this.accountEquity > 0 ? absoluteDrawdown / this.accountEquity : 0;
    const drawdownLimitUsd = soft ? this.scaleUsd(this.maxDrawdownUsd, soft.maxDailyLossMultiplier) : this.maxDrawdownUsd;
    const drawdownLimitPct = this.accountEquity > 0 ? drawdownLimitUsd / this.accountEquity : 0.05;
    if (!this.killSwitchActive && absoluteDrawdown >= drawdownLimitUsd) {
      const halt = createMaxDrawdownHalt(drawdownPct, drawdownLimitPct, absoluteDrawdown);
      this.triggerKillSwitch(halt.reasonText, halt.reasonCode);
      return;
    }

    const rapidWindowMs = 10 * 60 * 1000;
    this.equityHistory.push({ timestamp: now, equity: currentEquity });
    this.equityHistory = this.equityHistory.filter(point => now - point.timestamp <= rapidWindowMs);
    if (this.rapidLossThresholdUsd > 0 && this.equityHistory.length > 0) {
      const maxEquityWindow = Math.max(...this.equityHistory.map(point => point.equity));
      const drop = maxEquityWindow - currentEquity;
      const rapidLimitUsd = soft ? this.scaleUsd(this.rapidLossThresholdUsd, soft.maxDailyLossMultiplier) : this.rapidLossThresholdUsd;
      if (!this.killSwitchActive && drop >= rapidLimitUsd) {
        this.triggerKillSwitch(
          `Rapid loss guardrail tripped: -$${drop.toFixed(2)} in <10m`,
          'rapid_loss'
        );
      }
    }
  }

  // Update risk metrics
  private async updateMetrics(): Promise<void> {
    // Update exposure
    this.metrics.currentExposure = this.calculateTotalExposure();

    // Update daily P&L
    const currentEquity = await this.calculateCurrentEquity();
    this.metrics.dailyPnL = currentEquity - this.dailyStartEquity;
    this.metrics.dailyLossPercentage = this.dailyStartEquity !== 0
      ? (this.metrics.dailyPnL / this.dailyStartEquity) * 100
      : 0;

    // Portfolio-level drawdown from intraday high water mark.
    if (this.dailyHighEquity <= 0) {
      this.dailyHighEquity = this.dailyStartEquity > 0 ? this.dailyStartEquity : currentEquity;
    }
    this.dailyHighEquity = Math.max(this.dailyHighEquity, currentEquity);
    const currentDrawdownPct = this.dailyHighEquity > 0
      ? ((this.dailyHighEquity - currentEquity) / this.dailyHighEquity) * 100
      : 0;
    this.metrics.maxDrawdown = Math.max(this.metrics.maxDrawdown, currentDrawdownPct);
    
    // Step 5: Update canonical risk math snapshot
    const portfolioSummary = this.positionTracker.getPortfolioSummary();
    const realizedPnl = portfolioSummary.totalRealizedPnL || 0;
    const unrealizedPnl = portfolioSummary.totalUnrealizedPnL || 0;
    this.riskMath.computeSnapshot(realizedPnl, unrealizedPnl);
    
    // Check for day rollover
    this.riskStateMachine.checkDayRollover();

    // Update error rate
    const recentOrders = this.orderHistory.filter(
      o => o.timestamp > new Date(Date.now() - 3600000) // Last hour
    );
    if (recentOrders.length > 0) {
      const errors = recentOrders.filter(o => !o.success).length;
      this.metrics.errorRate = (errors / recentOrders.length) * 100;
    }

    // Update average latency
    if (this.latencyHistory.length > 0) {
      this.metrics.averageLatency = 
        this.latencyHistory.reduce((a, b) => a + b, 0) / this.latencyHistory.length;
    }

    this.metrics.lastUpdated = new Date();

    this.enforceLossGuardrails(currentEquity);
    this.metrics.killSwitchActive = this.killSwitchActive;

    // Check kill switches
    this.checkKillSwitches();

    // Emit metrics update
    this.emit('risk:metrics:update', this.metrics);

    // Persist metrics
    await this.persistMetrics();
  }

  private checkKillSwitches(): void {
    if (!this.config.killSwitches.enabled) {
      return;
    }

    // Check daily loss kill switch (use R-based threshold from risk math)
    const snapshot = this.riskMath.getSnapshot();
    if (snapshot && this.riskMath.isDailyStopTriggered(this.dailyStopThresholdR)) {
      const halt = createDailyStopHalt(
        snapshot.dailyPnlUsd,
        snapshot.dailyPnlR,
        this.dailyStopThresholdR
      );
      this.triggerKillSwitch(halt.reasonText, halt.reasonCode);
      return;
    }

    // Fallback: Check daily loss in USD
    const dailyLossLimit = this.getEffectiveKillSwitchDailyLossUsd();
    if (this.metrics.dailyPnL <= -dailyLossLimit) {
      this.triggerKillSwitch(
        `Daily loss limit exceeded: -$${Math.abs(this.metrics.dailyPnL).toFixed(2)}`,
        'daily_stop'
      );
      return;
    }

    // Check consecutive losses
    if (this.metrics.consecutiveLosses >= this.config.killSwitches.consecutiveLossLimit) {
      const halt = createConsecutiveLossesHalt(
        this.metrics.consecutiveLosses,
        this.config.killSwitches.consecutiveLossLimit
      );
      this.triggerKillSwitch(halt.reasonText, halt.reasonCode);
      return;
    }

    // Check error rate
    if (this.metrics.errorRate >= this.config.killSwitches.errorRateLimit) {
      this.triggerKillSwitch(
        `Error rate too high: ${this.metrics.errorRate.toFixed(2)}%`,
        'error_rate'
      );
      return;
    }

    // Check latency
    if (this.metrics.averageLatency >= this.config.killSwitches.latencyLimit) {
      this.triggerKillSwitch(
        `Latency too high: ${this.metrics.averageLatency.toFixed(0)}ms`,
        'latency'
      );
      return;
    }
  }

  private triggerKillSwitch(reason: string, reasonCode: RiskHaltReasonCode = 'unknown'): void {
    if (this.killSwitchActive) {
      return; // Already triggered
    }

    this.logger.error(`KILL SWITCH TRIGGERED: ${reason}`);
    this.killSwitchActive = true;
    this.metrics.killSwitchActive = true;
    
    // Use the risk state machine for structured halt
    const snapshot = this.riskMath.getSnapshot();
    const daily = isDailyHaltReason(reasonCode);
    
    this.riskStateMachine.halt(reasonCode, reason, daily, {
      dailyPnlUsd: snapshot?.dailyPnlUsd,
      dailyPnlR: snapshot?.dailyPnlR,
      thresholdR: this.dailyStopThresholdR,
      consecutiveLosses: this.metrics.consecutiveLosses,
      errorRate: this.metrics.errorRate,
    });
    
    // Emit legacy event for backward compatibility
    this.emit('risk:killswitch:triggered', reason);

    // Note: Position flattening is now optional and config-driven.
    // The state machine halts trading but does NOT automatically close positions.
    // Position monitor will still execute reduce-only exits (stop/TP/trailing).
  }
  
  /**
   * Trigger halt with structured reason (Step 5)
   */
  private haltTrading(
    reasonCode: RiskHaltReasonCode,
    reasonText: string,
    daily: boolean,
    context?: Record<string, any>
  ): void {
    if (this.riskStateMachine.isHalted()) {
      return; // Already halted
    }
    
    this.killSwitchActive = true;
    this.metrics.killSwitchActive = true;
    
    this.riskStateMachine.halt(reasonCode, reasonText, daily, context);
  }
  
  /**
   * Handle day rollover from state machine
   */
  private handleDayRollover(): void {
    this.logger.info('Risk day rollover triggered');
    
    // Reset daily tracking
    this.resetDailyMetrics().catch(e => {
      this.logger.error('Failed to reset daily metrics on rollover', { error: e.message });
    });
    
    // Update risk math for new day
    const currentEquity = this.dailyStartEquity + this.metrics.dailyPnL;
    this.riskMath.resetForNewDay(currentEquity);
  }
  
  /**
   * Check for day rollover (call on each tick)
   */
  public checkDayRollover(): boolean {
    return this.riskStateMachine.checkDayRollover();
  }

  // Calculate position size based on Kelly criterion
  public calculatePositionSize(
    winRate: number,
    avgWin: number,
    avgLoss: number,
    accountEquity: number
  ): number {
    // Kelly formula: f = (p * b - q) / b
    // where: f = fraction of capital to bet
    //        p = probability of winning
    //        q = probability of losing (1 - p)
    //        b = ratio of win to loss

    const p = winRate;
    const q = 1 - winRate;
    const b = avgWin / avgLoss;

    let kellyFraction = (p * b - q) / b;

    // Apply Kelly fraction scaling (quarter Kelly is safer)
    kellyFraction *= this.config.kellyFraction;

    // Apply risk per trade limit
    kellyFraction = Math.min(kellyFraction, this.config.riskPerTrade / 100);

    // Calculate position size
    const positionSize = accountEquity * kellyFraction;

    // Apply limits
    return Math.max(
      this.config.limits.minOrderSize,
      Math.min(positionSize, this.config.limits.maxOrderSize)
    );
  }

  // Record order result for tracking
  public recordOrderResult(orderId: string, success: boolean, latency: number): void {
    this.orderHistory.push({
      timestamp: new Date(),
      success
    });

    // Keep only last 1000 orders
    if (this.orderHistory.length > 1000) {
      this.orderHistory.shift();
    }

    // Track latency
    this.latencyHistory.push(latency);
    if (this.latencyHistory.length > 100) {
      this.latencyHistory.shift();
    }
  }

  // Update open order count
  public updateOpenOrderCount(count: number): void {
    this.metrics.openOrderCount = count;
  }

  /**
   * Persist the risk_metrics snapshot. One row per `(user_id,
   * execution_mode)` so a paper session and a live session never overwrite
   * each other's kill switch / streak counters (TASK_014 P5). Pre-migration
   * the legacy `(user_id)` key is used unchanged.
   */
  private async persistMetrics(): Promise<void> {
    if (!this.userId) {
      this.logger.debug('Skipping risk_metrics persist: userId not provided');
      return;
    }
    const row = {
      user_id: this.userId,
      daily_pnl: this.metrics.dailyPnL,
      max_drawdown: this.metrics.maxDrawdown,
      consecutive_losses: this.metrics.consecutiveLosses,
      error_rate: this.metrics.errorRate,
      kill_switch_active: this.metrics.killSwitchActive,
      exposure_usd: this.metrics.currentExposure,
      updated_at: this.metrics.lastUpdated.toISOString(),
    };
    try {
      const { error } = await this.modeScope.query(
        'risk_metrics',
        'upsert',
        () => this.supabase
          .from('risk_metrics')
          .upsert(
            { ...row, execution_mode: this.modeScope.mode },
            { onConflict: 'user_id,execution_mode' },
          ),
        () => this.supabase
          .from('risk_metrics')
          .upsert(row, { onConflict: 'user_id' }),
      );

      if (error) {
        // Table doesn't exist is less severe, but still track it
        if (error.code === 'PGRST205' || error.code === '42P01') {
          this.logger.debug('risk_metrics table not available');
        } else {
          riskMetricsWriteFailures.inc();
          this.logger.error('Failed to persist risk metrics:', {
            code: error.code,
            message: error.message,
            details: error.details,
          });
        }
      }
    } catch (error) {
      riskMetricsWriteFailures.inc();
      this.logger.error('Error persisting risk metrics:', error);
    }
  }

  /**
   * Eagerly persist the current (cleared) risk state instead of waiting for
   * the next 5s metrics tick, then mark any still-active `risk_events` rows
   * for this user as cleared.
   *
   * Every reset path in this class used to be memory-only. The engine would
   * happily trade while `risk_metrics.kill_switch_active` and
   * `risk_events.active` still said "halted" — and if the engine stopped
   * before the next tick (or was never started, e.g. a paper reset followed
   * by a crash) the phantom halt survived indefinitely. UI and Grafana read
   * those tables directly, so they showed a kill switch the runtime was not
   * honouring. Persistence failures are logged, counted, and swallowed: a DB
   * hiccup must never turn a successful in-memory resume into an exception
   * at an API boundary.
   */
  private async persistClearedRiskState(source: RiskStateResetSource): Promise<void> {
    if (!this.userId) {
      this.logger.debug('Skipping eager risk state persist: userId not provided', { source });
      return;
    }
    this.metrics.lastUpdated = new Date();
    this.logger.info('Eagerly persisting cleared risk state', {
      source,
      killSwitchActive: this.metrics.killSwitchActive,
      consecutiveLosses: this.metrics.consecutiveLosses,
      dailyPnL: this.metrics.dailyPnL,
      maxDrawdown: this.metrics.maxDrawdown,
    });
    await this.persistMetrics();
    await this.clearStaleRiskEvents(source);
  }

  /**
   * Flip every still-active `risk_events` row for this user to
   * `active=false` and stamp `cleared_at`. The state machine's own
   * `persistRiskEventCleared` only ever set `cleared_at`, and the API's
   * manual kill-switch insert never gets cleared at all, so `active=true`
   * rows accumulated forever — which is exactly what
   * `useActiveRiskEvents` and the Grafana "active halts" panel query.
   *
   * Scoped to this session's `execution_mode` (TASK_014 P5): a paper
   * `PAPER_RESET_RISK_STATE_ON_START` boot must never flip a live halt to
   * `active=false`, and a live resume must not touch paper's audit trail.
   * Pre-migration the update is unscoped, as before.
   *
   * Schema-tolerant: if the deployed `risk_events` has no `active` column
   * (older snapshots), falls back to stamping `cleared_at` on rows where it
   * is still NULL.
   */
  private async clearStaleRiskEvents(source: RiskStateResetSource): Promise<void> {
    if (!this.userId) {
      return;
    }
    const userId = this.userId;
    const clearedAt = new Date().toISOString();

    const clearActive = (scoped: boolean) => {
      let query = this.supabase
        .from('risk_events')
        .update({ active: false, cleared_at: clearedAt })
        .eq('user_id', userId)
        .eq('active', true);
      if (scoped) {
        query = query.eq('execution_mode', this.modeScope.mode);
      }
      return query;
    };
    const clearByClearedAt = (scoped: boolean) => {
      let query = this.supabase
        .from('risk_events')
        .update({ cleared_at: clearedAt })
        .eq('user_id', userId)
        .is('cleared_at', null);
      if (scoped) {
        query = query.eq('execution_mode', this.modeScope.mode);
      }
      return query;
    };

    try {
      const { error } = await this.modeScope.query(
        'risk_events',
        'update',
        () => clearActive(true),
        () => clearActive(false),
      );

      if (!error) {
        this.logger.info('Cleared stale active risk_events', { source, mode: this.modeScope.mode });
        return;
      }

      if (isMissingTableError(error)) {
        this.logger.debug('risk_events table not available');
        return;
      }

      if (isMissingColumnError(error)) {
        this.logger.warn('risk_events.active column missing; clearing by cleared_at only', {
          code: error.code,
          message: error.message,
        });
        const { error: fallbackError } = await this.modeScope.query(
          'risk_events',
          'update',
          () => clearByClearedAt(true),
          () => clearByClearedAt(false),
        );
        if (fallbackError) {
          this.logger.error('Failed to clear stale risk_events (cleared_at fallback):', {
            code: fallbackError.code,
            message: fallbackError.message,
            source,
          });
        }
        return;
      }

      this.logger.error('Failed to clear stale risk_events:', {
        code: error.code,
        message: error.message,
        details: error.details,
        source,
      });
    } catch (error) {
      this.logger.error('Error clearing stale risk_events:', error);
    }
  }

  /**
   * Zero the streak-style counters that drive kill-switch checks. Called on
   * an operator-confirmed resume: without it `checkKillSwitches()` would see
   * the same `consecutiveLosses >= limit` (or error-rate / latency window)
   * on the very next 5s tick and silently re-halt, making the resume a
   * no-op. Daily P&L and drawdown are deliberately left alone — they are
   * recomputed from equity every tick, and overriding a daily stop is a
   * separate decision that belongs to the day-rollover path.
   */
  private clearHaltCounters(): void {
    this.metrics.consecutiveLosses = 0;
    this.metrics.errorRate = 0;
    this.metrics.averageLatency = 0;
    this.orderHistory = [];
    this.latencyHistory = [];
  }

  // Get current risk metrics
  public getMetrics(): RiskMetrics {
    return { ...this.metrics };
  }
  
  /**
   * Get risk state for API (Step 5)
   */
  public getRiskState(): TradingState {
    return this.riskStateMachine.getState();
  }
  
  /**
   * Get comprehensive risk status for API (Step 5)
   */
  public getRiskStatus(): {
    tradingState: 'RUNNING' | 'PAUSED' | 'HALTED';
    reasonCode?: RiskHaltReasonCode;
    reasonText?: string;
    since?: number;
    daily?: boolean;
    dayStartEquityUsd: number;
    riskUnitUsd: number;
    perTradeRiskPct: number;
    dailyPnlUsd: number;
    dailyPnlR: number;
    realizedPnlUsd: number;
    unrealizedPnlUsd: number;
    drawdownPct: number;
    thresholds: {
      dailyStopR: number;
      maxHeat: number;
      perTradeRisk: number;
    };
  } {
    const stateStatus = this.riskStateMachine.getStatus();
    const mathStatus = this.riskMath.getStatus();
    
    return {
      ...stateStatus,
      ...mathStatus,
      thresholds: {
        dailyStopR: this.dailyStopThresholdR,
        maxHeat: this.config.limits.maxTotalExposure / this.accountEquity,
        perTradeRisk: mathStatus.perTradeRiskPct / 100,
      },
    };
  }
  
  /**
   * Get risk math snapshot (Step 5)
   */
  public getRiskSnapshot(): RiskSnapshot | null {
    return this.riskMath.getSnapshot();
  }
  
  /**
   * Check if entries are allowed (Step 5)
   */
  public canEnterTrades(): boolean {
    return this.riskStateMachine.canEnterTrades() && !this.killSwitchActive;
  }
  
  /**
   * Check if exits are allowed (always true) (Step 5)
   */
  public canExitTrades(): boolean {
    return this.riskStateMachine.canExitTrades();
  }

  // Reset daily metrics (call at start of trading day)
  public async resetDailyMetrics(): Promise<void> {
    const currentEquity = await this.calculateCurrentEquity();
    this.dailyStartEquity = currentEquity;
    this.dailyHighEquity = currentEquity;
    await this.saveDailyStartEquity(currentEquity);
    this.resetSymbolDailyTracking();

    this.metrics.dailyPnL = 0;
    this.metrics.dailyLossPercentage = 0;
    this.metrics.consecutiveLosses = 0;
    this.metrics.maxDrawdown = 0;

    this.logger.info('Daily risk metrics reset');
  }

  // Manual kill switch control
  public activateKillSwitch(reason: string): void {
    this.triggerKillSwitch(`Manual activation: ${reason}`);
  }

  /**
   * Operator-confirmed resume (`POST /api/killswitch/deactivate` with the
   * `RESUME TRADING` phrase, or `POST /api/risk/killswitch {active:false}`).
   *
   * On success this (1) clears the in-memory halt flags and streak counters,
   * (2) eagerly upserts the cleared `risk_metrics` row, and (3) marks stale
   * `risk_events` as cleared — all before resolving, so the HTTP response
   * only reports "deactivated" once the DB agrees. Previously the DB kept
   * `kill_switch_active=true` until the next 5s metrics tick, and because
   * `consecutiveLosses` was never reset the next tick re-tripped the switch
   * anyway when the halt reason was a losing streak.
   *
   * Persistence errors are logged and swallowed; the return value reflects
   * only whether the in-memory resume succeeded.
   *
   * @param force Required (`true`) to resume from a non-daily HALTED state.
   * @returns `true` if trading is RUNNING after the call.
   */
  public async deactivateKillSwitch(force: boolean = true): Promise<boolean> {
    const resumed = this.riskStateMachine.resume(force);
    if (!resumed) {
      this.logger.warn('Failed to deactivate kill switch (requires force=true for non-daily halts)');
      return false;
    }

    const wasActive = this.killSwitchActive || this.metrics.killSwitchActive;
    this.killSwitchActive = false;
    this.metrics.killSwitchActive = false;
    this.clearHaltCounters();
    this.logger.info('Kill switch deactivated', { wasActive });

    await this.persistClearedRiskState('manual_resume');
    return true;
  }

  // Cleanup
  public stop(): void {
    if (this.metricsUpdateInterval) {
      clearInterval(this.metricsUpdateInterval);
      this.metricsUpdateInterval = null;
    }
  }
}
