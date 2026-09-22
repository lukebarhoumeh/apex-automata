/**
 * Hydrated open positions → active session restamp (Tier-A polish, DESK GO 2026-09-22).
 *
 * Why this exists: `PositionTracker.hydrateOpenPositions` re-materialises
 * every `closed_at IS NULL` row at engine start, so a position opened under
 * `sess_A` is managed by the engine running `sess_B` after an API/engine
 * restart. Its `positions.session_id` stayed `sess_A` — `syncPositionToSupabase`
 * deliberately wrote hydrated positions UNSTAMPED so the opening session's
 * value survived — while every session-scoped read (`GET /api/positions`, the
 * FE Supabase fallback, strategy session stats) filters on the ACTIVE session.
 * The engine therefore held N open positions that the session-scoped DB view
 * could not see until the desk restamped them by hand (ETH opens left on
 * `…cvjy53` while the active session was `…hkub8j`, 2026-09-21).
 *
 * Model: an open position belongs to the session that is MANAGING it. When a
 * paper session starts, the rows the engine hydrated are moved onto the new
 * `session_id` / `execution_mode` in one `UPDATE … WHERE id IN (…)`. Two
 * invariants are protected on purpose:
 *
 *   - Keyed by primary key `id` only — never a `(user_id, symbol)` conflict
 *     path — so #69's upsert-on-`id` and the 20260511 partial open index
 *     (`positions_user_symbol_open_uidx`) are untouched.
 *   - Only `closed_at IS NULL` rows the engine actually hydrated are touched:
 *     closed history keeps the session that closed it, and a row that closed
 *     between the hydrate SELECT and this UPDATE is left alone.
 *
 * Live sessions do NOT take ownership (`sessionOwnsHydratedPositions`): the
 * opening session's stamp survives exactly as before, and nothing on the live
 * unlock / CONFIRM_LIVE path is touched.
 *
 * Schema-tolerant like the rest of `persistence/`: a missing `session_id` /
 * `execution_mode` column (migration 20260911170000 not applied) is remembered
 * in the shared `SessionColumnSupport` and the restamp is skipped — never a
 * failed start.
 *
 * Pure and Supabase-free (the read and the update are injected) so the
 * decision tree can be unit tested without a database.
 */

import type { PostgrestErrorLike } from '../core/postgrest-errors';
import {
  isSessionColumnMissingError,
  type SessionColumnSupport,
  type SessionStamp,
  type SessionStampColumns,
} from './session-stamp';

/** A position the engine hydrated at start — the identity the restamp keys on. */
export interface HydratedPositionRef {
  /** `positions.id` (primary key). */
  id: string;
  symbol: string;
}

/** Stamp columns as currently persisted on one open row. */
export interface PositionStampRow {
  id: string;
  symbol?: string | null;
  session_id?: string | null;
  execution_mode?: string | null;
}

export type RestampOutcome =
  /** At least one row was moved onto the active session. */
  | 'restamped'
  /** Nothing hydrated, or every hydrated row already carries the active stamp. */
  | 'noop'
  /** Stamp columns are not in the deployed schema (migration 20260911170000 pending). */
  | 'skipped_columns_missing'
  /** The session's mode does not take ownership of hydrated positions (live). */
  | 'skipped_mode'
  /** Read or update failed for a reason other than the missing columns. */
  | 'error';

/** One row moved by the restamp, with the stamp it carried before. */
export interface RestampedRow {
  id: string;
  symbol: string;
  fromSessionId: string | null;
  fromExecutionMode: string | null;
}

export interface RestampOpenPositionsResult {
  outcome: RestampOutcome;
  /** Session the rows were (or would have been) moved onto. */
  sessionId: string;
  /** Distinct hydrated positions the caller handed in. */
  hydrated: number;
  /** Rows the UPDATE actually moved. */
  restamped: number;
  /** Open rows that already carried the active stamp. */
  alreadyCurrent: number;
  rows: RestampedRow[];
  error: PostgrestErrorLike | null;
}

