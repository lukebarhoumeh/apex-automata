import { describe, test, expect, beforeEach, vi } from 'vitest';
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
      select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }),
      insert: () => Promise.resolve({ error: null }),
      upsert: () => Promise.resolve({ error: null }),
      update: () => Promise.resolve({ error: null }),
    }),
  }),
}));

const config: PositionTrackerConfig = {
  supabaseUrl: 'http://localhost:54321',
  supabaseKey: 'test-key',
  updateInterval: 10_000,
  pnlCalculationMethod: 'fifo',
  maxPositionValueUsd: 1_000_000,
  maxUnrealizedLossUsd: 1_000_000,
  drawdownWarningPct: 50,
  drawdownCriticalPct: 90,
};

const baseFill = {
  order_id: 'order-1',
  trade_id: 'trade-1',
  product_id: 'BTC-USD',
  created_at: new Date().toISOString(),
};

describe('PositionTracker FIFO PnL', () => {
  let tracker: PositionTracker;

  beforeEach(() => {
    vi.clearAllMocks();
    tracker = new PositionTracker(config, mockLogger as any);
  });

  test('buy, buy, sell consumes FIFO and allocates fees', async () => {
    await tracker.processFill({
      ...baseFill,
      side: 'buy',
      size: '1',
      price: '100',
      fee: '1',
    } as any);

    await tracker.processFill({
      ...baseFill,
      order_id: 'order-2',
      trade_id: 'trade-2',
      side: 'buy',
      size: '1',
      price: '110',
      fee: '1',
    } as any);

    await tracker.processFill({
      ...baseFill,
      order_id: 'order-3',
      trade_id: 'trade-3',
      side: 'sell',
      size: '1',
      price: '120',
      fee: '1',
    } as any);

    const position = tracker.getPosition('BTC-USD');
    expect(position?.realizedPnL).toBeCloseTo(18); // (120-100) - entryFee(1) - exitFee(1) = 18
    expect(position?.size).toBeCloseTo(1);
    expect(position?.side).toBe('long');
  });

  test('partial close then flip opens opposite side with remaining fee allocated', async () => {
    await tracker.processFill({
      ...baseFill,
      side: 'buy',
      size: '1',
      price: '100',
      fee: '1',
    } as any);

    await tracker.processFill({
      ...baseFill,
      order_id: 'order-4',
      trade_id: 'trade-4',
      side: 'sell',
      size: '2',
      price: '90',
      fee: '2',
    } as any);

    const position = tracker.getPosition('BTC-USD');
    expect(position?.realizedPnL).toBeCloseTo(-12); // (-10) - entryFee(1) - exitFee(1) = -12
    expect(position?.side).toBe('short');
    expect(position?.size).toBeCloseTo(1);
    expect(position?.averagePrice).toBeGreaterThan(0);
  });
});
