import type { LiveMarks } from "@/hooks/apex/useLiveMarks";
import type { Position, PositionSide } from "@/types/positions";

/** Where a position's mark came from, for the panel's marks label. */
export type MarkOrigin = "ws" | "engine" | null;

/**
 * Mark used to value a position: the live WS mark for its symbol when one is
 * streaming, else the engine's own mark from `/api/positions` (the number the
 * PositionTracker's unrealized P&L uses), else nothing (→ "—"). Entry price
 * is never used as a mark.
 */
export function resolvePositionMark(
  position: Pick<Position, "sym" | "mark">,
  marks: LiveMarks,
): { mark: number | undefined; origin: MarkOrigin } {
  const live = marks[position.sym]?.price;
  if (typeof live === "number" && Number.isFinite(live) && live > 0) return { mark: live, origin: "ws" };
  const engine = position.mark;
  if (typeof engine === "number" && Number.isFinite(engine) && engine > 0) return { mark: engine, origin: "engine" };
  return { mark: undefined, origin: null };
}

/**
 * Panel label for mark coverage: "" (no rows), "no live marks", "live marks"
 * (every row on a WS mark), or `marks N/M[ · K engine]`.
 */
export function markStatusLabel(rows: readonly Position[], marks: LiveMarks): string {
  if (rows.length === 0) return "";
  let ws = 0;
  let engine = 0;
  for (const p of rows) {
    const { origin } = resolvePositionMark(p, marks);
    if (origin === "ws") ws += 1;
    else if (origin === "engine") engine += 1;
  }
  const marked = ws + engine;
  if (marked === 0) return "no live marks";
  if (ws === rows.length) return "live marks";
  return `marks ${marked}/${rows.length}${engine > 0 ? ` · ${engine} engine` : ""}`;
}

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
