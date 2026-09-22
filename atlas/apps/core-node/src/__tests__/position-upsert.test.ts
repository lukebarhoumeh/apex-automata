/**
 * Tier-A (2026-09-21) — paper fill → `positions` row persistence.
 *
 * Root cause pinned here: `syncPositionToSupabase` upserted on
 * `user_id,symbol`, but migration 20260511000000_positions_history_preserve
 * dropped that UNIQUE and left only a partial open-only index, so Postgres
 * answered 42P10 on every write and the `positions` table stayed empty while
 * orders/fills persisted (Trading Master, sess_1790012382376_ox36vy).
 *
 * Pins:
 *   - the conflict target defaults to `id`; only an explicit
 *     POSITIONS_HISTORY_PRESERVE=false opts into the legacy target;
 *   - a 42P10 on the legacy target retries the SAME row on `id` once and
 *     latches the process on `id` (warned once);
 *   - unrelated errors are surfaced, never retried or masked;
 *   - the row that lands carries `session_id` / `execution_mode`;
 *   - end-to-end: a PositionTracker fill → `position:opened` → one open row
 *     with the session stamp; the closing fill updates that row in place.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  POSITIONS_CONFLICT_TARGET_ID,
  POSITIONS_CONFLICT_TARGET_LEGACY,
  POSITIONS_HISTORY_PRESERVE_ENV,
  PositionsConflictTargetSupport,
  describePositionUpsertError,
  resolvePositionsConflictTarget,
  upsertPositionRow,
  type PositionsConflictTarget,
} from '../persistence/position-upsert';
import { resolvePositionWriteStamp } from '../persistence/position-session-restamp';
import { SessionColumnSupport } from '../persistence/session-stamp';
import { PositionTracker, type Position, type PositionTrackerConfig } from '../trading/position-tracker';
import type { Fill } from '../exchanges/coinbase';
import type { Logger } from '../core/logger';

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: () => ({
      select: () => ({ eq: () => ({ is: () => Promise.resolve({ data: [], error: null }) }) }),
      insert: () => Promise.resolve({ error: null }),
      upsert: () => Promise.resolve({ error: null }),
    }),
  }),
}));

const USER_ID = 'b7e8f9c2-4d6a-4c8b-9e2d-1a3b5c7d9e1f';
const STAMP = { sessionId: 'sess_1790012382376_ox36vy', executionMode: 'paper' as const };

/** Exactly what PostgREST relayed for the positions upsert on the live project. */
const NO_ARBITER_42P10 = {
  code: '42P10',
  message: 'there is no unique or exclusion constraint matching the ON CONFLICT specification',
};
const RLS_DENIED = { code: '42501', message: 'new row violates row-level security policy for table "positions"' };
const MISSING_SESSION_ID = { code: 'PGRST204', message: "Could not find the 'session_id' column of 'positions' in the schema cache" };

type Row = Record<string, unknown>;

/**
 * In-memory `positions` shaped like the deployed schema after
 * 20260511000000_positions_history_preserve: PRIMARY KEY (id) is the only
 * arbiter `ON CONFLICT` can infer, and `positions_user_symbol_open_uidx`
 * (user_id, symbol) WHERE closed_at IS NULL still guards open rows.
 */
function liveSchemaPositionsTable() {
  const rows = new Map<string, Row>();
  const calls: Array<{ onConflict: PositionsConflictTarget; payload: Row }> = [];
  const upsert = async (payload: Row, onConflict: PositionsConflictTarget) => {
    calls.push({ onConflict, payload: { ...payload } });
    if (onConflict !== POSITIONS_CONFLICT_TARGET_ID) return { error: NO_ARBITER_42P10 };
    if (payload.closed_at == null) {
      for (const [id, row] of rows) {
        if (id !== payload.id && row.user_id === payload.user_id && row.symbol === payload.symbol && row.closed_at == null) {
          return { error: { code: '23505', message: 'duplicate key value violates unique constraint "positions_user_symbol_open_uidx"' } };
        }
      }
    }
    rows.set(String(payload.id), { ...(rows.get(String(payload.id)) ?? {}), ...payload });
    return { error: null };
  };
  return { rows, calls, upsert };
}

