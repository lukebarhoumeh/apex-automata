/**
 * Validated Indicators — Batch Computation via trading-signals (v7+)
 *
 * Single canonical source of truth for SMA / EMA / RSI / MACD /
 * BollingerBands / ATR / ADX. Strategies, RegimeDetector and MetricsTracker
 * all consume from here so they can never disagree on the math.
 *
 * v7 API: results are native numbers (no Big.js, no .toNumber()).
 * MACD constructor: new MACD(shortEMA, longEMA, signalEMA).
 *
 * Note on ATR/ADX: trading-signals uses Wilder's RMA (the textbook ADX/ATR
 * definition matching TradingView/MetaTrader). The previously-shipped
 * `TechnicalIndicators` versions used EMA smoothing, drifting ~10% on the
 * first 30-50 bars and converging to <1% past 100 bars.
 */

import { SMA, EMA, RSI, MACD, BollingerBands, ADX, ATR } from 'trading-signals';
import type { OHLCV } from './technical.js';

export class ValidatedIndicators {
  public static SMA(data: number[], period: number): number[] {
    if (period <= 0 || data.length < period) return [];
    const indicator = new SMA(period);
    const result: number[] = [];
    for (const value of data) {
      const r = indicator.add(value);
      if (r !== null) result.push(r);
    }
    return result;
  }

  public static EMA(data: number[], period: number): number[] {
    if (period <= 0 || data.length < period) return [];
    const indicator = new EMA(period);
    const result: number[] = [];
    for (const value of data) {
      const r = indicator.add(value);
      if (r !== null) result.push(r);
    }
    return result;
  }

  public static RSI(data: number[], period: number = 14): number[] {
    if (data.length <= period) return [];
    const indicator = new RSI(period);
    const result: number[] = [];
    for (const value of data) {
      const r = indicator.add(value);
      if (r !== null) result.push(r);
    }
    return result;
  }

  public static MACD(
    data: number[],
    fastPeriod: number = 12,
    slowPeriod: number = 26,
    signalPeriod: number = 9
  ): { macd: number[]; signal: number[]; histogram: number[] } {
    if (data.length < Math.max(fastPeriod, slowPeriod)) {
      return { macd: [], signal: [], histogram: [] };
    }
    const indicator = new MACD(
      new EMA(fastPeriod),
      new EMA(slowPeriod),
      new EMA(signalPeriod),
    );
    const macd: number[] = [];
    const signal: number[] = [];
    const histogram: number[] = [];
    for (const value of data) {
      const r = indicator.add(value);
      if (r !== null) {
        macd.push(r.macd);
        signal.push(r.signal);
        histogram.push(r.histogram);
      }
    }
    return { macd, signal, histogram };
  }

  public static BollingerBands(
    data: number[],
    period: number = 20,
    stdDev: number = 2
  ): { upper: number[]; middle: number[]; lower: number[] } {
    if (data.length < period) {
      return { upper: [], middle: [], lower: [] };
    }
    const indicator = new BollingerBands(period, stdDev);
    const upper: number[] = [];
    const middle: number[] = [];
    const lower: number[] = [];
    for (const value of data) {
      const r = indicator.add(value);
      if (r !== null) {
        upper.push(r.upper);
        middle.push(r.middle);
        lower.push(r.lower);
      }
    }
    return { upper, middle, lower };
  }

  public static ATR(candles: OHLCV[], period: number = 14): number[] {
    if (candles.length <= 1) return [];
    const indicator = new ATR(period);
    const result: number[] = [];
    for (const candle of candles) {
      const r = indicator.add({ high: candle.high, low: candle.low, close: candle.close });
      if (r !== null) result.push(r);
    }
    return result;
  }

  /**
   * ADX with +DI/-DI.
   *
   * trading-signals v7 exposes `.pdi` and `.mdi` on the ADX instance as
   * RATIOS (0-1, i.e. moves_up / ATR). The TradingView / Wilder convention
   * — and what every other consumer in this codebase expects — is the
   * 0-100 scale, where >25 = trending, ~50 = strong move. We multiply
   * here so callers don't have to know about the underlying library quirk.
   *
   * Sanity check on a 100-bar trending fixture: trading-signals raw
   * pdi=0.50/mdi=0.05 → returned as plusDI=50/minusDI=5, matching the
   * old hand-rolled implementation's scale.
   */
  public static ADX(candles: OHLCV[], period: number = 14): {
    adx: number[];
    plusDI: number[];
    minusDI: number[];
  } {
    if (candles.length <= period + 1) {
      return { adx: [], plusDI: [], minusDI: [] };
    }

    const indicator = new ADX(period);
    const adx: number[] = [];
    const plusDI: number[] = [];
    const minusDI: number[] = [];

    for (const candle of candles) {
      const r = indicator.add({ high: candle.high, low: candle.low, close: candle.close });
      if (r !== null) {
        adx.push(r);
        if (indicator.pdi !== undefined) plusDI.push((indicator.pdi as number) * 100);
        if (indicator.mdi !== undefined) minusDI.push((indicator.mdi as number) * 100);
      }
    }

    return { adx, plusDI, minusDI };
  }
}
