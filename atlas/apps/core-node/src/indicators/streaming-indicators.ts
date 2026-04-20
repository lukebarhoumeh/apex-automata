/**
 * Streaming Indicator Adapter
 *
 * Wraps the `trading-signals` library (v7+) into a streaming interface that
 * the candle aggregation pipeline and strategies can consume.
 *
 * v7 API: .add(value) returns Result | null, .getResult() returns native number
 * (no Big.js, no .toNumber() needed).
 */

import {
  SMA,
  EMA,
  RSI,
  MACD,
  BollingerBands,
  ADX,
  ATR,
} from 'trading-signals';

// ============ Types ============

export interface StreamingIndicatorSet {
  symbol: string;
  indicators: Map<string, StreamingIndicator>;
  updateClose(close: number): void;
  updateCandle(high: number, low: number, close: number): void;
  snapshot(): Record<string, number | undefined>;
}

export interface StreamingIndicator {
  key: string;
  type: string;
  update(value: number | { high: number; low: number; close: number }): void;
  getValue(): number | undefined;
  isStable(): boolean;
}

// ============ Indicator Wrappers ============

class StreamingEMA implements StreamingIndicator {
  readonly key: string;
  readonly type = 'ema';
  private indicator: EMA;

  constructor(period: number) {
    this.key = `ema${period}`;
    this.indicator = new EMA(period);
  }

  update(value: number): void {
    this.indicator.add(value);
  }

  getValue(): number | undefined {
    return this.indicator.isStable ? (this.indicator.getResult() as number) : undefined;
  }

  isStable(): boolean {
    return this.indicator.isStable;
  }
}

class StreamingSMA implements StreamingIndicator {
  readonly key: string;
  readonly type = 'sma';
  private indicator: SMA;

  constructor(period: number) {
    this.key = `sma${period}`;
    this.indicator = new SMA(period);
  }

  update(value: number): void {
    this.indicator.add(value);
  }

  getValue(): number | undefined {
    return this.indicator.isStable ? (this.indicator.getResult() as number) : undefined;
  }

  isStable(): boolean {
    return this.indicator.isStable;
  }
}

class StreamingRSI implements StreamingIndicator {
  readonly key: string;
  readonly type = 'rsi';
  private indicator: RSI;

  constructor(period: number) {
    this.key = `rsi${period}`;
    this.indicator = new RSI(period);
  }

  update(value: number): void {
    this.indicator.add(value);
  }

  getValue(): number | undefined {
    return this.indicator.isStable ? (this.indicator.getResult() as number) : undefined;
  }

  isStable(): boolean {
    return this.indicator.isStable;
  }
}

class StreamingMACD implements StreamingIndicator {
  readonly key: string;
  readonly type = 'macd';
  private indicator: MACD;
  private lastResult: { macd: number; signal: number; histogram: number } | undefined;

  constructor(fast: number, slow: number, signal: number) {
    this.key = `macd_${fast}_${slow}_${signal}`;
    this.indicator = new MACD(new EMA(fast), new EMA(slow), new EMA(signal));
  }

  update(value: number): void {
    const result = this.indicator.add(value);
    if (result !== null) {
      this.lastResult = {
        macd: result.macd,
        signal: result.signal,
        histogram: result.histogram,
      };
    }
  }

  getValue(): number | undefined {
    return this.lastResult?.macd;
  }

  getFullResult(): { macd: number; signal: number; histogram: number } | undefined {
    return this.lastResult;
  }

  isStable(): boolean {
    return this.indicator.isStable;
  }
}

class StreamingBollingerBands implements StreamingIndicator {
  readonly key: string;
  readonly type = 'bollinger';
  private indicator: BollingerBands;
  private lastResult: { upper: number; middle: number; lower: number } | undefined;

  constructor(period: number, stdDev: number = 2) {
    this.key = `bb_${period}_${stdDev}`;
    this.indicator = new BollingerBands(period, stdDev);
  }

  update(value: number): void {
    const result = this.indicator.add(value);
    if (result !== null) {
      this.lastResult = {
        upper: result.upper,
        middle: result.middle,
        lower: result.lower,
      };
    }
  }

  getValue(): number | undefined {
    return this.lastResult?.middle;
  }

  getFullResult(): { upper: number; middle: number; lower: number } | undefined {
    return this.lastResult;
  }

  isStable(): boolean {
    return this.indicator.isStable;
  }
}

