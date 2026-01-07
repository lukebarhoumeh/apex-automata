/**
 * RegimeFilter - Strategy-regime alignment filter
 * 
 * Filters signals based on their strategy type and current market regime:
 * - Breakout/Momentum strategies: Only fire in trending regimes
 * - Mean-reversion strategies: Only fire in ranging/choppy regimes
 * 
 * Also adjusts signal strength and position sizing based on regime confidence.
 */

import { EventEmitter } from 'events';
import { Logger } from '../core/logger';
import { Signal } from './signal-processor';
import { RegimeDetector, MarketRegime, RegimeState } from './regime-detector';
import { Counter, Gauge, Histogram } from 'prom-client';

// Prometheus metrics
const signalsReceivedCounter = new Counter({
  name: 'atlas_regime_signals_received_total',
  help: 'Total signals received by regime filter',
  labelNames: ['symbol', 'strategy'],
});

const signalsPassedCounter = new Counter({
  name: 'atlas_regime_signals_passed_total',
  help: 'Total signals that passed regime filter',
  labelNames: ['symbol', 'strategy', 'regime'],
});

const signalsFilteredCounter = new Counter({
  name: 'atlas_regime_signals_filtered_total',
  help: 'Total signals filtered out by regime',
  labelNames: ['symbol', 'strategy', 'regime', 'reason'],
});

const signalStrengthAdjustmentGauge = new Gauge({
  name: 'atlas_regime_strength_adjustment',
  help: 'Current signal strength adjustment factor',
  labelNames: ['symbol'],
});

const positionSizeMultiplierGauge = new Gauge({
  name: 'atlas_regime_position_multiplier',
  help: 'Current position size multiplier based on regime',
  labelNames: ['symbol'],
});

// Strategy type classification
export type StrategyType = 'trend_following' | 'mean_reversion' | 'neutral';

// Map strategies to their types
const STRATEGY_TYPES: Record<string, StrategyType> = {
  'breakout': 'trend_following',
  'momentum': 'trend_following',
  'trend': 'trend_following',
  'vwap_mr': 'mean_reversion',
  'mean_reversion': 'mean_reversion',
  'scalp': 'neutral',
  'arbitrage': 'neutral',
};

// Regime-strategy compatibility matrix
const REGIME_STRATEGY_COMPAT: Record<MarketRegime, Record<StrategyType, number>> = {
  'strong_trend': {
    'trend_following': 1.0,   // Full green light
    'mean_reversion': 0.0,    // Block completely
    'neutral': 0.7,
  },
  'weak_trend': {
    'trend_following': 0.8,   // Proceed with reduced size
    'mean_reversion': 0.3,    // Very cautious
    'neutral': 0.6,
  },
  'ranging': {
    'trend_following': 0.3,   // Very cautious - many false breakouts
    'mean_reversion': 1.0,    // Full green light
    'neutral': 0.7,
  },
  'choppy': {
    'trend_following': 0.0,   // Block - whipsaw city
    'mean_reversion': 0.7,    // Good but be careful
    'neutral': 0.5,
  },
};

export interface RegimeFilterConfig {
  enabled: boolean;
  
  // Minimum compatibility score to allow trade
  minCompatibilityScore: number;  // default: 0.3
  
  // Require higher signal strength for counter-regime trades
  counterRegimeStrengthBoost: number;  // default: 0.2 (require 20% higher strength)
  
  // Position size adjustments
  maxPositionMultiplier: number;   // default: 1.0 (never increase)
  minPositionMultiplier: number;   // default: 0.25 (min 25% of normal size)
  
  // Regime confidence threshold
  minRegimeConfidence: number;     // default: 0.4 (require 40% confidence to filter)
  
  // Strategy overrides (allow specific strategies in all regimes)
  alwaysAllowStrategies: string[];
  
  // MTF alignment requirements
  requireMTFAlignment: boolean;    // default: true
  mtfAlignmentThreshold: number;   // default: 0.3 (30% alignment required)
}

