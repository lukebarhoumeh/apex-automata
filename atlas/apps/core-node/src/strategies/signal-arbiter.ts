/**
 * Signal Arbiter - Deconfliction for Multiple Strategy Signals
 * 
 * When multiple strategies fire signals simultaneously for the same symbol,
 * this arbiter determines which signal(s) should be acted upon.
 * 
 * Key responsibilities:
 * 1. Resolve conflicting signals (e.g., breakout says BUY, momentum says SELL)
 * 2. Prioritize signals based on strategy type and market regime
 * 3. Enforce cooldowns after position flips to prevent churn
 * 4. Aggregate signal strength for consensus-based decisions
 */

import { EventEmitter } from 'events';
import { Logger } from '../core/logger';
import { StrategySignal } from './plugins/types';
import { MarketRegime, RegimeState } from './regime-detector';

/**
 * Arbiter configuration options.
 */
export interface SignalArbiterConfig {
  // Minimum time (ms) between position flips on the same symbol
  flipCooldownMs: number;
  
  // Minimum signal strength to consider (0-1)
  minSignalStrength: number;
  
  // Whether to require consensus (multiple strategies agreeing)
  requireConsensus: boolean;
  
  // Minimum number of strategies that must agree for consensus
  minConsensusCount: number;
  
  // Strategy priority weights (higher = more important)
  strategyPriorities: Record<string, number>;
  
  // Whether to log all arbitration decisions
  verbose: boolean;
}

/**
 * Result of signal arbitration.
 */
export interface ArbiterResult {
  // The winning signal(s) to act upon
  signals: StrategySignal[];
  
  // Signals that were filtered out
  filteredSignals: StrategySignal[];
  
  // Reason for the decision
  reason: string;
  
  // Consensus score (0-1) if multiple signals agreed
  consensusScore?: number;
  
  // Whether a cooldown is active
  cooldownActive?: boolean;
}

/**
 * Internal tracking for position flips and cooldowns.
 */
interface SymbolState {
  lastFlipTime: number;
  lastDirection: 'buy' | 'sell' | null;
  signalHistory: Array<{
    timestamp: number;
    strategy: string;
    direction: 'buy' | 'sell';
    strength: number;
  }>;
}

const DEFAULT_CONFIG: SignalArbiterConfig = {
  flipCooldownMs: 5 * 60 * 1000, // 5 minutes between direction flips to prevent churn
  minSignalStrength: 0.3,  // Require medium-strength signals (filters weak counter-signals)
  requireConsensus: false,
  minConsensusCount: 2,
  strategyPriorities: {
    'breakout': 1.0,      // Trend-following gets base priority
    'vwap_mr': 1.0,       // Mean reversion same priority
    'momentum': 0.9,      // Oscillator slightly lower
    'trend_follow': 1.1,  // Higher timeframe trend gets boost
  },
  verbose: false,
};

/**
 * Per-strategy observed strength ranges for min-max normalization.
 * Strategies emit strength on different internal scales — normalizing to [0,1]
 * before cross-strategy comparison prevents one strategy from dominating.
 */
const STRATEGY_STRENGTH_RANGE: Record<string, { min: number; max: number }> = {
  'breakout':     { min: 0.3, max: 1.0 },
  'vwap_mr':      { min: 0.2, max: 0.8 },
  'momentum':     { min: 0.4, max: 0.9 },
  'trend_follow': { min: 0.3, max: 0.85 },
};

/**
 * Regime-based strategy compatibility for arbitration.
 * When strategies conflict, prefer the one better suited to current regime.
 */
const REGIME_PREFERENCE: Record<MarketRegime, Record<string, number>> = {
  'strong_trend': {
    'breakout': 1.0,
    'trend_follow': 1.0,
    'vwap_mr': 0.3,
    'momentum': 0.6,
  },
  'weak_trend': {
    'breakout': 0.7,
    'trend_follow': 0.8,
    'vwap_mr': 0.5,
    'momentum': 1.0,
  },
  'ranging': {
    'breakout': 0.3,
    'trend_follow': 0.4,
    'vwap_mr': 1.0,
    'momentum': 0.9,
  },
  'choppy': {
    'breakout': 0.1,
    'trend_follow': 0.2,
    'vwap_mr': 0.6,
    'momentum': 0.4,
  },
};

export class SignalArbiter extends EventEmitter {
  private config: SignalArbiterConfig;
  private logger: Logger;
  private symbolStates: Map<string, SymbolState> = new Map();
  
