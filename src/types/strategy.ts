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
  /** Realized P&L of this strategy's closed trades in the current session (USD). */
  pnlSession: number;
  /** Closed trades in the current session — same TradeAnalytics source as the hero. */
  trades: number;
  winRate: number;
  /** Signals the plugin emitted in the current process (NOT trades). */
  signals: number;
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
  /** Session-scoped, from TradeAnalytics closed trades (same SoT as the hero). */
  stats: {
    winRate: number;
    avgR: number;
    trades: number;
    signals: number;
    lastR: readonly number[];
  };
}

/**
 * Rule-based meta-filter state (there is no ML model in this codebase).
 * `enabled === null` → engine stopped / filter state unknown.
 */
export interface MetaFilterInfo {
  name: string;
  enabled: boolean | null;
  /** Quality-score threshold a signal must reach to pass (0–1). */
  threshold: number;
  rules: readonly { key: string; label: string; enabled: boolean }[];
}
