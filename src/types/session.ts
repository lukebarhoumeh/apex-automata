export type BotMode = "paper" | "live" | "paused";

export interface SessionStats {
  openedAt: string;
  pnl: number;
  pnlR: number;
  realized: number;
  unrealized: number;
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  heat: number;
  heatCap: number;
  maxDrawDown: number;
  signalsSeen: number;
  signalsTaken: number;
  acceptanceRate: number;
  uptime: string;
  mode: BotMode;
  engineVersion: string;
  markets: number;
  metaThreshold: number;
}
