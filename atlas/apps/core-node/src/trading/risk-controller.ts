/**
 * RiskController - Extended Risk Controls and Analytics
 * 
 * Provides:
 * - Per-symbol daily loss limits with auto-disable
 * - Per-strategy daily loss limits with auto-disable
 * - Trailing equity drawdown protection (daily peak trailing stop)
 * - Enhanced analytics (win/loss streaks, avg win/loss, profit factor)
 * - Strict max concurrent positions enforcement
 * - Dynamic profit targets and loss limits
 */

import { EventEmitter } from 'events';
import { Logger } from '../core/logger';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { Counter, Gauge, Histogram } from 'prom-client';
import { Position, PositionTracker } from './position-tracker';
import { GuardrailConfig } from '../config/loadGuardrails';

// Prometheus metrics
const symbolBlockedGauge = new Gauge({
  name: 'atlas_symbols_blocked_total',
  help: 'Number of symbols currently blocked',
});

const strategyBlockedGauge = new Gauge({
  name: 'atlas_strategies_blocked_total',
  help: 'Number of strategies currently blocked',
});

const trailingStopActiveGauge = new Gauge({
  name: 'atlas_trailing_stop_active',
  help: 'Whether trailing equity stop is active (0/1)',
});

const dailyEquityPeakGauge = new Gauge({
  name: 'atlas_daily_equity_peak_usd',
  help: 'Daily equity high-water mark',
});

const trailingDrawdownGauge = new Gauge({
  name: 'atlas_trailing_drawdown_usd',
  help: 'Current drawdown from daily peak',
});

const consecutiveWinsGauge = new Gauge({
  name: 'atlas_consecutive_wins',
  help: 'Current consecutive wins streak',
});

const consecutiveLossesGauge = new Gauge({
  name: 'atlas_consecutive_losses',
  help: 'Current consecutive losses streak',
});

const profitFactorGauge = new Gauge({
  name: 'atlas_session_profit_factor',
  help: 'Session profit factor (gross profit / gross loss)',
});

// Per-symbol/strategy loss tracking
export interface EntityLossState {
  dailyLoss: number;
  tradesCount: number;
  winsCount: number;
  lossesCount: number;
  consecutiveLosses: number;
  consecutiveWins: number;
  blocked: boolean;
  blockedReason?: string;
  blockedAt?: Date;
}

// Trailing stop configuration
export interface TrailingStopConfig {
  enabled: boolean;
  trailingPercent: number;         // % of peak to trail (e.g., 0.5 = never give back more than 50% of gains)
  absoluteMinEquity?: number;      // Never fall below this absolute equity
  activationProfitPct: number;     // Activate trailing after this % profit (e.g., 0.01 = 1%)
  lockInProfitPct: number;         // Lock in at least this % of gains (e.g., 0.3 = lock 30%)
}

// Risk controller configuration
export interface RiskControllerConfig {
  supabaseUrl: string;
  supabaseKey: string;
  userId: string;
  
  // Starting equity for the day
  dailyStartEquity: number;
  
  // Per-strategy limits (strategy ID -> max daily loss USD)
  strategyLimits: Record<string, {
    maxDailyLossUsd: number;
    maxConsecutiveLosses: number;
    cooldownMs: number;
  }>;
  
  // Default per-strategy limits if not specified
  defaultStrategyLimits: {
    maxDailyLossUsd: number;
    maxConsecutiveLosses: number;
    cooldownMs: number;
  };
  
  // Trailing equity stop
  trailingStop: TrailingStopConfig;
  
  // Max concurrent positions (strict enforcement)
  maxConcurrentPositions: number;
  
  // Daily profit target (optional, stop trading after reaching)
  dailyProfitTargetUsd?: number;
  
  // Session time limits
  tradingHoursUTC?: { start: number; end: number };
  
  // Guardrails reference
  guardrails: GuardrailConfig;
}

