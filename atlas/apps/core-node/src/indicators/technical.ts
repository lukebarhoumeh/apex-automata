/**
 * Technical indicators — auxiliary primitives.
 *
 * SCOPE NOTE (post indicator-standardization, 2026-05):
 *   The seven core indicators (SMA, EMA, RSI, MACD, BollingerBands, ATR, ADX)
 *   used to live here as a hand-rolled, EMA-smoothed implementation. They are
 *   now consolidated into `ValidatedIndicators` (thin wrapper over
 *   `trading-signals`, which uses Wilder's RMA — the textbook ATR/ADX
 *   definition matching TradingView/MetaTrader/etc.).
 *
 *   This file retains only the indicators that are NOT covered by
 *   `trading-signals`: VWAP, Donchian, Choppiness, Bollinger Band Width / %B,
 *   Keltner, StdDev, Volume Profile, Support/Resistance.
 *
 *   The compound indicators that internally need EMA/ATR/BollingerBands
 *   delegate to `ValidatedIndicators` so the entire codebase shares one
 *   single source of truth for the underlying smoothing math.
 *
 *   See `__tests__/indicator-snapshot.test.ts` for the locked-in regression
 *   numbers that protect against future drift.
 */

import { ValidatedIndicators } from './validated-indicators.js';

export interface OHLCV {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export class TechnicalIndicators {
  /**
   * Simple Moving Average — kept here only because StandardDeviation,
   * BollingerBandWidth and BollingerPercentB internally need an SMA-aligned
   * series. Public callers should prefer `ValidatedIndicators.SMA`.
   */
  public static SMA(data: number[], period: number): number[] {
    const result: number[] = [];
    if (period <= 0 || data.length < period) {
      return result;
    }
    for (let i = period - 1; i < data.length; i++) {
      let sum = 0;
      for (let j = 0; j < period; j++) {
        sum += data[i - j];
      }
      result.push(sum / period);
    }
    return result;
  }

  // VWAP (Volume Weighted Average Price)
  public static VWAP(candles: OHLCV[]): number[] {
    const result: number[] = [];
    if (candles.length === 0) {
      return result;
    }
    let cumulativeTPV = 0;
    let cumulativeVolume = 0;

    let lastDay = new Date(candles[0].time).toISOString().split('T')[0];

    for (const candle of candles) {
      const currentDay = new Date(candle.time).toISOString().split('T')[0];

      if (currentDay !== lastDay) {
        cumulativeTPV = 0;
        cumulativeVolume = 0;
        lastDay = currentDay;
      }

      const typicalPrice = (candle.high + candle.low + candle.close) / 3;
      cumulativeTPV += typicalPrice * candle.volume;
      cumulativeVolume += candle.volume;

      const vwap = cumulativeVolume > 0 ? cumulativeTPV / cumulativeVolume : typicalPrice;
      result.push(vwap);
    }

    return result;
  }

  // Donchian Channels
  public static DonchianChannels(
    candles: OHLCV[],
    period: number = 20
  ): { upper: number[]; lower: number[]; middle: number[] } {
    const upper: number[] = [];
    const lower: number[] = [];
    const middle: number[] = [];
    if (candles.length < period) {
      return { upper, lower, middle };
    }

    for (let i = period - 1; i < candles.length; i++) {
      let highest = -Infinity;
      let lowest = Infinity;

      for (let j = 0; j < period; j++) {
        highest = Math.max(highest, candles[i - j].high);
        lowest = Math.min(lowest, candles[i - j].low);
      }

      upper.push(highest);
      lower.push(lowest);
      middle.push((highest + lowest) / 2);
    }

    return { upper, lower, middle };
  }

  // Standard Deviation
  public static StandardDeviation(data: number[], period: number): number[] {
    const result: number[] = [];
    if (period <= 0 || data.length < period) {
      return result;
    }
    const sma = this.SMA(data, period);

    for (let i = period - 1; i < data.length; i++) {
      let sum = 0;
      for (let j = 0; j < period; j++) {
        sum += Math.pow(data[i - j] - sma[i - (period - 1)], 2);
      }
      result.push(Math.sqrt(sum / period));
    }

    return result;
  }

  // Volume analysis
  public static VolumeProfile(candles: OHLCV[], bins: number = 20): Map<number, number> {
    const profile = new Map<number, number>();
    if (candles.length === 0 || bins <= 0) {
      return profile;
    }

    let minPrice = Infinity;
    let maxPrice = -Infinity;
    for (const candle of candles) {
      minPrice = Math.min(minPrice, candle.low);
      maxPrice = Math.max(maxPrice, candle.high);
    }

    const binSize = (maxPrice - minPrice) / bins;
    if (binSize === 0) {
      return profile;
    }

    for (let i = 0; i < bins; i++) {
      const binPrice = minPrice + i * binSize + binSize / 2;
      profile.set(binPrice, 0);
    }

    for (const candle of candles) {
      const binIndex = Math.floor((candle.close - minPrice) / binSize);
      const binPrice = minPrice + binIndex * binSize + binSize / 2;
      const currentVolume = profile.get(binPrice) || 0;
      profile.set(binPrice, currentVolume + candle.volume);
    }

    return profile;
  }

