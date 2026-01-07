/**
 * RegimeDetector - HFT-grade market regime classification
 * 
 * Detects market regimes using multiple quantitative indicators:
 * - ADX for trend strength
 * - ATR% for volatility
 * - Bollinger Band width for squeeze/expansion
 * - Choppiness Index for consolidation
 * - Directional consistency for trend clarity
 * 
 * Outputs: 'strong_trend' | 'weak_trend' | 'ranging' | 'choppy'
 */

import { EventEmitter } from 'events';
import { Logger } from '../core/logger';
import { TechnicalIndicators, OHLCV } from '../indicators/technical';
import { Gauge, Counter } from 'prom-client';

// Prometheus metrics
const regimeGauge = new Gauge({
  name: 'atlas_market_regime',
  help: 'Current market regime (0=choppy, 1=ranging, 2=weak_trend, 3=strong_trend)',
  labelNames: ['symbol'],
});

const regimeConfidenceGauge = new Gauge({
  name: 'atlas_regime_confidence',
  help: 'Confidence score of regime classification (0-1)',
  labelNames: ['symbol'],
});

const regimeChangeCounter = new Counter({
  name: 'atlas_regime_changes_total',
  help: 'Total number of regime changes',
  labelNames: ['symbol', 'from', 'to'],
});

const adxGauge = new Gauge({
  name: 'atlas_adx_value',
  help: 'Current ADX value',
  labelNames: ['symbol'],
});

const choppinessGauge = new Gauge({
  name: 'atlas_choppiness_index',
  help: 'Current Choppiness Index value',
  labelNames: ['symbol'],
});

const bbWidthGauge = new Gauge({
  name: 'atlas_bb_width_pct',
  help: 'Current Bollinger Band width percentage',
  labelNames: ['symbol'],
});

export type MarketRegime = 'strong_trend' | 'weak_trend' | 'ranging' | 'choppy';

export interface RegimeState {
  regime: MarketRegime;
  confidence: number;        // 0-1, how confident we are in the classification
  trendDirection: 'up' | 'down' | 'neutral';
  
  // Raw metrics
  adx: number;
  plusDI: number;
  minusDI: number;
  atrPercent: number;
  bbWidth: number;
  choppiness: number;
  directionConsistency: number;  // 0-1, how consistent recent price moves are
  
  // Multi-timeframe alignment
  mtfAlignment: number;  // -1 to 1 (negative = bearish, positive = bullish alignment)
  
  // Timestamps
  lastUpdated: Date;
  regimeSince: Date;
}

export interface RegimeDetectorConfig {
  // ADX thresholds
  adxStrongTrend: number;    // ADX > this = strong trend (default: 35)
  adxWeakTrend: number;      // ADX > this = weak trend (default: 25)
  adxRanging: number;        // ADX < this = ranging (default: 20)
  
  // Choppiness thresholds
  chopHighThreshold: number; // > this = choppy (default: 61.8 - Fibonacci)
  chopLowThreshold: number;  // < this = trending (default: 38.2 - Fibonacci)
  
  // ATR% thresholds
  atrHighVolatility: number; // > this = high volatility (default: 0.02 = 2%)
  atrLowVolatility: number;  // < this = low volatility (default: 0.005 = 0.5%)
  
  // BB width thresholds
  bbSqueezeThreshold: number;    // < this = squeeze (default: 2%)
  bbExpansionThreshold: number;  // > this = expansion (default: 5%)
  
  // Lookback periods
  directionLookback: number;     // Candles to check for direction consistency
  smoothingPeriod: number;       // Smooth regime transitions
}

const DEFAULT_CONFIG: RegimeDetectorConfig = {
  adxStrongTrend: 35,
  adxWeakTrend: 25,
  adxRanging: 20,
  chopHighThreshold: 61.8,
  chopLowThreshold: 38.2,
  atrHighVolatility: 0.02,
  atrLowVolatility: 0.005,
  bbSqueezeThreshold: 2,
  bbExpansionThreshold: 5,
  directionLookback: 10,
  smoothingPeriod: 3,
};

export class RegimeDetector extends EventEmitter {
  private config: RegimeDetectorConfig;
  private logger: Logger;
  
  // State per symbol
  private regimeState: Map<string, RegimeState> = new Map();
  private regimeHistory: Map<string, MarketRegime[]> = new Map();
  