// Extended analytics
export interface RiskAnalytics {
  // Session performance
  sessionTrades: number;
  sessionWins: number;
  sessionLosses: number;
  sessionBreakeven: number;
  sessionGrossProfit: number;
  sessionGrossLoss: number;
  sessionNetPnL: number;
  
  // Streaks
  currentConsecutiveWins: number;
  currentConsecutiveLosses: number;
  maxConsecutiveWins: number;
  maxConsecutiveLosses: number;
  
  // Ratios
  winRate: number;
  profitFactor: number;
  avgWinAmount: number;
  avgLossAmount: number;
  avgWinLossRatio: number;
  expectancy: number;
  
  // Drawdown
  dailyPeakEquity: number;
  currentEquity: number;
  currentDrawdownUsd: number;
  currentDrawdownPct: number;
  maxDrawdownUsd: number;
  maxDrawdownPct: number;
  
  // Per-symbol stats
  perSymbol: Record<string, EntityLossState>;
  
  // Per-strategy stats
  perStrategy: Record<string, EntityLossState>;
  
  // Control status
  trailingStopActive: boolean;
  trailingStopTriggered: boolean;
  dailyProfitTargetReached: boolean;
  blockedSymbols: string[];
  blockedStrategies: string[];
}

export interface RiskControllerEvents {
  'risk:symbol:blocked': (symbol: string, reason: string) => void;
  'risk:symbol:unblocked': (symbol: string) => void;
  'risk:strategy:blocked': (strategyId: string, reason: string) => void;
  'risk:strategy:unblocked': (strategyId: string) => void;
  'risk:trailing_stop:triggered': (peakEquity: number, currentEquity: number) => void;
  'risk:trailing_stop:activated': (peakEquity: number) => void;
  'risk:profit_target:reached': (target: number, currentPnL: number) => void;
  'risk:max_positions:reached': (current: number, max: number) => void;
  'risk:analytics:updated': (analytics: RiskAnalytics) => void;
}

export class RiskController extends EventEmitter {
  private config: RiskControllerConfig;
  private logger: Logger;
  private supabase: SupabaseClient;
  private positionTracker: PositionTracker;
  
  // State tracking
  private perSymbol: Map<string, EntityLossState> = new Map();
  private perStrategy: Map<string, EntityLossState> = new Map();
  
  // Equity tracking
  private dailyStartEquity: number;
  private dailyPeakEquity: number;
  private currentEquity: number;
  private maxDrawdownUsd: number = 0;
  private maxDrawdownPct: number = 0;
  
  // Trailing stop state
  private trailingStopActive = false;
  private trailingStopTriggered = false;
  private trailingStopLevel: number | null = null;
  
  // Profit target state
  private profitTargetReached = false;
  
  // Session analytics
  private sessionTrades = 0;
  private sessionWins = 0;
  private sessionLosses = 0;
  private sessionBreakeven = 0;
  private sessionGrossProfit = 0;
  private sessionGrossLoss = 0;
  
  // Streak tracking
  private currentConsecutiveWins = 0;
  private currentConsecutiveLosses = 0;
  private maxConsecutiveWins = 0;
  private maxConsecutiveLosses = 0;
  
  // Update timer
  private updateInterval: NodeJS.Timeout | null = null;

  constructor(
    config: RiskControllerConfig,
    logger: Logger,
    positionTracker: PositionTracker
  ) {
    super();
    this.config = config;
    this.logger = logger;
    this.positionTracker = positionTracker;
    this.supabase = createClient(config.supabaseUrl, config.supabaseKey);
    
    // Initialize equity tracking
    this.dailyStartEquity = config.dailyStartEquity;
    this.dailyPeakEquity = config.dailyStartEquity;
    this.currentEquity = config.dailyStartEquity;
    
    // Subscribe to position events
    this.positionTracker.on('position:closed', (position: Position) => {
      this.handleClosedPosition(position);
    });
    
    // Start periodic updates
    this.updateInterval = setInterval(() => this.updateEquity(), 5000);
    
    this.logger.info('RiskController initialized', {
      dailyStartEquity: this.dailyStartEquity,
      maxConcurrentPositions: config.maxConcurrentPositions,
      trailingStopEnabled: config.trailingStop.enabled,
    });
  }

