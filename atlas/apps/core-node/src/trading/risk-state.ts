/**
 * Risk State Machine
 * 
 * Defines explicit trading states and transitions for 24/7 reliability.
 * The key abstraction that separates "trading halted" from "runtime dead".
 * 
 * Design principles:
 * 1. HALTED blocks entries but allows reduce-only exits
 * 2. Runtime stays alive when trading is halted
 * 3. Daily halt reasons can auto-clear on rollover
 * 4. Non-daily halts require manual reset
 * 5. All state changes are logged and persisted
 */

import { EventEmitter } from 'events';
import { Counter, Gauge } from 'prom-client';
import { Logger } from '../core/logger';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import type { ExecutionMode } from './risk/types';
import { ExecutionModeScope, normalizeExecutionMode } from './risk/execution-mode-scope';

/**
 * Halt reason codes (exhaustive list)
 */
export type RiskHaltReasonCode =
  | 'daily_stop'          // Daily P&L limit hit
  | 'max_drawdown'        // Max drawdown limit hit
  | 'weekly_stop'         // Weekly P&L limit hit
  | 'consecutive_losses'  // Too many losses in a row
  | 'error_rate'          // Too many order errors
  | 'latency'             // Latency too high
  | 'data_gap'            // Market data stale
  | 'rapid_loss'          // Lost too much too fast
  | 'manual_killswitch'   // User-triggered halt
  | 'symbol_blocked'      // Per-symbol limit hit
  | 'unknown';            // Catch-all

/**
 * Trading state (discriminated union)
 */
export type TradingState =
  | { state: 'RUNNING' }
  | { state: 'PAUSED'; reason: string }
  | { 
      state: 'HALTED'; 
      reasonCode: RiskHaltReasonCode; 
      reasonText: string; 
      since: number; 
      /** True if this halt can auto-clear on day rollover */
      daily: boolean;
      /** Additional context (e.g., computed values) */
      context?: HaltContext;
    };

/**
 * Additional context for halts (for observability)
 */
export interface HaltContext {
  dailyPnlUsd?: number;
  dailyPnlR?: number;
  thresholdR?: number;
  thresholdUsd?: number;
  consecutiveLosses?: number;
  errorRate?: number;
  latencyMs?: number;
  drawdownPct?: number;
}

/**
 * Prometheus metrics
 */
const riskHaltCounter = new Counter({
  name: 'atlas_risk_halt_total',
  help: 'Total number of trading halts by reason',
  labelNames: ['reason_code'],
});

const riskResetCounter = new Counter({
  name: 'atlas_risk_reset_total',
  help: 'Total number of trading resets by reason',
  labelNames: ['reason_code'],
});

const dailyRolloverCounter = new Counter({
  name: 'atlas_daily_rollover_total',
  help: 'Total number of daily rollovers',
});

const riskStateGauge = new Gauge({
  name: 'atlas_risk_state',
  help: 'Current risk state (0=running, 1=paused, 2=halted)',
});

/**
 * Risk state machine configuration
 */
export interface RiskStateConfig {
  logger: Logger;
  supabaseUrl?: string;
  supabaseKey?: string;
  userId?: string;
  /**
   * Execution mode stamped on every `risk_events` row this machine writes
   * and used to scope every read/clear (TASK_014 P5). Defaults to `paper`
   * so pre-existing callers keep today's behaviour.
   */
  executionMode?: ExecutionMode;
  /** Timezone for risk day (default: 'UTC') */
  riskDayTz?: string;
  /** Hour at which risk day rolls over (default: 0) */
  riskDayRolloverHour?: number;
}

/**
 * Risk state change event
 */
export interface RiskStateChangeEvent {
  previousState: TradingState;
  newState: TradingState;
  timestamp: number;
}

/**
 * Risk State Machine
 * 
 * Owns "can we enter trades" and "why not".
 */
export class RiskStateMachine extends EventEmitter {
  private logger: Logger;
  private supabase: SupabaseClient | null;
  private userId?: string;
  private riskDayTz: string;
  private riskDayRolloverHour: number;
  private readonly modeScope: ExecutionModeScope;

  private currentState: TradingState = { state: 'RUNNING' };
  private lastStateChange: number = Date.now();
  private currentRiskDay: string = '';

