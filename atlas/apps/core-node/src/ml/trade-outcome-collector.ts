/**
 * Trade Outcome Collector
 * 
 * Collects complete trade context and outcomes for ML Meta-Label training.
 * 
 * Flow:
 * 1. When a signal is generated, store its full context (indicators, regime, etc.)
 * 2. When a position is closed, match it to the original signal and record the outcome
 * 3. Write the complete record to Supabase trade_outcomes table
 */

import { EventEmitter } from 'events';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { Counter } from 'prom-client';
import { Logger } from '../core/logger';
import { Position } from '../trading/position-tracker';
import { RegimeState } from '../strategies/regime-detector';

const tradeOutcomesRecordedCounter = new Counter({
  name: 'atlas_trade_outcomes_recorded_total',
  help: 'Total trade_outcomes rows successfully written',
  labelNames: ['strategy', 'outcome'],
});

const tradeOutcomesDroppedCounter = new Counter({
  name: 'atlas_trade_outcomes_dropped_total',
  help: 'Closed positions whose outcome was not persisted, with reason',
  labelNames: ['reason'],
});

const signalContextsCapturedCounter = new Counter({
  name: 'atlas_signal_contexts_captured_total',
  help: 'Signal contexts captured at signal:generated time',
  labelNames: ['strategy'],
});

const signalContextsExpiredCounter = new Counter({
  name: 'atlas_signal_contexts_expired_total',
  help: 'Signal contexts that aged past contextTtlMs without a close',
});

/**
 * Signal context captured at entry time.
 */
export interface SignalContext {
  signalId: string;
  symbol: string;
  strategy: string;
  direction: 'buy' | 'sell';
  strength: number;
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  timestamp: Date;
  
  // Regime context
  regime: string;
  regimeConfidence?: number;
  trendDirection?: string;
  adx?: number;
  atrPercent?: number;
  bbWidth?: number;
  choppiness?: number;
  mtfAlignment?: number;
  
  // Indicators snapshot
  indicators: Record<string, number>;
  
  // Volume context
  volumeRatio?: number;
  
  // Meta filter context
  metaFilterScore?: number;
  coldStreakActive?: boolean;
  positionMultiplier?: number;
  
  // Full metadata
  metadata: Record<string, unknown>;
}

/**
 * Trade outcome record to be stored.
 */
export interface TradeOutcomeRecord {
  signal_id: string;
  session_id?: string;
  symbol: string;
  entry_time: string;
  exit_time?: string;
  hold_duration_seconds?: number;
  strategy: string;
  signal_direction: string;
  signal_strength: number;
  entry_price: number;
  regime: string;
  regime_confidence?: number;
  trend_direction?: string;
  adx?: number;
  atr_percent?: number;
  bb_width?: number;
  choppiness?: number;
  mtf_alignment?: number;
  indicators_snapshot: Record<string, number>;
  volume_ratio?: number;
  meta_filter_score?: number;
  cold_streak_active?: boolean;
  position_multiplier?: number;
  position_size?: number;
  exit_price?: number;
  exit_reason?: string;
  realized_pnl?: number;
  pnl_percent?: number;
  max_favorable_excursion?: number;
  max_adverse_excursion?: number;
  outcome_label?: string;
  outcome_score?: number;
  r_multiple?: number;
  initial_risk?: number;
  slippage_bps?: number;
  fees?: number;
  signal_metadata: Record<string, unknown>;
}

export interface TradeOutcomeCollectorConfig {
  supabaseUrl: string;
  supabaseKey: string;
  sessionId?: string;
  enabled: boolean;
  // Minimum PnL to count as profitable (to handle fees)
  profitThreshold: number;
  // Maximum time to hold signal context before expiring (ms)
  contextTtlMs: number;
}

const DEFAULT_CONFIG: TradeOutcomeCollectorConfig = {
  supabaseUrl: '',
  supabaseKey: '',
  enabled: true,
  profitThreshold: 0,  // Any positive PnL is profitable
  contextTtlMs: 24 * 60 * 60 * 1000,  // 24 hours
};

export class TradeOutcomeCollector extends EventEmitter {
  private config: TradeOutcomeCollectorConfig;
  private logger: Logger;
  private supabase: SupabaseClient | null = null;
  