  // ============ Position/Trade Recording ============

  /**
   * Handle a closed position - update all tracking.
   */
  private handleClosedPosition(position: Position): void {
    const pnl = position.realizedPnL;
    const symbol = position.symbol;
    const strategy = position.strategy || 'unknown';
    
    // Update session stats
    this.sessionTrades++;
    
    if (pnl > 0) {
      this.sessionWins++;
      this.sessionGrossProfit += pnl;
      this.currentConsecutiveWins++;
      this.currentConsecutiveLosses = 0;
      this.maxConsecutiveWins = Math.max(this.maxConsecutiveWins, this.currentConsecutiveWins);
    } else if (pnl < 0) {
      this.sessionLosses++;
      this.sessionGrossLoss += Math.abs(pnl);
      this.currentConsecutiveLosses++;
      this.currentConsecutiveWins = 0;
      this.maxConsecutiveLosses = Math.max(this.maxConsecutiveLosses, this.currentConsecutiveLosses);
    } else {
      this.sessionBreakeven++;
    }
    
    // Update per-symbol tracking
    this.recordEntityLoss(this.perSymbol, symbol, pnl);
    this.checkSymbolLimits(symbol);
    
    // Update per-strategy tracking
    this.recordEntityLoss(this.perStrategy, strategy, pnl);
    this.checkStrategyLimits(strategy);
    
    // Update equity and check trailing stop
    this.updateEquity();
    
    // Update Prometheus metrics
    consecutiveWinsGauge.set(this.currentConsecutiveWins);
    consecutiveLossesGauge.set(this.currentConsecutiveLosses);
    
    const profitFactor = this.sessionGrossLoss > 0 
      ? this.sessionGrossProfit / this.sessionGrossLoss 
      : this.sessionGrossProfit > 0 ? Infinity : 0;
    profitFactorGauge.set(Number.isFinite(profitFactor) ? profitFactor : 0);
    
    // Emit analytics update
    this.emit('risk:analytics:updated', this.getAnalytics());
  }

  /**
   * Record P&L for an entity (symbol or strategy).
   */
  private recordEntityLoss(
    map: Map<string, EntityLossState>,
    entityId: string,
    pnl: number
  ): void {
    let state = map.get(entityId);
    if (!state) {
      state = {
        dailyLoss: 0,
        tradesCount: 0,
        winsCount: 0,
        lossesCount: 0,
        consecutiveLosses: 0,
        consecutiveWins: 0,
        blocked: false,
      };
      map.set(entityId, state);
    }
    
    state.tradesCount++;
    
    if (pnl < 0) {
      state.dailyLoss += Math.abs(pnl);
      state.lossesCount++;
      state.consecutiveLosses++;
      state.consecutiveWins = 0;
    } else if (pnl > 0) {
      state.dailyLoss = Math.max(0, state.dailyLoss - pnl); // Offset wins against losses
      state.winsCount++;
      state.consecutiveWins++;
      state.consecutiveLosses = 0;
    }
  }

  // ============ Limit Checking ============

  /**
   * Check if symbol should be blocked.
   */
  private checkSymbolLimits(symbol: string): void {
    const state = this.perSymbol.get(symbol);
    if (!state || state.blocked) return;
    
    // Get per-symbol limits from guardrails
    const limits = this.config.guardrails.per_symbol?.[symbol];
    if (!limits) return;
    
    if (state.dailyLoss >= limits.max_daily_loss_usd) {
      state.blocked = true;
      state.blockedReason = `Daily loss limit reached: $${state.dailyLoss.toFixed(2)} >= $${limits.max_daily_loss_usd}`;
      state.blockedAt = new Date();
      
      symbolBlockedGauge.set(this.getBlockedSymbols().length);
      this.logger.warn(`Symbol blocked: ${symbol}`, { reason: state.blockedReason });
      this.emit('risk:symbol:blocked', symbol, state.blockedReason);
    }
  }

