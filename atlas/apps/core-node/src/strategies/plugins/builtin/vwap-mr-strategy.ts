/**
 * VWAP Mean Reversion Strategy Plugin
 * 
 * Generates signals when price deviates significantly from VWAP,
 * betting on reversion to the mean.
 * 
 * Entry Conditions:
 * - Price is N standard deviations below VWAP (long entry)
 * - Price is N standard deviations above VWAP (short entry)
 * - Minimum volume requirement met
 * 
 * Exit:
 * - Target: Return to VWAP
 * - Stop: Beyond entry deviation level
 */

import { BaseStrategy } from '../base-strategy';
import {
  MarketContext,
  StrategySignal,
  StrategyConfigSchema,
  RegimeCompatibility,
  IndicatorRequirement,
} from '../types';

export class VWAPMeanReversionStrategy extends BaseStrategy {
  readonly id = 'vwap_mr';
  readonly name = 'VWAP Mean Reversion';
  readonly description = 'Mean reversion strategy fading extreme moves from VWAP';
  readonly version = '1.0.0';
  readonly author = 'AtlasBot';
  readonly category = 'mean-reversion' as const;
  readonly tags = ['vwap', 'mean-reversion', 'intraday', 'fading'];

  constructor(config?: Record<string, unknown>) {
    super(config);
    this.initializeWithConfig();
  }

  readonly configSchema: StrategyConfigSchema = {
    parameters: [
      {
        key: 'deviationEntry',
        name: 'Entry Deviation',
        description: 'Number of standard deviations from VWAP required for entry',
        type: 'number',
        default: 0.15,  // ULTRA AGGRESSIVE: Trigger on any small deviation
        min: 0.1,
        max: 4.0,
        step: 0.05,
      },
      {
        key: 'deviationExit',
        name: 'Exit Deviation',
        description: 'Target deviation level for exit (0 = return to VWAP)',
        type: 'number',
        default: 0.0,
        min: -1.0,
        max: 1.0,
        step: 0.1,
      },
      {
        key: 'minVolume',
        name: 'Minimum Volume',
        description: 'Minimum candle volume required for signal',
        type: 'number',
        default: 0,
        min: 0,
      },
      {
        key: 'stopMultiplier',
        name: 'Stop Multiplier',
        description: 'How far beyond entry deviation to place stop (in std devs)',
        type: 'number',
        default: 1.0,
        min: 0.5,
        max: 2.0,
        step: 0.1,
      },
      {
        key: 'useBollinger',
        name: 'Use Bollinger Bands',
        description: 'Use Bollinger Bands instead of VWAP deviation',
        type: 'boolean',
        default: false,
      },
      {
        key: 'maxDeviation',
        name: 'Max Deviation',
        description: 'Maximum deviation before signal is considered invalid (overextended)',
        type: 'number',
        default: 4.0,
        min: 2.5,
        max: 6.0,
        step: 0.5,
      },
    ],
  };

  readonly requiredIndicators: IndicatorRequirement[] = [
    { name: 'vwap', required: true, description: 'Volume-Weighted Average Price' },
    { name: 'bbUpper', required: false, description: 'Bollinger Band upper (optional, used when useBollinger=true)' },
    { name: 'bbMiddle', required: false, description: 'Bollinger Band middle/SMA (optional, used when useBollinger=true)' },
    { name: 'bbLower', required: false, description: 'Bollinger Band lower (optional, used when useBollinger=true)' },
    { name: 'atr', required: true, description: 'ATR for stop calculation' },
  ];

  readonly regimeCompatibility: RegimeCompatibility[] = [
    { 
      regime: 'strong_trend', 
      compatibility: 'incompatible', 
      positionMultiplier: 0.0,
      notes: 'Mean reversion fails in strong trends - price may not revert',
    },
    { 
      regime: 'weak_trend', 
      compatibility: 'neutral', 
      positionMultiplier: 0.5,
      notes: 'Can work if entry is extreme enough',
    },
    { 
      regime: 'ranging', 
      compatibility: 'optimal', 
      positionMultiplier: 1.0,
      notes: 'Mean reversion thrives in ranging markets',
    },
    { 
      regime: 'choppy', 
      compatibility: 'compatible', 
      positionMultiplier: 0.7,
      notes: 'Quick moves offer MR opportunities but timing is harder',
    },
  ];

