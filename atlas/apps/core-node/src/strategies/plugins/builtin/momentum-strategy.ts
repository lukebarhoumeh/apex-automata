/**
 * Momentum Strategy Plugin
 * 
 * Generates signals based on RSI and MACD momentum indicators.
 * Looks for oversold/overbought conditions with MACD confirmation.
 * 
 * Entry Conditions:
 * - RSI crosses into oversold (<30) or overbought (>70) territory
 * - MACD histogram confirms direction
 * - Optional: MACD crossover confirmation
 * 
 * Exit:
 * - RSI returns to neutral zone
 * - MACD histogram reversal
 */

import { BaseStrategy } from '../base-strategy';
import {
  MarketContext,
  StrategySignal,
  StrategyConfigSchema,
  RegimeCompatibility,
  IndicatorRequirement,
} from '../types';

export class MomentumStrategy extends BaseStrategy {
  readonly id = 'momentum';
  readonly name = 'RSI/MACD Momentum';
  readonly description = 'Momentum strategy using RSI extremes with MACD confirmation';
  readonly version = '1.0.0';
  readonly author = 'AtlasBot';
  readonly category = 'momentum' as const;
  readonly tags = ['rsi', 'macd', 'momentum', 'oscillator'];

  constructor(config?: Record<string, unknown>) {
    super(config);
    this.initializeWithConfig();
  }

  readonly configSchema: StrategyConfigSchema = {
    parameters: [
      {
        key: 'rsiPeriod',
        name: 'RSI Period',
        description: 'Period for RSI calculation',
        type: 'number',
        default: 14,
        min: 5,
        max: 30,
      },
      {
        key: 'rsiOverbought',
        name: 'RSI Overbought',
        description: 'RSI level considered overbought (sell signal)',
        type: 'number',
        default: 60,  // AGGRESSIVE: Lowered from 70 to trigger more sell signals
        min: 55,
        max: 90,
      },
      {
        key: 'rsiOversold',
        name: 'RSI Oversold',
        description: 'RSI level considered oversold (buy signal)',
        type: 'number',
        default: 40,  // AGGRESSIVE: Raised from 30 to trigger more buy signals
        min: 10,
        max: 45,
      },
      {
        key: 'macdFast',
        name: 'MACD Fast Period',
        description: 'Fast EMA period for MACD',
        type: 'number',
        default: 12,
        min: 5,
        max: 20,
      },
      {
        key: 'macdSlow',
        name: 'MACD Slow Period',
        description: 'Slow EMA period for MACD',
        type: 'number',
        default: 26,
        min: 15,
        max: 40,
      },
      {
        key: 'macdSignal',
        name: 'MACD Signal Period',
        description: 'Signal line period for MACD',
        type: 'number',
        default: 9,
        min: 5,
        max: 15,
      },
      {
        key: 'requireMacdConfirm',
        name: 'Require MACD Confirmation',
        description: 'Require MACD histogram to confirm direction',
        type: 'boolean',
        default: false,  // AGGRESSIVE: Disabled to allow more signals
      },
      {
        key: 'requireMacdCrossover',
        name: 'Require MACD Crossover',
        description: 'Require MACD line to cross signal line',
        type: 'boolean',
        default: false,
      },
      {
        key: 'stopAtr',
        name: 'Stop Loss ATR Multiplier',
        description: 'Multiplier for ATR-based stop loss distance',
        type: 'number',
        default: 2.0,
        min: 1.0,
        max: 4.0,
        step: 0.5,
      },
      {
        key: 'takeProfitAtr',
        name: 'Take Profit ATR Multiplier',
        description: 'Take profit distance as multiple of ATR',
        type: 'number',
        default: 4.0,
        min: 1.0,
        max: 8.0,
        step: 0.5,
      },
      {
        key: 'atrMultiplier',
        name: 'ATR Multiplier (legacy)',
        description: 'Legacy alias for stopAtr — prefer stopAtr',
        type: 'number',
        default: 2.0,
        min: 1.0,
        max: 4.0,
        step: 0.5,
      },
    ],
  };

  readonly requiredIndicators: IndicatorRequirement[] = [
    { name: 'rsi', required: true, description: 'Relative Strength Index' },
    { name: 'macd', required: true, description: 'MACD line' },
    { name: 'macdSignal', required: true, description: 'MACD signal line' },
    { name: 'macdHistogram', required: true, description: 'MACD histogram' },
    { name: 'atr', required: true, description: 'ATR for stop calculation' },
  ];

  readonly regimeCompatibility: RegimeCompatibility[] = [
    { 
      regime: 'strong_trend', 
      compatibility: 'compatible', 
      positionMultiplier: 0.8,
      notes: 'Momentum works with trend but may give false overbought/oversold',
    },
    { 
      regime: 'weak_trend', 
      compatibility: 'optimal', 
      positionMultiplier: 1.0,
      notes: 'Momentum oscillators work well in mild trends',
    },
    { 
      regime: 'ranging', 
      compatibility: 'optimal', 
      positionMultiplier: 1.0,
      notes: 'RSI oscillation works great in ranges',
    },
    { 
      regime: 'choppy', 
      compatibility: 'neutral', 
      positionMultiplier: 0.5,
      notes: 'Many false signals in choppy conditions',
    },
  ];

