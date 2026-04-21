import { type StrategyId } from "./signals";

export type StrategyStatus = "on" | "off" | "cooldown";

export interface StrategyCardData {
  id: StrategyId | string;
  name: string;
  status: StrategyStatus;
  pnlToday: number;
  trades: number;
  winRate: number;
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
  params: readonly StrategyParam[];
  stats: {
    winRate: number;
    avgR: number;
    trades: number;
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