  /**
   * Check if strategy should be blocked.
   */
  private checkStrategyLimits(strategyId: string): void {
    const state = this.perStrategy.get(strategyId);
    if (!state || state.blocked) return;
    
    // Get strategy-specific limits or use defaults
    const limits = this.config.strategyLimits[strategyId] || this.config.defaultStrategyLimits;
    
    let blocked = false;
    let reason = '';
    
    // Check daily loss limit
    if (state.dailyLoss >= limits.maxDailyLossUsd) {
      blocked = true;
      reason = `Daily loss limit: $${state.dailyLoss.toFixed(2)} >= $${limits.maxDailyLossUsd}`;
    }
    
    // Check consecutive losses
    if (!blocked && state.consecutiveLosses >= limits.maxConsecutiveLosses) {
      blocked = true;
      reason = `Consecutive losses: ${state.consecutiveLosses} >= ${limits.maxConsecutiveLosses}`;
    }
    
    if (blocked) {
      state.blocked = true;
      state.blockedReason = reason;
      state.blockedAt = new Date();
      
      strategyBlockedGauge.set(this.getBlockedStrategies().length);
      this.logger.warn(`Strategy blocked: ${strategyId}`, { reason });
      this.emit('risk:strategy:blocked', strategyId, reason);
      
      // Schedule unblock after cooldown
      if (limits.cooldownMs > 0) {
        setTimeout(() => {
          this.unblockStrategy(strategyId);
        }, limits.cooldownMs);
      }
    }
  }

  // ============ Trailing Equity Stop ============

  /**
   * Update current equity and check trailing stop.
   */
  private updateEquity(): void {
    const summary = this.positionTracker.getPortfolioSummary();
    this.currentEquity = this.dailyStartEquity + summary.totalPnL;
    
    // Update peak if new high
    if (this.currentEquity > this.dailyPeakEquity) {
      this.dailyPeakEquity = this.currentEquity;
      dailyEquityPeakGauge.set(this.dailyPeakEquity);
      
      // Update trailing stop level
      if (this.config.trailingStop.enabled) {
        this.updateTrailingStopLevel();
      }
    }
    
    // Calculate drawdown
    const drawdownUsd = this.dailyPeakEquity - this.currentEquity;
    const drawdownPct = this.dailyPeakEquity > 0 ? drawdownUsd / this.dailyPeakEquity : 0;
    
    trailingDrawdownGauge.set(drawdownUsd);
    
    // Track max drawdown
    if (drawdownUsd > this.maxDrawdownUsd) {
      this.maxDrawdownUsd = drawdownUsd;
      this.maxDrawdownPct = drawdownPct;
    }
    
    // Check trailing stop
    if (this.config.trailingStop.enabled && !this.trailingStopTriggered) {
      this.checkTrailingStop();
    }
    
    // Check profit target
    if (this.config.dailyProfitTargetUsd && !this.profitTargetReached) {
      const dailyPnL = this.currentEquity - this.dailyStartEquity;
      if (dailyPnL >= this.config.dailyProfitTargetUsd) {
        this.profitTargetReached = true;
        this.logger.info('Daily profit target reached', {
          target: this.config.dailyProfitTargetUsd,
          currentPnL: dailyPnL,
        });
        this.emit('risk:profit_target:reached', this.config.dailyProfitTargetUsd, dailyPnL);
      }
    }
  }

