/**
 * Unit tests for PositionTracker.hydrateOpenPositions.
 *
 * These guard the startup-rehydration path added in the platform-integrity
 * PR: before this work, PositionTracker held all state in-memory only, so
 * any restart silently abandoned every live position.
 *
 * The Supabase client is mocked at module scope so each test can swap in a
 * different response shape (rows, error, malformed rows) without touching
 * the network.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { PositionTracker, PositionTrackerConfig } from '../trading/position-tracker';

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

// Each test sets this to control what supabase.from('positions').select(...).eq(...).is(...) returns.
let nextQueryResult: { data: any[] | null; error: { message: string } | null } = { data: [], error: null };

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          is: () => Promise.resolve(nextQueryResult),
        }),
      }),
      insert: () => Promise.resolve({ error: null }),
      upsert: () => Promise.resolve({ error: null }),
    }),
  }),
}));

const baseConfig: PositionTrackerConfig = {
  supabaseUrl: 'http://localhost:54321',
  supabaseKey: 'test-key',
  updateInterval: 5000,
  pnlCalculationMethod: 'fifo',
  maxPositionValueUsd: 500_000,
  maxUnrealizedLossUsd: 500_000,
  drawdownWarningPct: 50,
  drawdownCriticalPct: 75,
};

describe('PositionTracker.hydrateOpenPositions', () => {
  let tracker: PositionTracker;

  beforeEach(() => {
    vi.clearAllMocks();
    nextQueryResult = { data: [], error: null };
    tracker = new PositionTracker(baseConfig, mockLogger as any);
  });

  afterEach(() => {
    tracker.stopUpdateLoop();
  });

  test('returns 0 and skips fetch when userId is empty', async () => {
    const count = await tracker.hydrateOpenPositions('');
    expect(count).toBe(0);
    expect(mockLogger.warn).toHaveBeenCalled();
  });

  test('hydrates a well-formed open position row', async () => {
    nextQueryResult = {
      data: [
        {
          id: '11111111-1111-1111-1111-111111111111',
          symbol: 'ETH-USD',
          side: 'long',
          qty_open: 0.5,
          entry_price: 3000,
          opened_at: '2026-05-10T12:00:00.000Z',
          stop_price_at_entry: 2900,
          take_profit_price: 3150,
          strategy: 'momentum',
          realized_pnl_usd: 0,
          exit_reason: null,
        },
      ],
      error: null,
    };

    const count = await tracker.hydrateOpenPositions('user-abc');
    expect(count).toBe(1);

    const pos = tracker.getPosition('ETH-USD');
    expect(pos).toBeDefined();
    expect(pos!.side).toBe('long');
    expect(pos!.size).toBe(0.5);
    expect(pos!.averagePrice).toBe(3000);
    expect(pos!.stopPrice).toBe(2900);
    expect(pos!.takeProfit).toBe(3150);
    expect(pos!.metadata?.hydratedFromSupabase).toBe(true);
  });

  test('skips malformed rows (zero size, invalid price) without throwing', async () => {
    nextQueryResult = {
      data: [
        { id: 'a', symbol: 'BTC-USD', side: 'long', qty_open: 0, entry_price: 50000 },
        { id: 'b', symbol: 'ETH-USD', side: 'short', qty_open: 1, entry_price: 0 },
        { id: 'c', symbol: 'SOL-USD', side: 'long', qty_open: 5, entry_price: 100, opened_at: '2026-05-10T12:00:00.000Z' },
      ],
      error: null,
    };

    const count = await tracker.hydrateOpenPositions('user-abc');
    // Only the valid SOL row hydrates; the two malformed rows are skipped + warned.
    expect(count).toBe(1);
    expect(tracker.getPosition('SOL-USD')).toBeDefined();
    expect(tracker.getPosition('BTC-USD')).toBeUndefined();
    expect(tracker.getPosition('ETH-USD')).toBeUndefined();
    expect(mockLogger.warn).toHaveBeenCalled();
  });

  test('is idempotent — second call replaces in-memory state with current DB snapshot', async () => {
    nextQueryResult = {
      data: [
        { id: 'a', symbol: 'BTC-USD', side: 'long', qty_open: 1, entry_price: 50000 },
      ],
      error: null,
    };
    await tracker.hydrateOpenPositions('user-abc');
    expect(tracker.getPosition('BTC-USD')).toBeDefined();

    // Simulate DB now showing the position closed (no rows returned).
    nextQueryResult = { data: [], error: null };
    const second = await tracker.hydrateOpenPositions('user-abc');
    expect(second).toBe(0);
    expect(tracker.getPosition('BTC-USD')).toBeUndefined();
  });

  test('throws when Supabase returns an error so the engine can branch on failure', async () => {
    nextQueryResult = { data: null, error: { message: 'fetch failed' } };
    await expect(tracker.hydrateOpenPositions('user-abc')).rejects.toThrow(/positions hydrate query failed/);
  });
});