const DEFAULT_CONFIG: RegimeFilterConfig = {
  enabled: true,
  minCompatibilityScore: 0.3,
  counterRegimeStrengthBoost: 0.2,
  maxPositionMultiplier: 1.0,
  minPositionMultiplier: 0.25,
  minRegimeConfidence: 0.4,
  alwaysAllowStrategies: [],
  requireMTFAlignment: true,
  mtfAlignmentThreshold: 0.3,
};

export interface FilterResult {
  allowed: boolean;
  reason: string;
  originalSignal: Signal;
  adjustedSignal?: Signal;
  positionMultiplier: number;
  regimeState: RegimeState;
  compatibilityScore: number;
}

export class RegimeFilter extends EventEmitter {
  private config: RegimeFilterConfig;
  private logger: Logger;
  private regimeDetector: RegimeDetector;

  constructor(
    regimeDetector: RegimeDetector,
    config: Partial<RegimeFilterConfig>,
    logger: Logger
  ) {
    super();
    this.regimeDetector = regimeDetector;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.logger = logger;
  }

  /**
   * Filter a signal based on current regime
   */
  public filter(signal: Signal): FilterResult {
    signalsReceivedCounter.inc({ symbol: signal.symbol, strategy: signal.strategy });

    // Check if filtering is disabled FIRST
    if (!this.config.enabled) {
      return {
        allowed: true,
        reason: 'Regime filtering disabled',
        originalSignal: signal,
        adjustedSignal: signal,
        positionMultiplier: 1.0,
        regimeState: this.getDefaultRegimeState(),
        compatibilityScore: 1.0,
      };
    }

    // Get current regime state
    const regimeState = this.regimeDetector.getState(signal.symbol);
    
    if (!regimeState) {
      // No regime data - allow with caution
      return {
        allowed: true,
        reason: 'No regime data available, allowing with caution',
        originalSignal: signal,
        adjustedSignal: signal,
        positionMultiplier: 0.5,
        regimeState: this.getDefaultRegimeState(),
        compatibilityScore: 0.5,
      };
    }

    // Check if strategy is always allowed
    if (this.config.alwaysAllowStrategies.includes(signal.strategy)) {
      return {
        allowed: true,
        reason: `Strategy '${signal.strategy}' is always allowed`,
        originalSignal: signal,
        adjustedSignal: signal,
        positionMultiplier: 1.0,
        regimeState,
        compatibilityScore: 1.0,
      };
    }

    // Get strategy type
    const strategyType = this.getStrategyType(signal.strategy);
    
    // Get compatibility score
    const compatibilityScore = REGIME_STRATEGY_COMPAT[regimeState.regime][strategyType];

    // Check if regime confidence is sufficient to filter
    if (regimeState.confidence < this.config.minRegimeConfidence) {
      // Low confidence - allow but reduce size
      const positionMultiplier = Math.max(
        this.config.minPositionMultiplier,
        0.5 + regimeState.confidence * 0.5
      );
      
      return {
        allowed: true,
        reason: `Low regime confidence (${(regimeState.confidence * 100).toFixed(0)}%), allowing with reduced size`,
        originalSignal: signal,
        adjustedSignal: signal,
        positionMultiplier,
        regimeState,
        compatibilityScore,
      };
    }

    // Check compatibility score
    if (compatibilityScore < this.config.minCompatibilityScore) {
      signalsFilteredCounter.inc({
        symbol: signal.symbol,
        strategy: signal.strategy,
        regime: regimeState.regime,
        reason: 'incompatible_regime',
      });

      this.emit('signal:filtered', signal, regimeState, 'incompatible_regime');
      
      this.logger.info('Signal filtered by regime', {
        symbol: signal.symbol,
        strategy: signal.strategy,
        strategyType,
        regime: regimeState.regime,
        compatibilityScore,
        reason: 'Regime-strategy mismatch',
      });

      return {
        allowed: false,
        reason: `${strategyType} strategy incompatible with ${regimeState.regime} regime (score: ${compatibilityScore})`,
        originalSignal: signal,
        positionMultiplier: 0,
        regimeState,
        compatibilityScore,
      };
    }

    // Check MTF alignment for trend-following strategies
    if (
      this.config.requireMTFAlignment &&
      strategyType === 'trend_following' &&
      Math.abs(regimeState.mtfAlignment) < this.config.mtfAlignmentThreshold
    ) {
      signalsFilteredCounter.inc({
        symbol: signal.symbol,
        strategy: signal.strategy,
        regime: regimeState.regime,
        reason: 'mtf_misalignment',
      });

      this.emit('signal:filtered', signal, regimeState, 'mtf_misalignment');

      this.logger.info('Signal filtered by MTF alignment', {
        symbol: signal.symbol,
        strategy: signal.strategy,
        mtfAlignment: regimeState.mtfAlignment,
        threshold: this.config.mtfAlignmentThreshold,
      });

      return {
        allowed: false,
        reason: `Insufficient MTF alignment (${(regimeState.mtfAlignment * 100).toFixed(0)}%) for trend-following`,
        originalSignal: signal,
        positionMultiplier: 0,
        regimeState,
        compatibilityScore,
      };
    }

    // Check direction alignment for trend-following
    if (strategyType === 'trend_following') {
      const directionMatch = this.checkDirectionAlignment(signal.direction, regimeState);
      if (!directionMatch.aligned && regimeState.regime === 'strong_trend') {
        signalsFilteredCounter.inc({
          symbol: signal.symbol,
          strategy: signal.strategy,
          regime: regimeState.regime,
          reason: 'counter_trend',
        });

        this.emit('signal:filtered', signal, regimeState, 'counter_trend');

        this.logger.info('Signal filtered - counter trend', {
          symbol: signal.symbol,
          direction: signal.direction,
          trendDirection: regimeState.trendDirection,
        });

        return {
          allowed: false,
          reason: `Counter-trend trade blocked: ${signal.direction} signal in ${regimeState.trendDirection} trend`,
          originalSignal: signal,
          positionMultiplier: 0,
          regimeState,
          compatibilityScore: 0,
        };
      }
    }

    // Calculate position multiplier based on compatibility
    const positionMultiplier = this.calculatePositionMultiplier(
      compatibilityScore,
      regimeState.confidence,
      strategyType,
      regimeState
    );

    // Adjust signal strength if trading against weak regime
    let adjustedSignal = { ...signal };
    if (compatibilityScore < 0.7) {
      // Require higher strength for lower compatibility
      const requiredStrength = signal.strength + this.config.counterRegimeStrengthBoost;
      if (signal.strength < requiredStrength) {
        signalsFilteredCounter.inc({
          symbol: signal.symbol,
          strategy: signal.strategy,
          regime: regimeState.regime,
          reason: 'insufficient_strength',
        });

        this.emit('signal:filtered', signal, regimeState, 'insufficient_strength');

        this.logger.info('Signal filtered - insufficient strength for regime', {
          symbol: signal.symbol,
          strategy: signal.strategy,
          signalStrength: signal.strength,
          requiredStrength,
          regime: regimeState.regime,
        });

        return {
          allowed: false,
          reason: `Signal strength ${signal.strength.toFixed(2)} below required ${requiredStrength.toFixed(2)} for ${regimeState.regime}`,
          originalSignal: signal,
          positionMultiplier: 0,
          regimeState,
          compatibilityScore,
        };
      }
    }

    // Add regime metadata to signal
    adjustedSignal.metadata = {
      ...signal.metadata,
      regime: regimeState.regime,
      regimeConfidence: regimeState.confidence,
      compatibilityScore,
      positionMultiplier,
    };

    // Signal passes all filters
    signalsPassedCounter.inc({
      symbol: signal.symbol,
      strategy: signal.strategy,
      regime: regimeState.regime,
    });

    signalStrengthAdjustmentGauge.set({ symbol: signal.symbol }, compatibilityScore);
    positionSizeMultiplierGauge.set({ symbol: signal.symbol }, positionMultiplier);

    this.emit('signal:passed', adjustedSignal, regimeState, positionMultiplier);

    this.logger.debug('Signal passed regime filter', {
      symbol: signal.symbol,
      strategy: signal.strategy,
      regime: regimeState.regime,
      compatibilityScore,
      positionMultiplier,
    });

    return {
      allowed: true,
      reason: `Compatible with ${regimeState.regime} regime`,
      originalSignal: signal,
      adjustedSignal,
      positionMultiplier,
      regimeState,
      compatibilityScore,
    };
  }