/** Minimal logger surface this module needs. */
export interface RestampLogger {
  info: (message: string, meta?: Record<string, unknown>) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
  error: (message: string, meta?: Record<string, unknown>) => void;
}

/**
 * Whether a session takes ownership of the open positions it hydrates.
 *
 * Paper sessions do (this is the whole point of the restamp). Live sessions
 * do not: the opening session keeps `session_id`, exactly as before this
 * module existed, so the live path is behaviourally unchanged.
 *
 * @param stamp Active session stamp; `null` / `undefined` when no session is open.
 */
export function sessionOwnsHydratedPositions(stamp: SessionStamp | null | undefined): boolean {
  return stamp?.executionMode === 'paper';
}

/**
 * The stamp a `positions` write should carry.
 *
 * Positions opened in the active session always carry its stamp. A hydrated
 * position carries it only when the session owns hydrated positions (paper),
 * so the debounced ticker update and the eventual close re-assert the
 * start-up restamp — the DB self-heals even if that UPDATE failed. In live a
 * hydrated position is written unstamped (`null`) and the opening session's
 * value survives its close, as before.
 *
 * @param position Any object carrying `PositionTracker`'s `metadata.hydratedFromSupabase` flag.
 * @param active Active session stamp; `null` when no session is open.
 */
export function resolvePositionWriteStamp(
  position: { metadata?: { hydratedFromSupabase?: unknown } | null },
  active: SessionStamp | null | undefined,
): SessionStamp | null {
  if (!active) return null;
  if (!position.metadata?.hydratedFromSupabase) return active;
  return sessionOwnsHydratedPositions(active) ? active : null;
}

function dedupeRefs(positions: ReadonlyArray<HydratedPositionRef>): HydratedPositionRef[] {
  const seen = new Map<string, HydratedPositionRef>();
  for (const ref of positions) {
    if (ref && typeof ref.id === 'string' && ref.id.length > 0 && !seen.has(ref.id)) seen.set(ref.id, ref);
  }
  return [...seen.values()];
}

/**
 * Move the rows of the positions a session hydrated onto that session's
 * `session_id` / `execution_mode`.
 *
 * Bounded: at most one read and one update; no retries. The injected `read`
 * and `update` MUST scope to the owning `user_id` and to `closed_at IS NULL`
 * (the caller owns the query builder; see `api/server.ts`).
 *
 * @param params.positions Positions the engine hydrated (`metadata.hydratedFromSupabase`).
 * @param params.stamp Active session stamp the rows should end up carrying.
 * @param params.support Shared per-table memory of the stamp columns' presence.
 * @param params.read `SELECT id, symbol, session_id, execution_mode … WHERE id IN (ids) AND closed_at IS NULL`.
 * @param params.update `UPDATE positions SET session_id, execution_mode WHERE id IN (ids) AND closed_at IS NULL RETURNING id`.
 * @param params.logger Optional; one line per outcome, missing columns warned once per process.
 */