  constructor(config: RiskStateConfig) {
    super();
    this.logger = config.logger;
    this.userId = config.userId;
    this.riskDayTz = config.riskDayTz || 'UTC';
    this.riskDayRolloverHour = config.riskDayRolloverHour ?? 0;
    this.modeScope = new ExecutionModeScope(normalizeExecutionMode(config.executionMode), config.logger);

    if (config.supabaseUrl && config.supabaseKey) {
      this.supabase = createClient(config.supabaseUrl, config.supabaseKey);
    } else {
      this.supabase = null;
    }

    this.currentRiskDay = this.getRiskDay();
    riskStateGauge.set(0);
  }

  // ============ State Accessors ============

  /**
   * Get current trading state
   */
  public getState(): TradingState {
    return this.currentState;
  }

  /**
   * Check if trading is running (entries allowed)
   */
  public isRunning(): boolean {
    return this.currentState.state === 'RUNNING';
  }

  /**
   * Check if trading is halted (entries blocked)
   */
  public isHalted(): boolean {
    return this.currentState.state === 'HALTED';
  }

  /**
   * Check if trading is paused
   */
  public isPaused(): boolean {
    return this.currentState.state === 'PAUSED';
  }

  /**
   * Check if entries are allowed
   */
  public canEnterTrades(): boolean {
    return this.currentState.state === 'RUNNING';
  }

  /**
   * Check if exits are allowed (always true - reduce-only always works)
   */
  public canExitTrades(): boolean {
    return true; // Exits always allowed
  }

  /**
   * Get halt reason code if halted
   */
  public getHaltReasonCode(): RiskHaltReasonCode | null {
    if (this.currentState.state === 'HALTED') {
      return this.currentState.reasonCode;
    }
    return null;
  }

  /**
   * Get halt context if halted
   */
  public getHaltContext(): HaltContext | null {
    if (this.currentState.state === 'HALTED') {
      return this.currentState.context || null;
    }
    return null;
  }

  // ============ State Transitions ============

  /**
   * Halt trading with a reason
   */
  public halt(
    reasonCode: RiskHaltReasonCode,
    reasonText: string,
    daily: boolean,
    context?: HaltContext
  ): void {
    if (this.currentState.state === 'HALTED') {
      // Already halted - log but don't re-emit
      this.logger.debug('Already halted, ignoring duplicate halt', {
        existingReason: (this.currentState as any).reasonCode,
        newReason: reasonCode,
      });
      return;
    }

    const previousState = this.currentState;
    const now = Date.now();

    this.currentState = {
      state: 'HALTED',
      reasonCode,
      reasonText,
      since: now,
      daily,
      context,
    };
    this.lastStateChange = now;

    // Update metrics
    riskHaltCounter.labels({ reason_code: reasonCode }).inc();
    riskStateGauge.set(2);

    // Log
    this.logger.warn('RISK_HALTED', {
      reasonCode,
      reasonText,
      daily,
      ...context,
    });

    // Persist
    this.persistRiskEvent('halt', reasonCode, context).catch(e => {
      this.logger.error('Failed to persist halt event', { error: e.message });
    });

    // Emit
    this.emit('risk:state_changed', { previousState, newState: this.currentState, timestamp: now });
    this.emit('risk:killswitch:triggered', { reasonCode, reasonText, daily, context });
  }

  /**
   * Pause trading temporarily (e.g., during maintenance)
   */
  public pause(reason: string): void {
    if (this.currentState.state === 'HALTED') {
      // Halt takes precedence over pause
      return;
    }

    const previousState = this.currentState;
    const now = Date.now();

    this.currentState = { state: 'PAUSED', reason };
    this.lastStateChange = now;

    riskStateGauge.set(1);

    this.logger.info('Trading paused', { reason });
    this.emit('risk:state_changed', { previousState, newState: this.currentState, timestamp: now });
  }

  /**
   * Resume trading (clear pause or halt)
   */
  public resume(force: boolean = false): boolean {
    if (this.currentState.state === 'RUNNING') {
      return true;
    }

    if (this.currentState.state === 'HALTED' && !force) {
      // Can't resume from halt without force
      this.logger.warn('Cannot resume from HALTED without force=true');
      return false;
    }

    const previousState = this.currentState;
    const now = Date.now();

    const reasonCode = (previousState as any).reasonCode;

    this.currentState = { state: 'RUNNING' };
    this.lastStateChange = now;

    // Update metrics
    if (reasonCode) {
      riskResetCounter.labels({ reason_code: reasonCode }).inc();
    }
    riskStateGauge.set(0);

    // Log
    this.logger.info('Trading resumed', {
      previousState: previousState.state,
      reasonCode,
    });

    // Update cleared_at in persistence
    this.persistRiskEventCleared(reasonCode).catch(e => {
      this.logger.error('Failed to persist reset event', { error: e.message });
    });

    // Emit
    this.emit('risk:state_changed', { previousState, newState: this.currentState, timestamp: now });
    this.emit('risk:killswitch:deactivated', { reasonCode });

    return true;
  }

