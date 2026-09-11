export type SignalSide = "BUY" | "SELL";
/**
 * KILLED marks a row whose strategy is in guardrails.yaml `disabled_strategies`
 * (single source of truth). Such rows are historical/audit only — a killed
 * plugin is never registered, so nothing it "signalled" can reach routing.
 */
export type SignalState = "ACCEPTED" | "REJECTED" | "CANCELLED" | "KILLED";
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

/** Scope applied to Supabase signal reads; session scope when a paper session is active. */
export interface SignalScope {
  /** ISO timestamp lower bound (the active session's start) or null for "recent". */
  sinceIso: string | null;
  /** Strategy ids killed by guardrails.yaml — excluded from live views, badged in audit views. */
  killedStrategies: readonly string[];
}
