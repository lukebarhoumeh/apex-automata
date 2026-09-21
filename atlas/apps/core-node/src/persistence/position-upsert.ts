/**
 * Positions upsert — conflict-target selection with 42P10 fallback.
 *
 * Why this exists (Tier-A, 2026-09-21): `syncPositionToSupabase` upserted with
 * `onConflict: 'user_id,symbol'` unless `POSITIONS_HISTORY_PRESERVE=true`.
 * Migration `20260511000000_positions_history_preserve.sql` DROPPED the
 * unconditional `UNIQUE (user_id, symbol)` and replaced it with a PARTIAL
 * unique index (`... WHERE closed_at IS NULL`). Postgres does not infer a
 * partial index as the arbiter for `ON CONFLICT (user_id, symbol)` without a
 * matching predicate, so every position write answered
 *
 *     42P10  there is no unique or exclusion constraint matching the
 *            ON CONFLICT specification
 *
 * and was logged-and-swallowed. Orders and fills persisted fine, so the
 * engine ran with open positions the `positions` table never saw (and
 * `upsert_account_metrics`, which sums open `positions`, reported equity 0).
 *
 * The position's UUID `id` is its primary key for the whole lifecycle
 * (open → updates → close), so `ON CONFLICT (id)` is the correct target on
 * the deployed schema and is now the default. The legacy target stays
 * available for a schema where the migration has NOT been applied
 * (`POSITIONS_HISTORY_PRESERVE=false`), and — mirroring
 * `trading/risk/execution-mode-scope.ts` — a 42P10 on the configured target
 * switches the process to `id` for the rest of its lifetime (warned once),
 * so a stale env value can never take position persistence down again.
 *
 * Pure and Supabase-free (the actual write is injected) so the fallback can
 * be unit tested without a database.
 */

import { isOnConflictTargetError, type PostgrestErrorLike } from '../core/postgrest-errors';
import {
  writeWithSessionStamp,
  type SessionColumnSupport,
  type SessionStamp,
} from './session-stamp';

/** Primary key of `positions`; stable for the whole lifecycle of one position. */
export const POSITIONS_CONFLICT_TARGET_ID = 'id' as const;
/** Pre-20260511 key: the unconditional `UNIQUE (user_id, symbol)` the migration dropped. */
export const POSITIONS_CONFLICT_TARGET_LEGACY = 'user_id,symbol' as const;

export type PositionsConflictTarget =
  | typeof POSITIONS_CONFLICT_TARGET_ID
  | typeof POSITIONS_CONFLICT_TARGET_LEGACY;

/** Env var that opts a pre-migration schema back into the legacy target. */
export const POSITIONS_HISTORY_PRESERVE_ENV = 'POSITIONS_HISTORY_PRESERVE';

/** Migration that changed the row key; referenced from logs so operators can find it. */
export const POSITIONS_HISTORY_PRESERVE_MIGRATION = '20260511000000_positions_history_preserve.sql';

const LEGACY_OPT_IN_VALUES = new Set(['false', '0', 'no', 'off']);

/**
 * Resolve the configured conflict target from the environment.
 *
 * Defaults to `id` (the deployed schema). Only an explicit
 * `POSITIONS_HISTORY_PRESERVE=false|0|no|off` selects the legacy
 * `user_id,symbol` target, for a database where
 * `20260511000000_positions_history_preserve.sql` has not been applied.
 *
 * @param env Environment to read; defaults to `process.env`.
 */
export function resolvePositionsConflictTarget(
  env: Record<string, string | undefined> = process.env,
): PositionsConflictTarget {
  const raw = (env[POSITIONS_HISTORY_PRESERVE_ENV] ?? '').trim().toLowerCase();
  return LEGACY_OPT_IN_VALUES.has(raw) ? POSITIONS_CONFLICT_TARGET_LEGACY : POSITIONS_CONFLICT_TARGET_ID;
}

export interface PositionsConflictTargetSnapshot {
  configured: PositionsConflictTarget;
  current: PositionsConflictTarget;
  /** True once a 42P10 forced the switch from the configured target to `id`. */
  fellBack: boolean;
}

/**
 * Process-lifetime memory of which conflict target the deployed schema
 * accepts for `positions`.
 *
 * Starts at the configured target. The first 42P10 seen on a non-`id`
 * target switches it to `id` permanently (the dropped constraint is not
 * coming back under a running process) and warns once with the remediation.
 */
export class PositionsConflictTargetSupport {
  private target: PositionsConflictTarget;
  private switched = false;
  private readonly logger?: { warn: (message: string, meta?: Record<string, unknown>) => void };

  constructor(
    private readonly configured: PositionsConflictTarget,
    options: { logger?: { warn: (message: string, meta?: Record<string, unknown>) => void } } = {},
  ) {
    this.target = configured;
    this.logger = options.logger;
  }

  /** Conflict target the next upsert should use. */
  public get current(): PositionsConflictTarget {
    return this.target;
  }

