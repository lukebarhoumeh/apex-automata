/**
 * Observational session reconcile, scoped by execution_mode (follow-up to
 * P3-C, 2026-09-28).
 *
 * Defect pinned here: after P3-C a paper start no longer hydrates a LIVE open
 * row (cross-mode isolation), but `openTradingSession`'s reconcile still read
 * every `closed_at IS NULL` row for the user and would therefore report that
 * live row as `inDbNotEngine` drift on every paper start (and vice versa).
 * The classification must scope like hydrate — same-mode + legacy NULL rows —
 * and report foreign-mode rows separately, never as drift; a schema without
 * the column (legacy select) keeps the old all-rows behaviour.
 */
import { describe, expect, it } from 'vitest';
import {
  classifyReconcileRows,
  RECONCILE_NOTE_ALIGNED,
  RECONCILE_NOTE_DRIFT,
  selectRowsForDestructiveReconcile,
} from '../persistence/session-reconcile';

const rows = () => [
  { id: 'p-1', symbol: 'ETH-USD', execution_mode: 'paper' },
  { id: 'l-1', symbol: 'BTC-USD', execution_mode: 'live' },
  // Legacy row written before migration 20260911170000.
  { id: 'n-1', symbol: 'SOL-USD', execution_mode: null },
];

describe('classifyReconcileRows — execution_mode scoping', () => {
  it('paper start: a live open row is foreignModeOpen, NOT inDbNotEngine (the defect)', () => {
    const result = classifyReconcileRows({
      rows: rows(),
      engineSymbols: ['ETH-USD', 'SOL-USD'], // exactly what a paper hydrate adopts
      executionMode: 'paper',
      modeColumnPresent: true,
    });

    expect(result.inDbNotEngine).toEqual([]);
    expect(result.inEngineNotDb).toEqual([]);
    expect(result.dbOpenCount).toBe(2);
    expect(result.engineOpenCount).toBe(2);
    expect(result.foreignModeOpen).toBe(1);
    expect(result.foreignModeSymbols).toEqual(['BTC-USD']);
    expect(result.foreignModes).toEqual(['live']);
    expect(result.modeScoped).toBe(true);
    expect(result.note).toBe(RECONCILE_NOTE_ALIGNED);
  });

  it('live start is symmetric: the paper row is foreign, NULL legacy rows are in scope', () => {
    const result = classifyReconcileRows({
      rows: rows(),
      engineSymbols: ['BTC-USD', 'SOL-USD'],
      executionMode: 'live',
      modeColumnPresent: true,
    });

    expect(result.inDbNotEngine).toEqual([]);
    expect(result.inEngineNotDb).toEqual([]);
    expect(result.foreignModeOpen).toBe(1);
    expect(result.foreignModeSymbols).toEqual(['ETH-USD']);
    expect(result.foreignModes).toEqual(['paper']);
  });

  it('real same-mode drift is still reported as drift', () => {
    const result = classifyReconcileRows({
      rows: rows(),
      engineSymbols: ['ETH-USD', 'XRP-USD'], // SOL missing in engine (phantom row), XRP missing in DB
      executionMode: 'paper',
      modeColumnPresent: true,
    });

    expect(result.inDbNotEngine).toEqual(['SOL-USD']);
    expect(result.inEngineNotDb).toEqual(['XRP-USD']);
    expect(result.foreignModeOpen).toBe(1);
    expect(result.note).toBe(RECONCILE_NOTE_DRIFT);
  });

  it('pre-20260911 schema (legacy select, no column): every row is in scope and nothing is foreign — old behaviour', () => {
    const legacyRows = rows().map(({ execution_mode: _m, ...row }) => row);
    const result = classifyReconcileRows({
      rows: legacyRows,
      engineSymbols: ['ETH-USD', 'SOL-USD'],
      executionMode: 'paper',
      modeColumnPresent: false,
    });

    expect(result.modeScoped).toBe(false);
    expect(result.foreignModeOpen).toBe(0);
    expect(result.dbOpenCount).toBe(3);
    // The live row hydrated too on that schema (no column to filter on), so
    // here it is genuine drift vs this engine set — reported as before.
    expect(result.inDbNotEngine).toEqual(['BTC-USD']);
    expect(result.note).toBe(RECONCILE_NOTE_DRIFT);
  });

  it('no mode given: unscoped, every row counts (legacy callers unchanged)', () => {
    const result = classifyReconcileRows({
      rows: rows(),
      engineSymbols: ['ETH-USD', 'BTC-USD', 'SOL-USD'],
      executionMode: null,
      modeColumnPresent: true,
    });

    expect(result.modeScoped).toBe(false);
    expect(result.dbOpenCount).toBe(3);
    expect(result.foreignModeOpen).toBe(0);
    expect(result.note).toBe(RECONCILE_NOTE_ALIGNED);
  });

  it('counts distinct symbols (two open rows for one symbol collapse) and ignores malformed rows', () => {
    const result = classifyReconcileRows({
      rows: [
        { id: 'a', symbol: 'ETH-USD', execution_mode: 'paper' },
        { id: 'b', symbol: 'ETH-USD', execution_mode: 'paper' },
        { id: 'c', symbol: undefined as unknown as string, execution_mode: 'paper' },
      ],
      engineSymbols: ['ETH-USD'],
      executionMode: 'paper',
      modeColumnPresent: true,
    });

    expect(result.dbOpenCount).toBe(1);
    expect(result.inDbNotEngine).toEqual([]);
    expect(result.note).toBe(RECONCILE_NOTE_ALIGNED);
  });
});

