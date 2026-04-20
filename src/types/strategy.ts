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
