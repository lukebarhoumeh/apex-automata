import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { SignalRecord } from "@/types/signals";
import type { StrategyConfig, StrategyParam, MetaFilterInfo } from "@/types/strategy";
import {
  fetchMetaFilterStats,
  fetchStrategyPolicy,
  type BackendStrategy,
  type BackendStrategyPolicy,
} from "@/services/apexDashboardApi";
import { mergeStrategyPolicy } from "@/lib/strategy-policy";
import { emptyStrategyStats, type StrategySessionStatsMap } from "@/lib/strategy-stats";
import { fetchRecentSignals, fetchStrategyInputs, sessionSinceIso } from "@/hooks/apex/useDashboardData";

// ============================================================
// Signal stream — Supabase public.signals (audit view)
// ============================================================

/**
 * Session-scoped while a paper session runs. Rows from guardrails-killed
 * strategies are kept for audit but badged KILLED so nothing shelved by the
 * SoT (vwap_mr / breakout / momentum) can read as active.
 */
export function useSignalStream(sessionStartedAt: number | null) {
  const sinceIso = sessionSinceIso(sessionStartedAt);
  return useQuery<readonly SignalRecord[]>({
    queryKey: ["apex", "signal-stream", sinceIso],
    queryFn: async () => {
      const policy = await fetchStrategyPolicy();
      return fetchRecentSignals(60, { sinceIso, killedStrategies: policy?.disabledStrategies ?? [] }, false);
    },
    staleTime: 2_000,
    refetchInterval: 10_000,
    placeholderData: keepPreviousData,
  });
}

// ============================================================
// Strategies — /api/strategies + policy + session trades → StrategyConfig
// ============================================================

function keyToLabel(key: string): string {
  const spaced = key.replace(/([A-Z])/g, " $1").trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function paramFromEntry(key: string, raw: unknown): StrategyParam | null {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return null;
  const absVal = Math.abs(raw);
  let min: number;
  let max: number;
  let step: number;
  let format: (v: number) => string;
  if (absVal < 1) {
    min = 0;
    max = Math.max(2, absVal * 3);
    step = 0.05;
    format = (v) => v.toFixed(2);
  } else if (absVal < 10) {
    min = 0;
    max = Math.max(20, Math.ceil(absVal * 3));
    step = 0.5;
    format = (v) => v.toFixed(1);
  } else {
    min = 1;
    max = Math.max(200, Math.ceil(absVal * 3));
    step = 1;
    format = (v) => v.toFixed(0);
  }
  return { key, label: keyToLabel(key), val: raw, min, max, step, format };
}

function kindFromCategory(category: string): StrategyConfig["kind"] {
  return category === "mean-reversion" || category === "revert"
    ? "revert"
    : category === "momentum" || category === "trend"
    ? "trend"
    : "ml";
}

export function mapStrategyConfigs(
  registered: readonly BackendStrategy[],
  policy: BackendStrategyPolicy | null,
  sessionStats: StrategySessionStatsMap = {},
): StrategyConfig[] {
  return mergeStrategyPolicy(registered, policy).map((m) => {
    const params = Object.entries(m.registered?.config ?? {})
      .map(([k, v]) => paramFromEntry(k, v))
      .filter((p): p is StrategyParam => p !== null)
      .slice(0, 5);
    const s = sessionStats[m.id] ?? emptyStrategyStats();
    return {
      id: m.id,
      name: m.name,
      desc: m.description,
      kind: kindFromCategory(m.category),
      enabled: m.enabled,
      disabledBy: m.disabledBy,
      params,
      stats: {
        winRate: s.winRate,
        avgR: s.avgR,
        trades: s.trades,
        signals: m.registered?.stats?.signalsGenerated ?? 0,
        lastR: s.lastR,
      },
    };
  });
}

export function useStrategyConfigs() {
  return useQuery<readonly StrategyConfig[]>({
    queryKey: ["apex", "strategy-configs"],
    queryFn: async () => {
      // Same inputs as the dashboard cards: registered plugins, guardrails
      // policy and the session's closed trades (TradeAnalytics).
      const { registered, policy, sessionStats } = await fetchStrategyInputs();
      return mapStrategyConfigs(registered, policy, sessionStats);
    },
    staleTime: 10_000,
    refetchInterval: 30_000,
    placeholderData: keepPreviousData,
  });
}

// ============================================================
// Meta-filter — /api/metafilter/stats (rule-based; no ML model)
// ============================================================

type MetaRuleKey = "coldStreakEnabled" | "timeFilterEnabled" | "strengthFilterEnabled" | "volumeConfirmEnabled";

const RULE_LABELS: readonly { key: MetaRuleKey; label: string }[] = [
  { key: "coldStreakEnabled", label: "Cold-streak cooldown" },
  { key: "timeFilterEnabled", label: "Time-of-day filter" },
  { key: "strengthFilterEnabled", label: "Signal-strength floor" },
  { key: "volumeConfirmEnabled", label: "Volume confirmation" },
];

export function useMetaFilter() {
  return useQuery<MetaFilterInfo>({
    queryKey: ["apex", "meta-filter"],
    queryFn: async () => {
      const res = await fetchMetaFilterStats();
      const cfg = res?.config ?? {};
      return {
        name: "Rule-based meta-filter · cold-streak + time-of-day (no ML model loaded)",
        enabled: res ? Boolean(res.enabled) : null,
        threshold: typeof cfg.minQualityScore === "number" ? cfg.minQualityScore : 0.5,
        rules: RULE_LABELS.map((r) => ({ key: r.key, label: r.label, enabled: Boolean(cfg[r.key]) })),
      };
    },
    staleTime: 30_000,
    refetchInterval: 60_000,
    placeholderData: keepPreviousData,
  });
}
