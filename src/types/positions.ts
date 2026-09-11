export type PositionSide = "LONG" | "SHORT";

/**
 * - engine: from GET /api/positions (PositionTracker of the running paper session)
 * - book:   from the Supabase `positions` table while the engine is stopped
 *           (rows the engine would hydrate on the next start; no live marks)
 */
export type PositionSource = "engine" | "book";

export interface Position {
  id: string;
  sym: string;
  side: PositionSide;
  qty: number;
  entry: number;
  stop: number;
  target: number;
  opened: string;
  strat: string;
  conf: number;
  source: PositionSource;
  /** Engine mark at the last poll; overlaid by fresher WS ticks at render time. Undefined until known. */
  mark?: number;
  /** Engine-reported unrealized P&L (USD) at the last poll. */
  pnl?: number;
  /** Derived P&L %. */
  pnlPct?: number;
  sparkline?: readonly number[];
}
