/**
 * Session stamping for blotter rows — TASK_014 P5 (blotter side).
 *
 * Every `orders` / `fills` / `signals` / `positions` row the runtime writes is
 * stamped with the active trading session (`trading_sessions.session_id`) and
 * the session's execution mode so the UI can scope its blotters to one
 * session instead of reading "last 100 rows" across every paper run that ever
 * happened (Frontend Lead contract #1).
 *
 * The columns land with migration
 * `supabase/migrations/20260911170000_session_scope_blotter_tables.sql`, which
 * is STAGED and applied separately by the Database Engineer. The runtime is
 * deployed independently of that apply, so this module is schema-tolerant:
 * a write first goes out stamped; if PostgREST answers "column does not
 * exist" for one of the two stamp columns, the columns are stripped and the
 * write is retried once, and the table is remembered as unstamped for
 * `reprobeMs` so the next writes skip the failing round-trip. The memory
 * expires so applying the migration under a running process is picked up
 * without a restart.
 *
 * Pure and Supabase-free (the actual write is injected) so it can be unit
 * tested without a database.
 */

import { isMissingColumnError, PostgrestErrorLike } from '../core/postgrest-errors';
import type { ExecutionMode } from '../runtime/session-context';

export type { ExecutionMode };

/** The two columns added by the blotter session-scope migration. */
export const SESSION_STAMP_COLUMNS = ['session_id', 'execution_mode'] as const;
export type SessionStampColumn = (typeof SESSION_STAMP_COLUMNS)[number];

/** Identity of the active trading session as stamped on persisted rows. */
export interface SessionStamp {
  /** `trading_sessions.session_id` of the active engine session (`sess_<epoch>_<rand>`). */
  sessionId: string;
  /** Execution mode the session runs in; paper and live share one Supabase project. */
  executionMode: ExecutionMode;
}

/** Column shape the stamp adds to a row. */
export interface SessionStampColumns {
  session_id: string;
  execution_mode: ExecutionMode;
}

/** Tables the runtime stamps and the blotter endpoints scope. */
export const SESSION_SCOPED_TABLES = ['orders', 'fills', 'signals', 'positions'] as const;
export type SessionScopedTable = (typeof SESSION_SCOPED_TABLES)[number];

/** Default time a table stays remembered as "columns missing" before re-probing. */
export const DEFAULT_SESSION_COLUMN_REPROBE_MS = 5 * 60_000;

/**
 * Add `session_id` / `execution_mode` to a row. Returns the row unchanged
 * (same reference) when there is no stamp, so callers can pass the runtime
 * state through without branching.
 */
export function stampSessionColumns<T extends Record<string, unknown>>(
  row: T,
  stamp: SessionStamp | null | undefined,
): T | (T & SessionStampColumns) {
  if (!stamp) return row;
  return { ...row, session_id: stamp.sessionId, execution_mode: stamp.executionMode };
}

/** Remove the two stamp columns (fallback shape for pre-migration schemas). */
export function stripSessionColumns<T extends Record<string, unknown>>(
  row: T,
): Omit<T, SessionStampColumn> {
  const { session_id: _sessionId, execution_mode: _executionMode, ...rest } = row as T & Partial<SessionStampColumns>;
  return rest as Omit<T, SessionStampColumn>;
}

/**
 * True when the error says one of the two stamp columns is not in the schema
 * (PostgREST `PGRST204` on a payload column, Postgres `42703` on a filter or
 * ON CONFLICT target). Unrelated missing columns return false so the caller
 * does not mask a genuine schema drift as "migration not applied yet".
 */
export function isSessionColumnMissingError(error: PostgrestErrorLike | null | undefined): boolean {
  return SESSION_STAMP_COLUMNS.some((column) => isMissingColumnError(error, column));
}

export type SessionColumnState = 'unknown' | 'present' | 'missing';

/**
 * Per-table memory of whether the stamp columns exist on the deployed schema.
 *
 * `unknown` and `present` both mean "send the stamped shape"; `missing` means
 * "skip straight to the legacy shape" until `reprobeMs` has elapsed since the
 * miss was recorded, after which one stamped attempt is made again.
 */
