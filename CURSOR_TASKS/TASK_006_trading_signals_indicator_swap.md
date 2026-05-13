# TASK_006: trading-signals Indicator Swap — Replace Hand-Rolled Math with Battle-Tested Library

**Priority:** HIGH — Stabilization move, not feature creep. Eliminates calculation risk before live trading.
**Status:** READY FOR CURSOR
**Depends on:** TASK_005 (runtime bug fixes) — complete TASK_005 first
**Created:** 2026-03-24 by Cowork (Architecture AI)
**Phase:** 5A — Open-Source Integration Sprint 1

---

## Context

The `trading-signals` npm package (`^7.4.3`) is **already installed** in `atlas/apps/core-node/package.json` but has **zero imports** anywhere in the codebase. The hand-rolled `TechnicalIndicators` static class in `indicators/technical.ts` (~618 lines) is still the active implementation for all indicator calculations.

This task replaces the hand-rolled indicator math with `trading-signals` streaming API calls, using a thin adapter layer that preserves the existing interface. This is a **risk reduction** move — it eliminates the possibility of subtle calculation bugs in ADX, RSI, MACD, EMA, ATR, Bollinger, and Donchian producing bad signals in live trading.

### Why this is safe

- `trading-signals` is a production-tested TypeScript monorepo with 886+ GitHub stars
- Uses Vitest for testing (same test runner as Apex Automata)
- Streaming `.update()` / `.getResult()` API maps cleanly to our candle pipeline
- The library is already installed — no new dependency risk
- We keep the existing `TechnicalIndicators` class interface intact via adapter pattern

### What `trading-signals` provides

The library exposes streaming indicator classes. Key ones we need:

```typescript
import { SMA, EMA, RSI, MACD, BollingerBands, ADX, ATR, DX } from 'trading-signals';
// Each indicator is a class with .update(value) and .getResult() methods
// .getResult() returns a Big.js number (use .toNumber() for native)
// .isStable is true once enough data points have been fed
```

**Version note:** We're on `^7.4.3`. In v7+, the API uses `.update()` and `.getResult()`. Verify import paths against the installed version.

---

## IMPORTANT CONSTRAINTS

