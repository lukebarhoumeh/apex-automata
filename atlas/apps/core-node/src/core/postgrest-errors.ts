/**
 * PostgREST / Postgres error classifiers shared by the schema-tolerant
 * persistence paths (risk engine, risk state machine, API handlers).
 *
 * The runtime is deployed independently of Supabase migrations (migrations
 * are staged in the repo and applied by the Trading Master as a separate
 * step), so every write that starts using a new column must be able to
 * recognise "that column is not there yet" and fall back to the legacy
 * shape instead of failing every tick.
 */

export interface PostgrestErrorLike {
  code?: string;
  message?: string;
  details?: string;
}

/**
 * "This column does not exist."
 *
 * `42703` is the Postgres undefined_column SQLSTATE (filters / ON CONFLICT
 * targets naming a missing column); `PGRST204` is what PostgREST returns
 * when an insert/update payload names a column missing from its schema
 * cache. When `column` is given, the message must also mention that column
 * so callers can tell "execution_mode is missing" apart from an unrelated
 * missing column (e.g. `risk_events.active` on older snapshots).
 */
export function isMissingColumnError(
  error: PostgrestErrorLike | null | undefined,
  column?: string,
): boolean {
  if (!error) return false;
  const message = error.message ?? '';
  const codeMatches = error.code === '42703' || error.code === 'PGRST204';
  const messageMatches = /column .*does not exist|could not find the '.*' column/i.test(message);
  if (!codeMatches && !messageMatches) return false;
  if (!column) return true;
  return message.includes(column);
}

/** "This relation does not exist" (PostgREST `PGRST205`, Postgres `42P01`). */
export function isMissingTableError(error: PostgrestErrorLike | null | undefined): boolean {
  return error?.code === 'PGRST205' || error?.code === '42P01';
}

/**
 * Postgres `42P10` — "there is no unique or exclusion constraint matching
 * the ON CONFLICT specification". Raised when an upsert's `onConflict`
 * column set does not match any unique index, i.e. the code and the
 * deployed uniqueness constraint disagree about the row key.
 */
export function isOnConflictTargetError(error: PostgrestErrorLike | null | undefined): boolean {
  if (!error) return false;
  if (error.code === '42P10') return true;
  return /no unique or exclusion constraint matching the ON CONFLICT/i.test(error.message ?? '');
}
