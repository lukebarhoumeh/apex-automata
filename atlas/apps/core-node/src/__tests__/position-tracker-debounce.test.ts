import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  PositionTracker,
  type PositionTrackerConfig,
  type Position,
} from '../trading/position-tracker';

/**
 * D10 — verify the per-symbol debounce on `position:updated`.
 *
 * Contract (see position-tracker.ts class comment):
 *   - 'position:updated' coalesces to ≤ 1 emit per `updateDebounceMs` (1s) per symbol.
 *   - 'position:closed' is undebounced AND cancels any pending 'position:updated'
 *     for that symbol, so observers never see a stale update after the close.
 */

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          single: () => Promise.resolve({ data: null, error: null }),
          maybeSingle: () => Promise.resolve({ data: null, error: null }),
        }),
      }),
      insert: () => Promise.resolve({ error: null }),
      upsert: () => Promise.resolve({ error: null }),
    }),
  }),
}));

function makeFill(overrides: Partial<any>) {
  const now = new Date().toISOString();
  return {
    trade_id: overrides.trade_id ?? 1,
    product_id: overrides.product_id ?? 'BTC-USD',
    order_id: overrides.order_id ?? `order-${overrides.trade_id ?? 1}`,
    user_id: 'u',
    profile_id: 'p',
    liquidity: 'T',
    price: overrides.price ?? '50000',
    size: overrides.size ?? '1',
    fee: overrides.fee ?? '0',
    created_at: overrides.created_at ?? now,
    side: overrides.side ?? 'buy',
    settled: true,
    usd_volume: overrides.usd_volume ?? '0',
  };
}

describe('PositionTracker debounce (D10)', () => {
  let tracker: PositionTracker;

  const config: PositionTrackerConfig = {
    supabaseUrl: 'http://localhost:54321',
    supabaseKey: 'test-key',
    updateInterval: 60_000, // long enough that the internal update loop won't interfere
    pnlCalculationMethod: 'fifo',
    maxPositionValueUsd: 500_000,
    maxUnrealizedLossUsd: 500_000,
    drawdownWarningPct: 50,
    drawdownCriticalPct: 75,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    tracker = new PositionTracker(config, mockLogger as any);
  });

  afterEach(() => {
    tracker.stopUpdateLoop();
    vi.useRealTimers();
  });

  test('10 rapid mark-price updates coalesce to a single tail-edge position:updated', async () => {
    const updates: Position[] = [];
    tracker.on('position:updated', (p: Position) => updates.push(p));

    // Open a long position so updateMarketPrice has a live position to mutate.
    // processFill emits 'position:opened' for the first trade (not 'updated'),
    // so it does not pollute our counter.
    await tracker.processFill(makeFill({ trade_id: 1, side: 'buy', price: '50000', size: '1', fee: '0' }) as any);
    expect(updates.length).toBe(0);

    // 10 rapid mark-price updates within the debounce window. None should
    // emit synchronously — the first one schedules a 1s timer; the rest
    // overwrite the pending state without resetting it.
    for (let i = 0; i < 10; i++) {
      tracker.updateMarketPrice('BTC-USD', 50_100 + i);
    }
    expect(updates.length).toBe(0);

    // Advance just under 1s — still debounced, nothing emitted yet.
    await vi.advanceTimersByTimeAsync(999);
    expect(updates.length).toBe(0);

    // Cross the 1s boundary — tail-edge fires with the latest state.
    await vi.advanceTimersByTimeAsync(1);
    expect(updates.length).toBe(1);
    expect(updates[0].symbol).toBe('BTC-USD');
    expect(updates[0].marketPrice).toBe(50_109);
  });

  test('position:closed fires immediately and cancels any pending debounced update', async () => {
    const updates: Position[] = [];
    const closes: Position[] = [];
    tracker.on('position:updated', (p: Position) => updates.push(p));
    tracker.on('position:closed', (p: Position) => closes.push(p));

    await tracker.processFill(makeFill({ trade_id: 1, side: 'buy', price: '50000', size: '1', fee: '0' }) as any);

    // Schedule a pending debounced update.
    tracker.updateMarketPrice('BTC-USD', 50_500);
    expect(updates.length).toBe(0);
    expect(closes.length).toBe(0);

    // Close fill arrives mid-debounce-window. Close should be:
    //   (a) immediate (no timer wait)
    //   (b) the LAST event observers see for this symbol (no trailing 'updated')
    await tracker.processFill(
      makeFill({ trade_id: 2, side: 'sell', price: '50_500', size: '1', fee: '0' }) as any,
    );

    expect(closes.length).toBe(1);
    expect(closes[0].closedAt).toBeInstanceOf(Date);
    // The pending 'position:updated' for BTC-USD must have been cancelled.
    expect(updates.length).toBe(0);

    // Even after the original debounce window expires, no stale 'updated' fires.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(updates.length).toBe(0);
    expect(closes.length).toBe(1);
  });

  test('subsequent burst after a quiet window emits again', async () => {
    const updates: Position[] = [];
    tracker.on('position:updated', (p: Position) => updates.push(p));

    await tracker.processFill(makeFill({ trade_id: 1, side: 'buy', price: '50000', size: '1', fee: '0' }) as any);

    // First burst → 1 tail emit.
    for (let i = 0; i < 5; i++) tracker.updateMarketPrice('BTC-USD', 50_010 + i);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(updates.length).toBe(1);

    // Quiet for 1.5s.
    await vi.advanceTimersByTimeAsync(1_500);
    expect(updates.length).toBe(1);

    // Second burst → 1 more tail emit.
    for (let i = 0; i < 5; i++) tracker.updateMarketPrice('BTC-USD', 51_010 + i);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(updates.length).toBe(2);
    expect(updates[1].marketPrice).toBe(51_014);
  });

  test('multiple symbols debounce independently', async () => {
    const updates: Position[] = [];
    tracker.on('position:updated', (p: Position) => updates.push(p));

    await tracker.processFill(makeFill({ trade_id: 1, product_id: 'BTC-USD', side: 'buy', price: '50000', size: '1' }) as any);
    await tracker.processFill(makeFill({ trade_id: 2, product_id: 'ETH-USD', side: 'buy', price: '3000', size: '1' }) as any);

    // Interleaved bursts on two symbols.
    for (let i = 0; i < 5; i++) {
      tracker.updateMarketPrice('BTC-USD', 50_100 + i);
      tracker.updateMarketPrice('ETH-USD', 3_100 + i);
    }
    expect(updates.length).toBe(0);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(updates.length).toBe(2);
    const symbols = updates.map((u) => u.symbol).sort();
    expect(symbols).toEqual(['BTC-USD', 'ETH-USD']);
  });
});
