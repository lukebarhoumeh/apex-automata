/**
 * Indicator Regression Snapshot
 *
 * Locks in the canonical (Wilder RMA / trading-signals) output of every
 * core indicator on a deterministic 50-bar BTC-USD-like fixture. This is
 * the gate test for the indicator-standardization migration: any silent
 * drift in EMA, RSI, ATR (Wilder), ADX, or MACD will trip these asserts.
 *
 * If you intentionally change the underlying math (e.g. version-bump
 * `trading-signals`), regenerate values with:
 *     npx tsx scripts/compute-snapshot-values.ts
 * and update the constants below — and document the reason in the commit.
 */

import { describe, it, expect } from 'vitest';
import { ValidatedIndicators } from '../indicators/validated-indicators';
import type { OHLCV } from '../indicators/technical';

function makeFixture(): OHLCV[] {
  // 50 bars of 1m BTC-USD-like data — deterministic LCG, seed 1337.
  const candles: OHLCV[] = [];
  let seed = 1337;
  let price = 50000;
  for (let i = 0; i < 50; i++) {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    const change = ((seed / 2147483648) - 0.5) * 0.02;
    const close = price * (1 + change);
    const high = Math.max(price, close) * (1 + Math.abs(change) * 0.4);
    const low = Math.min(price, close) * (1 - Math.abs(change) * 0.4);
    candles.push({
      time: 1700000000000 + i * 60000,
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

// Tight tolerance — we're locking in exact Wilder RMA values, not
// asserting "approximately right". Floating-point error only.
const EPS = 1e-6;

const SNAPSHOT = {
  lastClose: 48732.09459910,
  ema12Last: 48838.92129612,
  rsi14Last: 44.33239832,
  atr14Last: 359.04595560,
  adx14Last: 18.02554344,
  macdLast: -209.83723067,
  macdSignalLast: -194.32639297,
  macdHistLast: -15.51083770,
};

const SHAPES = {
  ema12Len: 50,
  rsi14Len: 36,
  atr14Len: 37,
  adx14Len: 24,
  macdLen: 25,
  macdSignalLen: 25,
  macdHistLen: 25,
};

describe('Indicator regression snapshot (50-bar BTC-USD fixture)', () => {
  const candles = makeFixture();
  const closes = candles.map((c) => c.close);

  it('fixture is reproducible: last close matches', () => {
    expect(closes[closes.length - 1]).toBeCloseTo(SNAPSHOT.lastClose, 6);
  });

  it('EMA(12) tail value is locked', () => {
    const ema = ValidatedIndicators.EMA(closes, 12);
    expect(ema.length).toBe(SHAPES.ema12Len);
    expect(Math.abs(ema[ema.length - 1] - SNAPSHOT.ema12Last)).toBeLessThan(EPS);
  });

  it('RSI(14) tail value is locked', () => {
    const rsi = ValidatedIndicators.RSI(closes, 14);
    expect(rsi.length).toBe(SHAPES.rsi14Len);
    expect(Math.abs(rsi[rsi.length - 1] - SNAPSHOT.rsi14Last)).toBeLessThan(EPS);
  });

  it('ATR(14) tail value is locked (Wilder RMA, not EMA)', () => {
    const atr = ValidatedIndicators.ATR(candles, 14);
    expect(atr.length).toBe(SHAPES.atr14Len);
    expect(Math.abs(atr[atr.length - 1] - SNAPSHOT.atr14Last)).toBeLessThan(EPS);
  });

  it('ADX(14) tail value is locked (Wilder RMA)', () => {
    const adx = ValidatedIndicators.ADX(candles, 14);
    expect(adx.adx.length).toBe(SHAPES.adx14Len);
    expect(Math.abs(adx.adx[adx.adx.length - 1] - SNAPSHOT.adx14Last)).toBeLessThan(EPS);
  });

  it('MACD(12,26,9) tail values are locked', () => {
    const macd = ValidatedIndicators.MACD(closes, 12, 26, 9);
    expect(macd.macd.length).toBe(SHAPES.macdLen);
    expect(macd.signal.length).toBe(SHAPES.macdSignalLen);
    expect(macd.histogram.length).toBe(SHAPES.macdHistLen);
    expect(Math.abs(macd.macd[macd.macd.length - 1] - SNAPSHOT.macdLast)).toBeLessThan(EPS);
    expect(Math.abs(macd.signal[macd.signal.length - 1] - SNAPSHOT.macdSignalLast)).toBeLessThan(EPS);
    expect(Math.abs(macd.histogram[macd.histogram.length - 1] - SNAPSHOT.macdHistLast)).toBeLessThan(EPS);
  });
});
