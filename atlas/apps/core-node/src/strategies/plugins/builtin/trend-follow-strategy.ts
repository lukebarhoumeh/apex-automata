/**
 * Trend Follow Strategy Plugin
 * 
 * Higher-timeframe trend-following strategy designed to capture multi-day moves.
 * Uses EMA crossovers on 15m/1h timeframes with trailing stops for extended holds.
 * 
 * Entry Conditions:
 * - Fast EMA crosses above Slow EMA (bullish) or below (bearish)
 * - Price above/below both EMAs for confirmation
 * - Optional: ADX confirms trend strength
 * - Optional: Higher timeframe alignment (1h trend matches 15m signal)
 * 
 * Exit:
 * - Trailing stop based on ATR
 * - Optional: EMA re-cross exit
 * - Time-based exit after max hold period
 * 
 * Best suited for: strong_trend regime
 * Not suited for: choppy, ranging markets
 */

import { BaseStrategy } from '../base-strategy';
import {
  MarketContext,
  StrategySignal,
  StrategyConfigSchema,
  RegimeCompatibility,
  IndicatorRequirement,
} from '../types';

export class TrendFollowStrategy extends BaseStrategy {
  readonly id = 'trend_follow';
  readonly name = 'EMA Trend Follow';
  readonly description = 'Higher-timeframe trend following using EMA crossovers with trailing stops';
  readonly version = '1.0.0';
  readonly author = 'AtlasBot';
  readonly category = 'trend' as const;
  readonly tags = ['trend', 'ema', 'crossover', 'swing', 'higher-timeframe'];

  constructor(config?: Record<string, unknown>) {
    super(config);
    this.initializeWithConfig();
  }

  readonly configSchema: StrategyConfigSchema = {
    parameters: [
      {
        key: 'fastEmaPeriod',
        name: 'Fast EMA Period',
        description: 'Period for the fast EMA',
        type: 'number',
        default: 9,
        min: 3,
        max: 50,
      },
      {
        key: 'slowEmaPeriod',
        name: 'Slow EMA Period',
        description: 'Period for the slow EMA',
        type: 'number',
        default: 21,
        min: 10,
        max: 100,
      },
      {
        key: 'atrPeriod',
        name: 'ATR Period',
        description: 'Period for ATR calculation (used for trailing stop)',
        type: 'number',
        default: 14,
        min: 5,
        max: 50,
      },
      {
        key: 'atrMultiplier',
        name: 'ATR Trailing Stop Multiplier',
        description: 'Multiplier for ATR-based trailing stop distance',
        type: 'number',
        default: 2.5,
        min: 1.0,
        max: 5.0,
        step: 0.5,
      },
      {
        key: 'targetMultiplier',
        name: 'Target Multiplier',
        description: 'Take profit as multiple of stop distance',
        type: 'number',
        default: 3.0,
        min: 1.5,
        max: 6.0,
        step: 0.5,
      },
      {
        key: 'minAdx',
        name: 'Minimum ADX',
        description: 'Minimum ADX value to confirm trend strength (0 to disable)',
        type: 'number',
        default: 0,  // AGGRESSIVE: Disabled ADX filter
        min: 0,
        max: 50,
      },
      {
        key: 'requireMtfAlignment',
        name: 'Require MTF Alignment',
        description: 'Require higher timeframe (1h) EMA alignment',
        type: 'boolean',
        default: false,  // AGGRESSIVE: Disabled MTF requirement
      },
      {
        key: 'crossoverLookback',
        name: 'Crossover Lookback',
        description: 'Number of candles to look back for recent crossover',
        type: 'number',
        default: 10,  // AGGRESSIVE: Look back further for crossovers
        min: 1,
        max: 20,
      },
      {
        key: 'minStrength',
        name: 'Minimum Signal Strength',
        description: 'Minimum strength threshold for signal generation',
        type: 'number',
        default: 0.5,
        min: 0.1,
        max: 1.0,
        step: 0.1,
      },
    ],
  };

  readonly requiredIndicators: IndicatorRequirement[] = [
    { name: 'ema9', required: true, description: 'Fast EMA (9-period by default)' },
    { name: 'ema21', required: true, description: 'Slow EMA (21-period by default)' },
    { name: 'atr', required: true, description: 'ATR for stop/target calculation' },
    { name: 'adx', required: false, description: 'ADX for trend strength confirmation' },
  ];