  /**
   * Update the trailing stop level based on current peak.
   */
  private updateTrailingStopLevel(): void {
    const cfg = this.config.trailingStop;
    const dailyPnL = this.dailyPeakEquity - this.dailyStartEquity;
    const dailyPnLPct = dailyPnL / this.dailyStartEquity;
    
    // Activate trailing stop if we've exceeded activation threshold
    if (!this.trailingStopActive && dailyPnLPct >= cfg.activationProfitPct) {
      this.trailingStopActive = true;
      trailingStopActiveGauge.set(1);
      this.logger.info('Trailing equity stop activated', {
        peakEquity: this.dailyPeakEquity,
        dailyPnL,
        dailyPnLPct: (dailyPnLPct * 100).toFixed(2) + '%',
      });
      this.emit('risk:trailing_stop:activated', this.dailyPeakEquity);
    }
    
    if (this.trailingStopActive) {
      // Calculate the floor: peak - (trailingPercent * gains)
      const gainsToProtect = dailyPnL * (1 - cfg.trailingPercent);
      const lockInGains = dailyPnL * cfg.lockInProfitPct;
      const protectedGains = Math.max(gainsToProtect, lockInGains);
      
      this.trailingStopLevel = this.dailyStartEquity + protectedGains;
      
      // Apply absolute minimum if configured
      if (cfg.absoluteMinEquity) {
        this.trailingStopLevel = Math.max(this.trailingStopLevel, cfg.absoluteMinEquity);
      }
    }
  }

  /**
   * Check if trailing stop has been triggered.
   */
  private checkTrailingStop(): void {
    if (!this.trailingStopActive || this.trailingStopLevel === null) return;
    
    if (this.currentEquity <= this.trailingStopLevel) {
      this.trailingStopTriggered = true;
      this.logger.warn('Trailing equity stop TRIGGERED', {
        trailingStopLevel: this.trailingStopLevel,
        currentEquity: this.currentEquity,
        peakEquity: this.dailyPeakEquity,
        drawdown: this.dailyPeakEquity - this.currentEquity,
      });
      this.emit('risk:trailing_stop:triggered', this.dailyPeakEquity, this.currentEquity);
    }
  }

  // ============ Public API ============

  /**
   * Check if a trade is allowed (pre-trade check).
   */
  public canTrade(symbol: string, strategyId: string): {
    allowed: boolean;
    reason?: string;
  } {
    // Check if trailing stop triggered
    if (this.trailingStopTriggered) {
      return { allowed: false, reason: 'Trailing equity stop triggered - trading halted' };
    }
    
    // Check if profit target reached
    if (this.profitTargetReached) {
      return { allowed: false, reason: 'Daily profit target reached - trading halted' };
    }
    
    // Check symbol blocked
    const symbolState = this.perSymbol.get(symbol);
    if (symbolState?.blocked) {
      return { allowed: false, reason: `Symbol ${symbol} blocked: ${symbolState.blockedReason}` };
    }
    
    // Check strategy blocked
    const strategyState = this.perStrategy.get(strategyId);
    if (strategyState?.blocked) {
      return { allowed: false, reason: `Strategy ${strategyId} blocked: ${strategyState.blockedReason}` };
    }
    
    // Check max positions
    const openPositions = this.positionTracker.getOpenPositions().length;
    if (openPositions >= this.config.maxConcurrentPositions) {
      this.emit('risk:max_positions:reached', openPositions, this.config.maxConcurrentPositions);
      return { 
        allowed: false, 
        reason: `Max concurrent positions reached: ${openPositions}/${this.config.maxConcurrentPositions}` 
      };
    }
    
    // Check trading hours
    if (this.config.tradingHoursUTC) {
      const currentHour = new Date().getUTCHours();
      const { start, end } = this.config.tradingHoursUTC;
      const inHours = start <= end 
        ? currentHour >= start && currentHour < end
        : currentHour >= start || currentHour < end;
      if (!inHours) {
        return { allowed: false, reason: `Outside trading hours (${start}-${end} UTC)` };
      }
    }
    
    return { allowed: true };
  }

  /**
   * Check if a specific symbol is blocked.
   */
  public isSymbolBlocked(symbol: string): boolean {
    return this.perSymbol.get(symbol)?.blocked ?? false;
  }

