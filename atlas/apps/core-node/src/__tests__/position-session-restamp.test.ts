/**
 * Tier-A polish (DESK GO 2026-09-22) — hydrated open positions follow the
 * paper session that manages them.
 *
 * Root cause pinned here: after an API/engine restart, `hydrateOpenPositions`
 * re-materialised the `closed_at IS NULL` rows but `syncPositionToSupabase`
 * wrote hydrated positions UNSTAMPED (opening session owns `session_id`), so
 * their rows stayed on the prior `sess_*` while `/api/positions`, the FE
 * Supabase fallback and strategy session stats all scoped to the ACTIVE
 * session (ETH opens left on `…cvjy53` while the engine ran `…hkub8j`).
 *
 * Pins:
 *   - paper session start moves every hydrated open row onto the new
 *     session_id / execution_mode, by primary key `id`, in one UPDATE;
 *   - rows already on the active session are left alone (idempotent);
 *   - closed history is never touched — the session that closed a row keeps it;
 *   - live sessions do NOT take ownership (opening session keeps the stamp);
 *   - schema tolerance: missing stamp columns skip the restamp and are
 *     remembered in the shared SessionColumnSupport; unrelated errors surface;
 *   - the write-time stamp policy: hydrated positions are stamped with the
 *     active session in paper (self-heal), unstamped in live (unchanged);
 *   - end-to-end restart replay on an in-memory replica of the deployed
 *     schema: hydrate → restamp → ticker update → close, all upserting on
 *     `id` (#69), history rows preserved, no (user_id, symbol) conflict path.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  resolvePositionWriteStamp,
  restampHydratedOpenPositions,
  sessionOwnsHydratedPositions,
  type HydratedPositionRef,
  type PositionStampRow,
} from '../persistence/position-session-restamp';
import {
  POSITIONS_CONFLICT_TARGET_ID,
  PositionsConflictTargetSupport,
  resolvePositionsConflictTarget,
  upsertPositionRow,
  type PositionsConflictTarget,
} from '../persistence/position-upsert';
import { SessionColumnSupport, type SessionStamp, type SessionStampColumns } from '../persistence/session-stamp';
import { PositionTracker, type Position, type PositionTrackerConfig } from '../trading/position-tracker';
import { resolvePersistedEntryPrice } from '../trading/position-entry-vwap';
import type { Fill } from '../exchanges/coinbase';
import type { Logger } from '../core/logger';

// PositionTracker.hydrateOpenPositions reads through its own supabase-js
// client: `from('positions').select(...).eq('user_id', ...).is('closed_at', null)`.
// Each test points it at the in-memory table's open rows.
let hydrateRows: () => Array<Record<string, unknown>> = () => [];

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          is: () => Promise.resolve({ data: hydrateRows(), error: null }),
        }),
      }),
      insert: () => Promise.resolve({ error: null }),
      upsert: () => Promise.resolve({ error: null }),
    }),
  }),
}));

const USER_ID = 'b7e8f9c2-4d6a-4c8b-9e2d-1a3b5c7d9e1f';
const PRIOR_SESSION = 'sess_1790000000000_cvjy53';
const OLDER_SESSION = 'sess_1789900000000_a1b2c3';
const ACTIVE_PAPER: SessionStamp = { sessionId: 'sess_1790100000000_hkub8j', executionMode: 'paper' };
const ACTIVE_LIVE: SessionStamp = { sessionId: 'sess_1790100000000_live01', executionMode: 'live' };

const ETH_OPEN_ID = '0f1e2d3c-4b5a-4697-8877-665544332211';
const BTC_OPEN_ID = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const BTC_CLOSED_ID = '2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e';
const ETH_CLOSED_ID = '3c4d5e6f-7a8b-4c9d-0e1f-2a3b4c5d6e7f';

const MISSING_SESSION_ID_PGRST204 = {
  code: 'PGRST204',
  message: "Could not find the 'session_id' column of 'positions' in the schema cache",
};
const MISSING_SESSION_ID_42703 = { code: '42703', message: 'column positions.session_id does not exist' };
const RLS_DENIED = { code: '42501', message: 'new row violates row-level security policy for table "positions"' };

type Row = Record<string, unknown>;

/**
 * In-memory `positions` shaped like the deployed schema after
 * 20260511000000_positions_history_preserve + 20260911170000_session_scope:
 * PRIMARY KEY (id) is the only arbiter `ON CONFLICT` can infer,
 * `positions_user_symbol_open_uidx` (user_id, symbol) WHERE closed_at IS NULL
 * guards open rows, and `session_id` / `execution_mode` are nullable text.
 * `read` / `update` mirror exactly what api/server.ts injects.
 */
