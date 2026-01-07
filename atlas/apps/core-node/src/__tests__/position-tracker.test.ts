import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { PositionTracker, PositionTrackerConfig } from '../trading/position-tracker';

// Mock logger
const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

// Mock Supabase client
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
    price: overrides.price ?? '100',
    size: overrides.size ?? '1',
    fee: overrides.fee ?? '0',
    created_at: overrides.created_at ?? now,
    side: overrides.side ?? 'buy',
    settled: true,
    usd_volume: overrides.usd_volume ?? '0',
  };
}

describe('PositionTracker', () => {
  let tracker: PositionTracker;

  const config: PositionTrackerConfig = {
    supabaseUrl: 'http://localhost:54321',
    supabaseKey: 'test-key',
    updateInterval: 5000,
    pnlCalculationMethod: 'fifo',
    maxPositionValueUsd: 500000,
    maxUnrealizedLossUsd: 500000,
    drawdownWarningPct: 50,
    drawdownCriticalPct: 75,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    tracker = new PositionTracker(config, mockLogger as any);
  });

  afterEach(() => {
    tracker.stopUpdateLoop();
  });

  test('accumulates realized P&L after a position is closed and removed from memory', async () => {
    // Open long: buy 1 @ 100, fee 1 (cost basis = 101)
    await tracker.processFill(makeFill({ trade_id: 1, side: 'buy', price: '100', size: '1', fee: '1' }) as any);
    tracker.updateMarketPrice('BTC-USD', 100);

    // Close long: sell 1 @ 110, fee 1 (net proceeds = 109), realized PnL = 109 - 101 = 8
    await tracker.processFill(makeFill({ trade_id: 2, side: 'sell', price: '110', size: '1', fee: '1' }) as any);

    expect(tracker.getPosition('BTC-USD')).toBeUndefined();

    const summary = tracker.getPortfolioSummary();
    expect(summary.positionCount).toBe(0);
    expect(summary.totalUnrealizedPnL).toBeCloseTo(0, 8);
    expect(summary.totalRealizedPnL).toBeCloseTo(8, 8);
    expect(summary.totalPnL).toBeCloseTo(8, 8);
  });

  test('allocates fees correctly when a trade flips the position direction', async () => {
    // Open long: buy 1 @ 100, fee 1 => avg = 101
    await tracker.processFill(makeFill({ trade_id: 1, side: 'buy', price: '100', size: '1', fee: '1' }) as any);
    tracker.updateMarketPrice('BTC-USD', 100);

    // Sell 2 @ 110, fee 2:
    // - closes 1 with half the fee (1) => realized = (110 - 101) - 1 = 8
    // - opens short 1 with remaining fee (1) => short avg proceeds = 110 - 1 = 109
    await tracker.processFill(makeFill({ trade_id: 2, side: 'sell', price: '110', size: '2', fee: '2' }) as any);

    const flipped = tracker.getPosition('BTC-USD');
    expect(flipped).toBeDefined();
    expect(flipped!.side).toBe('short');
    expect(flipped!.size).toBeCloseTo(1, 8);
    expect(flipped!.averagePrice).toBeCloseTo(109, 8);

    // Close short: buy 1 @ 100, fee 1 => realized = (109 - 100) - 1 = 8; total realized = 16
    await tracker.processFill(makeFill({ trade_id: 3, side: 'buy', price: '100', size: '1', fee: '1' }) as any);

    expect(tracker.getPosition('BTC-USD')).toBeUndefined();
    const summary = tracker.getPortfolioSummary();
    expect(summary.totalRealizedPnL).toBeCloseTo(16, 8);
    expect(summary.totalPnL).toBeCloseTo(16, 8);
  });
});


