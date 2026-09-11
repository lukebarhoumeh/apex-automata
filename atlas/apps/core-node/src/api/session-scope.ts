/**
 * Session scoping for the blotter read endpoints
 * (`GET /api/orders|fills|signals|positions`) — Frontend Lead contract #1.
 *
 * The UI used to read these tables straight from Supabase as "last 100 rows"
 * with no session filter, so every paper run bled into the next one. Each of
 * the four endpoints now resolves ONE trading session (the active one by
 * default, or `?session_id=` for a past one) and returns only rows that
 * belong to it, plus a `scope` block that states exactly which filter was
 * applied so the UI can render "—" instead of guessing.
 *
 * Two filter shapes, chosen per table from the deployed schema:
 *   - `session_id`   (migration 20260911170000 applied): rows stamped with
 *                    the session id, OR unstamped rows inside the session's
 *                    time window (covers rows written before the apply
 *                    landed mid-session);
 *   - `time_window`  (columns absent): `<time col> >= started_at`
 *                    `[AND <= ended_at]` — the interim filter the Frontend
 *                    Lead asked for while the migration is pending.
 *
 * Pure and Supabase-free: the PostgREST builder is abstracted behind
 * `SessionScopeBuilder` and the query execution is injected, so the whole
 * decision tree is unit-testable.
 */

import type { PostgrestErrorLike } from '../core/postgrest-errors';
import { toIsoOrNull, type ExecutionMode } from '../runtime/session-context';
import {
  SESSION_SCOPED_TABLES,
  SessionColumnSupport,
  SessionScopedTable,
  isSessionColumnMissingError,
} from '../persistence/session-stamp';

export type { SessionScopedTable };
export { SESSION_SCOPED_TABLES };

/** Time column per table: interim window filter, ordering, and the index key. */
export const SESSION_SCOPE_TIME_COLUMN: Record<SessionScopedTable, string> = {
  orders: 'created_at',
  fills: 'filled_at',
  signals: 'created_at',
  positions: 'opened_at',
};

export const SESSION_SCOPE_DEFAULT_LIMIT = 100;
export const SESSION_SCOPE_MAX_LIMIT = 500;

/** `?status=` on `/api/positions`. */
export type PositionStatusFilter = 'open' | 'closed' | 'all';

/** Accepted session-id shape; also keeps the id safe inside a PostgREST `or()` string. */
export const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** Parsed and validated query string for a blotter endpoint. */
export interface SessionScopeQuery {
  /** Requested session; `null` means "the active session". */
  sessionId: string | null;
  /** Requested mode assertion; `null` means "whatever mode the session ran in". */
  executionMode: ExecutionMode | null;
  limit: number;
  /** Positions only; ignored by the other tables. */
  status: PositionStatusFilter;
}

export type SessionScopeParseResult =
  | { ok: true; query: SessionScopeQuery }
  | { ok: false; status: 400; error: string };

function firstString(value: unknown): string | undefined {
  if (Array.isArray(value)) return firstString(value[0]);
  return typeof value === 'string' ? value : undefined;
}

/**
 * Parse `session_id`, `execution_mode`, `limit` and `status` from an Express
 * `req.query`. Never throws; invalid input yields a 400 payload.
 *
 * @param raw Express `req.query` (values are strings or string arrays).
 * @param options Per-endpoint limit defaults and whether `status` is accepted.
 */
export function parseSessionScopeQuery(
  raw: Record<string, unknown>,
  options: { defaultLimit?: number; maxLimit?: number; allowStatus?: boolean; defaultStatus?: PositionStatusFilter } = {},
): SessionScopeParseResult {
  const defaultLimit = options.defaultLimit ?? SESSION_SCOPE_DEFAULT_LIMIT;
  const maxLimit = options.maxLimit ?? SESSION_SCOPE_MAX_LIMIT;

  const sessionIdRaw = firstString(raw.session_id);
  let sessionId: string | null = null;
  if (sessionIdRaw !== undefined && sessionIdRaw !== '') {
    if (!SESSION_ID_PATTERN.test(sessionIdRaw)) {
      return { ok: false, status: 400, error: 'Invalid session_id (expected 1-64 chars of [A-Za-z0-9_-])' };
    }
    sessionId = sessionIdRaw;
  }

  const modeRaw = firstString(raw.execution_mode);
  let executionMode: ExecutionMode | null = null;
  if (modeRaw !== undefined && modeRaw !== '') {
    if (modeRaw !== 'paper' && modeRaw !== 'live') {
      return { ok: false, status: 400, error: "Invalid execution_mode (expected 'paper' or 'live')" };
    }
    executionMode = modeRaw;
  }

  const limitRaw = firstString(raw.limit);
  let limit = defaultLimit;
  if (limitRaw !== undefined && limitRaw !== '') {
    const parsed = Number.parseInt(limitRaw, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return { ok: false, status: 400, error: 'Invalid limit (expected a positive integer)' };
    }
    limit = Math.min(parsed, maxLimit);
  }

  const statusRaw = firstString(raw.status);
  // FE PR1 #1: /api/positions is "open only" by default; closed/all are opt-in.
  let status: PositionStatusFilter = options.defaultStatus ?? 'all';
  if (options.allowStatus && statusRaw !== undefined && statusRaw !== '') {
    if (statusRaw !== 'open' && statusRaw !== 'closed' && statusRaw !== 'all') {
      return { ok: false, status: 400, error: "Invalid status (expected 'open', 'closed' or 'all')" };
    }
    status = statusRaw;
  }

  return { ok: true, query: { sessionId, executionMode, limit, status } };
}