  readonly regimeCompatibility: RegimeCompatibility[] = [
    {
      regime: 'strong_trend',
      compatibility: 'optimal',
      positionMultiplier: 1.0,
      notes: 'Ideal conditions - trend following excels in strong trends',
    },
    {
      regime: 'weak_trend',
      compatibility: 'compatible',
      positionMultiplier: 0.7,
      notes: 'Workable but reduced position size due to weaker momentum',
    },
    {
      regime: 'ranging',
      compatibility: 'neutral',  // Changed to allow signals with reduced size
      positionMultiplier: 0.3,
      notes: 'High whipsaw risk - use minimal size',
    },
    {
      regime: 'choppy',
      compatibility: 'neutral',  // Changed to allow signals with very small size
      positionMultiplier: 0.15,
      notes: 'Very high risk - use minimal size only',
    },
  ];

  generateSignals(context: MarketContext): StrategySignal[] {
    const signals: StrategySignal[] = [];
    const { symbol } = context;

    // Get config (with per-symbol overrides)
    const fastEmaPeriod = this.getConfig<number>('fastEmaPeriod', 9, symbol);
    const slowEmaPeriod = this.getConfig<number>('slowEmaPeriod', 21, symbol);
    const atrMultiplier = this.getConfig<number>('atrMultiplier', 2.5, symbol);
    const targetMultiplier = this.getConfig<number>('targetMultiplier', 3.0, symbol);
    const minAdx = this.getConfig<number>('minAdx', 0, symbol);  // AGGRESSIVE: Disabled
    const requireMtfAlignment = this.getConfig<boolean>('requireMtfAlignment', false, symbol);  // AGGRESSIVE: Disabled
    const crossoverLookback = this.getConfig<number>('crossoverLookback', 15, symbol);  // AGGRESSIVE: Look back further
    const minStrength = this.getConfig<number>('minStrength', 0.1, symbol);  // AGGRESSIVE: Very low

    // Get indicators
    // Use dynamic indicator names based on config
    const fastEmaKey = `ema${fastEmaPeriod}`;
    const slowEmaKey = `ema${slowEmaPeriod}`;
    
    const fastEma = context.indicators[fastEmaKey] || context.indicators.ema9;
    const slowEma = context.indicators[slowEmaKey] || context.indicators.ema21;
    const atr = context.indicators.atr;
    const adx = context.indicators.adx;

    // Validate required data
    if (!fastEma || !slowEma || !atr) {
      return signals;
    }

    if (fastEma.length < crossoverLookback + 2 || slowEma.length < crossoverLookback + 2) {
      return signals;
    }

    const currentFastEma = fastEma[fastEma.length - 1];
    const currentSlowEma = slowEma[slowEma.length - 1];
    const prevFastEma = fastEma[fastEma.length - 2];
    const prevSlowEma = slowEma[slowEma.length - 2];
    const currentAtr = atr[atr.length - 1];
    const currentAdx = adx?.[adx.length - 1];
    const price = context.latestCandle.close;

    // Check ADX filter if enabled
    if (minAdx > 0 && currentAdx !== undefined && currentAdx < minAdx) {
      return signals; // Trend not strong enough
    }

    // Detect crossover within lookback period
    let bullishCrossover = false;
    let bearishCrossover = false;
    let crossoverBarsAgo = 0;

    for (let i = 1; i <= crossoverLookback; i++) {
      const idx = fastEma.length - 1 - i;
      if (idx < 1) break;

      const prevFast = fastEma[idx - 1];
      const prevSlow = slowEma[idx - 1];
      const currFast = fastEma[idx];
      const currSlow = slowEma[idx];

      // Bullish crossover: fast crosses above slow
      if (prevFast <= prevSlow && currFast > currSlow) {
        bullishCrossover = true;
        crossoverBarsAgo = i;
        break;
      }

      // Bearish crossover: fast crosses below slow
      if (prevFast >= prevSlow && currFast < currSlow) {
        bearishCrossover = true;
        crossoverBarsAgo = i;
        break;
      }
    }

    // Also check current bar for crossover
    if (!bullishCrossover && !bearishCrossover) {
      if (prevFastEma <= prevSlowEma && currentFastEma > currentSlowEma) {
        bullishCrossover = true;
        crossoverBarsAgo = 0;
      } else if (prevFastEma >= prevSlowEma && currentFastEma < currentSlowEma) {
        bearishCrossover = true;
        crossoverBarsAgo = 0;
      }
    }

    if (!bullishCrossover && !bearishCrossover) {
      return signals; // No crossover detected
    }

    // Price confirmation: should be on the right side of both EMAs
    const priceAboveBothEmas = price > currentFastEma && price > currentSlowEma;
    const priceBelowBothEmas = price < currentFastEma && price < currentSlowEma;

    // Check MTF alignment if required
    let mtfAligned = true;
    if (requireMtfAlignment && context.mtfCandles?.h1) {
      // Check if we have 1h EMA data (would need indicator calculation on 1h candles)
      // For now, use trend direction from regime detector as proxy
      const regimeTrend = context.regime.trendDirection;
      if (bullishCrossover && regimeTrend === 'bearish') {
        mtfAligned = false;
      } else if (bearishCrossover && regimeTrend === 'bullish') {
        mtfAligned = false;
      }
    }

    // Calculate signal strength
    let strength = 0.5;

    // Boost for recent crossover
    strength += (crossoverLookback - crossoverBarsAgo) * 0.05;

    // Boost for strong ADX
    if (currentAdx !== undefined) {
      if (currentAdx > 30) strength += 0.15;
      else if (currentAdx > 25) strength += 0.1;
      else if (currentAdx > 20) strength += 0.05;
    }

    // Boost for price confirmation
    if ((bullishCrossover && priceAboveBothEmas) || (bearishCrossover && priceBelowBothEmas)) {
      strength += 0.1;
    }

    // Boost for MTF alignment
    if (mtfAligned) {
      strength += 0.1;
    }

    // Boost for strong regime
    if (context.regime.regime === 'strong_trend') {
      strength += 0.1;
    }

    // Clamp strength
    strength = Math.min(1.0, Math.max(0.1, strength));

    // Check minimum strength
    if (strength < minStrength) {
      return signals;
    }

    // Generate signal
    const stopDistance = currentAtr * atrMultiplier;
    const targetDistance = stopDistance * targetMultiplier;

    if (bullishCrossover && priceAboveBothEmas && mtfAligned) {
      const stopLoss = price - stopDistance;
      const takeProfit = price + targetDistance;

      signals.push(
        this.createSignal({
          symbol,
          direction: 'buy',
          strength,
          price,
          stopLoss,
          takeProfit,
          metadata: {
            fastEma: currentFastEma,
            slowEma: currentSlowEma,
            atr: currentAtr,
            adx: currentAdx,
            crossoverBarsAgo,
            mtfAligned,
            regime: context.regime.regime,
            reason: `Bullish EMA crossover (${fastEmaPeriod}/${slowEmaPeriod}) with price confirmation`,
          },
        })
      );
    } else if (bearishCrossover && priceBelowBothEmas && mtfAligned) {
      const stopLoss = price + stopDistance;
      const takeProfit = price - targetDistance;

      signals.push(
        this.createSignal({
          symbol,
          direction: 'sell',
          strength,
          price,
          stopLoss,
          takeProfit,
          metadata: {
            fastEma: currentFastEma,
            slowEma: currentSlowEma,
            atr: currentAtr,
            adx: currentAdx,
            crossoverBarsAgo,
            mtfAligned,
            regime: context.regime.regime,
            reason: `Bearish EMA crossover (${fastEmaPeriod}/${slowEmaPeriod}) with price confirmation`,
          },
        })
      );
    }

    return signals;
  }

  validateContext(context: MarketContext): { valid: boolean; reason?: string } {
    const fastEma = context.indicators.ema9;
    const slowEma = context.indicators.ema21;
    const atr = context.indicators.atr;

    if (!fastEma || fastEma.length < 25) {
      return { valid: false, reason: 'Insufficient fast EMA data (need 25+ candles)' };
    }

    if (!slowEma || slowEma.length < 25) {
      return { valid: false, reason: 'Insufficient slow EMA data (need 25+ candles)' };
    }

    if (!atr || atr.length < 15) {
      return { valid: false, reason: 'Insufficient ATR data (need 15+ candles)' };
    }

    return { valid: true };
  }
}
