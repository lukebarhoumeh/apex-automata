import type { BackendTradeRecord } from "@/services/apexDashboardApi";

/** Per-strategy performance derived from the session's closed trades. */
export interface StrategySessionStats {
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  /** Sum of realized P&L (USD) of closed trades. */
  pnl: number;
  /** Mean R multiple; 0 when the risk unit is unknown. */
  avgR: number;
  /** R multiples of the most recent closed trades (oldest → newest). */
  lastR: number[];
}

export type StrategySessionStatsMap = Readonly<Record<string, StrategySessionStats>>;

const EMPTY: StrategySessionStats = { trades: 0, wins: 0, losses: 0, winRate: 0, pnl: 0, avgR: 0, lastR: [] };

export function emptyStrategyStats(): StrategySessionStats {
  return { ...EMPTY, lastR: [] };
}

/**
 * Aggregate `/api/analytics/trades` (TradeAnalytics closed trades — the same
 * object `/api/analytics/session` counts) per strategy, so the strategy cards
 * reconcile with the hero's trade count instead of showing plugin
 * `signalsGenerated` under a "Trades" label (TASK_016 P5).
 *
 * @param trades   Closed trades of the current session (null → engine stopped).
 * @param riskUnitUsd  1R in USD from the PnL snapshot; R multiples are omitted when unknown.
 * @param lastN    How many recent R multiples to keep per strategy.
 */
export function aggregateStrategyStats(
  trades: readonly BackendTradeRecord[] | null | undefined,
  riskUnitUsd: number | null | undefined,
  lastN = 12,
): StrategySessionStatsMap {
  const out: Record<string, StrategySessionStats> = {};
  if (!trades) return out;

  const rUnit = typeof riskUnitUsd === "number" && Number.isFinite(riskUnitUsd) && riskUnitUsd > 0 ? riskUnitUsd : null;
  const rSums: Record<string, { sum: number; n: number }> = {};

  // Oldest → newest so `lastR` reads left-to-right in time order.
  const ordered = [...trades].sort((a, b) => time(a) - time(b));

  for (const t of ordered) {
    if (t.exitTime === undefined && t.realizedPnl === undefined) continue; // still open
    const key = t.strategy ?? "—";
    const s = (out[key] ??= emptyStrategyStats());
    const pnl = typeof t.realizedPnl === "number" && Number.isFinite(t.realizedPnl) ? t.realizedPnl : 0;
    s.trades += 1;
    s.pnl += pnl;
    const outcome = t.outcome ?? (pnl > 0 ? "win" : pnl < 0 ? "loss" : "breakeven");
    if (outcome === "win") s.wins += 1;
    else if (outcome === "loss") s.losses += 1;
    if (rUnit !== null) {
      const r = pnl / rUnit;
      s.lastR.push(r);
      if (s.lastR.length > lastN) s.lastR.shift();
      const acc = (rSums[key] ??= { sum: 0, n: 0 });
      acc.sum += r;
      acc.n += 1;
    }
  }

  for (const [key, s] of Object.entries(out)) {
    s.winRate = s.trades > 0 ? s.wins / s.trades : 0;
    const acc = rSums[key];
    s.avgR = acc && acc.n > 0 ? acc.sum / acc.n : 0;
  }
  return out;
}

function time(t: BackendTradeRecord): number {
  const v = new Date(t.exitTime ?? t.entryTime).getTime();
  return Number.isFinite(v) ? v : 0;
}