/**
 * Legacy destructive reconcile (`STARTUP_RECONCILE=false`), round-3 Task E.
 *
 * Defect pinned here: the orphan-zero UPDATE ran on every `closed_at IS NULL`
 * row for the user with no execution_mode filter, so a paper start with the
 * env set would zero a LIVE open row (paper and live share one Supabase
 * project + USER_ID). The selection must be mode-scoped like hydrate:
 *   - rows stamped with the session's mode are in scope;
 *   - legacy NULL-mode rows are in scope for a PAPER session only, never live;
 *   - rows stamped with another mode are skipped (`skippedForeignMode`);
 *   - without the execution_mode column the update is skipped entirely.
 */
describe('selectRowsForDestructiveReconcile — execution_mode scoping', () => {
  it('paper start never selects a live row (the defect); legacy NULL rows are in scope', () => {
    const selection = selectRowsForDestructiveReconcile(rows(), 'paper', true);

    expect(selection.skipped).toBe(false);
    expect(selection.ids).toEqual(['p-1', 'n-1']);
    expect(selection.ids).not.toContain('l-1');
    expect(selection.skippedForeignMode).toBe(1);
    expect(selection.skippedForeignModeSymbols).toEqual(['BTC-USD']);
    expect(selection.skippedNullModeForLive).toBe(0);
  });

  it('live start selects only rows stamped live — never a paper row, never a NULL-mode legacy row', () => {
    const selection = selectRowsForDestructiveReconcile(rows(), 'live', true);

    expect(selection.skipped).toBe(false);
    expect(selection.ids).toEqual(['l-1']);
    expect(selection.skippedForeignMode).toBe(1);
    expect(selection.skippedForeignModeSymbols).toEqual(['ETH-USD']);
    expect(selection.skippedNullModeForLive).toBe(1);
  });

  it('execution_mode column missing: the destructive update is skipped entirely, nothing is selected', () => {
    const legacyRows = rows().map(({ execution_mode: _m, ...row }) => row);
    const selection = selectRowsForDestructiveReconcile(legacyRows, 'paper', false);

    expect(selection.skipped).toBe(true);
    expect(selection.skipReason).toBe('execution_mode_column_missing');
    expect(selection.ids).toEqual([]);
    expect(selection.skippedForeignMode).toBe(0);
  });

  it('rows without an id cannot be targeted and are dropped, not zeroed by a blanket filter', () => {
    const selection = selectRowsForDestructiveReconcile(
      [
        { id: 'p-1', symbol: 'ETH-USD', execution_mode: 'paper' },
        { id: null, symbol: 'SOL-USD', execution_mode: 'paper' },
        { symbol: 'XRP-USD', execution_mode: 'paper' },
      ],
      'paper',
      true,
    );

    expect(selection.ids).toEqual(['p-1']);
    expect(selection.droppedNoId).toBe(2);
  });

  it('empty input selects nothing and skips nothing', () => {
    const selection = selectRowsForDestructiveReconcile([], 'paper', true);

    expect(selection).toEqual({
      ids: [],
      skipped: false,
      skipReason: null,
      skippedForeignMode: 0,
      skippedForeignModeSymbols: [],
      skippedNullModeForLive: 0,
      droppedNoId: 0,
    });
  });
});
