/**
 * Engine state as shown in the dashboard hero.
 * - paper / live: engine running in that execution mode
 * - paused: entries halted, positions held
 * - halted: kill switch active — trading blocked, positions NOT auto-closed
 * - stopped: no engine session (never default to "paper" here)
 */
export type BotMode = "paper" | "live" | "paused" | "halted" | "stopped";

export interface SessionStats {
  /** Active session id from /api/status; null when the engine is stopped. */
  sessionId: string | null;
  /**
   * Epoch ms the active session opened (/api/status → sessionStartedAt).
   * The ONE clock every uptime label derives from; null without a session.
   */
  sessionStartedAt: number | null;
  openedAt: string;
  pnl: number;
  /** Expectancy in R over the session's closed trades; null when there are none (render "—"). */
  pnlR: number | null;
  realized: number;
  /** Open-position P&L from the runtime PositionTracker; null when unknown. */
  unrealized: number | null;
  /** Closed trades this session (TradeAnalytics). */
  trades: number;
  wins: number;
  losses: number;
  /** wins / trades; null when trades === 0 — a rate over zero closes is undefined, never 0%. */
  winRate: number | null;
  /**
   * Portfolio heat = exposure / equity × 100 from the PnL snapshot — the SAME
   * definition the Risk desk uses (lib/portfolio-heat). null when equity is
   * unknown; never a hard-coded 0.
   */
  heat: number | null;
  heatCap: number;
  /** Open notional exposure (USD) from the PnL snapshot; null when unknown. */
  exposureUsd: number | null;
  /** Engine open-position count from the PnL snapshot; null when unknown. */
  openPositions: number | null;
  maxDrawDown: number;
  mode: BotMode;
  engineVersion: string;
  markets: number;
}
