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
type QueryResult = { data: any[] | null; error: { message: string; code?: string } | null };
let nextQueryResult: QueryResult = { data: [], error: null };
// Optional FIFO of per-call results (schema-tolerance tests); falls back to nextQueryResult when drained.
let queuedQueryResults: QueryResult[] = [];
// Column lists passed to select(), in call order.
let selectCalls: string[] = [];

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: () => ({
      select: (columns: string) => {
        selectCalls.push(columns);
        return {
          eq: () => ({
            is: () => Promise.resolve(queuedQueryResults.length > 0 ? queuedQueryResults.shift() : nextQueryResult),
          }),
        };
      },
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
    queuedQueryResults = [];
    selectCalls = [];
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
    // Recovered by the close write once the tracker zeroes averagePrice (PR #64).
    expect(pos!.metadata?.hydratedEntryPrice).toBe(3000);
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

  // ── execution_mode isolation (paper and live share one Supabase project) ──

  const LIVE_ROW_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const modeRows = () => [
    { id: 'p-1', symbol: 'ETH-USD', side: 'long', qty_open: 0.5, entry_price: 3000, opened_at: '2026-09-27T12:00:00.000Z', execution_mode: 'paper' },
    { id: LIVE_ROW_ID, symbol: 'BTC-USD', side: 'long', qty_open: 0.01, entry_price: 110_000, opened_at: '2026-09-27T12:05:00.000Z', execution_mode: 'live' },
    // Legacy row written before migration 20260911170000: execution_mode never stamped.
    { id: 'n-1', symbol: 'SOL-USD', side: 'short', qty_open: 5, entry_price: 150, opened_at: '2026-09-27T12:10:00.000Z', execution_mode: null },
  ];

  test('paper hydrate adopts paper and legacy (NULL) rows only — a live row is skipped and reported', async () => {
    nextQueryResult = { data: modeRows(), error: null };

    const count = await tracker.hydrateOpenPositions('user-abc', { executionMode: 'paper' });

    expect(count).toBe(2);
    expect(tracker.getPosition('ETH-USD')).toBeDefined();
    expect(tracker.getPosition('SOL-USD')).toBeDefined();
    expect(tracker.getPosition('BTC-USD')).toBeUndefined();

    // The skipped row is surfaced (count + ids), never silently dropped.
    const skipWarn = mockLogger.warn.mock.calls.find(([msg]) => /execution_mode/.test(String(msg)));
    expect(skipWarn).toBeDefined();
    expect(skipWarn![1]).toMatchObject({ executionMode: 'paper', skipped: 1, ids: [LIVE_ROW_ID], symbols: ['BTC-USD'] });
    // The query itself asked for the column so the decision is made on the row, not by guessing.
    expect(selectCalls[0]).toMatch(/execution_mode/);
  });

  test('live hydrate is symmetric: paper rows are never adopted by a live start (NULL still hydrates)', async () => {
    nextQueryResult = { data: modeRows(), error: null };

    const count = await tracker.hydrateOpenPositions('user-abc', { executionMode: 'live' });

    expect(count).toBe(2);
    expect(tracker.getPosition('BTC-USD')).toBeDefined();
    expect(tracker.getPosition('SOL-USD')).toBeDefined();
    expect(tracker.getPosition('ETH-USD')).toBeUndefined();
    const skipWarn = mockLogger.warn.mock.calls.find(([msg]) => /execution_mode/.test(String(msg)));
    expect(skipWarn![1]).toMatchObject({ executionMode: 'live', skipped: 1, ids: ['p-1'] });
  });

  test('no active mode given: every open row hydrates (legacy callers unchanged)', async () => {
    nextQueryResult = { data: modeRows(), error: null };
    const count = await tracker.hydrateOpenPositions('user-abc');
    expect(count).toBe(3);
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  test('pre-20260911 schema: 42703 on execution_mode retries the legacy select once and hydrates every row', async () => {
    queuedQueryResults = [
      { data: null, error: { code: '42703', message: 'column positions.execution_mode does not exist' } },
      { data: modeRows().map(({ execution_mode: _m, ...row }) => row), error: null },
    ];

    const count = await tracker.hydrateOpenPositions('user-abc', { executionMode: 'paper' });

    expect(count).toBe(3);
    expect(selectCalls).toHaveLength(2);
    expect(selectCalls[0]).toMatch(/execution_mode/);
    expect(selectCalls[1]).not.toMatch(/execution_mode/);
    // Warned once about the missing column; no "skipped" warning since nothing was skipped.
    expect(mockLogger.warn).toHaveBeenCalledTimes(1);
    expect(mockLogger.warn.mock.calls[0][0]).toMatch(/20260911170000/);
  });

  test('an unrelated error on the stamped select still throws (no silent legacy retry)', async () => {
    queuedQueryResults = [{ data: null, error: { code: '42501', message: 'permission denied for table positions' } }];
    await expect(tracker.hydrateOpenPositions('user-abc', { executionMode: 'paper' })).rejects.toThrow(/positions hydrate query failed/);
    expect(selectCalls).toHaveLength(1);
  });
});