  // ============ Day Rollover ============

  /**
   * Check if we need to roll over to a new risk day.
   * Called periodically (e.g., every minute or on each tick).
   */
  public checkDayRollover(): boolean {
    const newRiskDay = this.getRiskDay();

    if (newRiskDay !== this.currentRiskDay) {
      this.performDayRollover(newRiskDay);
      return true;
    }

    return false;
  }

  /**
   * Perform day rollover
   */
  private performDayRollover(newRiskDay: string): void {
    const previousDay = this.currentRiskDay;
    this.currentRiskDay = newRiskDay;

    dailyRolloverCounter.inc();

    this.logger.info('Risk day rollover', {
      previousDay,
      newDay: newRiskDay,
      currentState: this.currentState.state,
    });

    // Clear daily halts
    if (this.currentState.state === 'HALTED' && this.currentState.daily) {
      this.logger.info('Clearing daily halt on rollover', {
        reasonCode: this.currentState.reasonCode,
      });
      this.resume(true);
    }

    // Emit rollover event for other modules
    this.emit('risk:day_rollover', { previousDay, newDay: newRiskDay });
  }

  /**
   * Get current risk day string (YYYY-MM-DD)
   */
  public getRiskDay(): string {
    const now = new Date();
    
    // Adjust for rollover hour
    const adjusted = new Date(now);
    adjusted.setUTCHours(adjusted.getUTCHours() - this.riskDayRolloverHour);
    
    return adjusted.toISOString().split('T')[0];
  }

  // ============ Persistence ============

  /**
   * Execution mode this machine stamps on / scopes `risk_events` by.
   */
  public getExecutionMode(): ExecutionMode {
    return this.modeScope.mode;
  }

  /**
   * Persist a risk event to the database, stamped with the session's
   * `execution_mode` so a paper reset never clears a live halt (and vice
   * versa). Falls back to the legacy (unstamped) shape until the
   * `execution_mode` migration has been applied.
   */
  private async persistRiskEvent(
    eventType: 'halt' | 'resume',
    reasonCode: RiskHaltReasonCode,
    context?: HaltContext
  ): Promise<void> {
    if (!this.supabase || !this.userId) return;
    const supabase = this.supabase;

    const row = {
      user_id: this.userId,
      event_type: reasonCode,
      details: {
        eventType,
        reasonCode,
        ...context,
      },
      triggered_at: new Date().toISOString(),
    };

    try {
      const { error } = await this.modeScope.query(
        'risk_events',
        'insert',
        () => supabase.from('risk_events').insert({ ...row, execution_mode: this.modeScope.mode }),
        () => supabase.from('risk_events').insert(row),
      );
      if (error) {
        this.logger.warn('Failed to persist risk event', { code: error.code, message: error.message });
      }
    } catch (error) {
      // Log but don't throw - persistence failure shouldn't break trading
      this.logger.warn('Failed to persist risk event', { error });
    }
  }

  /**
   * Update cleared_at when a halt is cleared (scoped to this session's
   * execution mode; legacy unscoped fallback pre-migration).
   */
  private async persistRiskEventCleared(reasonCode?: string): Promise<void> {
    if (!this.supabase || !this.userId || !reasonCode) return;
    const supabase = this.supabase;
    const userId = this.userId;
    const clearedAt = new Date().toISOString();

    const clear = (scoped: boolean) => {
      let query = supabase
        .from('risk_events')
        .update({ cleared_at: clearedAt })
        .eq('user_id', userId)
        .eq('event_type', reasonCode)
        .is('cleared_at', null);
      if (scoped) {
        query = query.eq('execution_mode', this.modeScope.mode);
      }
      return query;
    };

    try {
      const { error } = await this.modeScope.query('risk_events', 'update', () => clear(true), () => clear(false));
      if (error) {
        this.logger.warn('Failed to update risk event cleared_at', { code: error.code, message: error.message });
      }
    } catch (error) {
      this.logger.warn('Failed to update risk event cleared_at', { error });
    }
  }