/** The resolved session a blotter read is scoped to. */
export interface SessionWindow {
  sessionId: string;
  executionMode: ExecutionMode | null;
  /** Epoch ms. */
  startedAt: number;
  /** Epoch ms; `null` while the session is still running. */
  endedAt: number | null;
  /** True when this is the engine's currently open session. */
  isActive: boolean;
}

/** Subset of the API server's runtime state this module reads. */
export interface ActiveSessionState {
  sessionId: string | null;
  sessionStartedAt: number | null;
  sessionMode: ExecutionMode | null;
}

/**
 * The active session as a window, or `null` when no engine session is open.
 * `sessionId` and `sessionStartedAt` are set together by `openTradingSession`;
 * a half-set pair is treated as "no session" rather than guessed at.
 */
export function activeSessionWindow(state: ActiveSessionState): SessionWindow | null {
  if (!state.sessionId || state.sessionStartedAt === null || state.sessionStartedAt === undefined) return null;
  return {
    sessionId: state.sessionId,
    executionMode: state.sessionMode ?? null,
    startedAt: state.sessionStartedAt,
    endedAt: null,
    isActive: true,
  };
}

/** `trading_sessions` columns needed to build a window for a past session. */
export interface TradingSessionRowLike {
  session_id: string;
  started_at: string | null;
  ended_at?: string | null;
  mode?: string | null;
  execution_mode?: string | null;
}

/**
 * Build a window from a `trading_sessions` row. Returns `null` when the row
 * has no usable `started_at` (nothing honest can be scoped to it).
 */
export function sessionWindowFromRow(row: TradingSessionRowLike): SessionWindow | null {
  const startedAt = row.started_at ? Date.parse(row.started_at) : NaN;
  if (!Number.isFinite(startedAt)) return null;
  const endedAt = row.ended_at ? Date.parse(row.ended_at) : NaN;
  const mode = row.execution_mode ?? row.mode ?? null;
  return {
    sessionId: row.session_id,
    executionMode: mode === 'paper' || mode === 'live' ? mode : null,
    startedAt,
    endedAt: Number.isFinite(endedAt) ? endedAt : null,
    isActive: false,
  };
}

/** Filter shape actually applied to a read. */
export type SessionScopeFilterKind = 'session_id' | 'time_window' | 'none';

/** `scope` block returned with every blotter response. */
export interface SessionScopeMeta {
  sessionId: string | null;
  executionMode: ExecutionMode | null;
  /** ISO-8601 UTC; mirrors `/api/status.sessionStartedAt` for the active session. */
  sessionStartedAt: string | null;
  /** ISO-8601 UTC; set for past sessions only. */
  sessionEndedAt: string | null;
  isActive: boolean;
  filter: SessionScopeFilterKind;
  /** Column the window filter and ordering use for this table. */
  timeColumn: string;
  limit: number;
  /** Positions only. */
  status?: PositionStatusFilter;
  note: string;
}

const FILTER_NOTES: Record<SessionScopeFilterKind, string> = {
  session_id:
    'rows stamped session_id = sessionId (plus unstamped rows inside the session window); execution_mode enforced',
  time_window:
    'interim filter: session_id/execution_mode columns not in schema yet (migration 20260911170000 pending) — rows selected by time window only',
  none: 'no active session and no session_id given — nothing is scoped, rows intentionally empty',
};

/**
 * Build the `scope` block for a response.
 *
 * @param window Resolved session, or `null` when there is none.
 * @param filter Filter shape that was applied.
 * @param table Table the read targeted.
 * @param query Parsed query (limit / status echo).
 */
export function buildSessionScopeMeta(
  window: SessionWindow | null,
  filter: SessionScopeFilterKind,
  table: SessionScopedTable,
  query: Pick<SessionScopeQuery, 'limit' | 'status'>,
): SessionScopeMeta {
  return {
    sessionId: window?.sessionId ?? null,
    executionMode: window?.executionMode ?? null,
    sessionStartedAt: toIsoOrNull(window?.startedAt),
    sessionEndedAt: toIsoOrNull(window?.endedAt),
    isActive: window?.isActive ?? false,
    filter,
    timeColumn: SESSION_SCOPE_TIME_COLUMN[table],
    limit: query.limit,
    ...(table === 'positions' ? { status: query.status } : {}),
    note: FILTER_NOTES[filter],
  };
}

/**
 * The slice of the PostgREST filter builder this module drives. Every method
 * returns the builder so calls chain exactly like supabase-js.
 */