  generateSignals(context: MarketContext): StrategySignal[] {
    const signals: StrategySignal[] = [];
    const { symbol } = context;
    
    // EARLY DEBUG
    console.log(`[VWAP_MR_START ${symbol}] entering generateSignals`);

    // Get config (with per-symbol overrides) - AGGRESSIVE defaults
    const deviationEntry = this.getConfig<number>('deviationEntry', 0.15, symbol);  // Ultra aggressive
    const minVolume = this.getConfig<number>('minVolume', 0, symbol);
    const stopMultiplier = this.getConfig<number>('stopMultiplier', 1.0, symbol);
    const maxDeviation = this.getConfig<number>('maxDeviation', 4.0, symbol);
    const useBollinger = this.getConfig<boolean>('useBollinger', false, symbol);

    const { latestCandle, candles, indicators } = context;

    console.log(`[VWAP_MR ${symbol}] useBollinger=${useBollinger} deviationEntry=${deviationEntry}`);

    // Volume filter - skip for testing
    // if (latestCandle.volume < minVolume) {
    //   return signals;
    // }

    let deviation: number;
    let currentMean: number;
    let stdDev: number;

    if (useBollinger) {
      // Use Bollinger Bands
      const bbUpper = this.getLatestIndicator(indicators, 'bbUpper');
      const bbLower = this.getLatestIndicator(indicators, 'bbLower');
      const bbMiddle = this.getLatestIndicator(indicators, 'bbMiddle');

      if (!bbUpper || !bbLower || !bbMiddle) {
        return signals;
      }

      currentMean = bbMiddle;
      stdDev = (bbUpper - bbMiddle) / 2; // Assuming 2 std dev bands
      deviation = (latestCandle.close - bbMiddle) / stdDev;
    } else {
      // Use VWAP
      const vwap = indicators.vwap;
      console.log(`[VWAP_MR ${symbol}] vwap exists=${!!vwap} length=${vwap?.length || 0}`);
      if (!vwap || vwap.length < 20) {
        console.log(`[VWAP_MR ${symbol}] EXITING: insufficient vwap data`);
        return signals;
      }

      currentMean = vwap[vwap.length - 1];
      stdDev = this.calculateVWAPStdDev(candles, vwap);
      
      if (stdDev === 0) {
        return signals;
      }

      deviation = (latestCandle.close - currentMean) / stdDev;
    }

    // AGGRESSIVE DEBUG: Log every evaluation
    console.log(`[VWAP_MR ${symbol}] price=${latestCandle.close.toFixed(2)} vwap=${currentMean.toFixed(2)} deviation=${deviation.toFixed(3)} threshold=${deviationEntry}`);

    // Check if deviation is too extreme (overextended)
    if (Math.abs(deviation) > maxDeviation) {
      return signals;
    }

    const currentPrice = latestCandle.close;

    // Long signal: price significantly below mean
    if (deviation < -deviationEntry) {
      const stopDistance = stdDev * stopMultiplier;
      
      const signal = this.createSignal({
        context,
        direction: 'buy',
        strength: Math.min(Math.abs(deviation) / 3, 1), // More deviation = stronger signal
        stopLoss: currentPrice - stopDistance,
        takeProfit: currentMean, // Target: return to mean
        reason: `Price ${Math.abs(deviation).toFixed(2)} std devs below ${useBollinger ? 'BB middle' : 'VWAP'}`,
        indicators: {
          [useBollinger ? 'bbMiddle' : 'vwap']: currentMean,
          deviation,
          stdDev,
        },
        metadata: {
          meanLevel: currentMean,
          distanceToMean: currentMean - currentPrice,
          regimeCompatibility: this.checkRegimeCompatibility(context.regime.regime),
        },
      });

      signals.push(signal);
    }
    // Short signal: price significantly above mean
    else if (deviation > deviationEntry) {
      const stopDistance = stdDev * stopMultiplier;
      
      const signal = this.createSignal({
        context,
        direction: 'sell',
        strength: Math.min(Math.abs(deviation) / 3, 1),
        stopLoss: currentPrice + stopDistance,
        takeProfit: currentMean,
        reason: `Price ${deviation.toFixed(2)} std devs above ${useBollinger ? 'BB middle' : 'VWAP'}`,
        indicators: {
          [useBollinger ? 'bbMiddle' : 'vwap']: currentMean,
          deviation,
          stdDev,
        },
        metadata: {
          meanLevel: currentMean,
          distanceToMean: currentPrice - currentMean,
          regimeCompatibility: this.checkRegimeCompatibility(context.regime.regime),
        },
      });

      signals.push(signal);
    }

    return signals;
  }

  /**
   * Calculate standard deviation of price from VWAP.
   */
  private calculateVWAPStdDev(candles: { close: number }[], vwap: number[]): number {
    const recentCandles = candles.slice(-20);
    const recentVWAP = vwap.slice(-20);
    
    if (recentCandles.length !== recentVWAP.length || recentCandles.length < 5) {
      return 0;
    }

    let sumSquaredDiff = 0;
    for (let i = 0; i < recentCandles.length; i++) {
      const diff = recentCandles[i].close - recentVWAP[i];
      sumSquaredDiff += diff * diff;
    }

    return Math.sqrt(sumSquaredDiff / recentCandles.length);
  }
}

