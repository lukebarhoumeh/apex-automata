/**
 * Validated Indicators — Batch Computation via trading-signals (v7+)
 *
 * Drop-in replacement for TechnicalIndicators static methods.
 * Uses trading-signals library for the actual math, returns the same
 * array formats that strategies and backtesting expect.
 *
 * v7 API: results are native numbers (no Big.js, no .toNumber()).
 * MACD constructor: new MACD(shortEMA, longEMA, signalEMA).
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
   * trading-signals v7 exposes .pdi and .mdi on the ADX instance.
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
        if (indicator.pdi !== undefined) plusDI.push(indicator.pdi as number);
        if (indicator.mdi !== undefined) minusDI.push(indicator.mdi as number);
      }
    }

    return { adx, plusDI, minusDI };
  }
}
