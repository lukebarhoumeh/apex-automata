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
 * The legacy destructive path (`STARTUP_RECONCILE=false`) selects its rows
 * through `selectRowsForDestructiveReconcile` below, with the same mode rule
 * (NULL-mode rows for paper only; no column → skip the update entirely).
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

/**
 * Row selection for the LEGACY DESTRUCTIVE reconcile (`STARTUP_RECONCILE=false`
 * / `0`): the orphan-zero UPDATE that force-closes open rows the engine does
 * not hold (`exit_reason='session_end'`, `realized_pnl_usd=0`).
 *
 * Until round 3 (2026-09-29) that UPDATE had NO execution_mode filter — every
 * `closed_at IS NULL` row for the user — so a paper start with the env set
 * would have zeroed a LIVE open row (one Supabase project + USER_ID for both
 * modes). The rule now:
 *
 *   - rows stamped with the session's own `execution_mode` are selected;
 *   - legacy NULL-mode rows (written before migration 20260911170000) are
 *     selected for a PAPER session only — NEVER for live, because an
 *     unstamped row cannot be proven not to be a live position;
 *   - rows stamped with another mode are skipped (`skippedForeignMode`);
 *   - when the caller could not read the column (`columnPresent = false`)
 *     NOTHING is selected and `skipped = true`: the caller must log an
 *     error-level line and not run the update at all — an unscoped update is
 *     exactly the defect, so skipping is the safe fallback;
 *   - rows without an `id` are dropped (`droppedNoId`), because the update is
 *     targeted by primary key and never by a blanket `closed_at IS NULL`
 *     filter again.
 */
export type DestructiveReconcileSkipReason = 'execution_mode_column_missing';

export interface DestructiveReconcileSelection {
  /** Primary keys the caller may orphan-zero (same-mode rows; NULL-mode rows for paper only). */
  ids: string[];
  /** True when the update must NOT run at all (see `skipReason`). */
  skipped: boolean;
  skipReason: DestructiveReconcileSkipReason | null;
  /** Open rows stamped with another execution_mode — left untouched. */
  skippedForeignMode: number;
  skippedForeignModeSymbols: string[];
  /** Legacy NULL-mode rows left untouched because the session is live. */
  skippedNullModeForLive: number;
  /** Rows the read returned without an id — cannot be targeted, left untouched. */
  droppedNoId: number;
}

export function selectRowsForDestructiveReconcile(
  rows: ReadonlyArray<ReconcileOpenRow>,
  executionMode: ExecutionMode,
  columnPresent: boolean,
): DestructiveReconcileSelection {
  const selection: DestructiveReconcileSelection = {
    ids: [],
    skipped: false,
    skipReason: null,
    skippedForeignMode: 0,
    skippedForeignModeSymbols: [],
    skippedNullModeForLive: 0,
    droppedNoId: 0,
  };

  if (!columnPresent) {
    selection.skipped = true;
    selection.skipReason = 'execution_mode_column_missing';
    return selection;
  }

  const foreignSymbols = new Set<string>();
  for (const row of rows) {
    if (!row) continue;
    const rowMode = row.execution_mode ?? null;
    if (rowMode !== null && rowMode !== executionMode) {
      selection.skippedForeignMode++;
      if (typeof row.symbol === 'string') foreignSymbols.add(row.symbol);
      continue;
    }
    if (rowMode === null && executionMode !== 'paper') {
      selection.skippedNullModeForLive++;
      continue;
    }
    if (typeof row.id !== 'string' || row.id.length === 0) {
      selection.droppedNoId++;
      continue;
    }
    selection.ids.push(row.id);
  }
  selection.skippedForeignModeSymbols = [...foreignSymbols];
  return selection;
}
