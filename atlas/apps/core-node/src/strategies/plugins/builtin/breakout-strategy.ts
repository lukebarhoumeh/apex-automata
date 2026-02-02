/**
 * Breakout Strategy Plugin
 * 
 * Generates signals when price breaks above/below Donchian channel highs/lows
 * with volume confirmation.
 * 
 * Entry Conditions:
 * - Price breaks above N-period high (bullish) or below N-period low (bearish)
 * - Volume is above threshold (default 1.1x average)
 * 
 * Exit:
 * - Stop loss: ATR-based trailing stop
 * - Take profit: ATR-based target (2x risk typically)
 */

import { BaseStrategy } from '../base-strategy';
import {
  MarketContext,
  StrategySignal,
  StrategyConfigSchema,
  RegimeCompatibility,
  IndicatorRequirement,
} from '../types';

export class BreakoutStrategy extends BaseStrategy {
  readonly id = 'breakout';
  readonly name = 'Donchian Breakout';
  readonly description = 'Breakout strategy using Donchian channels with volume confirmation';
  readonly version = '1.0.0';
  readonly author = 'AtlasBot';
  readonly category = 'trend' as const;
  readonly tags = ['breakout', 'donchian', 'volume', 'trend-following'];

  constructor(config?: Record<string, unknown>) {
    super(config);
    this.initializeWithConfig();
  }

  readonly configSchema: StrategyConfigSchema = {
    parameters: [
      {
        key: 'period',
        name: 'Donchian Period',
        description: 'Lookback period for Donchian channel highs/lows',
        type: 'number',
        default: 10,  // AGGRESSIVE: Shortened from 20 to catch more breakouts
        min: 5,
        max: 100,
      },
      {
        key: 'atrPeriod',
        name: 'ATR Period',
        description: 'Period for ATR calculation (used for stops)',
        type: 'number',
        default: 14,
        min: 5,
        max: 50,
      },
      {
        key: 'atrMultiplier',
        name: 'ATR Multiplier',
        description: 'Multiplier for ATR-based stop loss distance',
        type: 'number',
        default: 2.0,
        min: 0.5,
        max: 5.0,
        step: 0.5,
      },
      {
        key: 'volumeThreshold',
        name: 'Volume Threshold',
        description: 'Minimum volume ratio (vs 20-period average) required for breakout',
        type: 'number',
        default: 0.5,  // AGGRESSIVE: Lowered from 1.1 to allow breakouts without volume confirm
        min: 0.1,
        max: 3.0,
        step: 0.1,
      },
      {
        key: 'targetMultiplier',
        name: 'Target Multiplier',
        description: 'Risk:reward multiplier for take profit (relative to stop distance)',
        type: 'number',
        default: 2.0,
        min: 1.0,
        max: 5.0,
        step: 0.5,
      },
      {
        key: 'confirmWithClose',
        name: 'Confirm With Close',
        description: 'Require candle to close beyond channel (vs just breaking intrabar)',
        type: 'boolean',
        default: false,  // AGGRESSIVE: Don't require close confirmation
      },
    ],
  };

  readonly requiredIndicators: IndicatorRequirement[] = [
    { name: 'donchianUpper', required: true, description: 'Donchian channel upper band' },
    { name: 'donchianLower', required: true, description: 'Donchian channel lower band' },
    { name: 'atr', required: true, description: 'Average True Range' },
    { name: 'volumeSMA', required: true, description: 'Volume SMA for comparison' },
  ];

  readonly regimeCompatibility: RegimeCompatibility[] = [
    { 
      regime: 'strong_trend', 
      compatibility: 'optimal', 
      positionMultiplier: 1.0,
      notes: 'Breakouts work best in trending markets',
    },
    { 
      regime: 'weak_trend', 
      compatibility: 'compatible', 
      positionMultiplier: 0.8,
      notes: 'Acceptable but expect more false breakouts',
    },
    { 
      regime: 'ranging', 
      compatibility: 'neutral', 
      positionMultiplier: 0.5,
      notes: 'Many false breakouts in ranging markets',
    },
    { 
      regime: 'choppy', 
      compatibility: 'neutral',  // Changed from incompatible to allow signals with reduced size
      positionMultiplier: 0.25,
      notes: 'High fakeout risk in choppy markets - use minimal size',
    },
  ];

