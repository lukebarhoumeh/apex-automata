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
  /** Realized P&L (USD) of this strategy's closed trades in the ACTIVE session. */
  pnlSession: number;
  /** Closed trades attributed to this strategy in the ACTIVE session (TradeAnalytics). */
  trades: number;
  /** Signals the plugin emitted this run — NOT trades; most are filtered before routing. */
  signals: number;
  winRate: number;
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
    winRate: number;
    avgR: number;
    /** Closed trades in the ACTIVE session (TradeAnalytics), not signals. */
    trades: number;
    /** Signals emitted by the plugin this run (StrategyRegistry counter). */
    signals: number;
    lastR: readonly number[];
  };
}

export interface MetaModelInfo {
  name: string;
  features: number;
  rocAuc: number;
  precision: number;
  recall: number;
  f1: number;
  threshold: number;
  trainedOn: number;
}