  // Store pending signal contexts keyed by signalId (to avoid symbol collisions).
  private pendingSignals: Map<string, SignalContext> = new Map();
  // Index pending signalIds by symbol for lookup/debugging.
  private pendingSignalIdsBySymbol: Map<string, Set<string>> = new Map();
  
  // Statistics
  private stats = {
    signalsCaptured: 0,
    outcomesRecorded: 0,
    outcomesSuccessful: 0,
    outcomesFailed: 0,
    signalsExpired: 0,
  };

  constructor(config: Partial<TradeOutcomeCollectorConfig>, logger: Logger) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.logger = logger;
    
    if (this.config.enabled && this.config.supabaseUrl && this.config.supabaseKey) {
      this.supabase = createClient(this.config.supabaseUrl, this.config.supabaseKey);
      this.logger.info('[TradeOutcomeCollector] Initialized and connected to Supabase');
    } else if (this.config.enabled) {
      this.logger.warn('[TradeOutcomeCollector] Enabled but missing Supabase credentials - outcomes will not be persisted');
    } else {
      this.logger.info('[TradeOutcomeCollector] Disabled - trade outcomes will not be collected');
    }
    
    // Start cleanup interval for expired contexts
    setInterval(() => this.cleanupExpiredContexts(), 60 * 60 * 1000); // Every hour
  }

  /**
   * Capture signal context when a signal is generated.
   * Call this from the signal:generated event handler.
   */
  public captureSignalContext(
    signal: {
      id: string;
      symbol: string;
      strategy: string;
      direction: 'buy' | 'sell';
      strength: number;
      price: number;
      stopLoss: number;
      takeProfit: number;
      timestamp: Date;
      metadata: Record<string, unknown>;
    },
    regimeState: RegimeState,
    indicators: Record<string, number>,
    extras?: {
      volumeRatio?: number;
      metaFilterScore?: number;
      coldStreakActive?: boolean;
      positionMultiplier?: number;
    }
  ): void {
    if (!this.config.enabled) return;

    const context: SignalContext = {
      signalId: signal.id,
      symbol: signal.symbol,
      strategy: signal.strategy,
      direction: signal.direction,
      strength: signal.strength,
      entryPrice: signal.price,
      stopLoss: signal.stopLoss,
      takeProfit: signal.takeProfit,
      timestamp: signal.timestamp,
      
      // Regime
      regime: regimeState.regime,
      regimeConfidence: regimeState.confidence,
      trendDirection: regimeState.trendDirection,
      adx: regimeState.adx,
      atrPercent: regimeState.atrPercent,
      bbWidth: regimeState.bbWidth,
      choppiness: regimeState.choppiness,
      mtfAlignment: regimeState.mtfAlignment,
      
      // Indicators
      indicators,
      
      // Extras
      volumeRatio: extras?.volumeRatio,
      metaFilterScore: extras?.metaFilterScore,
      coldStreakActive: extras?.coldStreakActive,
      positionMultiplier: extras?.positionMultiplier,
      
      // Full metadata
      metadata: signal.metadata,
    };

    // Store by signalId to avoid overwriting contexts for the same symbol.
    this.pendingSignals.set(signal.id, context);
    const symbolSet = this.pendingSignalIdsBySymbol.get(signal.symbol) ?? new Set<string>();
    symbolSet.add(signal.id);
    this.pendingSignalIdsBySymbol.set(signal.symbol, symbolSet);
    this.stats.signalsCaptured++;
    signalContextsCapturedCounter.inc({ strategy: signal.strategy });

    this.logger.debug('[TradeOutcomeCollector] Signal context captured', {
      signalId: signal.id,
      symbol: signal.symbol,
      strategy: signal.strategy,
      regime: regimeState.regime,
    });
  }

  /**
   * Record trade outcome when a position is closed.
   * Call this from the position:closed event handler.
   */
  public async recordOutcome(position: Position, exitReason?: string): Promise<void> {
    if (!this.config.enabled) return;

    const context = this.getContextForPosition(position);

    if (!context) {
      // Log warn (not debug) so empty trade_outcomes is observable in default
      // log levels. The diagnostic fields tell us exactly which path failed
      // when investigating: signalId-set-but-not-in-map vs symbol-fallback-empty.
      const pendingForSymbol = this.pendingSignalIdsBySymbol.get(position.symbol);
      this.logger.warn('[TradeOutcomeCollector] No signal context found for closed position', {
        symbol: position.symbol,
        positionId: position.id,
        positionSignalId: position.signalId,
        pendingForSymbolCount: pendingForSymbol?.size ?? 0,
        pendingTotalCount: this.pendingSignals.size,
      });
      const reason = position.signalId ? 'signalid_not_in_pending' : 'no_pending_for_symbol';
      tradeOutcomesDroppedCounter.inc({ reason });
      return;
    }

    // Calculate outcome metrics
    const holdDuration = position.closedAt 
      ? Math.floor((position.closedAt.getTime() - context.timestamp.getTime()) / 1000)
      : undefined;
    
    const realizedPnl = position.realizedPnL;
    const entryValue = context.entryPrice * (position.maxSize || position.size);
    const pnlPercent = entryValue > 0 ? (realizedPnl / entryValue) * 100 : 0;
    
    // Calculate initial risk (stop distance * size)
    const stopDistance = Math.abs(context.entryPrice - context.stopLoss);
    const initialRisk = stopDistance * (position.maxSize || position.size);
    const rMultiple = initialRisk > 0 ? realizedPnl / initialRisk : 0;
    
    // Determine outcome label
    let outcomeLabel: string;
    if (realizedPnl > this.config.profitThreshold) {
      outcomeLabel = 'profitable';
    } else if (realizedPnl < -this.config.profitThreshold) {
      outcomeLabel = 'unprofitable';
    } else {
      outcomeLabel = 'breakeven';
    }
    
    // Calculate outcome score (clamped to [-1, 1])
    const outcomeScore = Math.max(-1, Math.min(1, pnlPercent / 10));
    
    // Calculate slippage
    const actualEntry = position.averagePrice;
    const expectedEntry = context.entryPrice;
    const slippageBps = expectedEntry > 0 
      ? ((actualEntry - expectedEntry) / expectedEntry) * 10000 
      : 0;
    
    // Calculate fees
    const fees = position.trades?.reduce((sum, t) => sum + (t.fee || 0), 0) || 0;

    const metadataMfe = position.metadata?.maxFavorableExcursion;
    const maxFavorableExcursion = typeof metadataMfe === 'number' && Number.isFinite(metadataMfe)
      ? metadataMfe
      : undefined;
    const maxAdverseExcursion = Number.isFinite(position.maxDrawdown) ? position.maxDrawdown : undefined;

    // Build record
    const record: TradeOutcomeRecord = {
      signal_id: context.signalId,
      session_id: this.config.sessionId,
      symbol: position.symbol,
      entry_time: context.timestamp.toISOString(),
      exit_time: position.closedAt?.toISOString(),
      hold_duration_seconds: holdDuration,
      strategy: context.strategy,
      signal_direction: context.direction,
      signal_strength: context.strength,
      entry_price: context.entryPrice,
      regime: context.regime,
      regime_confidence: context.regimeConfidence,
      trend_direction: context.trendDirection,
      adx: context.adx,
      atr_percent: context.atrPercent,
      bb_width: context.bbWidth,
      choppiness: context.choppiness,
      mtf_alignment: context.mtfAlignment,
      indicators_snapshot: context.indicators,
      volume_ratio: context.volumeRatio,
      meta_filter_score: context.metaFilterScore,
      cold_streak_active: context.coldStreakActive,
      position_multiplier: context.positionMultiplier,
      position_size: position.maxSize || position.size,
      exit_price: position.exitPrice ?? position.marketPrice,
      exit_reason: exitReason || this.inferExitReason(position, context),
      realized_pnl: realizedPnl,
      pnl_percent: pnlPercent,
      max_favorable_excursion: maxFavorableExcursion,
      max_adverse_excursion: maxAdverseExcursion,
      outcome_label: outcomeLabel,
      outcome_score: outcomeScore,
      r_multiple: rMultiple,
      initial_risk: initialRisk,
      slippage_bps: slippageBps,
      fees: fees,
      signal_metadata: context.metadata,
    };

    // Write to Supabase
    await this.writeOutcome(record);
    
    // Remove pending context
    this.removePendingContext(context.signalId);
    
    this.emit('outcome:recorded', record);
  }

  /**
   * Infer exit reason from position data.
   */
  private inferExitReason(position: Position, context: SignalContext): string {
    const exitPrice = position.exitPrice ?? position.marketPrice;
    
    // Check if hit stop loss
    if (context.direction === 'buy' && exitPrice <= context.stopLoss) {
      return 'stop_loss';
    }
    if (context.direction === 'sell' && exitPrice >= context.stopLoss) {
      return 'stop_loss';
    }
    
    // Check if hit take profit
    if (context.direction === 'buy' && exitPrice >= context.takeProfit) {
      return 'take_profit';
    }
    if (context.direction === 'sell' && exitPrice <= context.takeProfit) {
      return 'take_profit';
    }
    
    const metadataMfe = position.metadata?.maxFavorableExcursion;
    const maxFavorableExcursion = typeof metadataMfe === 'number' && Number.isFinite(metadataMfe)
      ? metadataMfe
      : undefined;

    // Check for trailing stop (if we have MFE data)
    if (maxFavorableExcursion !== undefined && maxFavorableExcursion > 0 && position.realizedPnL < maxFavorableExcursion * 0.5) {
      return 'trailing_stop';
    }
    
    return 'unknown';
  }

  /**
   * Write outcome record to Supabase.
   */
  private async writeOutcome(record: TradeOutcomeRecord): Promise<void> {
    if (!this.supabase) {
      this.logger.debug('[TradeOutcomeCollector] No Supabase client - skipping write', {
        signalId: record.signal_id,
      });
      tradeOutcomesDroppedCounter.inc({ reason: 'no_supabase_client' });
      return;
    }

    this.stats.outcomesRecorded++;

    try {
      const { error } = await this.supabase
        .from('trade_outcomes')
        .insert(record);

      if (error) {
        this.stats.outcomesFailed++;
        tradeOutcomesDroppedCounter.inc({ reason: 'supabase_insert_error' });
        this.logger.error('[TradeOutcomeCollector] Failed to write outcome', {
          signalId: record.signal_id,
          error: error.message,
        });
      } else {
        this.stats.outcomesSuccessful++;
        tradeOutcomesRecordedCounter.inc({
          strategy: record.strategy,
          outcome: record.outcome_label ?? 'unknown',
        });
        this.logger.info('[TradeOutcomeCollector] Outcome recorded', {
          signalId: record.signal_id,
          symbol: record.symbol,
          strategy: record.strategy,
          outcome: record.outcome_label,
          pnlPercent: record.pnl_percent?.toFixed(2),
          rMultiple: record.r_multiple?.toFixed(2),
        });
      }
    } catch (error) {
      this.stats.outcomesFailed++;
      this.logger.error('[TradeOutcomeCollector] Exception writing outcome', {
        signalId: record.signal_id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Clean up expired signal contexts.
   */
  private cleanupExpiredContexts(): void {
    const now = Date.now();
    const expiredSignalIds: string[] = [];

    for (const [signalId, context] of this.pendingSignals) {
      if (now - context.timestamp.getTime() > this.config.contextTtlMs) {
        expiredSignalIds.push(signalId);
      }
    }

    for (const signalId of expiredSignalIds) {
      this.removePendingContext(signalId);
      this.stats.signalsExpired++;
      signalContextsExpiredCounter.inc();
    }

    if (expiredSignalIds.length > 0) {
      this.logger.debug('[TradeOutcomeCollector] Cleaned up expired contexts', {
        count: expiredSignalIds.length,
      });
    }
  }

  /**
   * Get collector statistics.
   */
  public getStats() {
    return {
      ...this.stats,
      pendingSignals: this.pendingSignals.size,
      successRate: this.stats.outcomesRecorded > 0
        ? this.stats.outcomesSuccessful / this.stats.outcomesRecorded
        : 0,
    };
  }

  /**
   * Check if collector is enabled and connected.
   */
  public isEnabled(): boolean {
    return this.config.enabled && this.supabase !== null;
  }

  /**
   * Get pending signal context for a symbol (for debugging).
   */
  public getPendingContext(symbol: string): SignalContext | undefined {
    const ids = this.pendingSignalIdsBySymbol.get(symbol);
    if (!ids || ids.size === 0) {
      return undefined;
    }
    if (ids.size === 1) {
      const [onlyId] = ids;
      return this.pendingSignals.get(onlyId);
    }
    // If multiple pending contexts exist for this symbol, return the most recent one.
    let latest: SignalContext | undefined;
    for (const id of ids) {
      const context = this.pendingSignals.get(id);
      if (!context) continue;
      if (!latest || context.timestamp > latest.timestamp) {
        latest = context;
      }
    }
    return latest;
  }

  private getContextForPosition(position: Position): SignalContext | undefined {
    if (position.signalId) {
      const direct = this.pendingSignals.get(position.signalId);
      if (direct) return direct;
      // SignalId on the position but the context was already consumed (or
      // expired) — fall through to the symbol-scoped match so we still log
      // an outcome record. This is rare but happens if recordOutcome is
      // invoked twice for the same position (e.g. duplicate fill events).
    }

    const ids = this.pendingSignalIdsBySymbol.get(position.symbol);
    if (!ids || ids.size === 0) {
      return undefined;
    }

    if (ids.size === 1) {
      const [onlyId] = ids;
      return this.pendingSignals.get(onlyId);
    }

    // Multiple pending contexts for this symbol. Pick the best match using
    // direction + entry timestamp:
    //   1. Direction must match (long position ← buy signal, short ← sell).
    //   2. Among directional matches, prefer the one whose timestamp is
    //      latest but still ≤ position.openTime — that's the entry signal.
    //   3. If no signal predates the open (clock skew, paper sim), fall back
    //      to the closest-in-time directional match.
    const positionDirection: 'buy' | 'sell' | null =
      position.side === 'long' ? 'buy' : position.side === 'short' ? 'sell' : null;
    const openTimeMs = position.openTime?.getTime?.() ?? Date.now();

    let bestPreOpen: SignalContext | undefined;
    let bestAnyDir: SignalContext | undefined;
    let bestAnyDirDistance = Number.POSITIVE_INFINITY;

    for (const id of ids) {
      const ctx = this.pendingSignals.get(id);
      if (!ctx) continue;
      if (positionDirection && ctx.direction !== positionDirection) continue;
      const ctxMs = ctx.timestamp.getTime();
      if (ctxMs <= openTimeMs) {
        if (!bestPreOpen || ctxMs > bestPreOpen.timestamp.getTime()) {
          bestPreOpen = ctx;
        }
      }
      const distance = Math.abs(ctxMs - openTimeMs);
      if (distance < bestAnyDirDistance) {
        bestAnyDir = ctx;
        bestAnyDirDistance = distance;
      }
    }

    if (bestPreOpen) {
      return bestPreOpen;
    }
    if (bestAnyDir) {
      this.logger.debug('[TradeOutcomeCollector] No pre-open directional match; using closest', {
        symbol: position.symbol,
        candidates: ids.size,
        positionDirection,
      });
      return bestAnyDir;
    }

    this.logger.warn('[TradeOutcomeCollector] Multiple pending contexts but no directional match', {
      symbol: position.symbol,
      count: ids.size,
      positionDirection,
    });
    return undefined;
  }

  private removePendingContext(signalId: string): void {
    const context = this.pendingSignals.get(signalId);
    if (!context) {
      return;
    }

    this.pendingSignals.delete(signalId);

    const symbolSet = this.pendingSignalIdsBySymbol.get(context.symbol);
    if (symbolSet) {
      symbolSet.delete(signalId);
      if (symbolSet.size === 0) {
        this.pendingSignalIdsBySymbol.delete(context.symbol);
      }
    }
  }

  /**
   * Update configuration.
   */
  public updateConfig(config: Partial<TradeOutcomeCollectorConfig>): void {
    this.config = { ...this.config, ...config };
  }
}