function liveSchemaPositionsTable(seed: Row[] = []) {
  const rows = new Map<string, Row>(seed.map((row) => [String(row.id), { ...row }]));
  const upsertCalls: Array<{ onConflict: PositionsConflictTarget; payload: Row }> = [];
  const readCalls: string[][] = [];
  const updateCalls: Array<{ ids: string[]; columns: SessionStampColumns }> = [];

  const upsert = async (payload: Row, onConflict: PositionsConflictTarget) => {
    upsertCalls.push({ onConflict, payload: { ...payload } });
    if (onConflict !== POSITIONS_CONFLICT_TARGET_ID) {
      return { error: { code: '42P10', message: 'there is no unique or exclusion constraint matching the ON CONFLICT specification' } };
    }
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

  const openRowsForUser = (userId: string) => [...rows.values()].filter((row) => row.user_id === userId && row.closed_at == null);

  const read = async (ids: string[]) => {
    readCalls.push([...ids]);
    const data: PositionStampRow[] = openRowsForUser(USER_ID)
      .filter((row) => ids.includes(String(row.id)))
      .map((row) => ({
        id: String(row.id),
        symbol: row.symbol as string,
        session_id: (row.session_id as string | null | undefined) ?? null,
        execution_mode: (row.execution_mode as string | null | undefined) ?? null,
      }));
    return { data, error: null };
  };

  const update = async (ids: string[], columns: SessionStampColumns) => {
    updateCalls.push({ ids: [...ids], columns: { ...columns } });
    const touched: Array<{ id: string }> = [];
    for (const row of openRowsForUser(USER_ID)) {
      if (!ids.includes(String(row.id))) continue;
      rows.set(String(row.id), { ...row, ...columns });
      touched.push({ id: String(row.id) });
    }
    return { data: touched, error: null };
  };

  return { rows, upsertCalls, readCalls, updateCalls, upsert, read, update, openRowsForUser };
}

const positionRow = (overrides: Row): Row => ({
  user_id: USER_ID,
  strategy: 'momentum',
  side: 'long',
  stop_price_at_entry: 4235.07,
  take_profit_price: 4451.15,
  closed_at: null,
  exit_price: null,
  exit_reason: null,
  realized_pnl_usd: 0,
  execution_mode: 'paper',
  ...overrides,
});

/** What the `positions` table looked like on 2026-09-21 when the engine restarted. */
function tableBeforeRestart() {
  return liveSchemaPositionsTable([
    // Still open, opened by the prior session — the rows the desk had to restamp by hand.
    positionRow({ id: ETH_OPEN_ID, symbol: 'ETH-USD', qty_open: 0.05, entry_price: 4321.5, opened_at: '2026-09-21T17:41:02.000Z', session_id: PRIOR_SESSION }),
    positionRow({ id: BTC_OPEN_ID, symbol: 'BTC-USD', qty_open: 0.002, entry_price: 112_450, opened_at: '2026-09-21T17:55:30.000Z', session_id: PRIOR_SESSION }),
    // Closed history: the session that closed each row must keep it.
    positionRow({ id: BTC_CLOSED_ID, symbol: 'BTC-USD', qty_open: 0, entry_price: 111_900, opened_at: '2026-09-21T15:10:00.000Z', closed_at: '2026-09-21T16:02:00.000Z', exit_price: 112_300, exit_reason: 'take_profit', realized_pnl_usd: 0.8, session_id: PRIOR_SESSION }),
    positionRow({ id: ETH_CLOSED_ID, symbol: 'ETH-USD', qty_open: 0, entry_price: 4250, opened_at: '2026-09-20T09:00:00.000Z', closed_at: '2026-09-20T11:30:00.000Z', exit_price: 4180, exit_reason: 'stop_loss', realized_pnl_usd: -3.5, session_id: OLDER_SESSION }),
  ]);
}

const hydratedRefs: HydratedPositionRef[] = [
  { id: ETH_OPEN_ID, symbol: 'ETH-USD' },
  { id: BTC_OPEN_ID, symbol: 'BTC-USD' },
];

const makeLogger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() });
const asLogger = (logger: ReturnType<typeof makeLogger>) => logger as unknown as Logger;

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

