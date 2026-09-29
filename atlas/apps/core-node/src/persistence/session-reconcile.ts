/**
 * Start-up session reconcile (observational) — DB open set vs engine open set,
 * scoped by execution_mode.
 *
 * `openTradingSession` (api/server.ts) reads every `closed_at IS NULL` row for
 * the user and logs the symbols that are open in the DB but not in the engine
 * (`inDbNotEngine`) and vice versa (`inEngineNotDb`). Since P3-C (2026-09-28)
 * `PositionTracker.hydrateOpenPositions` deliberately does NOT adopt an open
 * row stamped with the OTHER execution_mode (paper and live share one Supabase
 * project), so an unscoped reconcile would now report every such row as
 * engine/DB drift on every start. This module classifies the rows the same
 * way hydrate does:
 *
 *   - same-mode rows and legacy NULL-mode rows are the DB open set;
 *   - rows whose non-null `execution_mode` differs are reported separately as
 *     `foreignModeOpen` (count + symbols), never as drift;
 *   - when the caller could not read the column (schema before migration
 *     20260911170000, `modeColumnPresent = false`), every row is in scope —
 *     exactly the pre-P3-C behaviour, and exactly what hydrate does then.
 *
 * Pure and Supabase-free (the read is the caller's) so the classification can
 * be unit tested without a database.
 */

import type { ExecutionMode } from '../runtime/session-context';

/** The columns the reconcile read selects; `execution_mode` only when the schema has it. */
export interface ReconcileOpenRow {
  id?: string | null;
  symbol: string;
  execution_mode?: string | null;
}

export interface ReconcileClassification {
  /** Distinct symbols open in the DB for THIS mode (same-mode + legacy NULL rows). */
  dbOpenCount: number;
  /** Distinct symbols the engine holds open (post-hydrate). */
  engineOpenCount: number;
  /** Symbols open in the DB for this mode with no engine counterpart (phantom / failed close). */
  inDbNotEngine: string[];
  /** Symbols the engine holds open with no DB row (missed open write). */
  inEngineNotDb: string[];
  /** Open rows stamped with ANOTHER execution_mode — left alone by hydrate, not drift. */
  foreignModeOpen: number;
  foreignModeSymbols: string[];
  foreignModes: string[];
  /** True when the read carried `execution_mode` and the mode filter was applied. */
  modeScoped: boolean;
  /** 'state aligned' or the drift note, exactly as logged. */
  note: string;
}

export const RECONCILE_NOTE_ALIGNED = 'state aligned';
export const RECONCILE_NOTE_DRIFT = 'mismatch — exchange reconciler + next ticker/fill will repair drift';

/**
 * Classify the DB open rows against the engine's open symbols.
 *
 * @param params.rows Every `closed_at IS NULL` row for the user (any mode).
 * @param params.engineSymbols Symbols the engine holds open (post-hydrate).
 * @param params.executionMode Mode of the session doing the reconcile; `null` → no mode filter.
 * @param params.modeColumnPresent False when the read had to fall back to the legacy select
 *   (no `execution_mode` column): then every row is in scope and nothing is foreign.
 */
export function classifyReconcileRows(params: {
  rows: ReadonlyArray<ReconcileOpenRow>;
  engineSymbols: Iterable<string>;
  executionMode: ExecutionMode | null;
  modeColumnPresent: boolean;
}): ReconcileClassification {
  const { rows, executionMode, modeColumnPresent } = params;
  const modeScoped = executionMode !== null && modeColumnPresent;

  const dbSymbols = new Set<string>();
  const foreignSymbols = new Set<string>();
  const foreignModes = new Set<string>();
  let foreignModeOpen = 0;
  for (const row of rows) {
    if (!row || typeof row.symbol !== 'string') continue;
    const rowMode = row.execution_mode ?? null;
    if (modeScoped && rowMode !== null && rowMode !== executionMode) {
      foreignModeOpen++;
      foreignSymbols.add(row.symbol);
      foreignModes.add(String(rowMode));
      continue;
    }
    dbSymbols.add(row.symbol);
  }

  const engineSymbols = new Set<string>(params.engineSymbols);
  const inDbNotEngine: string[] = [];
  for (const symbol of dbSymbols) {
    if (!engineSymbols.has(symbol)) inDbNotEngine.push(symbol);
  }
  const inEngineNotDb: string[] = [];
  for (const symbol of engineSymbols) {
    if (!dbSymbols.has(symbol)) inEngineNotDb.push(symbol);
  }

  return {
    dbOpenCount: dbSymbols.size,
    engineOpenCount: engineSymbols.size,
    inDbNotEngine,
    inEngineNotDb,
    foreignModeOpen,
    foreignModeSymbols: [...foreignSymbols],
    foreignModes: [...foreignModes],
    modeScoped,
    note: inDbNotEngine.length === 0 && inEngineNotDb.length === 0 ? RECONCILE_NOTE_ALIGNED : RECONCILE_NOTE_DRIFT,
  };
}
