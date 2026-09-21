export type PositionSide = "LONG" | "SHORT";

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
  /** Live mark price — ticks; may be undefined until feed arrives. */
  mark?: number;
  /** Derived unrealized P&L in quote currency. */
  pnl?: number;
  /** Derived P&L %. */
  pnlPct?: number;
  sparkline?: readonly number[];
  /**
   * Opened in a PRIOR session and hydrated into the engine at start
   * (`/api/positions` → `engineOpenPositions[].hydratedFromPriorSession`).
   * Live and counted as open, but not one of this session's trades.
   */
  hydratedFromPriorSession?: boolean;
}

/** Open positions carried from a prior session, for "N open · M hydrated" copy. */
export function countHydratedPositions(positions: readonly Position[]): number {
  return positions.reduce((n, p) => n + (p.hydratedFromPriorSession ? 1 : 0), 0);
}
