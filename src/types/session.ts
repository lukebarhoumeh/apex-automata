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
  pnlR: number;
  realized: number;
  /** Open-position P&L from the runtime PositionTracker; null when unknown. */
  unrealized: number | null;
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  heat: number;
  heatCap: number;
  maxDrawDown: number;
  mode: BotMode;
  engineVersion: string;
  markets: number;
}