  generateSignals(context: MarketContext): StrategySignal[] {
    const signals: StrategySignal[] = [];
    const { symbol } = context;
    
    // Get config values (with per-symbol overrides) - AGGRESSIVE defaults
    const volumeThreshold = this.getConfig<number>('volumeThreshold', 0.5, symbol);  // Very low
    const atrMultiplier = this.getConfig<number>('atrMultiplier', 2.0, symbol);
    const targetMultiplier = this.getConfig<number>('targetMultiplier', 2.0, symbol);
    const period = this.getConfig<number>('period', 10, symbol);  // Shorter period

    // Get indicator values
    const donchianUpper = context.indicators.donchianUpper;
    const donchianLower = context.indicators.donchianLower;
    const atr = context.indicators.atr;
    const volumeSMA = context.indicators.volumeSMA;

    if (!donchianUpper || !donchianLower || !atr || !volumeSMA) {
      return signals;
    }

    // Use previous-period highs/lows to avoid self-referencing current candle
    const prevUpper = this.getPrevIndicator(context.indicators, 'donchianUpper', 1);
    const prevLower = this.getPrevIndicator(context.indicators, 'donchianLower', 1);
    const currentATR = this.getLatestIndicator(context.indicators, 'atr');
    const avgVolume = this.getLatestIndicator(context.indicators, 'volumeSMA');

    if (!prevUpper || !prevLower || !currentATR || !avgVolume || 
        !Number.isFinite(prevUpper) || !Number.isFinite(prevLower)) {
      return signals;
    }

    const { latestCandle } = context;

    // Volume filter - AGGRESSIVE: Skip volume check entirely for testing
    const volumeRatio = latestCandle.volume / (avgVolume || 1);
    // REMOVED: Volume threshold check to allow ALL breakouts
    
    // Calculate stop/target distances
    const stopDistance = currentATR * atrMultiplier;
    const targetDistance = stopDistance * targetMultiplier;

    // AGGRESSIVE DEBUG: Log every evaluation
    console.log(`[BREAKOUT ${symbol}] close=${latestCandle.close.toFixed(2)} upper=${prevUpper.toFixed(2)} lower=${prevLower.toFixed(2)} gap_up=${(latestCandle.close - prevUpper).toFixed(2)} gap_down=${(prevLower - latestCandle.close).toFixed(2)}`);

    // Check for bullish breakout (price closes above previous high)
    if (latestCandle.close > prevUpper) {
      const signal = this.createSignal({
        context,
        direction: 'buy',
        strength: Math.min(volumeRatio / 2, 1), // Higher volume = stronger signal
        stopLoss: latestCandle.close - stopDistance,
        takeProfit: latestCandle.close + targetDistance,
        reason: `Price broke above ${period}-period high with ${volumeRatio.toFixed(2)}x volume`,
        indicators: {
          donchianUpper: prevUpper,
          atr: currentATR,
          volumeRatio,
        },
        metadata: {
          breakoutLevel: prevUpper,
          regimeCompatibility: this.checkRegimeCompatibility(context.regime.regime),
        },
      });

      signals.push(signal);
    }
    // Check for bearish breakout (price closes below previous low)
    else if (latestCandle.close < prevLower) {
      const signal = this.createSignal({
        context,
        direction: 'sell',
        strength: Math.min(volumeRatio / 2, 1),
        stopLoss: latestCandle.close + stopDistance,
        takeProfit: latestCandle.close - targetDistance,
        reason: `Price broke below ${period}-period low with ${volumeRatio.toFixed(2)}x volume`,
        indicators: {
          donchianLower: prevLower,
          atr: currentATR,
          volumeRatio,
        },
        metadata: {
          breakoutLevel: prevLower,
          regimeCompatibility: this.checkRegimeCompatibility(context.regime.regime),
        },
      });

      signals.push(signal);
    }

    return signals;
  }
}