export async function restampHydratedOpenPositions(params: {
  positions: ReadonlyArray<HydratedPositionRef>;
  stamp: SessionStamp;
  support: SessionColumnSupport;
  read: (ids: string[]) => Promise<{ data: PositionStampRow[] | null; error: PostgrestErrorLike | null }>;
  update: (
    ids: string[],
    columns: SessionStampColumns,
  ) => Promise<{ data: Array<{ id: string }> | null; error: PostgrestErrorLike | null }>;
  logger?: RestampLogger;
}): Promise<RestampOpenPositionsResult> {
  const { stamp, support, read, update, logger } = params;
  const refs = dedupeRefs(params.positions);
  const base: RestampOpenPositionsResult = {
    outcome: 'noop',
    sessionId: stamp.sessionId,
    hydrated: refs.length,
    restamped: 0,
    alreadyCurrent: 0,
    rows: [],
    error: null,
  };

  if (!sessionOwnsHydratedPositions(stamp)) {
    logger?.info('positions: hydrated open positions keep their opening session_id (session mode does not take ownership)', {
      sessionId: stamp.sessionId,
      executionMode: stamp.executionMode,
      hydrated: refs.length,
    });
    return { ...base, outcome: 'skipped_mode' };
  }

  if (refs.length === 0) {
    return base;
  }

  if (!support.shouldStamp('positions')) {
    logger?.info('positions: session_id/execution_mode columns known missing — hydrated open positions not restamped', {
      sessionId: stamp.sessionId,
      hydrated: refs.length,
    });
    return { ...base, outcome: 'skipped_columns_missing' };
  }

  const noteColumnsMissing = (error: PostgrestErrorLike, step: 'read' | 'update') => {
    const previouslyKnown = support.getState('positions') === 'missing';
    support.markMissing('positions');
    if (!previouslyKnown) {
      logger?.warn('positions: session_id/execution_mode columns missing — hydrated open positions not restamped until migration 20260911170000 is applied', {
        step,
        code: error.code,
        message: error.message,
      });
    }
  };

  const ids = refs.map((ref) => ref.id);
  const readResult = await read(ids);
  if (readResult.error) {
    if (isSessionColumnMissingError(readResult.error)) {
      noteColumnsMissing(readResult.error, 'read');
      return { ...base, outcome: 'skipped_columns_missing' };
    }
    logger?.error('positions: failed to read session stamps of hydrated open positions', {
      sessionId: stamp.sessionId,
      code: readResult.error.code,
      message: readResult.error.message,
      ids,
    });
    return { ...base, outcome: 'error', error: readResult.error };
  }
  support.markPresent('positions');

  const symbolById = new Map(refs.map((ref) => [ref.id, ref.symbol]));
  const stale: RestampedRow[] = [];
  let alreadyCurrent = 0;
  for (const row of readResult.data ?? []) {
    if (!symbolById.has(row.id)) continue;
    const sessionId = row.session_id ?? null;
    const executionMode = row.execution_mode ?? null;
    if (sessionId === stamp.sessionId && executionMode === stamp.executionMode) {
      alreadyCurrent++;
      continue;
    }
    stale.push({
      id: row.id,
      symbol: symbolById.get(row.id) ?? row.symbol ?? '',
      fromSessionId: sessionId,
      fromExecutionMode: executionMode,
    });
  }

  if (stale.length === 0) {
    logger?.info('positions: hydrated open positions already carry the active session_id', {
      sessionId: stamp.sessionId,
      hydrated: refs.length,
      alreadyCurrent,
    });
    return { ...base, alreadyCurrent };
  }

  const columns: SessionStampColumns = { session_id: stamp.sessionId, execution_mode: stamp.executionMode };
  const updateResult = await update(stale.map((row) => row.id), columns);
  if (updateResult.error) {
    if (isSessionColumnMissingError(updateResult.error)) {
      noteColumnsMissing(updateResult.error, 'update');
      return { ...base, outcome: 'skipped_columns_missing', alreadyCurrent };
    }
    logger?.error('positions: failed to restamp hydrated open positions onto the active session', {
      sessionId: stamp.sessionId,
      code: updateResult.error.code,
      message: updateResult.error.message,
      ids: stale.map((row) => row.id),
      symbols: stale.map((row) => row.symbol),
    });
    return { ...base, outcome: 'error', alreadyCurrent, error: updateResult.error };
  }

  // A row that closed between the read and the update is filtered out by the
  // caller's `closed_at IS NULL`; RETURNING tells us what actually moved.
  const movedIds = updateResult.data ? new Set(updateResult.data.map((row) => row.id)) : null;
  const rows = movedIds ? stale.filter((row) => movedIds.has(row.id)) : stale;

  logger?.info('positions: restamped hydrated open positions onto the active session', {
    sessionId: stamp.sessionId,
    executionMode: stamp.executionMode,
    hydrated: refs.length,
    restamped: rows.length,
    alreadyCurrent,
    symbols: rows.map((row) => row.symbol),
    fromSessionIds: [...new Set(rows.map((row) => row.fromSessionId ?? 'null'))],
  });

  return { ...base, outcome: 'restamped', restamped: rows.length, alreadyCurrent, rows };
}