const openRow = (overrides: Row = {}): Row => ({
  id: '0f1e2d3c-4b5a-4697-8877-665544332211',
  user_id: USER_ID,
  symbol: 'ETH-USD',
  strategy: 'momentum',
  side: 'long',
  qty_open: 0.05,
  entry_price: 4321.5,
  stop_price_at_entry: 4235.07,
  take_profit_price: 4451.15,
  opened_at: '2026-09-21T17:41:02.000Z',
  closed_at: null,
  exit_price: null,
  exit_reason: null,
  realized_pnl_usd: 0,
  ...overrides,
});

describe('resolvePositionsConflictTarget', () => {
  it('defaults to id when the env var is unset, empty or true-ish', () => {
    expect(resolvePositionsConflictTarget({})).toBe(POSITIONS_CONFLICT_TARGET_ID);
    expect(resolvePositionsConflictTarget({ [POSITIONS_HISTORY_PRESERVE_ENV]: '' })).toBe(POSITIONS_CONFLICT_TARGET_ID);
    expect(resolvePositionsConflictTarget({ [POSITIONS_HISTORY_PRESERVE_ENV]: 'true' })).toBe(POSITIONS_CONFLICT_TARGET_ID);
    expect(resolvePositionsConflictTarget({ [POSITIONS_HISTORY_PRESERVE_ENV]: '1' })).toBe(POSITIONS_CONFLICT_TARGET_ID);
    expect(resolvePositionsConflictTarget({ [POSITIONS_HISTORY_PRESERVE_ENV]: 'garbage' })).toBe(POSITIONS_CONFLICT_TARGET_ID);
  });

  it('selects the legacy (user_id, symbol) target only on an explicit false', () => {
    for (const value of ['false', 'FALSE', ' False ', '0', 'no', 'off']) {
      expect(resolvePositionsConflictTarget({ [POSITIONS_HISTORY_PRESERVE_ENV]: value })).toBe(POSITIONS_CONFLICT_TARGET_LEGACY);
    }
  });

  it('reads process.env by default', () => {
    const previous = process.env[POSITIONS_HISTORY_PRESERVE_ENV];
    try {
      delete process.env[POSITIONS_HISTORY_PRESERVE_ENV];
      expect(resolvePositionsConflictTarget()).toBe(POSITIONS_CONFLICT_TARGET_ID);
      process.env[POSITIONS_HISTORY_PRESERVE_ENV] = 'false';
      expect(resolvePositionsConflictTarget()).toBe(POSITIONS_CONFLICT_TARGET_LEGACY);
    } finally {
      if (previous === undefined) delete process.env[POSITIONS_HISTORY_PRESERVE_ENV];
      else process.env[POSITIONS_HISTORY_PRESERVE_ENV] = previous;
    }
  });
});