  /**
   * Check if a specific strategy is blocked.
   */
  public isStrategyBlocked(strategyId: string): boolean {
    return this.perStrategy.get(strategyId)?.blocked ?? false;
  }

  /**
   * Get list of blocked symbols.
   */
  public getBlockedSymbols(): string[] {
    return Array.from(this.perSymbol.entries())
      .filter(([, state]) => state.blocked)
      .map(([symbol]) => symbol);
  }

  /**
   * Get list of blocked strategies.
   */
  public getBlockedStrategies(): string[] {
    return Array.from(this.perStrategy.entries())
      .filter(([, state]) => state.blocked)
      .map(([id]) => id);
  }

  /**
   * Manually unblock a symbol.
   */
  public unblockSymbol(symbol: string): boolean {
    const state = this.perSymbol.get(symbol);
    if (!state || !state.blocked) return false;
    
    state.blocked = false;
    state.blockedReason = undefined;
    state.blockedAt = undefined;
    symbolBlockedGauge.set(this.getBlockedSymbols().length);
    
    this.logger.info(`Symbol manually unblocked: ${symbol}`);
    this.emit('risk:symbol:unblocked', symbol);
    return true;
  }

  /**
   * Manually unblock a strategy.
   */
  public unblockStrategy(strategyId: string): boolean {
    const state = this.perStrategy.get(strategyId);
    if (!state || !state.blocked) return false;
    
    state.blocked = false;
    state.blockedReason = undefined;
    state.blockedAt = undefined;
    // Reset consecutive losses to give it a fresh start
    state.consecutiveLosses = 0;
    strategyBlockedGauge.set(this.getBlockedStrategies().length);
    
    this.logger.info(`Strategy manually unblocked: ${strategyId}`);
    this.emit('risk:strategy:unblocked', strategyId);
    return true;
  }

  /**
   * Reset trailing stop (allows continuing trading).
   */
  public resetTrailingStop(): void {
    this.trailingStopTriggered = false;
    this.logger.info('Trailing stop reset');
  }

  /**
   * Reset profit target reached flag.
   */
  public resetProfitTarget(): void {
    this.profitTargetReached = false;
    this.logger.info('Profit target reset');
  }

  /**
   * Reset daily tracking (call at start of new day).
   */
  public resetDaily(newStartEquity: number): void {
    this.dailyStartEquity = newStartEquity;
    this.dailyPeakEquity = newStartEquity;
    this.currentEquity = newStartEquity;
    this.maxDrawdownUsd = 0;
    this.maxDrawdownPct = 0;
    
    this.trailingStopActive = false;
    this.trailingStopTriggered = false;
    this.trailingStopLevel = null;
    this.profitTargetReached = false;
    
    this.perSymbol.clear();
    this.perStrategy.clear();
    
    this.sessionTrades = 0;
    this.sessionWins = 0;
    this.sessionLosses = 0;
    this.sessionBreakeven = 0;
    this.sessionGrossProfit = 0;
    this.sessionGrossLoss = 0;
    this.currentConsecutiveWins = 0;
    this.currentConsecutiveLosses = 0;
    
    trailingStopActiveGauge.set(0);
    symbolBlockedGauge.set(0);
    strategyBlockedGauge.set(0);
    
    this.logger.info('Daily tracking reset', { newStartEquity });
  }

