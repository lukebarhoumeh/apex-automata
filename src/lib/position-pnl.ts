import type { PositionSide } from "@/types/positions";

/** Unrealized P&L of a position valued at a known mark. */
export interface PositionPnl {
  mark: number;
  pnl: number;
  pnlPct: number;
}

/**
 * Pure unrealized-P&L math. Returns `null` when the mark is unknown or not a
 * usable price so callers render "—" instead of a fabricated $0.00.
 */
export function computePositionPnl(
  side: PositionSide,
  entry: number,
  qty: number,
  mark: number | null | undefined,
): PositionPnl | null {
  if (mark === null || mark === undefined || !Number.isFinite(mark) || mark <= 0) return null;
  if (!Number.isFinite(entry) || !Number.isFinite(qty)) return null;
  const diff = side === "LONG" ? mark - entry : entry - mark;
  const pnl = diff * qty;
  const pnlPct = entry > 0 ? (diff / entry) * 100 : 0;
  return { mark, pnl, pnlPct };
}

/**
 * Progress of the mark along SL — ENTRY — TP, in [-100, 100].
 * Positive = towards target, negative = towards stop. 0 when the mark is
 * unknown or the stop/target distances are degenerate.
 */
export function computeStopTargetProgress(
  side: PositionSide,
  entry: number,
  stop: number,
  target: number,
  mark: number | null | undefined,
): number {
  if (mark === null || mark === undefined || !Number.isFinite(mark) || mark <= 0) return 0;
  const moved = side === "LONG" ? mark - entry : entry - mark;
  const span = moved >= 0 ? Math.abs(target - entry) : Math.abs(entry - stop);
  if (!Number.isFinite(span) || span <= 0) return 0;
  return Math.max(-100, Math.min(100, (moved / span) * 100));
}
