/**
 * Execution-mode scoping for persisted risk state (TASK_014 P5, risk side).
 *
 * Paper and live share one Supabase project and (today) one `USER_ID`, so
 * every risk-state read at boot and every matching persist must carry the
 * session's `execution_mode` or paper state bleeds into live and vice versa
 * (a paper kill switch halting a live session; a paper
 * `PAPER_RESET_RISK_STATE_ON_START` boot clearing a live halt).
 *
 * The `execution_mode` columns on `risk_metrics`, `risk_events` and
 * `daily_equity` ship in a staged migration that the Trading Master applies
 * separately from the code deploy, so this helper also owns the
 * schema-tolerance latch: when a mode-aware query is answered with "column
 * does not exist" the table is marked legacy (warned once) and callers fall
 * back to today's unscoped shape. If the migration lands under a running
 * process, a legacy upsert fails with 42P10 (the `(user_id)` key is gone);
 * that un-latches the table so the next tick is mode-aware again.
 *
 * `account_metrics.execution_mode` already exists on prod (Sprint-9 DB
 * handoff #2) and is only ever read here, but it goes through the same
 * latch so a fresh chain without the column degrades the same way.
 */

import type { Logger } from '../../core/logger';
import {
  isMissingColumnError,
  isOnConflictTargetError,
  type PostgrestErrorLike,
} from '../../core/postgrest-errors';
import type { ExecutionMode } from './types';

/** Column that discriminates paper rows from live rows. */
export const EXECUTION_MODE_COLUMN = 'execution_mode';

/** Tables whose rows carry the `execution_mode` discriminator. */
export type ModeScopedTable = 'risk_metrics' | 'risk_events' | 'daily_equity' | 'account_metrics';

/** Normalise an optional mode to the two supported values (default paper). */
export function normalizeExecutionMode(mode: string | null | undefined): ExecutionMode {
  return mode === 'live' ? 'live' : 'paper';
}

export class ExecutionModeScope {
  private readonly legacyTables = new Set<ModeScopedTable>();

  constructor(
    public readonly mode: ExecutionMode,
    private readonly logger: Logger,
  ) {}

  /**
   * True once `table` has been observed to lack the `execution_mode` column
   * (staged migration not applied yet). Callers then skip the mode-aware
   * attempt and go straight to the legacy shape.
   */
  public isLegacy(table: ModeScopedTable): boolean {
    return this.legacyTables.has(table);
  }

  /**
   * Classify an error returned by a mode-aware query against `table`.
   *
   * Returns `true` — and latches the table as legacy (warning once) — when
   * the error says the `execution_mode` column or the mode-aware ON CONFLICT
   * target does not exist, i.e. the caller should re-issue the query in its
   * legacy shape. Every other error returns `false` and is the caller's to
   * handle as before.
   */
  public noteSchemaError(table: ModeScopedTable, error: PostgrestErrorLike | null | undefined, op: string): boolean {
    if (!error) return false;
    const modeColumnMissing = isMissingColumnError(error, EXECUTION_MODE_COLUMN);
    const conflictTargetMissing = isOnConflictTargetError(error);
    if (!modeColumnMissing && !conflictTargetMissing) return false;

    if (!this.legacyTables.has(table)) {
      this.legacyTables.add(table);
      this.logger.warn(`${table}.${EXECUTION_MODE_COLUMN} unavailable; falling back to unscoped legacy persistence`, {
        table,
        op,
        mode: this.mode,
        code: error.code,
        message: error.message,
        remediation: 'apply supabase/migrations/*_risk_state_execution_mode.sql',
      });
    }
    return true;
  }

  /**
   * Classify an error returned by a *legacy*-shaped upsert against `table`.
   *
   * A 42P10 here means the deployed uniqueness constraint no longer matches
   * the legacy key (the migration has been applied underneath us). Un-latch
   * the table and return `true` so the caller retries mode-aware.
   */
  public noteLegacyConflictError(table: ModeScopedTable, error: PostgrestErrorLike | null | undefined, op: string): boolean {
    if (!isOnConflictTargetError(error)) return false;
    if (this.legacyTables.delete(table)) {
      this.logger.info(`${table} uniqueness now includes ${EXECUTION_MODE_COLUMN}; resuming mode-scoped persistence`, {
        table,
        op,
        mode: this.mode,
      });
    }
    return true;
  }

  /**
   * Run a mode-scoped Supabase query with the legacy fallback baked in.
   *
   * Order of attempts (bounded, never loops):
   *   1. `scoped()` — unless the table is already latched legacy;
   *   2. `legacy()` — when (1) was skipped or failed with a schema error;
   *   3. `scoped()` once more — only when (2) failed with 42P10, i.e. the
   *      migration landed between ticks and the legacy key no longer exists.
   *
   * Returns the final `{ data, error }` result untouched so callers keep
   * their existing error handling (missing table, PGRST116, …).
   */
  public async query<T extends { error: PostgrestErrorLike | null }>(
    table: ModeScopedTable,
    op: string,
    scoped: () => PromiseLike<T>,
    legacy: () => PromiseLike<T>,
  ): Promise<T> {
    if (!this.isLegacy(table)) {
      const result = await scoped();
      if (!result.error || !this.noteSchemaError(table, result.error, op)) {
        return result;
      }
    }
    const result = await legacy();
    if (result.error && this.noteLegacyConflictError(table, result.error, op)) {
      return scoped();
    }
    return result;
  }
}