  /**
   * Classify an error returned by an upsert on `current`.
   *
   * Returns `true` — and switches `current` to `id` — when the error is a
   * 42P10 and there is still a target to fall back to, i.e. the caller
   * should retry the same row on `id`. Any other error, or a 42P10 while
   * already on `id`, returns `false` and is the caller's to report.
   */
  public noteConflictTargetError(error: PostgrestErrorLike | null | undefined): boolean {
    if (!isOnConflictTargetError(error)) return false;
    if (this.target === POSITIONS_CONFLICT_TARGET_ID) return false;

    const previous = this.target;
    this.target = POSITIONS_CONFLICT_TARGET_ID;
    if (!this.switched) {
      this.switched = true;
      this.logger?.warn(
        `positions: ON CONFLICT (${previous}) has no matching unique constraint — ` +
          `migration ${POSITIONS_HISTORY_PRESERVE_MIGRATION} dropped it; upserting on (id) from now on`,
        {
          table: 'positions',
          configured: previous,
          current: this.target,
          code: error?.code,
          message: error?.message,
          remediation: `unset ${POSITIONS_HISTORY_PRESERVE_ENV} or set it to true`,
        },
      );
    }
    return true;
  }

  /** Current knowledge (for `/api/status`-style diagnostics and tests). */
  public snapshot(): PositionsConflictTargetSnapshot {
    return { configured: this.configured, current: this.target, fellBack: this.switched };
  }
}

export interface PositionUpsertResult {
  error: PostgrestErrorLike | null;
  /** Conflict target the final write used. */
  onConflictTarget: PositionsConflictTarget;
  /** True when the configured target answered 42P10 and the row was re-written on `id`. */
  conflictFellBack: boolean;
  /** True when the persisted row carried `session_id` / `execution_mode`. */
  stamped: boolean;
  /** True when the stamped attempt failed on the stamp columns and the legacy shape was retried. */
  stampFellBack: boolean;
}

/**
 * Persist one `positions` row: session-stamped (schema-tolerant, see
 * `session-stamp.ts`) and upserted on the conflict target the deployed
 * schema accepts, falling back from the configured target to `id` on 42P10.
 *
 * Attempts are bounded: at most two conflict targets per row shape, at most
 * two row shapes (stamped, then legacy) — never a loop.
 *
 * @param params.row Mapped position row without the stamp columns.
 * @param params.stamp Active session stamp; `null` keeps the opening session's stamp (hydrated positions).
 * @param params.sessionSupport Shared per-table memory of the stamp columns' presence.
 * @param params.conflictSupport Shared memory of the accepted conflict target.
 * @param params.upsert The actual Supabase upsert for one payload + conflict target.
 * @param params.logger Optional; fallbacks are warned once per process.
 */
export async function upsertPositionRow(params: {
  row: Record<string, unknown>;
  stamp: SessionStamp | null | undefined;
  sessionSupport: SessionColumnSupport;
  conflictSupport: PositionsConflictTargetSupport;
  upsert: (
    payload: Record<string, unknown>,
    onConflict: PositionsConflictTarget,
  ) => Promise<{ error: PostgrestErrorLike | null }>;
  logger?: { warn: (message: string, meta?: Record<string, unknown>) => void };
}): Promise<PositionUpsertResult> {
  const { row, stamp, sessionSupport, conflictSupport, upsert, logger } = params;

  let onConflictTarget = conflictSupport.current;
  let conflictFellBack = false;

  const result = await writeWithSessionStamp({
    table: 'positions',
    row,
    stamp,
    support: sessionSupport,
    logger,
    write: async (payload) => {
      onConflictTarget = conflictSupport.current;
      const first = await upsert(payload, onConflictTarget);
      if (!first.error || !conflictSupport.noteConflictTargetError(first.error)) {
        return first;
      }
      conflictFellBack = true;
      onConflictTarget = conflictSupport.current;
      return upsert(payload, onConflictTarget);
    },
  });

  return {
    error: result.error,
    onConflictTarget,
    conflictFellBack,
    stamped: result.stamped,
    stampFellBack: result.fellBack,
  };
}

/**
 * Operator-facing hint for a failed positions upsert, or `null` when the
 * error is not one of the two schema/key mismatches this module knows about.
 *
 * - 42P10 on `id` cannot happen (it is the primary key); on the legacy target
 *   it means the migration is applied and the env still opts into legacy.
 * - 23505 on `id` for a NEW position means a row for the same (user, symbol)
 *   is still open in the table (`positions_user_symbol_open_uidx`), or the
 *   pre-migration `UNIQUE (user_id, symbol)` is still in place.
 */
export function describePositionUpsertError(
  error: PostgrestErrorLike | null | undefined,
  onConflictTarget: PositionsConflictTarget,
): string | null {
  if (!error) return null;
  if (isOnConflictTargetError(error)) {
    return `no unique constraint matches ON CONFLICT (${onConflictTarget}); ` +
      `${POSITIONS_HISTORY_PRESERVE_MIGRATION} dropped UNIQUE (user_id, symbol) — unset ${POSITIONS_HISTORY_PRESERVE_ENV} or set it to true`;
  }
  if (error.code === '23505') {
    return onConflictTarget === POSITIONS_CONFLICT_TARGET_ID
      ? 'another row for this (user_id, symbol) is still open (positions_user_symbol_open_uidx), or the ' +
        `pre-${POSITIONS_HISTORY_PRESERVE_MIGRATION} UNIQUE (user_id, symbol) is still in place — ` +
        `apply the migration or set ${POSITIONS_HISTORY_PRESERVE_ENV}=false`
      : 'duplicate key on the legacy (user_id, symbol) target';
  }
  return null;
}