export interface SessionScopeBuilder<B> {
  eq(column: string, value: unknown): B;
  gte(column: string, value: unknown): B;
  lte(column: string, value: unknown): B;
  is(column: string, value: null): B;
  not(column: string, operator: string, value: unknown): B;
  or(filters: string): B;
  order(column: string, options: { ascending: boolean }): B;
  limit(count: number): B;
}

/**
 * Apply the session filter, ordering and limit to a fresh builder.
 *
 * @param builder `supabase.from(table).select(...)` (or a test double).
 * @param params.table Target table (picks the time column).
 * @param params.userId Owning `user_id`; always applied.
 * @param params.window Session to scope to.
 * @param params.filter `session_id` (stamped columns present) or `time_window` (interim).
 * @param params.limit Row cap.
 * @param params.status Positions only: open / closed / all.
 */
export function applySessionScope<B extends SessionScopeBuilder<B>>(
  builder: B,
  params: {
    table: SessionScopedTable;
    userId: string;
    window: SessionWindow;
    filter: Exclude<SessionScopeFilterKind, 'none'>;
    limit: number;
    status?: PositionStatusFilter;
  },
): B {
  const { table, userId, window, filter, limit, status } = params;
  const timeColumn = SESSION_SCOPE_TIME_COLUMN[table];
  const startedAtIso = new Date(window.startedAt).toISOString();
  const endedAtIso = window.endedAt !== null ? new Date(window.endedAt).toISOString() : null;

  let q = builder.eq('user_id', userId);

  if (filter === 'session_id') {
    // Stamped rows for this session, or legacy/unstamped rows that fall inside
    // its window (a migration applied mid-session leaves the first rows NULL).
    const windowClause = endedAtIso
      ? `and(session_id.is.null,${timeColumn}.gte.${startedAtIso},${timeColumn}.lte.${endedAtIso})`
      : `and(session_id.is.null,${timeColumn}.gte.${startedAtIso})`;
    q = q.or(`session_id.eq.${window.sessionId},${windowClause}`);
    if (window.executionMode) {
      q = q.or(`execution_mode.eq.${window.executionMode},execution_mode.is.null`);
    }
  } else {
    q = q.gte(timeColumn, startedAtIso);
    if (endedAtIso) q = q.lte(timeColumn, endedAtIso);
  }

  if (table === 'positions' && status && status !== 'all') {
    q = status === 'open' ? q.is('closed_at', null) : q.not('closed_at', 'is', null);
  }

  return q.order(timeColumn, { ascending: false }).limit(limit);
}

export interface SessionScopedReadResult<Row> {
  rows: Row[];
  error: PostgrestErrorLike | null;
  filter: Exclude<SessionScopeFilterKind, 'none'>;
  /** True when the stamped-column read failed on the columns and the time window was used instead. */
  fellBack: boolean;
}

/**
 * Run a session-scoped read, preferring the stamped columns and falling back
 * to the interim time window when the deployed schema lacks them.
 *
 * @param params.createQuery Returns a fresh `supabase.from(table).select(...)` builder.
 * @param params.execute Awaits a builder (`(b) => b` for supabase-js thenables).
 * @param params.support Shared per-table column memory (same instance the writers use).
 */
export async function readWithSessionScope<Row, B extends SessionScopeBuilder<B>>(params: {
  table: SessionScopedTable;
  userId: string;
  window: SessionWindow;
  limit: number;
  status?: PositionStatusFilter;
  support: SessionColumnSupport;
  createQuery: () => B;
  execute: (builder: B) => Promise<{ data: Row[] | null; error: PostgrestErrorLike | null }>;
  logger?: { warn: (message: string, meta?: Record<string, unknown>) => void };
}): Promise<SessionScopedReadResult<Row>> {
  const { table, userId, window, limit, status, support, createQuery, execute, logger } = params;

  const run = async (filter: Exclude<SessionScopeFilterKind, 'none'>) =>
    execute(applySessionScope(createQuery(), { table, userId, window, filter, limit, status }));

  if (!support.shouldStamp(table)) {
    const { data, error } = await run('time_window');
    return { rows: data ?? [], error, filter: 'time_window', fellBack: false };
  }

  const first = await run('session_id');
  if (!first.error) {
    support.markPresent(table);
    return { rows: first.data ?? [], error: null, filter: 'session_id', fellBack: false };
  }
  if (!isSessionColumnMissingError(first.error)) {
    return { rows: [], error: first.error, filter: 'session_id', fellBack: false };
  }

  const previouslyKnown = support.getState(table) === 'missing';
  support.markMissing(table);
  if (!previouslyKnown) {
    logger?.warn(`${table}: session_id/execution_mode columns missing — serving interim time-window scope until migration 20260911170000 is applied`, {
      table,
      code: first.error.code,
      message: first.error.message,
    });
  }

  const { data, error } = await run('time_window');
  return { rows: data ?? [], error, filter: 'time_window', fellBack: true };
}
