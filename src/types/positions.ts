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
}
