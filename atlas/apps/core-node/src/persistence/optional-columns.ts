/**
 * Schema-tolerant writes for OPTIONAL columns — the generic form of the
 * session-stamp fallback (persistence/session-stamp.ts).
 *
 * The runtime is deployed independently of Supabase migrations (staged in the
 * repo, applied by the Database Engineer with Trading Master go), so a write
 * that starts using a new column must recognise "that column is not there
 * yet" and fall back to the legacy shape instead of failing every row.
 *
 * Contract, per table:
 *   1. send the full row (optional columns included);
 *   2. if PostgREST answers "column X does not exist" for one of the listed
 *      optional columns, strip ALL of them, retry once, and remember the table
 *      as `missing` for `reprobeMs` (re-uses `SessionColumnSupport`, which is
 *      a per-table presence memory with a re-probe window);
 *   3. any other error is returned untouched — an unrelated missing column is
 *      genuine schema drift and must not be masked as "migration pending".
 *
 * Pure (the actual write is injected) so it is unit-testable without a DB.
 */

import { isMissingColumnError, PostgrestErrorLike } from '../core/postgrest-errors';
import type { SessionColumnSupport } from './session-stamp';

/** Per-table presence memory (structural view of `SessionColumnSupport`). */
export type ColumnSupport = Pick<SessionColumnSupport, 'shouldStamp' | 'markMissing' | 'markPresent' | 'getState'>;

export interface OptionalColumnsWriteResult {
  error: PostgrestErrorLike | null;
  /** True when the persisted row carried the optional columns. */
  withOptional: boolean;
  /** True when the first attempt failed on an optional column and the legacy shape was retried. */
  fellBack: boolean;
}

/** Remove the listed columns from a row (legacy shape). */
export function stripColumns<T extends Record<string, unknown>>(row: T, columns: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = { ...row };
  for (const column of columns) delete out[column];
  return out;
}

/** True when `error` names one of `columns` as missing from the schema. */
export function isOptionalColumnMissingError(
  error: PostgrestErrorLike | null | undefined,
  columns: readonly string[],
): boolean {
  return columns.some((column) => isMissingColumnError(error, column));
}

/**
 * Persist `row`, falling back to the row without `columns` when the deployed
 * schema does not have them yet.
 *
 * @param params.table Table name (key for `support`).
 * @param params.row Full row, optional columns included.
 * @param params.columns The optional (migration-pending) columns.
 * @param params.support Shared per-table presence memory.
 * @param params.write The Supabase call for one row shape.
 * @param params.logger Optional; the first fallback per table is logged at warn.
 * @param params.migrationHint Migration id named in the warn log.
 */
export async function writeWithOptionalColumns<T extends Record<string, unknown>>(params: {
  table: string;
  row: T;
  columns: readonly string[];
  support: ColumnSupport;
  write: (row: Record<string, unknown>) => Promise<{ error: PostgrestErrorLike | null }>;
  logger?: { warn: (message: string, meta?: Record<string, unknown>) => void };
  migrationHint?: string;
}): Promise<OptionalColumnsWriteResult> {
  const { table, row, columns, support, write, logger, migrationHint } = params;

  if (!support.shouldStamp(table)) {
    const { error } = await write(stripColumns(row, columns));
    return { error, withOptional: false, fellBack: false };
  }

  const first = await write(row);
  if (!first.error) {
    support.markPresent(table);
    return { error: null, withOptional: true, fellBack: false };
  }
  if (!isOptionalColumnMissingError(first.error, columns)) {
    return { error: first.error, withOptional: true, fellBack: false };
  }

  const previouslyKnown = support.getState(table) === 'missing';
  support.markMissing(table);
  if (!previouslyKnown) {
    logger?.warn(
      `${table}: ${columns.join('/')} column(s) missing — writing legacy shape${migrationHint ? ` until migration ${migrationHint} is applied` : ''}`,
      { table, columns: [...columns], code: first.error.code, message: first.error.message },
    );
  }

  const { error } = await write(stripColumns(row, columns));
  return { error, withOptional: false, fellBack: true };
}
