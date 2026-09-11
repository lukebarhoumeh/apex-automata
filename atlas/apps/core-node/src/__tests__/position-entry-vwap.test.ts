import { describe, test, expect } from 'vitest';
import {
  HYDRATED_ENTRY_PRICE_KEY,
  computeRawEntryFillPrice,
  resolvePersistedEntryPrice,
} from '../trading/position-entry-vwap';

describe('computeRawEntryFillPrice', () => {
  test('SHORT single-fill: returns the raw fill price (not the cost-basis averagePrice)', () => {
    // Coinbase Advanced makerFee = 0.0025 (25 bps).
    // PositionTracker stores averagePrice = price * (1 - makerFee) for SHORTs.
    // Real fill came in at 77581.67 (signal.price - 2 bps offset on the
    // marketable_limit), so averagePrice = 77581.67 * 0.9975 = 77387.72.
    const result = computeRawEntryFillPrice({
      side: 'short',
      averagePrice: 77387.72, // cost-basis
      trades: [{ side: 'sell', size: 0.094, price: 77581.67 }],
    });
    expect(result).toBeCloseTo(77581.67, 2);
  });

  test('LONG single-fill: returns the raw fill price', () => {
    const result = computeRawEntryFillPrice({
      side: 'long',
      averagePrice: 100.25, // cost-basis (price + fee/unit)
      trades: [{ side: 'buy', size: 1, price: 100 }],
    });
    expect(result).toBeCloseTo(100, 8);
  });

  test('SHORT multi-fill: returns volume-weighted average of sell prices', () => {
    const result = computeRawEntryFillPrice({
      side: 'short',
      averagePrice: 0,
      trades: [
        { side: 'sell', size: 1, price: 100 },
        { side: 'sell', size: 3, price: 104 }, // VWAP = (100 + 312)/4 = 103
      ],
    });
    expect(result).toBeCloseTo(103, 8);
  });

  test('LONG multi-fill: returns volume-weighted average of buy prices', () => {
    const result = computeRawEntryFillPrice({
      side: 'long',
      averagePrice: 0,
      trades: [
        { side: 'buy', size: 2, price: 100 },
        { side: 'buy', size: 2, price: 110 },
      ],
    });
    expect(result).toBe(105);
  });

  test('SHORT with one prior buy in trade history: ignores opposite-side trades', () => {
    // Position is currently SHORT; an old 'buy' trade in history should NOT
    // be averaged into the SHORT entry VWAP.
    const result = computeRawEntryFillPrice({
      side: 'short',
      averagePrice: 0,
      trades: [
        { side: 'buy', size: 1, price: 200 }, // ignored
        { side: 'sell', size: 2, price: 100 },
      ],
    });
    expect(result).toBe(100);
  });

  test('falls back to averagePrice when no entry-side trades exist', () => {
    const result = computeRawEntryFillPrice({
      side: 'short',
      averagePrice: 99.5,
      trades: [],
    });
    expect(result).toBe(99.5);
  });

  test('falls back to averagePrice when side is flat', () => {
    const result = computeRawEntryFillPrice({
      side: 'flat',
      averagePrice: 50,
      trades: [{ side: 'buy', size: 1, price: 100 }],
    });
    expect(result).toBe(50);
  });

  test('returns 0 when averagePrice is missing and no trades', () => {
    const result = computeRawEntryFillPrice({ side: 'long', trades: [] });
    expect(result).toBe(0);
  });

  test('regression: full 5-row replay of sess_1776828896308 — entry_price now matches signal.price - 2 bps', () => {
    // For each SHORT, trades[0].price is the limit fill (signal.price * 0.9998).
    // Without this helper, syncPositionToSupabase would write averagePrice
    // (signal.price * 0.9973) — 25 bps off and the source of "broken R/R" in DB.
    const cases = [
      { name: 'BTC-USD',  averagePrice: 77387.72, fillPrice: 77597.19 * 0.9998 }, // 77581.67
      { name: 'SOL-USD',  averagePrice: 87.640,   fillPrice: 87.880   * 0.9998 }, // 87.862
      { name: 'BTC-PERP', averagePrice: 76377.68, fillPrice: 76584.42 * 0.9998 }, // 76569.10
      { name: 'ETH-USD',  averagePrice: 2358.19,  fillPrice: 2364.57  * 0.9998 }, // 2364.10
      { name: 'ETH-PERP', averagePrice: 2358.19,  fillPrice: 2364.57  * 0.9998 }, // 2364.10
    ];
    for (const c of cases) {
      const result = computeRawEntryFillPrice({
        side: 'short',
        averagePrice: c.averagePrice,
        trades: [{ side: 'sell', size: 1, price: c.fillPrice }],
      });
      expect(result, `${c.name} fill`).toBeCloseTo(c.fillPrice, 2);
      // And the result must be ABOVE the cost-basis averagePrice for SHORTs
      expect(result, `${c.name} above cost-basis`).toBeGreaterThan(c.averagePrice);
    }
  });
});

/**
 * PR #64 — persisted entry price for the `positions` writer. A position hydrated
 * from Supabase has no entry fill in `trades`, and PositionTracker zeroes
 * `averagePrice` when it goes flat, so the close write used to resolve
 * entry_price = 0 and skip — leaving the row `closed_at IS NULL` forever.
 */
describe('resolvePersistedEntryPrice', () => {
  test('prefers the raw entry-fill VWAP when entry fills exist', () => {
    const price = resolvePersistedEntryPrice({
      side: 'long',
      averagePrice: 0, // zeroed on close
      trades: [
        { side: 'buy', size: 1, price: 100 },
        { side: 'sell', size: 1, price: 110 },
      ],
      metadata: { [HYDRATED_ENTRY_PRICE_KEY]: 95 },
    });
    expect(price).toBe(100);
  });

  test('hydrated position closed in a later session: falls back to metadata.hydratedEntryPrice', () => {
    const price = resolvePersistedEntryPrice({
      side: 'long',
      averagePrice: 0, // zeroed on close
      trades: [{ side: 'sell', size: 0.05, price: 2565.1 }], // only the exit fill is known
      metadata: { hydratedFromSupabase: true, [HYDRATED_ENTRY_PRICE_KEY]: 2000.5 },
    });
    expect(price).toBe(2000.5);
  });

  test('falls back to averagePrice for a live position with no fills yet, and 0 when nothing is known', () => {
    expect(resolvePersistedEntryPrice({ side: 'short', averagePrice: 3010, trades: [] })).toBe(3010);
    expect(resolvePersistedEntryPrice({ side: 'long', averagePrice: 0, trades: [], metadata: {} })).toBe(0);
    expect(resolvePersistedEntryPrice({ side: 'long', averagePrice: Number.NaN, metadata: { [HYDRATED_ENTRY_PRICE_KEY]: 'garbage' } })).toBe(0);
  });
});
