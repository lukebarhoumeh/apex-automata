/**
 * Engine state as shown in the dashboard hero.
 * - paper / live: engine running in that execution mode
 * - paused: entries halted, positions held
 * - halted: kill switch active — trading blocked, positions NOT auto-closed
 * - stopped: no engine session (never default to "paper" here)
 */
export type BotMode = "paper" | "live" | "paused" | "halted" | "stopped";

export interface SessionStats {
  openedAt: string;
  /** Closed-trade P&L + open P&L (USD). */
  pnl: number;
  /** Session P&L in R (pnl / riskUnitUsd); null when the risk unit is unknown. */
  pnlR: number | null;
  realized: number;
  /** Open-position P&L from the runtime PositionTracker; null when unknown. */
  unrealized: number | null;
  /** Current equity for sizing (PnL snapshot); null when the engine is stopped. */
  equity: number | null;
  /** Equity the session started from; null when unknown. */
  startEquity: number | null;
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  /** Open exposure as % of equity (same definition as the Risk page); null when unknown. */
  heat: number | null;
  heatCap: number;
  maxDrawDown: number;
  openPositions: number;
  uptime: string;
  mode: BotMode;
  /** TradingEngine state string ('running' | 'stopped' | 'halted' | …). */
  engineState: string;
  markets: number;
  /** Rule-based meta-filter gate: true/false when the engine reports it, null otherwise. */
  metaFilterEnabled: boolean | null;
}
