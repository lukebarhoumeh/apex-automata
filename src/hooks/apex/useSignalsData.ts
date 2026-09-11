import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { SignalRecord, SignalSide, SignalState } from "@/types/signals";
import type {
  StrategyConfig,
  StrategyParam,
  MetaModelInfo,
} from "@/types/strategy";
import { supabase } from "@/integrations/supabase/client";
import { fetchStrategyPolicy, type BackendStrategyPolicy } from "@/services/apexDashboardApi";
import { mergeStrategyPolicy } from "@/lib/strategy-policy";

const API_URL = import.meta.env.VITE_RUNTIME_API_URL || "http://localhost:3001";

async function fetchJsonOrNull<T>(path: string): Promise<T | null> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`);
  } catch {
    throw new Error(`network error: ${path}`);
  }
  // 400 → engine not running (intentional empty). 429/5xx → transient, throw
  // so React Query keeps the last-good data instead of wiping panels.
  if (res.status === 400) return null;
  if (res.status === 429) throw new Error(`rate-limited: ${path}`);
  if (res.status >= 500) throw new Error(`server error ${res.status}: ${path}`);
  if (!res.ok) return null;
  return (await res.json()) as T;
}

function num(v: unknown): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  if (typeof v === "string") {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function formatTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toISOString().slice(11, 19);
}

// ============================================================
// Signal stream — Supabase public.signals
// ============================================================

interface SignalRow {
  id: string;
  symbol: string;
  strategy: string | null;
  decided_at: string;
  side: string | null;
  score: number | string | null;
  confidence: number | string | null;
  meta_prob: number | string | null;
  allowed: boolean | null;
  reason: string | null;
}

function mapSignalRecord(row: SignalRow): SignalRecord {
  const side: SignalSide = row.side?.toUpperCase() === "SELL" ? "SELL" : "BUY";
  const state: SignalState = row.allowed === false ? "REJECTED" : "ACCEPTED";
  const conf = num(row.meta_prob) || num(row.confidence) || num(row.score);
  return {
    id: row.id,
    ts: formatTime(row.decided_at),
    sym: row.symbol,
    strat: row.strategy ?? "—",
    side,
    conf,
    state,
    z: null,
    adx: null,
    note: row.reason ?? "",
  };
}

export function useSignalStream() {
  return useQuery<readonly SignalRecord[]>({
    queryKey: ["apex", "signal-stream"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("signals")
        .select(
          "id,symbol,strategy,decided_at,side,score,confidence,meta_prob,allowed,reason",
        )
        .order("decided_at", { ascending: false })
        .limit(60);
      if (error) throw new Error(`signal-stream fetch: ${error.message}`);
      return (data as SignalRow[] | null)?.map(mapSignalRecord) ?? [];
    },
    staleTime: 2_000,
    refetchInterval: 10_000,
    placeholderData: keepPreviousData,
  });
}

// ============================================================
// Strategies — /api/strategies mapped to StrategyConfig
// ============================================================

interface BackendStrategy {
  id: string;
  name: string;
  description: string;
  category: string;
  tags?: readonly string[];
  enabled: boolean;
  config?: Record<string, unknown>;
  stats?: {
    signalsGenerated?: number;
    avgSignalStrength?: number;
    signalsByDirection?: { buy?: number; sell?: number };
  };
}

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
): StrategyConfig[] {
  return mergeStrategyPolicy(registered, policy).map((m) => {
    const params = Object.entries(m.registered?.config ?? {})
      .map(([k, v]) => paramFromEntry(k, v))
      .filter((p): p is StrategyParam => p !== null)
      .slice(0, 5);
    return {
      id: m.id,
      name: m.name,
      desc: m.description,
      kind: kindFromCategory(m.category),
      enabled: m.enabled,
      disabledBy: m.disabledBy,
      params,
      stats: {
        winRate: 0,
        avgR: 0,
        trades: m.registered?.stats?.signalsGenerated ?? 0,
        lastR: [],
      },
    };
  });
}

export function useStrategyConfigs() {
  return useQuery<readonly StrategyConfig[]>({
    queryKey: ["apex", "strategy-configs"],
    queryFn: async () => {
      // Registered plugins (runtime) + guardrails policy (SoT) in parallel so
      // a strategy killed in guardrails.yaml renders as killed, not missing.
      const [res, policy] = await Promise.all([
        fetchJsonOrNull<{ strategies: readonly BackendStrategy[] }>("/api/strategies"),
        fetchStrategyPolicy(),
      ]);
      return mapStrategyConfigs(res?.strategies ?? [], policy);
    },
    staleTime: 10_000,
    refetchInterval: 30_000,
    placeholderData: keepPreviousData,
  });
}

// ============================================================
// Meta-filter stats — /api/metafilter/stats
// ============================================================

interface BackendMetaFilterStats {
  enabled: boolean;
  config?: {
    coldStreakEnabled?: boolean;
    coldStreakThreshold?: number;
    strengthFilterEnabled?: boolean;
    volumeConfirmEnabled?: boolean;
    timeFilterEnabled?: boolean;
  };
}

export function useMetaModel() {
  return useQuery<MetaModelInfo>({
    queryKey: ["apex", "meta-model"],
    queryFn: async () => {
      const res = await fetchJsonOrNull<BackendMetaFilterStats>("/api/metafilter/stats");
      const cfg = res?.config ?? {};
      const features = [
        cfg.coldStreakEnabled,
        cfg.strengthFilterEnabled,
        cfg.volumeConfirmEnabled,
        cfg.timeFilterEnabled,
      ].filter(Boolean).length;
      return {
        // Label explicitly clarifies this is the rule-based filter, not an
        // ML model. MetaModelHero renders this as the header.
        name: "Rule-based · cold-streak + time filter (ML not loaded)",
        features,
        rocAuc: 0,
        precision: 0,
        recall: 0,
        f1: 0,
        threshold: 0.5,
        trainedOn: 0,
      };
    },
    staleTime: 30_000,
    refetchInterval: 60_000,
    placeholderData: keepPreviousData,
  });
}
