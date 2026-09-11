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
  /**
   * Strategy is in guardrails.yaml `disabled_strategies` (GET
   * /api/strategies/policy). Such a signal can never reach order routing and
   * must not be rendered as activity of a runnable strategy.
   */
  killed?: boolean;
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
  /** See SignalRecord.killed. */
  killed?: boolean;
}