  // Support and Resistance levels
  public static SupportResistance(
    candles: OHLCV[],
    lookback: number = 20,
    threshold: number = 0.02
  ): { support: number[]; resistance: number[] } {
    const support: number[] = [];
    const resistance: number[] = [];
    if (candles.length < lookback * 2 + 1) {
      return { support, resistance };
    }

    for (let i = lookback; i < candles.length - lookback; i++) {
      let isSupport = true;
      let isResistance = true;

      for (let j = 1; j <= lookback; j++) {
        if (candles[i - j].low < candles[i].low || candles[i + j].low < candles[i].low) {
          isSupport = false;
          break;
        }
      }

      for (let j = 1; j <= lookback; j++) {
        if (candles[i - j].high > candles[i].high || candles[i + j].high > candles[i].high) {
          isResistance = false;
          break;
        }
      }

      if (isSupport) {
        support.push(candles[i].low);
      }

      if (isResistance) {
        resistance.push(candles[i].high);
      }
    }

    const filteredSupport = this.filterLevels(support, threshold);
    const filteredResistance = this.filterLevels(resistance, threshold);

    return { support: filteredSupport, resistance: filteredResistance };
  }

  private static filterLevels(levels: number[], threshold: number): number[] {
    if (levels.length === 0) return [];

    const sorted = [...levels].sort((a, b) => a - b);
    const filtered: number[] = [sorted[0]];

    for (let i = 1; i < sorted.length; i++) {
      const lastLevel = filtered[filtered.length - 1];
      const percentDiff = Math.abs(sorted[i] - lastLevel) / lastLevel;

      if (percentDiff > threshold) {
        filtered.push(sorted[i]);
      }
    }

    return filtered;
  }

  /**
   * Bollinger Band Width — measures volatility squeeze/expansion.
   * Width = (Upper - Lower) / Middle * 100.
   * Delegates to ValidatedIndicators.BollingerBands so the underlying SMA
   * + StdDev math is the canonical implementation.
   */
  public static BollingerBandWidth(
    data: number[],
    period: number = 20,
    stdDev: number = 2
  ): number[] {
    const bb = ValidatedIndicators.BollingerBands(data, period, stdDev);
    const width: number[] = [];

    for (let i = 0; i < bb.upper.length; i++) {
      const middle = bb.middle[i];
      if (middle === 0) {
        width.push(0);
        continue;
      }
      width.push(((bb.upper[i] - bb.lower[i]) / middle) * 100);
    }

    return width;
  }

  /**
   * Bollinger Band %B — where price is within the bands.
   * 0 = at lower band, 1 = at upper band, 0.5 = at middle.
   * Delegates to ValidatedIndicators.BollingerBands.
   */
  public static BollingerPercentB(
    data: number[],
    period: number = 20,
    stdDev: number = 2
  ): number[] {
    const bb = ValidatedIndicators.BollingerBands(data, period, stdDev);
    const percentB: number[] = [];
    const startIndex = period - 1;

    for (let i = 0; i < bb.upper.length; i++) {
      const range = bb.upper[i] - bb.lower[i];
      if (range === 0) {
        percentB.push(0.5);
        continue;
      }
      percentB.push((data[startIndex + i] - bb.lower[i]) / range);
    }

    return percentB;
  }

  /**
   * Keltner Channels — ATR-based channels for trend/breakout detection.
   * Delegates ATR + EMA to ValidatedIndicators (Wilder RMA + canonical EMA).
   */
  public static KeltnerChannels(
    candles: OHLCV[],
    emaPeriod: number = 20,
    atrPeriod: number = 10,
    atrMultiplier: number = 2
  ): { upper: number[]; middle: number[]; lower: number[] } {
    const closes = candles.map((c) => c.close);
    const middle = ValidatedIndicators.EMA(closes, emaPeriod);
    const atr = ValidatedIndicators.ATR(candles, atrPeriod);

    const upper: number[] = [];
    const lower: number[] = [];

    // trading-signals emits values once each indicator stabilizes; align tails.
    const len = Math.min(middle.length, atr.length);
    const middleTail = middle.slice(middle.length - len);
    const atrTail = atr.slice(atr.length - len);

    for (let i = 0; i < len; i++) {
      const m = middleTail[i];
      const a = atrTail[i];
      upper.push(m + a * atrMultiplier);
      lower.push(m - a * atrMultiplier);
    }

    return { upper, middle: middleTail, lower };
  }

  /**
   * Choppiness Index — measures market chop/consolidation (0-100).
   * High values (> 61.8) = choppy, low values (< 38.2) = trending.
   * True ranges are computed inline (not the smoothed ATR series), so this
   * stays self-contained and unaffected by the ATR smoothing change.
   */
  public static ChoppinessIndex(candles: OHLCV[], period: number = 14): number[] {
    if (candles.length <= period) {
      return [];
    }

    const result: number[] = [];
    const trueRanges: number[] = [];

    for (let i = 1; i < candles.length; i++) {
      const highLow = candles[i].high - candles[i].low;
      const highPrevClose = Math.abs(candles[i].high - candles[i - 1].close);
      const lowPrevClose = Math.abs(candles[i].low - candles[i - 1].close);
      trueRanges.push(Math.max(highLow, highPrevClose, lowPrevClose));
    }

    for (let i = period; i < candles.length; i++) {
      let atrSum = 0;
      for (let j = i - period; j < i; j++) {
        atrSum += trueRanges[j - 1] || 0;
      }

      let highestHigh = -Infinity;
      let lowestLow = Infinity;
      for (let j = i - period; j <= i; j++) {
        highestHigh = Math.max(highestHigh, candles[j].high);
        lowestLow = Math.min(lowestLow, candles[j].low);
      }

      const range = highestHigh - lowestLow;
      if (range === 0) {
        result.push(50);
        continue;
      }

      const chop = (100 * Math.log10(atrSum / range)) / Math.log10(period);
      result.push(Math.max(0, Math.min(100, chop)));
    }

    return result;
  }
}