1. **DO NOT** delete `indicators/technical.ts` — keep it as a fallback and for indicators not covered by `trading-signals`
2. **DO NOT** change any strategy plugin interfaces or `MarketContext.indicators` shape
3. **DO NOT** modify the candle aggregation pipeline in `trading-engine.ts`
4. **DO NOT** change any test assertions — only the underlying computation should change
5. **DO NOT** introduce any new npm dependencies — `trading-signals` is already installed
6. Keep `OHLCV` interface and `VolumeProfile`, `SupportResistance`, `KeltnerChannels`, `ChoppinessIndex` in `technical.ts` (these aren't in `trading-signals`)

---

## Step 1: Create Streaming Indicator Adapter

Create a new file that wraps `trading-signals` classes into the streaming pattern used by the engine.

**Create file:** `atlas/apps/core-node/src/indicators/streaming-indicators.ts`

```typescript
/**
 * Streaming Indicator Adapter
 *
 * Wraps the `trading-signals` library into a streaming interface that
 * the candle aggregation pipeline and strategies can consume.
 *
 * Design:
 * - Each indicator instance is created once and fed values via .update()
 * - .getResult() returns the current value (or undefined if not yet stable)
 * - The TechnicalIndicators static class in technical.ts remains as fallback
 *   for batch computation and indicators not covered by trading-signals
 */

import {
  SMA,
  EMA,
  RSI,
  MACD,
  MACDConfig,
  BollingerBands,
  BollingerBandsResult,
  ADX,
  ATR,
  StochasticRSI,
} from 'trading-signals';

// ============ Types ============

export interface StreamingIndicatorSet {
  /** Unique key for this indicator set (e.g., 'ETH-USD') */
  symbol: string;
  /** Configured indicators */
  indicators: Map<string, StreamingIndicator>;
  /** Feed a new close price to all price-based indicators */
  updateClose(close: number): void;
  /** Feed a new candle to candle-based indicators (ATR, ADX) */
  updateCandle(high: number, low: number, close: number): void;
  /** Get all current indicator values as a flat object */
  snapshot(): Record<string, number | number[] | undefined>;
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
    this.indicator.update(value);
  }

  getValue(): number | undefined {
    try {
      return this.indicator.isStable ? this.indicator.getResult().toNumber() : undefined;
    } catch {
      return undefined;
    }
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
    this.indicator.update(value);
  }

  getValue(): number | undefined {
    try {
      return this.indicator.isStable ? this.indicator.getResult().toNumber() : undefined;
    } catch {
      return undefined;
    }
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
    this.indicator.update(value);
  }

  getValue(): number | undefined {
    try {
      return this.indicator.isStable ? this.indicator.getResult().toNumber() : undefined;
    } catch {
      return undefined;
    }
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
    this.indicator = new MACD({
      indicator: EMA,
      longInterval: slow,
      shortInterval: fast,
      signalInterval: signal,
    });
  }

  update(value: number): void {
    this.indicator.update(value);
    if (this.indicator.isStable) {
      const result = this.indicator.getResult();
      this.lastResult = {
        macd: result.macd.toNumber(),
        signal: result.signal.toNumber(),
        histogram: result.histogram.toNumber(),
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
    this.indicator.update(value);
    if (this.indicator.isStable) {
      const result = this.indicator.getResult();
      this.lastResult = {
        upper: result.upper.toNumber(),
        middle: result.middle.toNumber(),
        lower: result.lower.toNumber(),
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
    this.indicator.update(candle);
  }

  getValue(): number | undefined {
    try {
      return this.indicator.isStable ? this.indicator.getResult().toNumber() : undefined;
    } catch {
      return undefined;
    }
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
    this.indicator.update(candle);
  }

  getValue(): number | undefined {
    try {
      return this.indicator.isStable ? this.indicator.getResult().toNumber() : undefined;
    } catch {
      return undefined;
    }
  }

  isStable(): boolean {
    return this.indicator.isStable;
  }
}

// ============ Factory ============

export interface IndicatorConfig {
  ema?: number[];          // e.g., [12, 15, 26]
  sma?: number[];          // e.g., [20, 50, 200]
  rsi?: number[];          // e.g., [10, 14]
  macd?: Array<{ fast: number; slow: number; signal: number }>;
  bollinger?: Array<{ period: number; stdDev?: number }>;
  atr?: number[];          // e.g., [14, 20]
  adx?: number[];          // e.g., [14]
}

/**
 * Create a complete indicator set for a symbol.
 *
 * Usage:
 * ```ts
 * const indicators = createIndicatorSet('ETH-USD', {
 *   ema: [12, 15],
 *   rsi: [10, 14],
 *   macd: [{ fast: 8, slow: 21, signal: 5 }],
 *   atr: [14],
 *   adx: [14],
 * });
 *
 * // On each candle:
 * indicators.updateClose(candle.close);
 * indicators.updateCandle(candle.high, candle.low, candle.close);
 *
 * // Get snapshot:
 * const snap = indicators.snapshot();
 * // { ema12: 3450.2, ema15: 3448.1, rsi10: 55.3, ... }
 * ```
 */
export function createIndicatorSet(symbol: string, config: IndicatorConfig): StreamingIndicatorSet {
  const indicators = new Map<string, StreamingIndicator>();

  // Price-based indicators
  const priceIndicators: StreamingIndicator[] = [];
  const candleIndicators: StreamingIndicator[] = [];

  // EMA
  for (const period of config.ema || []) {
    const ind = new StreamingEMA(period);
    indicators.set(ind.key, ind);
    priceIndicators.push(ind);
  }

  // SMA
  for (const period of config.sma || []) {
    const ind = new StreamingSMA(period);
    indicators.set(ind.key, ind);
    priceIndicators.push(ind);
  }

  // RSI
  for (const period of config.rsi || []) {
    const ind = new StreamingRSI(period);
    indicators.set(ind.key, ind);
    priceIndicators.push(ind);
  }

  // MACD
  for (const cfg of config.macd || []) {
    const ind = new StreamingMACD(cfg.fast, cfg.slow, cfg.signal);
    indicators.set(ind.key, ind);
    priceIndicators.push(ind);
  }

  // Bollinger Bands
  for (const cfg of config.bollinger || []) {
    const ind = new StreamingBollingerBands(cfg.period, cfg.stdDev);
    indicators.set(ind.key, ind);
    priceIndicators.push(ind);
  }

  // ATR (needs candle data)
  for (const period of config.atr || []) {
    const ind = new StreamingATR(period);
    indicators.set(ind.key, ind);
    candleIndicators.push(ind);
  }

  // ADX (needs candle data)
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

    snapshot(): Record<string, number | number[] | undefined> {
      const result: Record<string, number | number[] | undefined> = {};
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
```

---

## Step 2: Create Batch Computation Adapter (Backward Compatibility)

The existing strategies and backtesting engine use the `TechnicalIndicators` static class with batch arrays. Create an adapter that uses `trading-signals` under the hood but returns the same array format.

**Create file:** `atlas/apps/core-node/src/indicators/validated-indicators.ts`

```typescript
/**
 * Validated Indicators — Batch Computation via trading-signals
 *
 * Drop-in replacement for TechnicalIndicators static methods.
 * Uses trading-signals library for the actual math, returns the same
 * array formats that strategies and backtesting expect.
 *
 * Usage:
 *   // Before: TechnicalIndicators.EMA(data, 12)
 *   // After:  ValidatedIndicators.EMA(data, 12)
 *   // Output format is identical.
 */

import { SMA, EMA, RSI, MACD, BollingerBands, ADX, ATR } from 'trading-signals';
import { OHLCV } from './technical';

export class ValidatedIndicators {
  /**
   * Simple Moving Average — returns array aligned to end of input
   * Output length: data.length - period + 1
   */
  public static SMA(data: number[], period: number): number[] {
    if (period <= 0 || data.length < period) return [];
    const indicator = new SMA(period);
    const result: number[] = [];
    for (const value of data) {
      indicator.update(value);
      if (indicator.isStable) {
        result.push(indicator.getResult().toNumber());
      }
    }
    return result;
  }

  /**
   * Exponential Moving Average — returns array aligned to end of input
   * Output length: data.length - period + 1
   */
  public static EMA(data: number[], period: number): number[] {
    if (period <= 0 || data.length < period) return [];
    const indicator = new EMA(period);
    const result: number[] = [];
    for (const value of data) {
      indicator.update(value);
      if (indicator.isStable) {
        result.push(indicator.getResult().toNumber());
      }
    }
    return result;
  }

  /**
   * Relative Strength Index (Wilder's smoothing)
   */
  public static RSI(data: number[], period: number = 14): number[] {
    if (data.length <= period) return [];
    const indicator = new RSI(period);
    const result: number[] = [];
    for (const value of data) {
      indicator.update(value);
      if (indicator.isStable) {
        result.push(indicator.getResult().toNumber());
      }
    }
    return result;
  }

  /**
   * MACD — returns { macd, signal, histogram } arrays
   */
  public static MACD(
    data: number[],
    fastPeriod: number = 12,
    slowPeriod: number = 26,
    signalPeriod: number = 9
  ): { macd: number[]; signal: number[]; histogram: number[] } {
    if (data.length < Math.max(fastPeriod, slowPeriod)) {
      return { macd: [], signal: [], histogram: [] };
    }
    const indicator = new MACD({
      indicator: EMA,
      longInterval: slowPeriod,
      shortInterval: fastPeriod,
      signalInterval: signalPeriod,
    });
    const macd: number[] = [];
    const signal: number[] = [];
    const histogram: number[] = [];
    for (const value of data) {
      indicator.update(value);
      if (indicator.isStable) {
        const result = indicator.getResult();
        macd.push(result.macd.toNumber());
        signal.push(result.signal.toNumber());
        histogram.push(result.histogram.toNumber());
      }
    }
    return { macd, signal, histogram };
  }

  /**
   * Bollinger Bands — returns { upper, middle, lower } arrays
   */
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
      indicator.update(value);
      if (indicator.isStable) {
        const result = indicator.getResult();
        upper.push(result.upper.toNumber());
        middle.push(result.middle.toNumber());
        lower.push(result.lower.toNumber());
      }
    }
    return { upper, middle, lower };
  }

  /**
   * Average True Range
   */
  public static ATR(candles: OHLCV[], period: number = 14): number[] {
    if (candles.length <= 1) return [];
    const indicator = new ATR(period);
    const result: number[] = [];
    for (const candle of candles) {
      indicator.update({ high: candle.high, low: candle.low, close: candle.close });
      if (indicator.isStable) {
        result.push(indicator.getResult().toNumber());
      }
    }
    return result;
  }

  /**
   * Average Directional Index — returns { adx, plusDI, minusDI } arrays
   *
   * NOTE: trading-signals ADX only exposes the ADX value, not +DI/-DI.
   * For +DI/-DI, we fall back to TechnicalIndicators.ADX() from technical.ts.
   * This method returns ADX from trading-signals with +DI/-DI from the hand-rolled impl.
   */
  public static ADX(candles: OHLCV[], period: number = 14): {
    adx: number[];
    plusDI: number[];
    minusDI: number[];
  } {
    if (candles.length <= period + 1) {
      return { adx: [], plusDI: [], minusDI: [] };
    }

    // ADX from trading-signals
    const indicator = new ADX(period);
    const adx: number[] = [];
    for (const candle of candles) {
      indicator.update({ high: candle.high, low: candle.low, close: candle.close });
      if (indicator.isStable) {
        adx.push(indicator.getResult().toNumber());
      }
    }

    // +DI/-DI: trading-signals doesn't expose these separately.
    // Use the hand-rolled TechnicalIndicators for DI values.
    // Import dynamically to avoid circular dependency.
    const { TechnicalIndicators } = require('./technical');
    const diResult = TechnicalIndicators.ADX(candles, period);

    // Align array lengths (trading-signals may produce different length due to warmup)
    const minLen = Math.min(adx.length, diResult.plusDI.length, diResult.minusDI.length);
    return {
      adx: adx.slice(adx.length - minLen),
      plusDI: diResult.plusDI.slice(diResult.plusDI.length - minLen),
      minusDI: diResult.minusDI.slice(diResult.minusDI.length - minLen),
    };
  }
}
```

---

## Step 3: Create Parallel Validation Test

Before swapping out the indicators in production code, run both implementations side-by-side and verify output parity within acceptable tolerance (floating point differences).

**Create file:** `atlas/apps/core-node/src/__tests__/indicator-parity.test.ts`

```typescript
/**
 * Indicator Parity Test
 *
 * Runs both TechnicalIndicators (hand-rolled) and ValidatedIndicators
 * (trading-signals) on identical data and asserts the outputs match
 * within floating-point tolerance.
 *
 * This is the GATE test — if this fails, do NOT swap indicators.
 */

import { describe, it, expect } from 'vitest';
import { TechnicalIndicators, OHLCV } from '../indicators/technical';
import { ValidatedIndicators } from '../indicators/validated-indicators';

// Generate deterministic test data (BTC-like price series)
function generatePriceSeries(length: number, startPrice: number = 50000): number[] {
  const prices: number[] = [startPrice];
  let seed = 42;
  for (let i = 1; i < length; i++) {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    const change = ((seed / 2147483648) - 0.5) * 0.02; // ±1% per bar
    prices.push(prices[i - 1] * (1 + change));
  }
  return prices;
}

function generateCandles(length: number, startPrice: number = 50000): OHLCV[] {
  const candles: OHLCV[] = [];
  let seed = 42;
  let price = startPrice;
  for (let i = 0; i < length; i++) {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    const change = ((seed / 2147483648) - 0.5) * 0.03;
    const close = price * (1 + change);
    const high = Math.max(price, close) * (1 + Math.abs(change) * 0.5);
    const low = Math.min(price, close) * (1 - Math.abs(change) * 0.5);
    candles.push({
      time: Date.now() + i * 300000, // 5m bars
      open: price,
      high,
      low,
      close,
      volume: 100 + (seed % 200),
    });
    price = close;
  }
  return candles;
}

const TOLERANCE = 0.01; // 1% relative tolerance for floating point differences
const prices = generatePriceSeries(300);
const candles = generateCandles(300);

function assertArraysClose(
  actual: number[],
  expected: number[],
  label: string,
  tolerance: number = TOLERANCE
): void {
  // Allow ±2 difference in array length due to warmup differences
  expect(Math.abs(actual.length - expected.length)).toBeLessThanOrEqual(2);

  const minLen = Math.min(actual.length, expected.length);
  // Compare from the END (most recent values are most important)
  const aSlice = actual.slice(actual.length - minLen);
  const eSlice = expected.slice(expected.length - minLen);

  for (let i = 0; i < minLen; i++) {
    const relDiff = Math.abs(aSlice[i] - eSlice[i]) / Math.max(Math.abs(eSlice[i]), 1e-10);
    expect(relDiff, `${label}[${i}]: got ${aSlice[i]}, expected ${eSlice[i]}`).toBeLessThan(tolerance);
  }
}

describe('Indicator Parity: trading-signals vs hand-rolled', () => {
  it('SMA(20) output matches', () => {
    const handRolled = TechnicalIndicators.SMA(prices, 20);
    const validated = ValidatedIndicators.SMA(prices, 20);
    assertArraysClose(validated, handRolled, 'SMA(20)');
  });

  it('EMA(12) output matches', () => {
    const handRolled = TechnicalIndicators.EMA(prices, 12);
    const validated = ValidatedIndicators.EMA(prices, 12);
    assertArraysClose(validated, handRolled, 'EMA(12)');
  });

  it('EMA(15) output matches (trend_follow slow EMA)', () => {
    const handRolled = TechnicalIndicators.EMA(prices, 15);
    const validated = ValidatedIndicators.EMA(prices, 15);
    assertArraysClose(validated, handRolled, 'EMA(15)');
  });

  it('RSI(14) output matches', () => {
    const handRolled = TechnicalIndicators.RSI(prices, 14);
    const validated = ValidatedIndicators.RSI(prices, 14);
    assertArraysClose(validated, handRolled, 'RSI(14)');
  });

  it('RSI(10) output matches (momentum strategy)', () => {
    const handRolled = TechnicalIndicators.RSI(prices, 10);
    const validated = ValidatedIndicators.RSI(prices, 10);
    assertArraysClose(validated, handRolled, 'RSI(10)');
  });

  it('MACD(8,21,5) output matches (momentum strategy)', () => {
    const hrMACD = TechnicalIndicators.MACD(prices, 8, 21, 5);
    const valMACD = ValidatedIndicators.MACD(prices, 8, 21, 5);
    assertArraysClose(valMACD.macd, hrMACD.macd, 'MACD.macd');
    assertArraysClose(valMACD.signal, hrMACD.signal, 'MACD.signal');
    assertArraysClose(valMACD.histogram, hrMACD.histogram, 'MACD.histogram');
  });

  it('BollingerBands(20,2) output matches', () => {
    const hrBB = TechnicalIndicators.BollingerBands(prices, 20, 2);
    const valBB = ValidatedIndicators.BollingerBands(prices, 20, 2);
    assertArraysClose(valBB.upper, hrBB.upper, 'BB.upper');
    assertArraysClose(valBB.middle, hrBB.middle, 'BB.middle');
    assertArraysClose(valBB.lower, hrBB.lower, 'BB.lower');
  });

  it('ATR(14) output matches', () => {
    const handRolled = TechnicalIndicators.ATR(candles, 14);
    const validated = ValidatedIndicators.ATR(candles, 14);
    assertArraysClose(validated, handRolled, 'ATR(14)');
  });

  it('ADX(14) output matches', () => {
    const hrADX = TechnicalIndicators.ADX(candles, 14);
    const valADX = ValidatedIndicators.ADX(candles, 14);
    assertArraysClose(valADX.adx, hrADX.adx, 'ADX');
  });
});
```

**Run test:** `cd atlas/apps/core-node && pnpm test -- --grep "Indicator Parity"`

**IMPORTANT:** The tolerance is set to 1%. If specific indicators diverge more than this, investigate:
- EMA seeding differences (SMA vs first-value seeding)
- Wilder's smoothing vs standard EMA for RSI/ATR
- These differences mean the hand-rolled version may have subtle bugs — document them

---

## Step 4: Wire ValidatedIndicators into Strategy Context

Once the parity test passes, update the indicator computation pipeline to use `ValidatedIndicators` where the strategies consume batch arrays.

**File:** `atlas/apps/core-node/src/strategies/signal-processor.ts`

Locate where `TechnicalIndicators` is imported and used to compute indicator arrays for `MarketContext.indicators`. Replace those calls with `ValidatedIndicators`.

FIND the import:
```typescript
import { TechnicalIndicators } from '../indicators/technical';
```

ADD alongside it:
```typescript
import { ValidatedIndicators } from '../indicators/validated-indicators';
```

Then find each call to `TechnicalIndicators.EMA(...)`, `TechnicalIndicators.RSI(...)`, etc. inside the context-building function and replace with the `ValidatedIndicators` equivalent. **The function signatures and return types are identical** — this should be a mechanical find-and-replace.

Example:
```typescript
// Before:
const ema12 = TechnicalIndicators.EMA(closes, 12);
// After:
const ema12 = ValidatedIndicators.EMA(closes, 12);
```

**Keep TechnicalIndicators imports** for any indicators NOT in ValidatedIndicators (VolumeProfile, SupportResistance, KeltnerChannels, ChoppinessIndex, BollingerBandWidth, BollingerPercentB, DonchianChannels).

---

## Step 5: Wire StreamingIndicators into Trading Engine (Real-Time Path)

If the trading engine computes indicators per-tick (streaming), wire `StreamingIndicatorSet` into the candle close handler.

**File:** `atlas/apps/core-node/src/trading/trading-engine.ts`

Locate the candle aggregation callback where a new 5m bar completes. Add streaming indicator updates:

```typescript
import { createIndicatorSet, StreamingIndicatorSet } from '../indicators/streaming-indicators';

// In the engine class, add a per-symbol indicator set:
private streamingIndicators: Map<string, StreamingIndicatorSet> = new Map();

// During engine initialization (after symbols are known), create indicator sets:
for (const symbol of activeSymbols) {
  const indicatorSet = createIndicatorSet(symbol, {
    ema: [12, 15, 26],       // trend_follow + momentum
    rsi: [10, 14],           // momentum strategy
    macd: [{ fast: 8, slow: 21, signal: 5 }], // momentum
    atr: [14, 20],           // stop/position sizing
    adx: [14],               // regime detection
    bollinger: [{ period: 20, stdDev: 2 }],
  });
  this.streamingIndicators.set(symbol, indicatorSet);
}

// In the candle close handler:
const indicatorSet = this.streamingIndicators.get(symbol);
if (indicatorSet) {
  indicatorSet.updateClose(candle.close);
  indicatorSet.updateCandle(candle.high, candle.low, candle.close);
}
```

**NOTE:** This step may require investigation of how the engine currently feeds candles to the signal processor. If it already computes batch indicators on every candle (recomputing the full array), the streaming approach is a performance optimization but not strictly required for correctness. Prioritize Step 4 (batch replacement) over this step.

---

## Step 6: Update Backtest Engine

The backtesting engine also uses `TechnicalIndicators` for offline indicator computation.

**File:** `atlas/apps/core-node/src/backtesting/backtest-engine.ts`
**File:** `atlas/apps/core-node/src/backtesting/advanced-backtest-engine.ts`

Same mechanical replacement as Step 4:
```typescript
// Replace:
import { TechnicalIndicators } from '../indicators/technical';
// With:
import { ValidatedIndicators } from '../indicators/validated-indicators';
import { TechnicalIndicators } from '../indicators/technical'; // keep for non-covered indicators
```

---

## Step 7: Run Full Test Suite

After all changes:

```bash
cd atlas/apps/core-node && pnpm test
```

**Target:** 245/245 tests passing (or at minimum no regressions from the current 232/245).

> **Note (2026-05-13):** all tests now pass — Vitest migration completed in May 11 PRs. Current baseline: 35 test files / 493 tests, all passing in ~3s. The "232/245" figure above reflects the task's design-time snapshot (2026-03-24); use the current baseline as the gate.

If any strategy tests fail due to indicator value changes, investigate:
1. Run the parity test to see which indicator diverges
2. If the `trading-signals` value is more correct (matches TradingView), update the test assertion
3. Document any corrections as "indicator math corrections" in the commit message

---

## Verification Script

Create `CURSOR_TASKS/verify/verify_006.sh`:

```bash
#!/usr/bin/env bash
set -e

echo "=== TASK_006 Verification ==="

# Check streaming-indicators.ts exists
echo -n "1. streaming-indicators.ts created... "
if [ -f "atlas/apps/core-node/src/indicators/streaming-indicators.ts" ]; then
  echo "PASS"
else
  echo "FAIL — file not found"
  exit 1
fi

# Check validated-indicators.ts exists
echo -n "2. validated-indicators.ts created... "
if [ -f "atlas/apps/core-node/src/indicators/validated-indicators.ts" ]; then
  echo "PASS"
else
  echo "FAIL — file not found"
  exit 1
fi

# Check parity test exists
echo -n "3. indicator-parity.test.ts created... "
if [ -f "atlas/apps/core-node/src/__tests__/indicator-parity.test.ts" ]; then
  echo "PASS"
else
  echo "FAIL — test file not found"
  exit 1
fi

# Check trading-signals is imported somewhere in the indicators directory
echo -n "4. trading-signals imported in indicator files... "
if grep -rq "from 'trading-signals'" atlas/apps/core-node/src/indicators/; then
  echo "PASS"
else
  echo "FAIL — no trading-signals imports found in indicators/"
  exit 1
fi

# Check ValidatedIndicators is used in signal-processor or strategies
echo -n "5. ValidatedIndicators wired into signal processing... "
if grep -rq "ValidatedIndicators" atlas/apps/core-node/src/strategies/ || \
   grep -rq "ValidatedIndicators" atlas/apps/core-node/src/trading/; then
  echo "PASS"
else
  echo "FAIL — ValidatedIndicators not found in strategies/ or trading/"
  exit 1
fi

# Check technical.ts is NOT deleted
echo -n "6. technical.ts preserved as fallback... "
if [ -f "atlas/apps/core-node/src/indicators/technical.ts" ]; then
  echo "PASS"
else
  echo "FAIL — technical.ts was deleted (should be preserved)"
  exit 1
fi

# Run parity test
echo -n "7. Indicator parity test passes... "
cd atlas/apps/core-node
if pnpm test -- --grep "Indicator Parity" --reporter=dot 2>&1 | grep -q "passed"; then
  echo "PASS"
else
  echo "FAIL — parity test did not pass"
  exit 1
fi
cd ../../..

echo ""
echo "=== All TASK_006 checks passed ==="
```

---

## Execution Order

1. **Step 1** — Create `streaming-indicators.ts` (new file, zero risk)
2. **Step 2** — Create `validated-indicators.ts` (new file, zero risk)
3. **Step 3** — Create parity test and RUN IT (validation gate)
4. **Step 4** — Wire `ValidatedIndicators` into signal processor (batch path)
5. **Step 5** — Wire `StreamingIndicatorSet` into trading engine (streaming path) — OPTIONAL, lower priority
6. **Step 6** — Update backtest engines
7. **Step 7** — Run full test suite, verify no regressions

**If the parity test (Step 3) fails for any indicator, STOP and investigate before proceeding to Steps 4-6.**
