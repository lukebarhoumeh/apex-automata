export type SignalSide = "BUY" | "SELL";
export type SignalState = "ACCEPTED" | "REJECTED" | "CANCELLED";
export type StrategyId = "meta" | "breakout" | "vwap_mr" | "trend_follow" | "momentum";

export interface SignalRecord {
  id: string;
  ts: string;
  sym: string;
  strat: StrategyId | string;
  side: SignalSide;
  conf: number;
  state: SignalState;
  z: number | null;
  adx: number | null;
  note: string;
}

export type FeedEventKind = "FILL" | "SIGNAL" | "REGIME" | "REJECT" | "RISK" | "SESSION";

export interface FeedEvent {
  id: string;
  ts: string;
  kind: FeedEventKind;
  msg: string;
  tag: string;
  score?: number;
  risk?: "LOW" | "MED" | "HIGH";
}