describe('PositionsConflictTargetSupport', () => {
  it('starts on the configured target', () => {
    const support = new PositionsConflictTargetSupport(POSITIONS_CONFLICT_TARGET_LEGACY);
    expect(support.current).toBe(POSITIONS_CONFLICT_TARGET_LEGACY);
    expect(support.snapshot()).toEqual({ configured: 'user_id,symbol', current: 'user_id,symbol', fellBack: false });
  });

  it('switches to id on 42P10, warns once with the migration + remediation, and stays there', () => {
    const logger = { warn: vi.fn() };
    const support = new PositionsConflictTargetSupport(POSITIONS_CONFLICT_TARGET_LEGACY, { logger });

    expect(support.noteConflictTargetError(NO_ARBITER_42P10)).toBe(true);
    expect(support.current).toBe(POSITIONS_CONFLICT_TARGET_ID);
    expect(support.snapshot()).toEqual({ configured: 'user_id,symbol', current: 'id', fellBack: true });
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][0]).toMatch(/20260511000000_positions_history_preserve/);
    expect(logger.warn.mock.calls[0][1]).toMatchObject({
      table: 'positions',
      configured: 'user_id,symbol',
      current: 'id',
      code: '42P10',
      remediation: expect.stringContaining(POSITIONS_HISTORY_PRESERVE_ENV),
    });

    // Already on id: a further 42P10 has nothing to fall back to and does not warn again.
    expect(support.noteConflictTargetError(NO_ARBITER_42P10)).toBe(false);
    expect(support.current).toBe(POSITIONS_CONFLICT_TARGET_ID);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('recognises the 42P10 by message when PostgREST drops the code', () => {
    const support = new PositionsConflictTargetSupport(POSITIONS_CONFLICT_TARGET_LEGACY);
    expect(support.noteConflictTargetError({ message: NO_ARBITER_42P10.message })).toBe(true);
    expect(support.current).toBe(POSITIONS_CONFLICT_TARGET_ID);
  });

  it('ignores unrelated errors and null', () => {
    const logger = { warn: vi.fn() };
    const support = new PositionsConflictTargetSupport(POSITIONS_CONFLICT_TARGET_LEGACY, { logger });
    expect(support.noteConflictTargetError(RLS_DENIED)).toBe(false);
    expect(support.noteConflictTargetError(null)).toBe(false);
    expect(support.noteConflictTargetError(undefined)).toBe(false);
    expect(support.current).toBe(POSITIONS_CONFLICT_TARGET_LEGACY);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

describe('upsertPositionRow', () => {
  it('legacy target configured, live schema: 42P10 → retried on id, row lands stamped, process latches on id', async () => {
    const table = liveSchemaPositionsTable();
    const logger = { warn: vi.fn() };
    const conflictSupport = new PositionsConflictTargetSupport(resolvePositionsConflictTarget({ [POSITIONS_HISTORY_PRESERVE_ENV]: 'false' }), { logger });
    const sessionSupport = new SessionColumnSupport();
    const row = openRow();

    const first = await upsertPositionRow({ row, stamp: STAMP, sessionSupport, conflictSupport, upsert: table.upsert, logger });

    expect(first).toEqual({ error: null, onConflictTarget: 'id', conflictFellBack: true, stamped: true, stampFellBack: false });
    expect(table.calls.map((c) => c.onConflict)).toEqual(['user_id,symbol', 'id']);
    // The SAME row is retried — stamp columns included — not a stripped or re-mapped one.
    expect(table.calls[1].payload).toEqual({ ...row, session_id: STAMP.sessionId, execution_mode: 'paper' });
    expect(table.rows.get(String(row.id))).toMatchObject({ id: row.id, symbol: 'ETH-USD', session_id: STAMP.sessionId, execution_mode: 'paper', closed_at: null });
    expect(sessionSupport.getState('positions')).toBe('present');
    expect(logger.warn).toHaveBeenCalledTimes(1);

    // Next write goes straight to id: one round-trip, no further warning.
    table.calls.length = 0;
    const second = await upsertPositionRow({ row: openRow({ qty_open: 0.1 }), stamp: STAMP, sessionSupport, conflictSupport, upsert: table.upsert, logger });
    expect(second).toEqual({ error: null, onConflictTarget: 'id', conflictFellBack: false, stamped: true, stampFellBack: false });
    expect(table.calls.map((c) => c.onConflict)).toEqual(['id']);
    expect(table.rows.get(String(row.id))).toMatchObject({ qty_open: 0.1 });
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('default configuration writes on id in a single round-trip with the session stamp', async () => {
    const table = liveSchemaPositionsTable();
    const conflictSupport = new PositionsConflictTargetSupport(resolvePositionsConflictTarget({}));
    const row = openRow();

    const result = await upsertPositionRow({ row, stamp: STAMP, sessionSupport: new SessionColumnSupport(), conflictSupport, upsert: table.upsert });

    expect(result).toEqual({ error: null, onConflictTarget: 'id', conflictFellBack: false, stamped: true, stampFellBack: false });
    expect(table.calls).toHaveLength(1);
    expect(table.calls[0].payload.session_id).toBe(STAMP.sessionId);
    expect(table.calls[0].payload.execution_mode).toBe('paper');
    expect(conflictSupport.snapshot().fellBack).toBe(false);
  });

  it('a null stamp (live hydrated position: opening session keeps session_id) writes the legacy shape and still upserts on id', async () => {
    const table = liveSchemaPositionsTable();
    const conflictSupport = new PositionsConflictTargetSupport(POSITIONS_CONFLICT_TARGET_ID);
    const row = openRow({ closed_at: '2026-09-21T18:02:11.000Z', exit_price: 4400, exit_reason: 'take_profit', realized_pnl_usd: 3.9 });

    const result = await upsertPositionRow({ row, stamp: null, sessionSupport: new SessionColumnSupport(), conflictSupport, upsert: table.upsert });

    expect(result).toEqual({ error: null, onConflictTarget: 'id', conflictFellBack: false, stamped: false, stampFellBack: false });
    expect(table.calls[0].payload).toEqual(row);
    expect(table.calls[0].payload).not.toHaveProperty('session_id');
  });

  it('a 42P10 while already on id is surfaced once, never retried (bounded)', async () => {
    const upsert = vi.fn().mockResolvedValue({ error: NO_ARBITER_42P10 });
    const conflictSupport = new PositionsConflictTargetSupport(POSITIONS_CONFLICT_TARGET_ID);

    const result = await upsertPositionRow({ row: openRow(), stamp: STAMP, sessionSupport: new SessionColumnSupport(), conflictSupport, upsert });

    expect(result).toEqual({ error: NO_ARBITER_42P10, onConflictTarget: 'id', conflictFellBack: false, stamped: true, stampFellBack: false });
    expect(upsert).toHaveBeenCalledTimes(1);
  });

  it('surfaces unrelated errors without retrying or changing the target', async () => {
    const upsert = vi.fn().mockResolvedValue({ error: RLS_DENIED });
    const conflictSupport = new PositionsConflictTargetSupport(POSITIONS_CONFLICT_TARGET_LEGACY);
    const sessionSupport = new SessionColumnSupport();

    const result = await upsertPositionRow({ row: openRow(), stamp: STAMP, sessionSupport, conflictSupport, upsert });

    expect(result.error).toBe(RLS_DENIED);
    expect(result.conflictFellBack).toBe(false);
    expect(result.onConflictTarget).toBe('user_id,symbol');
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(conflictSupport.current).toBe(POSITIONS_CONFLICT_TARGET_LEGACY);
    expect(sessionSupport.getState('positions')).toBe('unknown');
  });

  it('composes with the session-stamp fallback: 42P10 then missing stamp columns → 3 bounded calls, lands legacy-shaped on id', async () => {
    const logger = { warn: vi.fn() };
    const conflictSupport = new PositionsConflictTargetSupport(POSITIONS_CONFLICT_TARGET_LEGACY, { logger });
    const sessionSupport = new SessionColumnSupport();
    const upsert = vi
      .fn()
      .mockResolvedValueOnce({ error: NO_ARBITER_42P10 })      // stamped row, legacy target
      .mockResolvedValueOnce({ error: MISSING_SESSION_ID })    // stamped row, id — pre-20260911 schema
      .mockResolvedValueOnce({ error: null });                 // legacy shape, id
    const row = openRow();

    const result = await upsertPositionRow({ row, stamp: STAMP, sessionSupport, conflictSupport, upsert, logger });

    expect(result).toEqual({ error: null, onConflictTarget: 'id', conflictFellBack: true, stamped: false, stampFellBack: true });
    expect(upsert.mock.calls.map((c) => c[1])).toEqual(['user_id,symbol', 'id', 'id']);
    expect(upsert.mock.calls[2][0]).toEqual(row);
    expect(sessionSupport.getState('positions')).toBe('missing');
    expect(conflictSupport.current).toBe(POSITIONS_CONFLICT_TARGET_ID);
  });
});

describe('describePositionUpsertError', () => {
  it('points 42P10 at the migration and the env var', () => {
    const hint = describePositionUpsertError(NO_ARBITER_42P10, POSITIONS_CONFLICT_TARGET_LEGACY);
    expect(hint).toMatch(/ON CONFLICT \(user_id,symbol\)/);
    expect(hint).toMatch(/20260511000000_positions_history_preserve/);
    expect(hint).toMatch(new RegExp(POSITIONS_HISTORY_PRESERVE_ENV));
  });

  it('explains a 23505 on id as a still-open row or an unapplied migration', () => {
    const hint = describePositionUpsertError({ code: '23505', message: 'duplicate key value violates unique constraint "positions_user_symbol_open_uidx"' }, POSITIONS_CONFLICT_TARGET_ID);
    expect(hint).toMatch(/positions_user_symbol_open_uidx/);
    expect(hint).toMatch(/apply the migration/);
  });

  it('returns null for errors it does not classify', () => {
    expect(describePositionUpsertError(RLS_DENIED, POSITIONS_CONFLICT_TARGET_ID)).toBeNull();
    expect(describePositionUpsertError(null, POSITIONS_CONFLICT_TARGET_ID)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// End-to-end: paper fill → PositionTracker → position:opened / position:closed
// → one `positions` row on the live schema, stamped with the session.
// ---------------------------------------------------------------------------

const trackerConfig: PositionTrackerConfig = {
  supabaseUrl: 'http://localhost:54321',
  supabaseKey: 'test-key',
  updateInterval: 60_000,
  pnlCalculationMethod: 'fifo',
  maxPositionValueUsd: 1_000_000,
  maxUnrealizedLossUsd: 1_000_000,
  drawdownWarningPct: 50,
  drawdownCriticalPct: 90,
};

const makeLogger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() });
const asLogger = (logger: ReturnType<typeof makeLogger>) => logger as unknown as Logger;

/** A paper fill as the engine hands it to `PositionTracker.processFill`. */
function paperFill(overrides: Partial<Fill> & Pick<Fill, 'order_id' | 'product_id' | 'side' | 'size' | 'price' | 'created_at'>): Fill {
  return {
    trade_id: 1,
    user_id: USER_ID,
    profile_id: 'paper',
    liquidity: 'T',
    fee: '0',
    settled: true,
    usd_volume: String(Number(overrides.size) * Number(overrides.price)),
    ...overrides,
  };
}

/** The subset of `syncPositionToSupabase`'s row mapping this path depends on. */
function mapPositionRow(position: Position): Row {
  const entry = position.trades[0]?.price ?? position.averagePrice;
  return {
    id: position.id,
    user_id: USER_ID,
    symbol: position.symbol,
    strategy: position.strategy ?? 'system',
    side: position.side,
    qty_open: Math.abs(position.size),
    entry_price: entry,
    stop_price_at_entry: position.stopPrice ?? entry * 0.98,
    take_profit_price: position.takeProfit ?? entry * 1.03,
    opened_at: position.openTime.toISOString(),
    closed_at: position.closedAt ? position.closedAt.toISOString() : null,
    exit_price: position.exitPrice ?? null,
    exit_reason: position.exitReason ?? null,
    realized_pnl_usd: position.realizedPnL,
  };
}

describe('paper fill → positions row (live schema, session-stamped)', () => {
  const trackers: PositionTracker[] = [];
  afterEach(() => {
    for (const t of trackers.splice(0)) t.stopUpdateLoop();
  });

  it('opening fill creates the row with session_id; closing fill updates the same row in place', async () => {
    const logger = makeLogger();
    const tracker = new PositionTracker(trackerConfig, asLogger(logger));
    trackers.push(tracker);

    const table = liveSchemaPositionsTable();
    const conflictSupport = new PositionsConflictTargetSupport(resolvePositionsConflictTarget({}), { logger });
    const sessionSupport = new SessionColumnSupport();
    const persisted: Array<Awaited<ReturnType<typeof upsertPositionRow>>> = [];

    // Same composition as api/server.ts: every position event → upsertPositionRow.
    const persist = async (position: Position) => {
      const stamp = resolvePositionWriteStamp(position, STAMP);
      persisted.push(await upsertPositionRow({ row: mapPositionRow(position), stamp, sessionSupport, conflictSupport, upsert: table.upsert, logger }));
    };
    const pending: Promise<void>[] = [];
    tracker.on('position:opened', (p) => { pending.push(persist(p)); });
    tracker.on('position:closed', (p) => { pending.push(persist(p)); });

    await tracker.processFill(
      paperFill({ order_id: 'ord-entry', trade_id: 1, product_id: 'ETH-USD', side: 'buy', size: '0.05', price: '4321.5', fee: '0.11', created_at: '2026-09-21T17:41:02.000Z' }),
      { strategy: 'momentum', signalId: 'sig-1', stopPrice: 4235.07, takeProfit: 4451.15 },
    );
    await Promise.all(pending);

    const opened = tracker.getPosition('ETH-USD')!;
    expect(opened.side).toBe('long');
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toEqual({ error: null, onConflictTarget: 'id', conflictFellBack: false, stamped: true, stampFellBack: false });
    expect(table.rows.size).toBe(1);
    expect(table.rows.get(opened.id)).toMatchObject({
      id: opened.id,
      user_id: USER_ID,
      symbol: 'ETH-USD',
      strategy: 'momentum',
      side: 'long',
      qty_open: 0.05,
      entry_price: 4321.5,
      closed_at: null,
      session_id: STAMP.sessionId,
      execution_mode: 'paper',
    });

    await tracker.processFill(
      paperFill({ order_id: 'ord-exit', trade_id: 2, product_id: 'ETH-USD', side: 'sell', size: '0.05', price: '4451.15', fee: '0.11', created_at: '2026-09-21T18:02:11.000Z' }),
      { tag: 'take_profit' },
    );
    await Promise.all(pending);

    expect(persisted).toHaveLength(2);
    expect(persisted[1].error).toBeNull();
    expect(persisted[1].onConflictTarget).toBe('id');
    // Still exactly one row for the position: the close is an in-place update on the PK.
    expect(table.rows.size).toBe(1);
    expect(table.rows.get(opened.id)).toMatchObject({
      id: opened.id,
      side: 'long',
      qty_open: 0,
      closed_at: '2026-09-21T18:02:11.000Z',
      exit_price: 4451.15,
      exit_reason: 'take_profit',
      session_id: STAMP.sessionId,
    });
    expect(table.rows.get(opened.id)!.realized_pnl_usd as number).toBeGreaterThan(0);
    expect(table.calls.every((c) => c.onConflict === 'id')).toBe(true);
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('reproduces the incident on a legacy-configured host and shows the fallback healing it', async () => {
    const logger = makeLogger();
    const tracker = new PositionTracker(trackerConfig, asLogger(logger));
    trackers.push(tracker);

    const table = liveSchemaPositionsTable();
    const conflictSupport = new PositionsConflictTargetSupport(resolvePositionsConflictTarget({ [POSITIONS_HISTORY_PRESERVE_ENV]: 'false' }), { logger });
    const sessionSupport = new SessionColumnSupport();
    const results: Array<Awaited<ReturnType<typeof upsertPositionRow>>> = [];
    const pending: Promise<void>[] = [];
    tracker.on('position:opened', (p) => {
      pending.push(upsertPositionRow({ row: mapPositionRow(p), stamp: STAMP, sessionSupport, conflictSupport, upsert: table.upsert, logger }).then((r) => { results.push(r); }));
    });

    const fills = [['ETH-USD', '4321.5'], ['ETH-PERP-INTX', '4320.9'], ['SOL-USD', '212.4']] as const;
    for (const [index, [symbol, price]] of fills.entries()) {
      await tracker.processFill(
        paperFill({ order_id: `ord-${symbol}`, trade_id: index + 1, product_id: symbol, side: 'buy', size: '1', price, created_at: '2026-09-21T17:41:02.000Z' }),
        { strategy: 'momentum' },
      );
    }
    await Promise.all(pending);

    // Before the fix every one of these was a swallowed 42P10 and the table stayed at 0 rows.
    expect(results.map((r) => r.error)).toEqual([null, null, null]);
    expect(results[0]).toMatchObject({ conflictFellBack: true, onConflictTarget: 'id', stamped: true });
    expect(results.slice(1).every((r) => r.conflictFellBack === false && r.onConflictTarget === 'id')).toBe(true);
    expect(table.rows.size).toBe(3);
    expect([...table.rows.values()].map((r) => r.symbol).sort()).toEqual(['ETH-PERP-INTX', 'ETH-USD', 'SOL-USD']);
    expect([...table.rows.values()].every((r) => r.session_id === STAMP.sessionId && r.execution_mode === 'paper')).toBe(true);
    expect(table.calls.map((c) => c.onConflict)).toEqual(['user_id,symbol', 'id', 'id', 'id']);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});
