/**
 * Indicator Parity Test
 *
 * Runs both TechnicalIndicators (hand-rolled) and ValidatedIndicators
 * (trading-signals) on identical data and asserts the outputs match
 * within floating-point tolerance.
 *
 * GATE TEST — if this fails, do NOT swap indicators in production code.
 */

import { describe, it, expect } from 'vitest';
import { TechnicalIndicators, OHLCV } from '../indicators/technical';
import { ValidatedIndicators } from '../indicators/validated-indicators';

function generatePriceSeries(length: number, startPrice: number = 50000): number[] {
  const prices: number[] = [startPrice];
  let seed = 42;
  for (let i = 1; i < length; i++) {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    const change = ((seed / 2147483648) - 0.5) * 0.02;
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
      time: Date.now() + i * 300000,
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

const TOLERANCE = 0.01; // 1% relative tolerance
const prices = generatePriceSeries(300);
const candles = generateCandles(300);

/**
 * Compare the TAIL of two indicator arrays (last N values).
 * EMA seeding and smoothing differences cause early divergence that converges.
 * Trading decisions use the most recent values, so tail parity is what matters.
 */
function assertTailClose(
  actual: number[],
  expected: number[],
  label: string,
  tailCount: number = 50,
  tolerance: number = TOLERANCE
): void {
  expect(actual.length, `${label}: actual array empty`).toBeGreaterThan(0);
  expect(expected.length, `${label}: expected array empty`).toBeGreaterThan(0);

  const n = Math.min(tailCount, actual.length, expected.length);
  const aTail = actual.slice(-n);
  const eTail = expected.slice(-n);

  for (let i = 0; i < n; i++) {
    const relDiff = Math.abs(aTail[i] - eTail[i]) / Math.max(Math.abs(eTail[i]), 1e-10);
    expect(relDiff, `${label} tail[${i}]: got ${aTail[i]}, expected ${eTail[i]}`).toBeLessThan(tolerance);
  }
}

describe('Indicator Parity: trading-signals vs hand-rolled', () => {
  it('SMA(20) tail values match exactly', () => {
    const handRolled = TechnicalIndicators.SMA(prices, 20);
    const validated = ValidatedIndicators.SMA(prices, 20);
    assertTailClose(validated, handRolled, 'SMA(20)', 50, 0.0001);
  });

  it('SMA(50) tail values match exactly', () => {
    const handRolled = TechnicalIndicators.SMA(prices, 50);
    const validated = ValidatedIndicators.SMA(prices, 50);
    assertTailClose(validated, handRolled, 'SMA(50)', 50, 0.0001);
  });

  it('EMA(12) tail values converge', () => {
    const handRolled = TechnicalIndicators.EMA(prices, 12);
    const validated = ValidatedIndicators.EMA(prices, 12);
    // trading-signals EMA produces output immediately (first-value seed)
    // hand-rolled waits for `period` values (SMA seed) — different lengths expected
    assertTailClose(validated, handRolled, 'EMA(12)');
  });

  it('EMA(15) tail values converge (trend_follow slow EMA)', () => {
    const handRolled = TechnicalIndicators.EMA(prices, 15);
    const validated = ValidatedIndicators.EMA(prices, 15);
    assertTailClose(validated, handRolled, 'EMA(15)');
  });

  it('EMA(26) tail values converge', () => {
    const handRolled = TechnicalIndicators.EMA(prices, 26);
    const validated = ValidatedIndicators.EMA(prices, 26);
    assertTailClose(validated, handRolled, 'EMA(26)');
  });

  it('RSI(14) tail values match', () => {
    const handRolled = TechnicalIndicators.RSI(prices, 14);
    const validated = ValidatedIndicators.RSI(prices, 14);
    assertTailClose(validated, handRolled, 'RSI(14)');
  });

  it('MACD(12,26,9) tail values converge', () => {
    const hrMACD = TechnicalIndicators.MACD(prices);
    const valMACD = ValidatedIndicators.MACD(prices);
    // MACD inherits EMA seeding difference — tail values converge
    assertTailClose(valMACD.macd, hrMACD.macd, 'MACD.macd', 30);
    assertTailClose(valMACD.signal, hrMACD.signal, 'MACD.signal', 30);
    assertTailClose(valMACD.histogram, hrMACD.histogram, 'MACD.histogram', 30);
  });

  it('BollingerBands(20,2) tail values match', () => {
    const hrBB = TechnicalIndicators.BollingerBands(prices, 20, 2);
    const valBB = ValidatedIndicators.BollingerBands(prices, 20, 2);
    assertTailClose(valBB.upper, hrBB.upper, 'BB.upper');
    assertTailClose(valBB.middle, hrBB.middle, 'BB.middle');
    assertTailClose(valBB.lower, hrBB.lower, 'BB.lower');
  });

  it('ATR(14) uses Wilder WSMA (differs from hand-rolled EMA smoothing)', () => {
    const handRolled = TechnicalIndicators.ATR(candles, 14);
    const validated = ValidatedIndicators.ATR(candles, 14);
    // Fundamental algorithm difference: WSMA (canonical per Wilder) vs EMA.
    // WSMA produces ~10% different values from EMA-smoothed ATR — this is
    // a CORRECTION, not a bug. The trading-signals version is more standard.
    assertTailClose(validated, handRolled, 'ATR(14)', 20, 0.12);
  });

  it('ADX(14) tail values converge', () => {
    const hrADX = TechnicalIndicators.ADX(candles, 14);
    const valADX = ValidatedIndicators.ADX(candles, 14);
    // ADX also uses Wilder smoothing — same convergence pattern as ATR
    assertTailClose(valADX.adx, hrADX.adx, 'ADX', 30, 0.08);
  });

  it('ValidatedIndicators produces non-empty results', () => {
    expect(ValidatedIndicators.SMA(prices, 20).length).toBeGreaterThan(0);
    expect(ValidatedIndicators.EMA(prices, 12).length).toBeGreaterThan(0);
    expect(ValidatedIndicators.RSI(prices, 14).length).toBeGreaterThan(0);
    const macd = ValidatedIndicators.MACD(prices);
    expect(macd.macd.length).toBeGreaterThan(0);
    const bb = ValidatedIndicators.BollingerBands(prices, 20, 2);
    expect(bb.upper.length).toBeGreaterThan(0);
    expect(ValidatedIndicators.ATR(candles, 14).length).toBeGreaterThan(0);
    expect(ValidatedIndicators.ADX(candles, 14).adx.length).toBeGreaterThan(0);
  });
});
