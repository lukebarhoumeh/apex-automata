import { useQuery } from "@tanstack/react-query";
import type { SessionStats } from "@/types/session";
import type { Position } from "@/types/positions";
import type { SignalRecord, FeedEvent } from "@/types/signals";
import type { StrategyCardData } from "@/types/strategy";
import type { MarketRegime } from "@/types/regime";
import type { EquityPoint, EquityRange } from "@/types/equity";
import type { KpiTile } from "@/types/kpi";
import {
  SESSION_SEED,
  POSITIONS_SEED,
  SIGNAL_SEED,
  FEED_SEED,
  STRATEGY_CARDS_SEED,
  REGIME_SEED,
  equityForRange,
} from "./mock/seed-data";
import { makeSeries } from "./mock/rng";

/**
 * Phase 1 — every hook resolves synchronously from deterministic mock data.
 * Swap `queryFn` with a real fetch when the backend endpoint exists; consumers
 * shouldn't have to change.
 */

export function useSessionStats() {
  return useQuery<SessionStats>({
    queryKey: ["apex", "session-stats"],
    queryFn: () => Promise.resolve(SESSION_SEED),
    staleTime: 1_000,
  });
}

export function useEquityCurve(range: EquityRange) {
  return useQuery<EquityPoint[]>({
    queryKey: ["apex", "equity", range],
    queryFn: () => Promise.resolve(equityForRange(range)),
    staleTime: 30_000,
  });
}

export function useOpenPositions() {
  return useQuery<readonly Position[]>({
    queryKey: ["apex", "positions"],
    queryFn: () => Promise.resolve(POSITIONS_SEED),
    staleTime: 1_000,
  });
}

export function useStrategyStatus() {
  return useQuery<readonly StrategyCardData[]>({
    queryKey: ["apex", "strategy-status"],
    queryFn: () => Promise.resolve(STRATEGY_CARDS_SEED),
    staleTime: 5_000,
  });
}

export function useSignalFeed() {
  return useQuery<readonly FeedEvent[]>({
    queryKey: ["apex", "feed"],
    queryFn: () => Promise.resolve(FEED_SEED),
    staleTime: 1_000,
  });
}

export function useSignalRecords() {
  return useQuery<readonly SignalRecord[]>({
    queryKey: ["apex", "signal-records"],
    queryFn: () => Promise.resolve(SIGNAL_SEED),
    staleTime: 1_000,
  });
}

export function useMarketRegime() {
  return useQuery<MarketRegime>({
    queryKey: ["apex", "regime"],
    queryFn: () => Promise.resolve(REGIME_SEED),
    staleTime: 30_000,
  });
}

/** Derived KPI tiles for the Dashboard headline row. */
export function useDashboardKpis(): { data: KpiTile[] } {
  const session = useSessionStats();
  const positions = useOpenPositions();

  const tiles: KpiTile[] = [
    {
      key: "win",
      label: "Win rate",
      value: session.data ? `${(session.data.winRate * 100).toFixed(1)}%` : "—",
      delta: session.data
        ? `${session.data.wins} winners / ${session.data.trades} total`
        : "",
      tone: "up",
      sparkline: makeSeries(301, 24, 62, 3),
    },
    {
      key: "sharpe",
      label: "Sharpe (30d)",
      value: "2.14",
      delta: "+0.31 vs prior",
      tone: "accent",
      sparkline: makeSeries(302, 24, 100, 2.5, 0.1),
    },
    {
      key: "dd",
      label: "Max DD (30d)",
      value: "-3.82%",
      delta: "$-4,120 peak",
      tone: "down",
      sparkline: makeSeries(303, 24, 100, 2, -0.2),
    },
    {
      key: "exposure",
      label: "Open exposure",
      value: positions.data
        ? `$${Math.round(
            positions.data.reduce((acc, p) => acc + (p.mark ?? p.entry) * p.qty, 0),
          ).toLocaleString()}`
        : "—",
      delta: positions.data
        ? `${positions.data.length} positions · 41% of capital`
        : "",
      tone: "neutral",
      sparkline: makeSeries(304, 24, 100, 3, 0.2),
    },
  ];

  return { data: tiles };
}