export class SessionColumnSupport {
  private readonly state = new Map<string, { state: SessionColumnState; missingSince: number | null }>();
  private readonly reprobeMs: number;
  private readonly now: () => number;

  constructor(options: { reprobeMs?: number; now?: () => number } = {}) {
    this.reprobeMs = options.reprobeMs ?? DEFAULT_SESSION_COLUMN_REPROBE_MS;
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Whether the next write/read on `table` should use the stamped shape.
   * @param table Supabase table name.
   */
  public shouldStamp(table: string): boolean {
    const entry = this.state.get(table);
    if (!entry || entry.state !== 'missing') return true;
    if (entry.missingSince !== null && this.now() - entry.missingSince >= this.reprobeMs) {
      // Re-probe window: try the stamped shape once more.
      return true;
    }
    return false;
  }

  /** Record that the schema rejected the stamp columns on `table`. */
  public markMissing(table: string): void {
    this.state.set(table, { state: 'missing', missingSince: this.now() });
  }

  /** Record that a stamped write/read on `table` succeeded. */
  public markPresent(table: string): void {
    this.state.set(table, { state: 'present', missingSince: null });
  }

  /** Current knowledge per table (for `/api/status`-style diagnostics and tests). */
  public getState(table: string): SessionColumnState {
    return this.state.get(table)?.state ?? 'unknown';
  }

  /** Snapshot of every table this instance has learned about. */
  public snapshot(): Record<string, SessionColumnState> {
    const out: Record<string, SessionColumnState> = {};
    for (const [table, entry] of this.state) out[table] = entry.state;
    return out;
  }
}

export interface SessionStampWriteResult {
  error: PostgrestErrorLike | null;
  /** True when the row that was persisted carried `session_id` / `execution_mode`. */
  stamped: boolean;
  /** True when the stamped attempt failed on the stamp columns and the legacy shape was retried. */
  fellBack: boolean;
}

/**
 * Persist `row` stamped with the active session, falling back to the legacy
 * (unstamped) shape when the deployed schema does not have the columns yet.
 *
 * @param params.table Table name, used as the key for `support`.
 * @param params.row Row without stamp columns.
 * @param params.stamp Active session stamp; `null` writes the legacy shape directly.
 * @param params.support Shared per-table memory of column presence.
 * @param params.write The actual Supabase call for one row shape (`insert` / `upsert`).
 * @param params.logger Optional; the first fallback per table is logged at warn.
 */
export async function writeWithSessionStamp<T extends Record<string, unknown>>(params: {
  table: string;
  row: T;
  stamp: SessionStamp | null | undefined;
  support: SessionColumnSupport;
  write: (row: Record<string, unknown>) => Promise<{ error: PostgrestErrorLike | null }>;
  logger?: { warn: (message: string, meta?: Record<string, unknown>) => void };
}): Promise<SessionStampWriteResult> {
  const { table, row, stamp, support, write, logger } = params;

  if (!stamp || !support.shouldStamp(table)) {
    const { error } = await write(stripSessionColumns(row));
    return { error, stamped: false, fellBack: false };
  }

  const stampedRow = stampSessionColumns(row, stamp);
  const first = await write(stampedRow);
  if (!first.error) {
    support.markPresent(table);
    return { error: null, stamped: true, fellBack: false };
  }

  if (!isSessionColumnMissingError(first.error)) {
    return { error: first.error, stamped: true, fellBack: false };
  }

  const previouslyKnown = support.getState(table) === 'missing';
  support.markMissing(table);
  if (!previouslyKnown) {
    logger?.warn(`${table}: session_id/execution_mode columns missing — writing legacy shape until migration 20260911170000 is applied`, {
      table,
      code: first.error.code,
      message: first.error.message,
    });
  }

  const { error } = await write(stripSessionColumns(row));
  return { error, stamped: false, fellBack: true };
}