  // Statistics
  private stats = {
    totalSignalsReceived: 0,
    signalsPassedThrough: 0,
    signalsFiltered: 0,
    conflictsResolved: 0,
    cooldownsTriggered: 0,
    consensusReached: 0,
  };

  constructor(config: Partial<SignalArbiterConfig>, logger: Logger) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.logger = logger;
  }

  /**
   * Arbitrate a batch of signals for a single symbol.
   * Call this with all signals generated in the same processing cycle.
   *
   * @param nowMs Current timestamp in epoch ms used for the flip-cooldown
   *   window and signal-history timestamps. **Backtest callers MUST pass the
   *   simulated bar timestamp.** Defaulting to `Date.now()` is correct only
   *   for the live engine — the backtest path latches the cooldown across
   *   the entire simulated window otherwise. See SPRINT-PLAN-FINAL.md §3 F1.
   */
  public arbitrate(
    signals: StrategySignal[],
    regime: RegimeState,
    nowMs: number = Date.now(),
  ): ArbiterResult {
    if (signals.length === 0) {
      return { signals: [], filteredSignals: [], reason: 'No signals to arbitrate' };
    }

    const symbol = signals[0].symbol;
    this.stats.totalSignalsReceived += signals.length;

    // Filter by minimum strength
    const strongSignals = signals.filter(s => s.strength >= this.config.minSignalStrength);
    const weakSignals = signals.filter(s => s.strength < this.config.minSignalStrength);

    if (strongSignals.length === 0) {
      this.stats.signalsFiltered += signals.length;
      return {
        signals: [],
        filteredSignals: signals,
        reason: `All ${signals.length} signals below minimum strength (${this.config.minSignalStrength})`,
      };
    }

    // Check cooldown
    const state = this.getOrCreateSymbolState(symbol);
    const timeSinceFlip = nowMs - state.lastFlipTime;
    
    // Determine if this would be a flip
    const dominantDirection = this.getDominantDirection(strongSignals);
    const isFlip = state.lastDirection !== null && state.lastDirection !== dominantDirection;
    
    if (isFlip && timeSinceFlip < this.config.flipCooldownMs) {
      this.stats.cooldownsTriggered++;
      this.stats.signalsFiltered += signals.length;
      
      const remainingCooldown = Math.ceil((this.config.flipCooldownMs - timeSinceFlip) / 1000);
      
      if (this.config.verbose) {
        this.logger.debug(`[Arbiter] Cooldown active for ${symbol}`, {
          lastDirection: state.lastDirection,
          newDirection: dominantDirection,
          remainingSeconds: remainingCooldown,
        });
      }
      
      return {
        signals: [],
        filteredSignals: signals,
        reason: `Flip cooldown active (${remainingCooldown}s remaining)`,
        cooldownActive: true,
      };
    }

    // Group by direction
    const buySignals = strongSignals.filter(s => s.direction === 'buy');
    const sellSignals = strongSignals.filter(s => s.direction === 'sell');

    // Check for conflict (signals in both directions)
    if (buySignals.length > 0 && sellSignals.length > 0) {
      this.stats.conflictsResolved++;
      return this.resolveConflict(buySignals, sellSignals, regime, weakSignals, nowMs);
    }

    // No conflict - check consensus if required
    const directionalSignals = buySignals.length > 0 ? buySignals : sellSignals;
    
    if (this.config.requireConsensus && directionalSignals.length < this.config.minConsensusCount) {
      this.stats.signalsFiltered += signals.length;
      return {
        signals: [],
        filteredSignals: signals,
        reason: `Consensus not reached (${directionalSignals.length}/${this.config.minConsensusCount} strategies)`,
      };
    }

    // Calculate consensus score
    const consensusScore = directionalSignals.length / signals.length;
    if (directionalSignals.length >= this.config.minConsensusCount) {
      this.stats.consensusReached++;
    }

    // Pick the best signal (highest adjusted strength)
    const rankedSignals = this.rankSignals(directionalSignals, regime);
    const winner = rankedSignals[0];

    // Update state
    this.updateSymbolState(symbol, winner.direction, rankedSignals, nowMs);
    
    this.stats.signalsPassedThrough++;
    this.stats.signalsFiltered += signals.length - 1;

    if (this.config.verbose) {
      this.logger.debug(`[Arbiter] Signal selected for ${symbol}`, {
        winner: winner.strategy,
        direction: winner.direction,
        strength: winner.strength,
        consensusScore,
        candidateCount: directionalSignals.length,
      });
    }

    return {
      signals: [winner],
      filteredSignals: [...weakSignals, ...rankedSignals.slice(1)],
      reason: `Selected ${winner.strategy} (strength: ${winner.strength.toFixed(2)}, consensus: ${(consensusScore * 100).toFixed(0)}%)`,
      consensusScore,
    };
  }

  /**
   * Resolve conflicting signals (buy vs sell).
   *
   * @param nowMs Current timestamp in epoch ms threaded through to
   *   `updateSymbolState` so flip-cooldown bookkeeping uses the same clock
   *   the caller supplied to `arbitrate`.
   */
  private resolveConflict(
    buySignals: StrategySignal[],
    sellSignals: StrategySignal[],
    regime: RegimeState,
    weakSignals: StrategySignal[],
    nowMs: number,
  ): ArbiterResult {
    const symbol = buySignals[0]?.symbol || sellSignals[0]?.symbol;
    
    // Rank both sides
    const rankedBuys = this.rankSignals(buySignals, regime);
    const rankedSells = this.rankSignals(sellSignals, regime);
    
    const bestBuy = rankedBuys[0];
    const bestSell = rankedSells[0];
    
    // Calculate aggregate scores for each direction
    const buyScore = this.calculateDirectionScore(rankedBuys, regime);
    const sellScore = this.calculateDirectionScore(rankedSells, regime);
    
    if (this.config.verbose) {
      this.logger.debug(`[Arbiter] Resolving conflict for ${symbol}`, {
        buySignals: buySignals.length,
        sellSignals: sellSignals.length,
        buyScore: buyScore.toFixed(3),
        sellScore: sellScore.toFixed(3),
        regime: regime.regime,
      });
    }

    // Winner takes all
    if (buyScore > sellScore) {
      this.updateSymbolState(symbol, 'buy', rankedBuys, nowMs);
      this.stats.signalsPassedThrough++;
      this.stats.signalsFiltered += sellSignals.length + weakSignals.length + rankedBuys.length - 1;
      
      return {
        signals: [bestBuy],
        filteredSignals: [...sellSignals, ...weakSignals, ...rankedBuys.slice(1)],
        reason: `Conflict resolved: BUY wins (score: ${buyScore.toFixed(2)} vs ${sellScore.toFixed(2)})`,
        consensusScore: buySignals.length / (buySignals.length + sellSignals.length),
      };
    } else if (sellScore > buyScore) {
      this.updateSymbolState(symbol, 'sell', rankedSells, nowMs);
      this.stats.signalsPassedThrough++;
      this.stats.signalsFiltered += buySignals.length + weakSignals.length + rankedSells.length - 1;
      
      return {
        signals: [bestSell],
        filteredSignals: [...buySignals, ...weakSignals, ...rankedSells.slice(1)],
        reason: `Conflict resolved: SELL wins (score: ${sellScore.toFixed(2)} vs ${buyScore.toFixed(2)})`,
        consensusScore: sellSignals.length / (buySignals.length + sellSignals.length),
      };
    } else {
      // Tie - no action (conservative)
      this.stats.signalsFiltered += buySignals.length + sellSignals.length + weakSignals.length;
      
      return {
        signals: [],
        filteredSignals: [...buySignals, ...sellSignals, ...weakSignals],
        reason: `Conflict unresolved: scores tied (${buyScore.toFixed(2)}), no action taken`,
      };
    }
  }

  /**
   * Rank signals by adjusted strength (incorporating regime and priority).
   */
  private rankSignals(signals: StrategySignal[], regime: RegimeState): StrategySignal[] {
    return [...signals].sort((a, b) => {
      const scoreA = this.calculateSignalScore(a, regime);
      const scoreB = this.calculateSignalScore(b, regime);
      return scoreB - scoreA;
    });
  }

  /**
   * Normalize raw signal strength to [0,1] using per-strategy observed ranges.
   */
  private normalizeStrength(strategy: string, raw: number): number {
    const range = STRATEGY_STRENGTH_RANGE[strategy];
    if (!range || range.max <= range.min) return Math.max(0, Math.min(1, raw));
    const normalized = (raw - range.min) / (range.max - range.min);
    return Math.max(0, Math.min(1, normalized));
  }

  /**
   * Calculate a single signal's adjusted score.
   */
  private calculateSignalScore(signal: StrategySignal, regime: RegimeState): number {
    const normalized = this.normalizeStrength(signal.strategy, signal.strength);
    const priority = this.config.strategyPriorities[signal.strategy] ?? 1.0;
    const regimeBonus = REGIME_PREFERENCE[regime.regime]?.[signal.strategy] ?? 0.5;
    
    return normalized * priority * regimeBonus;
  }

  /**
   * Calculate aggregate direction score.
   */
  private calculateDirectionScore(signals: StrategySignal[], regime: RegimeState): number {
    if (signals.length === 0) return 0;
    
    const totalScore = signals.reduce((sum, s) => sum + this.calculateSignalScore(s, regime), 0);
    const avgScore = totalScore / signals.length;
    
    // Bonus for multiple agreeing strategies
    const consensusBonus = Math.min(signals.length * 0.1, 0.3);
    
    return avgScore + consensusBonus;
  }

  /**
   * Get the dominant direction from a set of signals.
   */
  private getDominantDirection(signals: StrategySignal[]): 'buy' | 'sell' {
    const buys = signals.filter(s => s.direction === 'buy').length;
    const sells = signals.filter(s => s.direction === 'sell').length;
    return buys >= sells ? 'buy' : 'sell';
  }

  /**
   * Get or create symbol state.
   */
  private getOrCreateSymbolState(symbol: string): SymbolState {
    if (!this.symbolStates.has(symbol)) {
      this.symbolStates.set(symbol, {
        lastFlipTime: 0,
        lastDirection: null,
        signalHistory: [],
      });
    }
    return this.symbolStates.get(symbol)!;
  }

  /**
   * Update symbol state after a signal is selected.
   *
   * @param nowMs Caller-supplied "current" timestamp. Live: `Date.now()`.
   *   Backtest: simulated bar timestamp. The flip-cooldown window keys off
   *   this — wall-clock here latches the cooldown for the entire backtest
   *   run after the first flip. See SPRINT-PLAN-FINAL.md §3 F1.
   */
  private updateSymbolState(
    symbol: string,
    direction: 'buy' | 'sell',
    signals: StrategySignal[],
    nowMs: number = Date.now(),
  ): void {
    const state = this.getOrCreateSymbolState(symbol);

    // Check if this is a flip
    if (state.lastDirection !== null && state.lastDirection !== direction) {
      state.lastFlipTime = nowMs;
      this.emit('flip', { symbol, from: state.lastDirection, to: direction });
    }
    
    state.lastDirection = direction;
    
    // Update history (keep last 50 signals)
    for (const signal of signals) {
      state.signalHistory.push({
        timestamp: nowMs,
        strategy: signal.strategy,
        direction: signal.direction,
        strength: signal.strength,
      });
    }
    if (state.signalHistory.length > 50) {
      state.signalHistory = state.signalHistory.slice(-50);
    }
  }

  /**
   * Manually reset cooldown for a symbol (e.g., after manual intervention).
   */
  public resetCooldown(symbol: string): void {
    const state = this.symbolStates.get(symbol);
    if (state) {
      state.lastFlipTime = 0;
      this.logger.info(`[Arbiter] Cooldown reset for ${symbol}`);
    }
  }

  /**
   * Clear all state (useful for testing or session reset).
   */
  public clearState(): void {
    this.symbolStates.clear();
    this.logger.info('[Arbiter] All state cleared');
  }

  /**
   * Update configuration at runtime.
   */
  public updateConfig(config: Partial<SignalArbiterConfig>): void {
    this.config = { ...this.config, ...config };
    this.logger.info('[Arbiter] Configuration updated', config);
  }

  /**
   * Get current configuration.
   */
  public getConfig(): SignalArbiterConfig {
    return { ...this.config };
  }

  /**
   * Get statistics.
   */
  public getStats() {
    return {
      ...this.stats,
      passRate: this.stats.totalSignalsReceived > 0
        ? this.stats.signalsPassedThrough / this.stats.totalSignalsReceived
        : 0,
      conflictRate: this.stats.totalSignalsReceived > 0
        ? this.stats.conflictsResolved / this.stats.totalSignalsReceived
        : 0,
      activeSymbols: this.symbolStates.size,
    };
  }

  /**
   * Get symbol state for debugging.
   */
  public getSymbolState(symbol: string): SymbolState | undefined {
    return this.symbolStates.get(symbol);
  }

  /**
   * Get all symbol states.
   */
  public getAllSymbolStates(): Record<string, SymbolState> {
    const result: Record<string, SymbolState> = {};
    for (const [symbol, state] of this.symbolStates) {
      result[symbol] = state;
    }
    return result;
  }
}