  /**
   * Get strategy type from strategy name
   */
  private getStrategyType(strategy: string): StrategyType {
    return STRATEGY_TYPES[strategy] || 'neutral';
  }

  /**
   * Check if signal direction aligns with trend
   */
  private checkDirectionAlignment(
    signalDirection: 'buy' | 'sell',
    regimeState: RegimeState
  ): { aligned: boolean; score: number } {
    if (regimeState.trendDirection === 'neutral') {
      return { aligned: true, score: 0.5 };
    }

    const aligned = (
      (signalDirection === 'buy' && regimeState.trendDirection === 'up') ||
      (signalDirection === 'sell' && regimeState.trendDirection === 'down')
    );

    return {
      aligned,
      score: aligned ? 1.0 : 0.0,
    };
  }

  /**
   * Calculate position size multiplier based on regime factors
   */
  private calculatePositionMultiplier(
    compatibilityScore: number,
    regimeConfidence: number,
    strategyType: StrategyType,
    regimeState: RegimeState
  ): number {
    // Start with compatibility score
    let multiplier = compatibilityScore;

    // Boost for high confidence
    if (regimeConfidence > 0.8) {
      multiplier *= 1.1;
    } else if (regimeConfidence < 0.5) {
      multiplier *= 0.8;
    }

    // Boost for strong alignment
    if (
      strategyType === 'trend_following' &&
      (regimeState.regime === 'strong_trend' || regimeState.regime === 'weak_trend')
    ) {
      // Trending + trend strategy = boost
      const alignmentBoost = Math.abs(regimeState.mtfAlignment) * 0.2;
      multiplier = Math.min(1.0, multiplier + alignmentBoost);
    }

    if (
      strategyType === 'mean_reversion' &&
      (regimeState.regime === 'ranging' || regimeState.regime === 'choppy')
    ) {
      // Ranging + MR strategy = boost
      multiplier = Math.min(1.0, multiplier * 1.1);
    }

    // Reduce for high choppiness even in ranging
    if (regimeState.regime === 'choppy' && regimeState.choppiness > 70) {
      multiplier *= 0.7;
    }

    // Apply min/max bounds
    multiplier = Math.max(this.config.minPositionMultiplier, multiplier);
    multiplier = Math.min(this.config.maxPositionMultiplier, multiplier);

    return multiplier;
  }