  /**
   * Load persisted risk state on startup. Only rows stamped with this
   * session's `execution_mode` are considered (a paper halt must never be
   * restored into a live session); pre-migration the read is unscoped, as
   * before.
   */
  public async loadPersistedState(): Promise<void> {
    if (!this.supabase || !this.userId) return;
    const supabase = this.supabase;
    const userId = this.userId;

    try {
      // Check for unclearedhalt events from today
      const todayStr = this.getRiskDay();

      const load = (scoped: boolean) => {
        let query = supabase
          .from('risk_events')
          .select('*')
          .eq('user_id', userId)
          .is('cleared_at', null)
          .gte('triggered_at', `${todayStr}T00:00:00Z`);
        if (scoped) {
          query = query.eq('execution_mode', this.modeScope.mode);
        }
        return query.order('triggered_at', { ascending: false }).limit(1);
      };

      const { data, error } = await this.modeScope.query('risk_events', 'select', () => load(true), () => load(false));

      if (error && error.code !== 'PGRST116') {
        this.logger.warn('Failed to load persisted risk state', { error });
        return;
      }

      if (data && data.length > 0) {
        const event = data[0];
        const details = event.details || {};
        const reasonCode = (event.event_type as RiskHaltReasonCode) || 'unknown';
        
        // Restore halt state
        this.currentState = {
          state: 'HALTED',
          reasonCode,
          reasonText: details.reasonText || `Restored: ${reasonCode}`,
          since: new Date(event.triggered_at).getTime(),
          daily: details.daily ?? true,
          context: details,
        };
        this.lastStateChange = new Date(event.triggered_at).getTime();
        riskStateGauge.set(2);

        this.logger.warn('Restored halted state from database', {
          reasonCode,
          since: event.triggered_at,
        });
      }
    } catch (error) {
      this.logger.error('Error loading persisted risk state', { error });
    }
  }

  // ============ Status for API ============

  /**
   * Get status for API response
   */
  public getStatus(): {
    tradingState: 'RUNNING' | 'PAUSED' | 'HALTED';
    reasonCode?: RiskHaltReasonCode;
    reasonText?: string;
    since?: number;
    daily?: boolean;
    context?: HaltContext;
    riskDay: string;
  } {
    const state = this.currentState;

    if (state.state === 'RUNNING') {
      return {
        tradingState: 'RUNNING',
        riskDay: this.currentRiskDay,
      };
    }

    if (state.state === 'PAUSED') {
      return {
        tradingState: 'PAUSED',
        reasonText: state.reason,
        riskDay: this.currentRiskDay,
      };
    }

    // HALTED
    return {
      tradingState: 'HALTED',
      reasonCode: state.reasonCode,
      reasonText: state.reasonText,
      since: state.since,
      daily: state.daily,
      context: state.context,
      riskDay: this.currentRiskDay,
    };
  }
}

/**
 * Determine if a halt reason is daily (can auto-clear)
 */
export function isDailyHaltReason(reasonCode: RiskHaltReasonCode): boolean {
  const dailyReasons: RiskHaltReasonCode[] = [
    'daily_stop',
    'rapid_loss',
    'symbol_blocked',
  ];
  return dailyReasons.includes(reasonCode);
}

/**
 * Helper to create halt from daily stop trigger
 */
export function createDailyStopHalt(
  dailyPnlUsd: number,
  dailyPnlR: number,
  thresholdR: number
): { reasonCode: RiskHaltReasonCode; reasonText: string; daily: boolean; context: HaltContext } {
  return {
    reasonCode: 'daily_stop',
    reasonText: `Daily P&L limit hit: ${dailyPnlR.toFixed(2)}R (threshold: ${thresholdR}R)`,
    daily: true,
    context: {
      dailyPnlUsd,
      dailyPnlR,
      thresholdR,
      thresholdUsd: dailyPnlUsd, // Will be computed properly
    },
  };
}

/**
 * Helper to create halt from consecutive losses
 */
export function createConsecutiveLossesHalt(
  count: number,
  limit: number
): { reasonCode: RiskHaltReasonCode; reasonText: string; daily: boolean; context: HaltContext } {
  return {
    reasonCode: 'consecutive_losses',
    reasonText: `Consecutive losses limit hit: ${count} >= ${limit}`,
    daily: false,
    context: {
      consecutiveLosses: count,
    },
  };
}

/**
 * Helper to create halt from max drawdown
 */
export function createMaxDrawdownHalt(
  drawdownPct: number,
  limitPct: number,
  drawdownUsd: number
): { reasonCode: RiskHaltReasonCode; reasonText: string; daily: boolean; context: HaltContext } {
  return {
    reasonCode: 'max_drawdown',
    reasonText: `Max drawdown limit hit: ${(drawdownPct * 100).toFixed(2)}% (limit: ${(limitPct * 100).toFixed(2)}%)`,
    daily: false,
    context: {
      drawdownPct,
      dailyPnlUsd: -drawdownUsd,
    },
  };
}