  /**
   * Get comprehensive analytics.
   */
  public getAnalytics(): RiskAnalytics {
    const dailyPnL = this.currentEquity - this.dailyStartEquity;
    const drawdownUsd = this.dailyPeakEquity - this.currentEquity;
    const drawdownPct = this.dailyPeakEquity > 0 ? drawdownUsd / this.dailyPeakEquity : 0;
    
    const winRate = this.sessionTrades > 0 ? this.sessionWins / this.sessionTrades : 0;
    const profitFactor = this.sessionGrossLoss > 0 
      ? this.sessionGrossProfit / this.sessionGrossLoss 
      : this.sessionGrossProfit > 0 ? Infinity : 0;
    const avgWinAmount = this.sessionWins > 0 ? this.sessionGrossProfit / this.sessionWins : 0;
    const avgLossAmount = this.sessionLosses > 0 ? this.sessionGrossLoss / this.sessionLosses : 0;
    const avgWinLossRatio = avgLossAmount > 0 ? avgWinAmount / avgLossAmount : 0;
    
    // Expectancy = (Win% * Avg Win) - (Loss% * Avg Loss)
    const lossRate = this.sessionTrades > 0 ? this.sessionLosses / this.sessionTrades : 0;
    const expectancy = (winRate * avgWinAmount) - (lossRate * avgLossAmount);

    const perSymbol: Record<string, EntityLossState> = {};
    for (const [symbol, state] of this.perSymbol) {
      perSymbol[symbol] = { ...state };
    }

    const perStrategy: Record<string, EntityLossState> = {};
    for (const [id, state] of this.perStrategy) {
      perStrategy[id] = { ...state };
    }

    return {
      sessionTrades: this.sessionTrades,
      sessionWins: this.sessionWins,
      sessionLosses: this.sessionLosses,
      sessionBreakeven: this.sessionBreakeven,
      sessionGrossProfit: this.sessionGrossProfit,
      sessionGrossLoss: this.sessionGrossLoss,
      sessionNetPnL: dailyPnL,
      
      currentConsecutiveWins: this.currentConsecutiveWins,
      currentConsecutiveLosses: this.currentConsecutiveLosses,
      maxConsecutiveWins: this.maxConsecutiveWins,
      maxConsecutiveLosses: this.maxConsecutiveLosses,
      
      winRate,
      profitFactor: Number.isFinite(profitFactor) ? profitFactor : 0,
      avgWinAmount,
      avgLossAmount,
      avgWinLossRatio,
      expectancy,
      
      dailyPeakEquity: this.dailyPeakEquity,
      currentEquity: this.currentEquity,
      currentDrawdownUsd: drawdownUsd,
      currentDrawdownPct: drawdownPct,
      maxDrawdownUsd: this.maxDrawdownUsd,
      maxDrawdownPct: this.maxDrawdownPct,
      
      perSymbol,
      perStrategy,
      
      trailingStopActive: this.trailingStopActive,
      trailingStopTriggered: this.trailingStopTriggered,
      dailyProfitTargetReached: this.profitTargetReached,
      blockedSymbols: this.getBlockedSymbols(),
      blockedStrategies: this.getBlockedStrategies(),
    };
  }

  /**
   * Get current status for API/UI.
   */
  public getStatus(): {
    tradingAllowed: boolean;
    reason?: string;
    trailingStop: {
      active: boolean;
      triggered: boolean;
      level: number | null;
    };
    profitTarget: {
      target: number | null;
      reached: boolean;
    };
    positions: {
      current: number;
      max: number;
    };
    blockedSymbols: string[];
    blockedStrategies: string[];
  } {
    let tradingAllowed = true;
    let reason: string | undefined;
    
    if (this.trailingStopTriggered) {
      tradingAllowed = false;
      reason = 'Trailing equity stop triggered';
    } else if (this.profitTargetReached) {
      tradingAllowed = false;
      reason = 'Daily profit target reached';
    }
    
    return {
      tradingAllowed,
      reason,
      trailingStop: {
        active: this.trailingStopActive,
        triggered: this.trailingStopTriggered,
        level: this.trailingStopLevel,
      },
      profitTarget: {
        target: this.config.dailyProfitTargetUsd ?? null,
        reached: this.profitTargetReached,
      },
      positions: {
        current: this.positionTracker.getOpenPositions().length,
        max: this.config.maxConcurrentPositions,
      },
      blockedSymbols: this.getBlockedSymbols(),
      blockedStrategies: this.getBlockedStrategies(),
    };
  }

  /**
   * Stop the controller.
   */
  public stop(): void {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }
    this.logger.info('RiskController stopped');
  }
}

