import { type StrategyId } from "./signals";

/**
 * - on:       registered and enabled in the runtime StrategyRegistry
 * - off:      registered but disabled at runtime (or engine offline → unknown)
 * - cooldown: registered, temporarily paused
 * - killed:   listed in guardrails.yaml `disabled_strategies` (SoT) — never registered
 */
export type StrategyStatus = "on" | "off" | "cooldown" | "killed";

/** Why a strategy is not enabled. Absent when it is enabled. */
export type StrategyDisabledBy = "guardrails" | "runtime" | "engine-offline";

export interface StrategyCardData {
  id: StrategyId | string;
  name: string;
  status: StrategyStatus;
  disabledBy?: StrategyDisabledBy;
  /** Realized P&L (USD) of this strategy's CLOSED trades in the ACTIVE session — open positions excluded. */
  pnlSession: number;
  /** Engine unrealized P&L (USD) over this strategy's open positions; null when positions are unavailable. */
  pnlOpen: number | null;
  /** Closed trades attributed to this strategy in the ACTIVE session (TradeAnalytics / sessionStats). */
  closed: number;
  /** Open positions (live) incl. hydrated; null when no open source is available. */
  open: number | null;
  /** Subset of `open` carried from a prior session (hydrated at engine start); null when unknown. */
  hydratedOpen: number | null;
  /** Signals EMITTED this session (sessionStats.signalsGenerated) — NOT trades; null when no counter exists. */
  signals: number | null;
  /** wins / closed over the session's closed trades; null when closed === 0 (render "—"). */
  winRate: number | null;
  /** False when the engine is stopped and no session ledger exists. */
  sessionScoped: boolean;
  sparkline: readonly number[];
}

export interface StrategyParam {
  key: string;
  label: string;
  val: number;
  min: number;
  max: number;
  step: number;
  format: (v: number) => string;
}

export interface StrategyConfig {
  id: string;
  name: string;
  desc: string;
  kind: "trend" | "revert" | "ml";
  enabled: boolean;
  disabledBy?: StrategyDisabledBy;
  params: readonly StrategyParam[];
  stats: {
    /** wins / closed; null when closed === 0 (render "—"). */
    winRate: number | null;
    avgR: number;
    /** Closed trades in the ACTIVE session (TradeAnalytics / sessionStats), not signals. */
    closed: number;
    /** Open positions (live) incl. hydrated; null when no open source is available. */
    open: number | null;
    /** Subset of `open` carried from a prior session; null when unknown. */
    hydratedOpen: number | null;
    /** Signals EMITTED this session (sessionStats.signalsGenerated); null when no counter exists. */
    signals: number | null;
    lastR: readonly number[];
  };
}

export interface MetaModelInfo {
  name: string;
  features: number;
  /**
   * False in this codebase: the meta-filter is rule-based and no ML model is
   * loaded, so ROC-AUC / precision / recall / F1 are undefined and render "—"
   * (never a placeholder 0.0%).
   */
  mlLoaded: boolean;
  rocAuc: number | null;
  precision: number | null;
  recall: number | null;
  f1: number | null;
  threshold: number;
  trainedOn: number | null;
}