  generateSignals(context: MarketContext): StrategySignal[] {
    const signals: StrategySignal[] = [];
    const { symbol } = context;

    // Get config (with per-symbol overrides from guardrails.yaml)
    const rsiOversold = this.getConfig<number>('rsiOversold', 40, symbol);
    const rsiOverbought = this.getConfig<number>('rsiOverbought', 55, symbol);
    const requireMacdConfirm = this.getConfig<boolean>('requireMacdConfirm', false, symbol);
    const requireMacdCrossover = this.getConfig<boolean>('requireMacdCrossover', false, symbol);
    const stopAtr = this.getConfig<number>('stopAtr', 2.0, symbol);
    const takeProfitAtr = this.getConfig<number>('takeProfitAtr', 4.0, symbol);

    const { indicators } = context;

    // Get indicator values
    const rsi = this.getLatestIndicator(indicators, 'rsi');
    const prevRsi = this.getPrevIndicator(indicators, 'rsi', 1);
    const macdLine = this.getLatestIndicator(indicators, 'macd');
    const prevMacdLine = this.getPrevIndicator(indicators, 'macd', 1);
    const macdSignalLine = this.getLatestIndicator(indicators, 'macdSignal');
    const prevMacdSignal = this.getPrevIndicator(indicators, 'macdSignal', 1);
    const macdHist = this.getLatestIndicator(indicators, 'macdHistogram');
    const prevMacdHist = this.getPrevIndicator(indicators, 'macdHistogram', 1);
    const atr = this.getLatestIndicator(indicators, 'atr');

    if (rsi === undefined || prevRsi === undefined ||
        macdLine === undefined || macdSignalLine === undefined ||
        macdHist === undefined || atr === undefined) {
      return signals;
    }

    const currentPrice = context.latestCandle.close;
    const stopDistance = atr * stopAtr;
    const targetDistance = atr * takeProfitAtr;

    // Check for bullish signal (RSI oversold with MACD confirmation)
    const rsiOversoldNow = rsi <= rsiOversold;
    const rsiWasHigher = prevRsi > rsiOversold;
    const macdBullish = macdHist > 0 || (prevMacdHist !== undefined && macdHist > prevMacdHist);
    const macdCrossedUp = prevMacdLine !== undefined && prevMacdSignal !== undefined &&
      macdLine > macdSignalLine && prevMacdLine <= prevMacdSignal;

    if (rsiOversoldNow && rsiWasHigher) {
      // RSI just entered oversold
      let confirmed = true;

      if (requireMacdConfirm && !macdBullish) {
        confirmed = false;
      }
      if (requireMacdCrossover && !macdCrossedUp) {
        confirmed = false;
      }

      if (confirmed) {
        const strength = this.calculateMomentumStrength(rsi, rsiOversold, 0, macdHist);
        
        const signal = this.createSignal({
          context,
          direction: 'buy',
          strength,
          stopLoss: currentPrice - stopDistance,
          takeProfit: currentPrice + targetDistance,
          reason: `RSI oversold at ${rsi.toFixed(1)} with ${macdBullish ? 'bullish' : 'neutral'} MACD`,
          indicators: {
            rsi,
            macd: macdLine,
            macdSignal: macdSignalLine,
            macdHistogram: macdHist,
            atr,
          },
          metadata: {
            rsiCrossedInto: 'oversold',
            macdConfirmed: macdBullish,
            regimeCompatibility: this.checkRegimeCompatibility(context.regime.regime),
          },
        });

        signals.push(signal);
      }
    }

    // Check for bearish signal (RSI overbought with MACD confirmation)
    const rsiOverboughtNow = rsi >= rsiOverbought;
    const rsiWasLower = prevRsi < rsiOverbought;
    const macdBearish = macdHist < 0 || (prevMacdHist !== undefined && macdHist < prevMacdHist);
    const macdCrossedDown = prevMacdLine !== undefined && prevMacdSignal !== undefined &&
      macdLine < macdSignalLine && prevMacdLine >= prevMacdSignal;

    if (rsiOverboughtNow && rsiWasLower) {
      // RSI just entered overbought
      let confirmed = true;

      if (requireMacdConfirm && !macdBearish) {
        confirmed = false;
      }
      if (requireMacdCrossover && !macdCrossedDown) {
        confirmed = false;
      }

      if (confirmed) {
        const strength = this.calculateMomentumStrength(rsi, 100, rsiOverbought, macdHist);
        
        const signal = this.createSignal({
          context,
          direction: 'sell',
          strength,
          stopLoss: currentPrice + stopDistance,
          takeProfit: currentPrice - targetDistance,
          reason: `RSI overbought at ${rsi.toFixed(1)} with ${macdBearish ? 'bearish' : 'neutral'} MACD`,
          indicators: {
            rsi,
            macd: macdLine,
            macdSignal: macdSignalLine,
            macdHistogram: macdHist,
            atr,
          },
          metadata: {
            rsiCrossedInto: 'overbought',
            macdConfirmed: macdBearish,
            regimeCompatibility: this.checkRegimeCompatibility(context.regime.regime),
          },
        });

        signals.push(signal);
      }
    }

    return signals;
  }

  /**
   * Calculate signal strength based on RSI extremity and MACD magnitude.
   */
  private calculateMomentumStrength(
    rsi: number,
    targetLevel: number,
    baseLevel: number,
    macdHist: number
  ): number {
    // RSI component: how far into extreme territory
    const rsiRange = Math.abs(targetLevel - baseLevel);
    const rsiDistance = Math.abs(rsi - baseLevel);
    const rsiStrength = Math.min(rsiDistance / rsiRange, 1) * 0.7;

    // MACD component: histogram magnitude (normalized roughly)
    const macdStrength = Math.min(Math.abs(macdHist) * 10, 1) * 0.3;

    return Math.min(rsiStrength + macdStrength, 1);
  }
}