  constructor(config: Partial<RegimeDetectorConfig>, logger: Logger) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.logger = logger;
  }

  /**
   * Update regime detection with new candle data
   */
  public update(symbol: string, candles: OHLCV[], mtfCandles?: {
    m5?: OHLCV[];
    m15?: OHLCV[];
    h1?: OHLCV[];
  }): RegimeState {
    if (candles.length < 50) {
      // Not enough data - return neutral state
      return this.getNeutralState(symbol);
    }

    const closes = candles.map(c => c.close);
    const currentPrice = candles[candles.length - 1].close;

    // Calculate all indicators
    const adxResult = TechnicalIndicators.ADX(candles, 14);
    const atrValues = TechnicalIndicators.ATR(candles, 14);
    const bbWidth = TechnicalIndicators.BollingerBandWidth(closes, 20, 2);
    const choppiness = TechnicalIndicators.ChoppinessIndex(candles, 14);

    // Get latest values
    const adx = adxResult.adx.length > 0 ? adxResult.adx[adxResult.adx.length - 1] : 0;
    const plusDI = adxResult.plusDI.length > 0 ? adxResult.plusDI[adxResult.plusDI.length - 1] : 0;
    const minusDI = adxResult.minusDI.length > 0 ? adxResult.minusDI[adxResult.minusDI.length - 1] : 0;
    const atr = atrValues.length > 0 ? atrValues[atrValues.length - 1] : 0;
    const atrPercent = currentPrice > 0 ? atr / currentPrice : 0;
    const bbw = bbWidth.length > 0 ? bbWidth[bbWidth.length - 1] : 0;
    const chop = choppiness.length > 0 ? choppiness[choppiness.length - 1] : 50;

    // Calculate direction consistency
    const directionConsistency = this.calculateDirectionConsistency(candles);
    
    // Calculate multi-timeframe alignment
    const mtfAlignment = mtfCandles ? this.calculateMTFAlignment(candles, mtfCandles) : 0;

    // Determine trend direction
    const trendDirection = this.determineTrendDirection(plusDI, minusDI, candles);

    // Classify regime using weighted scoring
    const { regime, confidence } = this.classifyRegime({
      adx,
      atrPercent,
      bbWidth: bbw,
      choppiness: chop,
      directionConsistency,
      mtfAlignment,
    });

    // Get previous state for comparison
    const prevState = this.regimeState.get(symbol);
    const regimeChanged = prevState && prevState.regime !== regime;

    // Update state
    const newState: RegimeState = {
      regime,
      confidence,
      trendDirection,
      adx,
      plusDI,
      minusDI,
      atrPercent,
      bbWidth: bbw,
      choppiness: chop,
      directionConsistency,
      mtfAlignment,
      lastUpdated: new Date(),
      regimeSince: regimeChanged || !prevState ? new Date() : prevState.regimeSince,
    };

    // Update history for smoothing
    this.updateRegimeHistory(symbol, regime);
    
    // Apply smoothing - only change regime if consistent
    const smoothedRegime = this.getSmoothedRegime(symbol);
    if (smoothedRegime && smoothedRegime !== newState.regime) {
      newState.regime = smoothedRegime;
      newState.confidence *= 0.8; // Reduce confidence when smoothing
    }

    this.regimeState.set(symbol, newState);

    // Update Prometheus metrics
    this.updateMetrics(symbol, newState);

    // Emit events
    if (regimeChanged && prevState) {
      regimeChangeCounter.inc({ symbol, from: prevState.regime, to: regime });
      this.emit('regime:changed', symbol, prevState.regime, regime, newState);
      this.logger.info('Market regime changed', {
        symbol,
        from: prevState.regime,
        to: regime,
        confidence: newState.confidence.toFixed(2),
        adx: adx.toFixed(1),
        chop: chop.toFixed(1),
      });
    }

    this.emit('regime:updated', symbol, newState);

    return newState;
  }

  /**
   * Calculate direction consistency over lookback period
   */
  private calculateDirectionConsistency(candles: OHLCV[]): number {
    const lookback = Math.min(this.config.directionLookback, candles.length - 1);
    if (lookback < 2) return 0.5;

    const recentCandles = candles.slice(-lookback - 1);
    let upMoves = 0;
    let downMoves = 0;

    for (let i = 1; i < recentCandles.length; i++) {
      if (recentCandles[i].close > recentCandles[i - 1].close) {
        upMoves++;
      } else if (recentCandles[i].close < recentCandles[i - 1].close) {
        downMoves++;
      }
    }

    const totalMoves = upMoves + downMoves;
    if (totalMoves === 0) return 0.5;

    // Consistency = how dominant one direction is
    return Math.max(upMoves, downMoves) / totalMoves;
  }

  /**
   * Calculate multi-timeframe trend alignment
   * Returns -1 (all bearish) to 1 (all bullish)
   */
  private calculateMTFAlignment(
    m1Candles: OHLCV[],
    mtf: { m5?: OHLCV[]; m15?: OHLCV[]; h1?: OHLCV[] }
  ): number {
    const trends: number[] = [];

    // 1-minute trend
    trends.push(this.getSimpleTrend(m1Candles));

    // 5-minute trend
    if (mtf.m5 && mtf.m5.length >= 20) {
      trends.push(this.getSimpleTrend(mtf.m5));
    }

    // 15-minute trend
    if (mtf.m15 && mtf.m15.length >= 20) {
      trends.push(this.getSimpleTrend(mtf.m15));
    }

    // 1-hour trend (weighted more heavily)
    if (mtf.h1 && mtf.h1.length >= 10) {
      const h1Trend = this.getSimpleTrend(mtf.h1);
      trends.push(h1Trend);
      trends.push(h1Trend); // Double weight for hourly
    }

    if (trends.length === 0) return 0;

    return trends.reduce((a, b) => a + b, 0) / trends.length;
  }

  /**
   * Get simple trend direction: -1 (down), 0 (neutral), 1 (up)
   */
  private getSimpleTrend(candles: OHLCV[]): number {
    if (candles.length < 10) return 0;

    const closes = candles.map(c => c.close);
    const sma10 = TechnicalIndicators.SMA(closes, 10);
    const sma20 = TechnicalIndicators.SMA(closes, 20);

    if (sma10.length === 0 || sma20.length === 0) return 0;

    const currentSMA10 = sma10[sma10.length - 1];
    const currentSMA20 = sma20[sma20.length - 1];
    const currentPrice = closes[closes.length - 1];

    // Strong trend: price > SMA10 > SMA20 (bullish) or price < SMA10 < SMA20 (bearish)
    if (currentPrice > currentSMA10 && currentSMA10 > currentSMA20) {
      return 1;
    } else if (currentPrice < currentSMA10 && currentSMA10 < currentSMA20) {
      return -1;
    }

    return 0;
  }

  /**
   * Determine trend direction from DI values and price action
   */
  private determineTrendDirection(
    plusDI: number,
    minusDI: number,
    candles: OHLCV[]
  ): 'up' | 'down' | 'neutral' {
    const diDiff = plusDI - minusDI;
    
    // Need significant DI difference
    if (Math.abs(diDiff) < 5) {
      return 'neutral';
    }

    // Confirm with price action
    if (candles.length >= 3) {
      const recentCloses = candles.slice(-3).map(c => c.close);
      const priceUp = recentCloses[2] > recentCloses[0];
      const priceDown = recentCloses[2] < recentCloses[0];

      if (diDiff > 0 && priceUp) return 'up';
      if (diDiff < 0 && priceDown) return 'down';
    }

    return diDiff > 0 ? 'up' : 'down';
  }

  /**
   * Classify regime using weighted scoring from multiple indicators
   */
  private classifyRegime(metrics: {
    adx: number;
    atrPercent: number;
    bbWidth: number;
    choppiness: number;
    directionConsistency: number;
    mtfAlignment: number;
  }): { regime: MarketRegime; confidence: number } {
    const scores = {
      strong_trend: 0,
      weak_trend: 0,
      ranging: 0,
      choppy: 0,
    };

    // ADX scoring (weight: 30%)
    if (metrics.adx >= this.config.adxStrongTrend) {
      scores.strong_trend += 0.30;
    } else if (metrics.adx >= this.config.adxWeakTrend) {
      scores.weak_trend += 0.30;
    } else if (metrics.adx <= this.config.adxRanging) {
      scores.ranging += 0.20;
      scores.choppy += 0.10;
    } else {
      scores.weak_trend += 0.15;
      scores.ranging += 0.15;
    }

    // Choppiness Index scoring (weight: 25%)
    if (metrics.choppiness >= this.config.chopHighThreshold) {
      scores.choppy += 0.25;
    } else if (metrics.choppiness <= this.config.chopLowThreshold) {
      scores.strong_trend += 0.15;
      scores.weak_trend += 0.10;
    } else {
      scores.ranging += 0.15;
      scores.weak_trend += 0.10;
    }

    // Direction consistency scoring (weight: 20%)
    if (metrics.directionConsistency >= 0.8) {
      scores.strong_trend += 0.20;
    } else if (metrics.directionConsistency >= 0.6) {
      scores.weak_trend += 0.15;
      scores.strong_trend += 0.05;
    } else if (metrics.directionConsistency <= 0.55) {
      scores.choppy += 0.15;
      scores.ranging += 0.05;
    } else {
      scores.ranging += 0.10;
      scores.weak_trend += 0.10;
    }

    // BB Width scoring (weight: 15%)
    if (metrics.bbWidth <= this.config.bbSqueezeThreshold) {
      // Squeeze - potential breakout, but currently ranging
      scores.ranging += 0.15;
    } else if (metrics.bbWidth >= this.config.bbExpansionThreshold) {
      // Expansion - trending
      scores.strong_trend += 0.10;
      scores.weak_trend += 0.05;
    } else {
      scores.weak_trend += 0.08;
      scores.ranging += 0.07;
    }

    // MTF Alignment scoring (weight: 10%)
    const mtfStrength = Math.abs(metrics.mtfAlignment);
    if (mtfStrength >= 0.8) {
      scores.strong_trend += 0.10;
    } else if (mtfStrength >= 0.5) {
      scores.weak_trend += 0.10;
    } else if (mtfStrength <= 0.2) {
      scores.choppy += 0.05;
      scores.ranging += 0.05;
    } else {
      scores.ranging += 0.10;
    }

    // Find the winning regime
    let maxScore = 0;
    let regime: MarketRegime = 'choppy';
    
    for (const [r, score] of Object.entries(scores)) {
      if (score > maxScore) {
        maxScore = score;
        regime = r as MarketRegime;
      }
    }

    // Calculate confidence based on score margin
    const sortedScores = Object.values(scores).sort((a, b) => b - a);
    const margin = sortedScores[0] - sortedScores[1];
    const confidence = Math.min(1, 0.5 + margin * 2); // Base 50% + margin boost

    return { regime, confidence };
  }

  /**
   * Update regime history for smoothing
   */
  private updateRegimeHistory(symbol: string, regime: MarketRegime): void {
    if (!this.regimeHistory.has(symbol)) {
      this.regimeHistory.set(symbol, []);
    }

    const history = this.regimeHistory.get(symbol)!;
    history.push(regime);

    // Keep only recent history
    while (history.length > this.config.smoothingPeriod * 2) {
      history.shift();
    }
  }

  /**
   * Get smoothed regime (only change if consistent over smoothing period)
   */
  private getSmoothedRegime(symbol: string): MarketRegime | null {
    const history = this.regimeHistory.get(symbol);
    if (!history || history.length < this.config.smoothingPeriod) {
      return null;
    }

    const recent = history.slice(-this.config.smoothingPeriod);
    const counts: Record<MarketRegime, number> = {
      strong_trend: 0,
      weak_trend: 0,
      ranging: 0,
      choppy: 0,
    };

    for (const r of recent) {
      counts[r]++;
    }

    // Need majority for smooth transition
    for (const [regime, count] of Object.entries(counts)) {
      if (count >= this.config.smoothingPeriod * 0.67) {
        return regime as MarketRegime;
      }
    }

    return null;
  }

  /**
   * Get neutral state for insufficient data
   */
  private getNeutralState(symbol: string): RegimeState {
    const prevState = this.regimeState.get(symbol);
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
      regimeSince: prevState?.regimeSince || new Date(),
    };
  }

  /**
   * Update Prometheus metrics
   */
  private updateMetrics(symbol: string, state: RegimeState): void {
    const regimeValue = {
      choppy: 0,
      ranging: 1,
      weak_trend: 2,
      strong_trend: 3,
    }[state.regime];

    regimeGauge.set({ symbol }, regimeValue);
    regimeConfidenceGauge.set({ symbol }, state.confidence);
    adxGauge.set({ symbol }, state.adx);
    choppinessGauge.set({ symbol }, state.choppiness);
    bbWidthGauge.set({ symbol }, state.bbWidth);
  }

  /**
   * Get current regime state for a symbol
   */
  public getState(symbol: string): RegimeState | undefined {
    return this.regimeState.get(symbol);
  }

  /**
   * Get current regime (simple accessor)
   */
  public getRegime(symbol: string): MarketRegime {
    return this.regimeState.get(symbol)?.regime || 'choppy';
  }

  /**
   * Check if market is trending (strong or weak)
   */
  public isTrending(symbol: string): boolean {
    const regime = this.getRegime(symbol);
    return regime === 'strong_trend' || regime === 'weak_trend';
  }

  /**
   * Check if market is ranging or choppy
   */
  public isRanging(symbol: string): boolean {
    const regime = this.getRegime(symbol);
    return regime === 'ranging' || regime === 'choppy';
  }

  /**
   * Get all regime states
   */
  public getAllStates(): Map<string, RegimeState> {
    return new Map(this.regimeState);
  }

  /**
   * Reset state for a symbol
   */
  public reset(symbol: string): void {
    this.regimeState.delete(symbol);
    this.regimeHistory.delete(symbol);
  }

  /**
   * Reset all state
   */
  public resetAll(): void {
    this.regimeState.clear();
    this.regimeHistory.clear();
  }
}