describe('sessionOwnsHydratedPositions', () => {
  it('paper sessions own the open positions they hydrate; live sessions and no session do not', () => {
    expect(sessionOwnsHydratedPositions(ACTIVE_PAPER)).toBe(true);
    expect(sessionOwnsHydratedPositions(ACTIVE_LIVE)).toBe(false);
    expect(sessionOwnsHydratedPositions(null)).toBe(false);
    expect(sessionOwnsHydratedPositions(undefined)).toBe(false);
  });
});

describe('resolvePositionWriteStamp', () => {
  const fresh = { metadata: { entryOrderId: 'ord-1' } };
  const hydrated = { metadata: { hydratedFromSupabase: true, hydratedEntryPrice: 4321.5 } };

  it('stamps a position opened in the active session, in either mode', () => {
    expect(resolvePositionWriteStamp(fresh, ACTIVE_PAPER)).toBe(ACTIVE_PAPER);
    expect(resolvePositionWriteStamp(fresh, ACTIVE_LIVE)).toBe(ACTIVE_LIVE);
    expect(resolvePositionWriteStamp({}, ACTIVE_PAPER)).toBe(ACTIVE_PAPER);
    expect(resolvePositionWriteStamp({ metadata: null }, ACTIVE_PAPER)).toBe(ACTIVE_PAPER);
  });

  it('stamps a hydrated position with the active PAPER session so later writes re-assert the restamp', () => {
    expect(resolvePositionWriteStamp(hydrated, ACTIVE_PAPER)).toBe(ACTIVE_PAPER);
  });

  it('leaves a hydrated position unstamped in LIVE (opening session keeps session_id — unchanged behaviour)', () => {
    expect(resolvePositionWriteStamp(hydrated, ACTIVE_LIVE)).toBeNull();
  });

  it('returns null without an active session', () => {
    expect(resolvePositionWriteStamp(fresh, null)).toBeNull();
    expect(resolvePositionWriteStamp(hydrated, undefined)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// restampHydratedOpenPositions — decision tree
// ---------------------------------------------------------------------------

describe('restampHydratedOpenPositions', () => {
  it('paper start: moves every hydrated open row onto the new session_id in one UPDATE keyed by id', async () => {
    const table = tableBeforeRestart();
    const support = new SessionColumnSupport();
    const logger = makeLogger();

    const result = await restampHydratedOpenPositions({ positions: hydratedRefs, stamp: ACTIVE_PAPER, support, read: table.read, update: table.update, logger });

    expect(result).toMatchObject({ outcome: 'restamped', sessionId: ACTIVE_PAPER.sessionId, hydrated: 2, restamped: 2, alreadyCurrent: 0, error: null });
    expect(result.rows).toEqual([
      { id: ETH_OPEN_ID, symbol: 'ETH-USD', fromSessionId: PRIOR_SESSION, fromExecutionMode: 'paper' },
      { id: BTC_OPEN_ID, symbol: 'BTC-USD', fromSessionId: PRIOR_SESSION, fromExecutionMode: 'paper' },
    ]);

    // Exactly one read + one update, both on the hydrated ids only.
    expect(table.readCalls).toEqual([[ETH_OPEN_ID, BTC_OPEN_ID]]);
    expect(table.updateCalls).toEqual([{ ids: [ETH_OPEN_ID, BTC_OPEN_ID], columns: { session_id: ACTIVE_PAPER.sessionId, execution_mode: 'paper' } }]);

    // Open rows now share the engine's session; nothing else about them changed.
    expect(table.rows.get(ETH_OPEN_ID)).toMatchObject({ symbol: 'ETH-USD', qty_open: 0.05, entry_price: 4321.5, closed_at: null, session_id: ACTIVE_PAPER.sessionId, execution_mode: 'paper' });
    expect(table.rows.get(BTC_OPEN_ID)).toMatchObject({ symbol: 'BTC-USD', qty_open: 0.002, closed_at: null, session_id: ACTIVE_PAPER.sessionId, execution_mode: 'paper' });

    // Closed history untouched: the session that closed each row keeps it.
    expect(table.rows.get(BTC_CLOSED_ID)).toMatchObject({ session_id: PRIOR_SESSION, closed_at: '2026-09-21T16:02:00.000Z', realized_pnl_usd: 0.8 });
    expect(table.rows.get(ETH_CLOSED_ID)).toMatchObject({ session_id: OLDER_SESSION, closed_at: '2026-09-20T11:30:00.000Z', realized_pnl_usd: -3.5 });
    expect(table.rows.size).toBe(4);

    expect(support.getState('positions')).toBe('present');
    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.info.mock.calls[0][0]).toMatch(/restamped hydrated open positions/);
    expect(logger.info.mock.calls[0][1]).toMatchObject({ sessionId: ACTIVE_PAPER.sessionId, restamped: 2, symbols: ['ETH-USD', 'BTC-USD'], fromSessionIds: [PRIOR_SESSION] });
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('is idempotent: rows already on the active session are not rewritten', async () => {
    const table = tableBeforeRestart();
    const support = new SessionColumnSupport();
    await restampHydratedOpenPositions({ positions: hydratedRefs, stamp: ACTIVE_PAPER, support, read: table.read, update: table.update });
    table.updateCalls.length = 0;

    const again = await restampHydratedOpenPositions({ positions: hydratedRefs, stamp: ACTIVE_PAPER, support, read: table.read, update: table.update });

    expect(again).toMatchObject({ outcome: 'noop', hydrated: 2, restamped: 0, alreadyCurrent: 2, rows: [], error: null });
    expect(table.updateCalls).toEqual([]);
  });

  it('mixed: only the stale rows go into the UPDATE; unstamped (NULL) rows count as stale', async () => {
    const table = liveSchemaPositionsTable([
      positionRow({ id: ETH_OPEN_ID, symbol: 'ETH-USD', qty_open: 0.05, entry_price: 4321.5, opened_at: '2026-09-21T17:41:02.000Z', session_id: ACTIVE_PAPER.sessionId }),
      positionRow({ id: BTC_OPEN_ID, symbol: 'BTC-USD', qty_open: 0.002, entry_price: 112_450, opened_at: '2026-09-21T17:55:30.000Z', session_id: null, execution_mode: null }),
    ]);

    const result = await restampHydratedOpenPositions({ positions: hydratedRefs, stamp: ACTIVE_PAPER, support: new SessionColumnSupport(), read: table.read, update: table.update });

    expect(result).toMatchObject({ outcome: 'restamped', hydrated: 2, restamped: 1, alreadyCurrent: 1 });
    expect(result.rows).toEqual([{ id: BTC_OPEN_ID, symbol: 'BTC-USD', fromSessionId: null, fromExecutionMode: null }]);
    expect(table.updateCalls).toEqual([{ ids: [BTC_OPEN_ID], columns: { session_id: ACTIVE_PAPER.sessionId, execution_mode: 'paper' } }]);
    expect(table.rows.get(BTC_OPEN_ID)).toMatchObject({ session_id: ACTIVE_PAPER.sessionId, execution_mode: 'paper' });
  });

  it('a row that closed between the hydrate SELECT and the restamp is left alone', async () => {
    const table = tableBeforeRestart();
    // BTC closes (e.g. a stop fires) right after hydrate, before openTradingSession runs.
    table.rows.set(BTC_OPEN_ID, { ...table.rows.get(BTC_OPEN_ID)!, closed_at: '2026-09-21T18:00:00.000Z', qty_open: 0 });

    const result = await restampHydratedOpenPositions({ positions: hydratedRefs, stamp: ACTIVE_PAPER, support: new SessionColumnSupport(), read: table.read, update: table.update });

    expect(result).toMatchObject({ outcome: 'restamped', hydrated: 2, restamped: 1 });
    expect(result.rows.map((row) => row.symbol)).toEqual(['ETH-USD']);
    expect(table.rows.get(BTC_OPEN_ID)).toMatchObject({ session_id: PRIOR_SESSION, closed_at: '2026-09-21T18:00:00.000Z' });
  });

  it('nothing hydrated: no round-trips, noop', async () => {
    const read = vi.fn();
    const update = vi.fn();

    const result = await restampHydratedOpenPositions({ positions: [], stamp: ACTIVE_PAPER, support: new SessionColumnSupport(), read, update });

    expect(result).toEqual({ outcome: 'noop', sessionId: ACTIVE_PAPER.sessionId, hydrated: 0, restamped: 0, alreadyCurrent: 0, rows: [], error: null });
    expect(read).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it('dedupes repeated ids and ignores refs without an id', async () => {
    const table = tableBeforeRestart();

    const result = await restampHydratedOpenPositions({
      positions: [hydratedRefs[0], hydratedRefs[0], { id: '', symbol: 'SOL-USD' }, hydratedRefs[1]],
      stamp: ACTIVE_PAPER,
      support: new SessionColumnSupport(),
      read: table.read,
      update: table.update,
    });

    expect(result).toMatchObject({ outcome: 'restamped', hydrated: 2, restamped: 2 });
    expect(table.readCalls).toEqual([[ETH_OPEN_ID, BTC_OPEN_ID]]);
  });

  it('LIVE: does not take ownership — no read, no update, opening session keeps session_id', async () => {
    const table = tableBeforeRestart();
    const logger = makeLogger();

    const result = await restampHydratedOpenPositions({ positions: hydratedRefs, stamp: ACTIVE_LIVE, support: new SessionColumnSupport(), read: table.read, update: table.update, logger });

    expect(result).toMatchObject({ outcome: 'skipped_mode', sessionId: ACTIVE_LIVE.sessionId, hydrated: 2, restamped: 0, rows: [], error: null });
    expect(table.readCalls).toEqual([]);
    expect(table.updateCalls).toEqual([]);
    expect(table.rows.get(ETH_OPEN_ID)).toMatchObject({ session_id: PRIOR_SESSION });
    expect(table.rows.get(BTC_OPEN_ID)).toMatchObject({ session_id: PRIOR_SESSION });
    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.info.mock.calls[0][0]).toMatch(/keep their opening session_id/);
  });

  it('pre-20260911 schema: PGRST204 on the read skips the restamp, marks the columns missing, warns once', async () => {
    const support = new SessionColumnSupport();
    const logger = makeLogger();
    const read = vi.fn().mockResolvedValue({ data: null, error: MISSING_SESSION_ID_PGRST204 });
    const update = vi.fn();

    const result = await restampHydratedOpenPositions({ positions: hydratedRefs, stamp: ACTIVE_PAPER, support, read, update, logger });

    expect(result).toMatchObject({ outcome: 'skipped_columns_missing', hydrated: 2, restamped: 0, error: null });
    expect(update).not.toHaveBeenCalled();
    expect(support.getState('positions')).toBe('missing');
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][0]).toMatch(/20260911170000/);
    expect(logger.warn.mock.calls[0][1]).toMatchObject({ step: 'read', code: 'PGRST204' });
    expect(logger.error).not.toHaveBeenCalled();

    // Known missing: the next start skips straight to noop without a round-trip and without a second warning.
    read.mockClear();
    const next = await restampHydratedOpenPositions({ positions: hydratedRefs, stamp: ACTIVE_PAPER, support, read, update, logger });
    expect(next.outcome).toBe('skipped_columns_missing');
    expect(read).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('pre-20260911 schema: 42703 on the UPDATE (read succeeded on a partial schema) is skipped the same way', async () => {
    const support = new SessionColumnSupport();
    const logger = makeLogger();
    const read = vi.fn().mockResolvedValue({ data: [{ id: ETH_OPEN_ID, symbol: 'ETH-USD', session_id: PRIOR_SESSION, execution_mode: null }], error: null });
    const update = vi.fn().mockResolvedValue({ data: null, error: MISSING_SESSION_ID_42703 });

    const result = await restampHydratedOpenPositions({ positions: [hydratedRefs[0]], stamp: ACTIVE_PAPER, support, read, update, logger });

    expect(result).toMatchObject({ outcome: 'skipped_columns_missing', restamped: 0, error: null });
    expect(update).toHaveBeenCalledTimes(1);
    expect(support.getState('positions')).toBe('missing');
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][1]).toMatchObject({ step: 'update', code: '42703' });
  });

  it('a shared SessionColumnSupport already marked missing by a writer skips without a round-trip', async () => {
    const support = new SessionColumnSupport();
    support.markMissing('positions');
    const read = vi.fn();
    const update = vi.fn();

    const result = await restampHydratedOpenPositions({ positions: hydratedRefs, stamp: ACTIVE_PAPER, support, read, update });

    expect(result.outcome).toBe('skipped_columns_missing');
    expect(read).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it('surfaces an unrelated read error without touching the column memory or writing', async () => {
    const support = new SessionColumnSupport();
    const logger = makeLogger();
    const read = vi.fn().mockResolvedValue({ data: null, error: RLS_DENIED });
    const update = vi.fn();

    const result = await restampHydratedOpenPositions({ positions: hydratedRefs, stamp: ACTIVE_PAPER, support, read, update, logger });

    expect(result).toMatchObject({ outcome: 'error', restamped: 0, error: RLS_DENIED });
    expect(update).not.toHaveBeenCalled();
    expect(support.getState('positions')).toBe('unknown');
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error.mock.calls[0][1]).toMatchObject({ code: '42501', ids: [ETH_OPEN_ID, BTC_OPEN_ID] });
  });

  it('surfaces an unrelated update error with the ids and symbols it tried to move', async () => {
    const logger = makeLogger();
    const read = vi.fn().mockResolvedValue({
      data: [
        { id: ETH_OPEN_ID, symbol: 'ETH-USD', session_id: PRIOR_SESSION, execution_mode: 'paper' },
        { id: BTC_OPEN_ID, symbol: 'BTC-USD', session_id: PRIOR_SESSION, execution_mode: 'paper' },
      ],
      error: null,
    });
    const update = vi.fn().mockResolvedValue({ data: null, error: RLS_DENIED });

    const result = await restampHydratedOpenPositions({ positions: hydratedRefs, stamp: ACTIVE_PAPER, support: new SessionColumnSupport(), read, update, logger });

    expect(result).toMatchObject({ outcome: 'error', restamped: 0, rows: [], error: RLS_DENIED });
    expect(update).toHaveBeenCalledTimes(1);
    expect(logger.error.mock.calls[0][1]).toMatchObject({ ids: [ETH_OPEN_ID, BTC_OPEN_ID], symbols: ['ETH-USD', 'BTC-USD'] });
  });

  it('trusts RETURNING over the request when the UPDATE moved fewer rows than asked', async () => {
    const read = vi.fn().mockResolvedValue({
      data: [
        { id: ETH_OPEN_ID, symbol: 'ETH-USD', session_id: PRIOR_SESSION, execution_mode: 'paper' },
        { id: BTC_OPEN_ID, symbol: 'BTC-USD', session_id: PRIOR_SESSION, execution_mode: 'paper' },
      ],
      error: null,
    });
    const update = vi.fn().mockResolvedValue({ data: [{ id: ETH_OPEN_ID }], error: null });

    const result = await restampHydratedOpenPositions({ positions: hydratedRefs, stamp: ACTIVE_PAPER, support: new SessionColumnSupport(), read, update });

    expect(result).toMatchObject({ outcome: 'restamped', restamped: 1 });
    expect(result.rows.map((row) => row.id)).toEqual([ETH_OPEN_ID]);
  });
});

// ---------------------------------------------------------------------------
// End-to-end restart replay on the deployed schema:
//   prior session opens ETH + BTC → API restarts → new paper session hydrates →
//   restamp → ticker update → ETH closes → a fresh ETH opens in the new session.
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
  // Same resolver as api/server.ts: entry-fill VWAP → hydrated entry_price → averagePrice.
  const entry = resolvePersistedEntryPrice(position);
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

/** What the session-scoped `GET /api/positions?status=open` sees for one session. */
function openRowsScopedTo(table: ReturnType<typeof liveSchemaPositionsTable>, sessionId: string) {
  return table.openRowsForUser(USER_ID).filter((row) => row.session_id === sessionId).map((row) => row.symbol);
}

describe('restart replay: hydrate → restamp → update → close on the deployed schema', () => {
  const trackers: PositionTracker[] = [];
  afterEach(() => {
    for (const t of trackers.splice(0)) t.stopUpdateLoop();
    hydrateRows = () => [];
  });

  it('open rows follow the new paper session; closed history and #69 upsert-on-id are untouched', async () => {
    const table = tableBeforeRestart();
    hydrateRows = () => table.openRowsForUser(USER_ID);

    const logger = makeLogger();
    const tracker = new PositionTracker(trackerConfig, asLogger(logger));
    trackers.push(tracker);

    // Before the restart the active session sees nothing: the open rows are on the prior session.
    expect(openRowsScopedTo(table, ACTIVE_PAPER.sessionId)).toEqual([]);
    expect(openRowsScopedTo(table, PRIOR_SESSION).sort()).toEqual(['BTC-USD', 'ETH-USD']);

    // 1. TradingEngine.start → hydrateOpenPositions (unchanged).
    const hydrated = await tracker.hydrateOpenPositions(USER_ID);
    expect(hydrated).toBe(2);
    const engineOpen = tracker.getOpenPositions();
    expect(engineOpen.every((p) => p.metadata?.hydratedFromSupabase === true)).toBe(true);

    // 2. openTradingSession (paper) → restamp, exactly as api/server.ts composes it.
    const sessionSupport = new SessionColumnSupport();
    const restamp = await restampHydratedOpenPositions({
      positions: engineOpen.filter((p) => p.metadata?.hydratedFromSupabase).map((p) => ({ id: p.id, symbol: p.symbol })),
      stamp: ACTIVE_PAPER,
      support: sessionSupport,
      read: table.read,
      update: table.update,
      logger,
    });
    expect(restamp).toMatchObject({ outcome: 'restamped', hydrated: 2, restamped: 2 });

    // The DB and the engine now agree on the session — what /api/positions and the FE fallback scope on.
    expect(openRowsScopedTo(table, ACTIVE_PAPER.sessionId).sort()).toEqual(['BTC-USD', 'ETH-USD']);
    expect(openRowsScopedTo(table, PRIOR_SESSION)).toEqual([]);
    expect(engineOpen.map((p) => p.symbol).sort()).toEqual(openRowsScopedTo(table, ACTIVE_PAPER.sessionId).sort());

    // 3. Every later position write goes through syncPositionToSupabase's composition.
    const conflictSupport = new PositionsConflictTargetSupport(resolvePositionsConflictTarget({}), { logger });
    const persisted: Array<Awaited<ReturnType<typeof upsertPositionRow>>> = [];
    const persist = async (position: Position) => {
      const stamp = resolvePositionWriteStamp(position, ACTIVE_PAPER);
      persisted.push(await upsertPositionRow({ row: mapPositionRow(position), stamp, sessionSupport, conflictSupport, upsert: table.upsert, logger }));
    };
    const pending: Promise<void>[] = [];
    tracker.on('position:opened', (p) => { pending.push(persist(p)); });
    tracker.on('position:updated', (p) => { pending.push(persist(p)); });
    tracker.on('position:closed', (p) => { pending.push(persist(p)); });

    // 3a. A ticker-driven update on the hydrated ETH position (debounced 'position:updated').
    vi.useFakeTimers();
    try {
      tracker.updateMarketPrice('ETH-USD', 4400);
      await vi.advanceTimersByTimeAsync(1_100);
    } finally {
      vi.useRealTimers();
    }
    await Promise.all(pending);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({ error: null, onConflictTarget: 'id', stamped: true });
    expect(table.rows.get(ETH_OPEN_ID)).toMatchObject({ id: ETH_OPEN_ID, closed_at: null, qty_open: 0.05, session_id: ACTIVE_PAPER.sessionId, execution_mode: 'paper' });
    expect(table.rows.size).toBe(4);

    // 3b. The hydrated ETH position closes on a take-profit fill in the new session.
    await tracker.processFill(
      paperFill({ order_id: 'ord-exit', trade_id: 7, product_id: 'ETH-USD', side: 'sell', size: '0.05', price: '4451.15', fee: '0.11', created_at: '2026-09-22T14:02:11.000Z' }),
      { tag: 'take_profit' },
    );
    await Promise.all(pending);
    expect(persisted).toHaveLength(2);
    expect(persisted[1]).toMatchObject({ error: null, onConflictTarget: 'id', conflictFellBack: false, stamped: true });
    // Same row, updated in place on the PK — still 4 rows, closed under the session that closed it.
    expect(table.rows.size).toBe(4);
    expect(table.rows.get(ETH_OPEN_ID)).toMatchObject({
      id: ETH_OPEN_ID,
      symbol: 'ETH-USD',
      qty_open: 0,
      entry_price: 4321.5,
      closed_at: '2026-09-22T14:02:11.000Z',
      exit_price: 4451.15,
      exit_reason: 'take_profit',
      session_id: ACTIVE_PAPER.sessionId,
      execution_mode: 'paper',
    });
    expect(Number(table.rows.get(ETH_OPEN_ID)!.realized_pnl_usd)).toBeGreaterThan(0);

    // 3c. A fresh ETH position opens in the new session: a NEW row (history preserved by the partial index).
    await tracker.processFill(
      paperFill({ order_id: 'ord-entry-2', trade_id: 8, product_id: 'ETH-USD', side: 'buy', size: '0.04', price: '4380', fee: '0.1', created_at: '2026-09-22T14:30:00.000Z' }),
      { strategy: 'trend_follow', stopPrice: 4290, takeProfit: 4510 },
    );
    await Promise.all(pending);
    const fresh = tracker.getPosition('ETH-USD')!;
    expect(fresh.id).not.toBe(ETH_OPEN_ID);
    expect(fresh.metadata?.hydratedFromSupabase).toBeUndefined();
    expect(persisted).toHaveLength(3);
    expect(persisted[2]).toMatchObject({ error: null, onConflictTarget: 'id', stamped: true });
    expect(table.rows.size).toBe(5);
    expect(table.rows.get(fresh.id)).toMatchObject({ symbol: 'ETH-USD', strategy: 'trend_follow', qty_open: 0.04, closed_at: null, session_id: ACTIVE_PAPER.sessionId });

    // Prior-session history is exactly as it was before the restart.
    expect(table.rows.get(BTC_CLOSED_ID)).toMatchObject({ session_id: PRIOR_SESSION, closed_at: '2026-09-21T16:02:00.000Z', realized_pnl_usd: 0.8 });
    expect(table.rows.get(ETH_CLOSED_ID)).toMatchObject({ session_id: OLDER_SESSION, closed_at: '2026-09-20T11:30:00.000Z', realized_pnl_usd: -3.5 });
    // BTC (hydrated, still open) stays on the new session with its original open state.
    expect(table.rows.get(BTC_OPEN_ID)).toMatchObject({ qty_open: 0.002, closed_at: null, session_id: ACTIVE_PAPER.sessionId });

    // Never a (user_id, symbol) conflict path: every write went to the PK.
    expect(table.upsertCalls.every((c) => c.onConflict === 'id')).toBe(true);
    expect(conflictSupport.snapshot()).toEqual({ configured: 'id', current: 'id', fellBack: false });
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('LIVE restart replay: hydrated rows keep the opening session (behaviour unchanged)', async () => {
    const table = tableBeforeRestart();
    hydrateRows = () => table.openRowsForUser(USER_ID);

    const logger = makeLogger();
    const tracker = new PositionTracker(trackerConfig, asLogger(logger));
    trackers.push(tracker);

    expect(await tracker.hydrateOpenPositions(USER_ID)).toBe(2);
    const engineOpen = tracker.getOpenPositions();

    const restamp = await restampHydratedOpenPositions({
      positions: engineOpen.map((p) => ({ id: p.id, symbol: p.symbol })),
      stamp: ACTIVE_LIVE,
      support: new SessionColumnSupport(),
      read: table.read,
      update: table.update,
      logger,
    });
    expect(restamp.outcome).toBe('skipped_mode');
    expect(table.updateCalls).toEqual([]);

    // The close of a hydrated position is written unstamped in live: the payload
    // carries no session columns, so the opening session's stamp survives.
    const sessionSupport = new SessionColumnSupport();
    const conflictSupport = new PositionsConflictTargetSupport(resolvePositionsConflictTarget({}), { logger });
    const pending: Promise<void>[] = [];
    tracker.on('position:closed', (p) => {
      pending.push(
        upsertPositionRow({ row: mapPositionRow(p), stamp: resolvePositionWriteStamp(p, ACTIVE_LIVE), sessionSupport, conflictSupport, upsert: table.upsert, logger }).then(() => undefined),
      );
    });
    await tracker.processFill(
      paperFill({ order_id: 'ord-exit', trade_id: 9, product_id: 'ETH-USD', side: 'sell', size: '0.05', price: '4451.15', created_at: '2026-09-22T14:02:11.000Z' }),
      { tag: 'take_profit' },
    );
    await Promise.all(pending);

    expect(table.upsertCalls).toHaveLength(1);
    expect(table.upsertCalls[0].payload).not.toHaveProperty('session_id');
    expect(table.upsertCalls[0].payload).not.toHaveProperty('execution_mode');
    expect(table.rows.get(ETH_OPEN_ID)).toMatchObject({ closed_at: '2026-09-22T14:02:11.000Z', session_id: PRIOR_SESSION, execution_mode: 'paper' });
    expect(table.rows.size).toBe(4);
  });
});