  /**
   * Get default regime state for when no data available
   */
  private getDefaultRegimeState(): RegimeState {
    return {
      regime: 'choppy',
      confidence: 0,
      trendDirection: 'neutral',
      adx: 0,
      plusDI: 0,
      minusDI: 0,
      atrPercent: 0,
      bbWidth: 0,
      choppiness: 50,
      directionConsistency: 0.5,
      mtfAlignment: 0,
      lastUpdated: new Date(),
      regimeSince: new Date(),
    };
  }

  /**
   * Get filter statistics
   */
  public getStats(): {
    enabled: boolean;
    config: RegimeFilterConfig;
    strategyTypes: Record<string, StrategyType>;
    compatibilityMatrix: typeof REGIME_STRATEGY_COMPAT;
  } {
    return {
      enabled: this.config.enabled,
      config: this.config,
      strategyTypes: STRATEGY_TYPES,
      compatibilityMatrix: REGIME_STRATEGY_COMPAT,
    };
  }

  /**
   * Update configuration
   */
  public updateConfig(config: Partial<RegimeFilterConfig>): void {
    this.config = { ...this.config, ...config };
    this.logger.info('Regime filter config updated', { config: this.config });
  }

  /**
   * Enable/disable filtering
   */
  public setEnabled(enabled: boolean): void {
    this.config.enabled = enabled;
    this.logger.info(`Regime filtering ${enabled ? 'enabled' : 'disabled'}`);
  }
}