class StreamingATR implements StreamingIndicator {
  readonly key: string;
  readonly type = 'atr';
  private indicator: ATR;

  constructor(period: number) {
    this.key = `atr${period}`;
    this.indicator = new ATR(period);
  }

  update(candle: { high: number; low: number; close: number }): void {
    this.indicator.add(candle);
  }

  getValue(): number | undefined {
    return this.indicator.isStable ? (this.indicator.getResult() as number) : undefined;
  }

  isStable(): boolean {
    return this.indicator.isStable;
  }
}

class StreamingADX implements StreamingIndicator {
  readonly key: string;
  readonly type = 'adx';
  private indicator: ADX;

  constructor(period: number) {
    this.key = `adx${period}`;
    this.indicator = new ADX(period);
  }

  update(candle: { high: number; low: number; close: number }): void {
    this.indicator.add(candle);
  }

  getValue(): number | undefined {
    return this.indicator.isStable ? (this.indicator.getResult() as number) : undefined;
  }

  getPDI(): number | undefined {
    return this.indicator.pdi as number | undefined;
  }

  getMDI(): number | undefined {
    return this.indicator.mdi as number | undefined;
  }

  isStable(): boolean {
    return this.indicator.isStable;
  }
}

// ============ Factory ============

export interface IndicatorConfig {
  ema?: number[];
  sma?: number[];
  rsi?: number[];
  macd?: Array<{ fast: number; slow: number; signal: number }>;
  bollinger?: Array<{ period: number; stdDev?: number }>;
  atr?: number[];
  adx?: number[];
}

export function createIndicatorSet(symbol: string, config: IndicatorConfig): StreamingIndicatorSet {
  const indicators = new Map<string, StreamingIndicator>();
  const priceIndicators: StreamingIndicator[] = [];
  const candleIndicators: StreamingIndicator[] = [];

  for (const period of config.ema || []) {
    const ind = new StreamingEMA(period);
    indicators.set(ind.key, ind);
    priceIndicators.push(ind);
  }

  for (const period of config.sma || []) {
    const ind = new StreamingSMA(period);
    indicators.set(ind.key, ind);
    priceIndicators.push(ind);
  }

  for (const period of config.rsi || []) {
    const ind = new StreamingRSI(period);
    indicators.set(ind.key, ind);
    priceIndicators.push(ind);
  }

  for (const cfg of config.macd || []) {
    const ind = new StreamingMACD(cfg.fast, cfg.slow, cfg.signal);
    indicators.set(ind.key, ind);
    priceIndicators.push(ind);
  }

  for (const cfg of config.bollinger || []) {
    const ind = new StreamingBollingerBands(cfg.period, cfg.stdDev);
    indicators.set(ind.key, ind);
    priceIndicators.push(ind);
  }

  for (const period of config.atr || []) {
    const ind = new StreamingATR(period);
    indicators.set(ind.key, ind);
    candleIndicators.push(ind);
  }

  for (const period of config.adx || []) {
    const ind = new StreamingADX(period);
    indicators.set(ind.key, ind);
    candleIndicators.push(ind);
  }

  return {
    symbol,
    indicators,

    updateClose(close: number): void {
      for (const ind of priceIndicators) {
        ind.update(close);
      }
    },

    updateCandle(high: number, low: number, close: number): void {
      const candle = { high, low, close };
      for (const ind of candleIndicators) {
        ind.update(candle);
      }
    },

    snapshot(): Record<string, number | undefined> {
      const result: Record<string, number | undefined> = {};
      for (const [key, ind] of indicators) {
        if (ind instanceof StreamingMACD) {
          const full = ind.getFullResult();
          if (full) {
            result[`${key}_macd`] = full.macd;
            result[`${key}_signal`] = full.signal;
            result[`${key}_histogram`] = full.histogram;
          }
        } else if (ind instanceof StreamingBollingerBands) {
          const full = ind.getFullResult();
          if (full) {
            result[`${key}_upper`] = full.upper;
            result[`${key}_middle`] = full.middle;
            result[`${key}_lower`] = full.lower;
          }
        } else {
          result[key] = ind.getValue();
        }
      }
      return result;
    },
  };
}

export {
  StreamingEMA,
  StreamingSMA,
  StreamingRSI,
  StreamingMACD,
  StreamingBollingerBands,
  StreamingATR,
  StreamingADX,
};
