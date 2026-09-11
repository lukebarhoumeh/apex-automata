import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { BotMode, SessionStats } from "@/types/session";
import type { Position } from "@/types/positions";
import type { SignalRecord, FeedEvent, SignalState, SignalSide } from "@/types/signals";
import type { StrategyCardData, StrategyStatus } from "@/types/strategy";
import type { MarketRegime, RegimeMeter, RegimeMeterTone } from "@/types/regime";
import type { EquityPoint, EquityRange } from "@/types/equity";
import type { KpiTile } from "@/types/kpi";
import type { LiveMarks } from "@/hooks/apex/useLiveMarks";
import { mergeStrategyPolicy } from "@/lib/strategy-policy";
import { hasActiveSession, sessionKey, sessionWindow, type SessionScope } from "@/lib/session-scope";
import { useActiveSession } from "@/runtime/session";
import { supabase } from "@/integrations/supabase/client";
import {
  countActiveMarkets,
  fetchEquityCurve,
  fetchMetaFilterStats,
  fetchRegimeStatus,
  fetchRuntimeStatus,
  fetchSessionAnalytics,
  fetchSessionTrades,
  fetchStrategies,
  fetchStrategyPolicy,
  summarizeTradesByStrategy,
  type BackendRegimeEntry,
  type BackendRuntimeStatus,
  type BackendSessionStats,
  type BackendStrategy,
  type BackendStrategyPolicy,
  type BackendTradeRecord,
} from "@/services/apexDashboardApi";

const PRIMARY_SYMBOL = "BTC-USD";

// ============================================================
// Helpers
// ============================================================

function formatTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toISOString().slice(11, 19);
}

function formatEpoch(ms: number | null | undefined): string {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return "—";
  return new Date(ms).toISOString().slice(11, 19);
}

// ============================================================
// Session stats: map /api/analytics/session → SessionStats
// ============================================================

/**
 * Engine mode for the hero pill, from the runtime status — never a "paper"
 * default. Kill switch outranks paused outranks running.
 */
export function deriveBotMode(status: BackendRuntimeStatus | null): BotMode {
  if (!status || !status.engineRunning) return "stopped";
  if (status.killSwitch?.active || status.engineState === "halted") return "halted";
  if (status.paused) return "paused";
  return status.mode === "live" ? "live" : "paper";
}

export function mapSessionStats(
  raw: BackendSessionStats | null,
  status: BackendRuntimeStatus | null,
): SessionStats {
  const markets = countActiveMarkets(status);
  const mode = deriveBotMode(status);
  // Unrealized comes from the PositionTracker snapshot on /api/status — the
  // same number the engine's own P&L uses. `null` (rendered "—") when the
  // engine is stopped or the snapshot is missing; never a hard-coded 0.
  const unrealized =
    status?.pnl && Number.isFinite(status.pnl.unrealizedPnlUsd)
      ? status.pnl.unrealizedPnlUsd
      : null;

  // Session identity comes from /api/status only. TradeAnalytics has its own
  // `sessionId`/`startTime` (paper-YYYYMMDD-…) which is NOT the runtime's
  // `sess_…` id, so it must never be shown as the session clock.
  const sessionId = status?.engineRunning && status.sessionId ? status.sessionId : null;
  const sessionStartedAt =
    sessionId && typeof status?.sessionStartedAt === "number" && status.sessionStartedAt > 0
      ? status.sessionStartedAt
      : null;

  if (!raw) {
    return {
      sessionId,
      sessionStartedAt,
      openedAt: formatEpoch(sessionStartedAt),
      pnl: 0,
      pnlR: 0,
      realized: 0,
      unrealized,
      trades: 0,
      wins: 0,
      losses: 0,
      winRate: 0,
      heat: 0,
      heatCap: 3.0,
      maxDrawDown: 0,
      mode,
      engineVersion: "v2.4.1",
      markets,
    };
  }

  const realized = raw.totalPnl ?? 0;
  return {
    sessionId,
    sessionStartedAt,
    openedAt: sessionStartedAt ? formatEpoch(sessionStartedAt) : formatTime(raw.startTime),
    // Session P&L = closed-trade P&L (TradeAnalytics) + open P&L (PositionTracker).
    pnl: realized + (unrealized ?? 0),
    pnlR: raw.expectancy ?? 0,
    realized,
    unrealized,
    trades: raw.totalTrades ?? 0,
    wins: raw.winningTrades ?? 0,
    losses: raw.losingTrades ?? 0,
    winRate: raw.winRate ?? 0,
    heat: 0,
    heatCap: 3.0,
    maxDrawDown: raw.maxDrawdownPct ?? 0,
    mode,
    engineVersion: "v2.4.1",
    markets,
  };
}

export function useSessionStats() {
  return useQuery<SessionStats>({
    queryKey: ["apex", "session-stats"],
    queryFn: async () => {
      // Session analytics + runtime status fetched in parallel so the
      // "scanning N markets" hero number reflects real active symbols
      // (spot + perps) instead of a hardcoded constant.
      const [raw, status] = await Promise.all([
        fetchSessionAnalytics(),
        fetchRuntimeStatus(),
      ]);
      return mapSessionStats(raw, status);
    },
    staleTime: 5_000,
    refetchInterval: 15_000,
    placeholderData: keepPreviousData,
  });
}

// ============================================================
// Equity curve: map /api/analytics/equity-curve → EquityPoint[]
// ============================================================

function sliceByRange(points: EquityPoint[], range: EquityRange): EquityPoint[] {
  const n = points.length;
  if (n === 0) return points;
  if (range === "1D") return points.slice(Math.max(0, n - 24));
  if (range === "1W") return points.slice(Math.max(0, n - 60));
  if (range === "1M") return points.slice(Math.max(0, n - 120));
  return points;
}

export function useEquityCurve(range: EquityRange) {
  return useQuery<EquityPoint[]>({
    queryKey: ["apex", "equity", range],
    queryFn: async () => {
      const res = await fetchEquityCurve();
      if (!res) return [];
      const points: EquityPoint[] = res.equityCurve.map((p, i) => ({
        t: i,
        v: p.equity ?? res.currentEquity,
      }));
      // Ensure at least one point so the chart renders a flat line instead
      // of breaking on an empty dataset.
      if (points.length === 0) {
        points.push({ t: 0, v: res.currentEquity });
        points.push({ t: 1, v: res.currentEquity });
      }
      return sliceByRange(points, range);
    },
    staleTime: 10_000,
    refetchInterval: 30_000,
    placeholderData: keepPreviousData,
  });
}

// ============================================================
// Open positions: Supabase positions table
// ============================================================

interface PositionRow {
  id: string;
  symbol: string;
  strategy: string | null;
  side: string;
  qty_open: number | string | null;
  entry_price: number | string | null;
  stop_price_at_entry: number | string | null;
  take_profit_price: number | string | null;
  opened_at: string | null;
  closed_at: string | null;
}

function num(v: unknown): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  if (typeof v === "string") {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function mapPosition(row: PositionRow): Position {
  const side = row.side?.toUpperCase() === "SHORT" ? "SHORT" : "LONG";

  // The positions table stores no mark price. Marks come from the runtime
  // (useLiveMarks: WS ticker + engine PositionUpdate) and are layered in at
  // render time; until one arrives the UI shows "—", never entry-as-mark or a
  // fabricated $0.00 P&L.
  return {
    id: row.id,
    sym: row.symbol,
    side,
    qty: num(row.qty_open),
    entry: num(row.entry_price),
    stop: num(row.stop_price_at_entry),
    target: num(row.take_profit_price),
    opened: formatTime(row.opened_at),
    strat: row.strategy ?? "—",
    conf: 0,
    sparkline: [],
  };
}

export function useOpenPositions() {
  return useQuery<readonly Position[]>({
    queryKey: ["apex", "positions"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("positions")
        .select(
          "id,symbol,strategy,side,qty_open,entry_price,stop_price_at_entry,take_profit_price,opened_at,closed_at",
        )
        .is("closed_at", null)
        .order("opened_at", { ascending: false })
        .limit(50);
      // Throw on transient errors so React Query keeps the last-good list
      // instead of clearing the positions table while a refetch stumbles.
      if (error) throw new Error(`positions fetch: ${error.message}`);
      return (data as PositionRow[] | null)?.map(mapPosition) ?? [];
    },
    staleTime: 2_000,
    refetchInterval: 20_000,
    placeholderData: keepPreviousData,
  });
}

// ============================================================
// Meta-filter status (rule-based gate; no ML model exists)
// ============================================================

export interface MetaFilterStatus {
  /** null → engine stopped / signal processor not running. */
  enabled: boolean | null;
}

export function useMetaFilterStatus() {
  return useQuery<MetaFilterStatus>({
    queryKey: ["apex", "meta-filter-status"],
    queryFn: async () => {
      const res = await fetchMetaFilterStats();
      return { enabled: res ? Boolean(res.enabled) : null };
    },
    staleTime: 15_000,
    refetchInterval: 30_000,
    placeholderData: keepPreviousData,
  });
}

// ============================================================
// Strategies: /api/strategies → StrategyCardData[]
// ============================================================

/**
 * Strategy cards. Trade counts / P&L / win rate come from the ACTIVE session's
 * TradeAnalytics ledger (`/api/analytics/trades`), bucketed by plugin id — the
 * same ledger the hero's "Trades" QuickStat sums, so the numbers agree by
 * construction. `stats.signalsGenerated` is surfaced separately as `signals`:
 * it counts emitted signals (most are filtered before order routing) and was
 * previously shown as "Trades", producing phantom trades on a zero-trade run.
 *
 * @param trades `null` when the engine is stopped (no session ledger).
 */
export function mapStrategyCards(
  registered: readonly BackendStrategy[],
  policy: BackendStrategyPolicy | null,
  trades: readonly BackendTradeRecord[] | null = null,
): StrategyCardData[] {
  const byStrategy = summarizeTradesByStrategy(trades);
  return mergeStrategyPolicy(registered, policy).map((m) => {
    const status: StrategyStatus =
      m.disabledBy === "guardrails" ? "killed" : m.enabled ? "on" : "off";
    const summary = byStrategy[m.id];
    return {
      id: m.id,
      name: m.name,
      status,
      disabledBy: m.disabledBy,
      pnlSession: summary?.pnl ?? 0,
      trades: summary?.trades ?? 0,
      signals: m.registered?.stats?.signalsGenerated ?? 0,
      winRate: summary?.winRate ?? 0,
      sessionScoped: trades !== null,
      sparkline: [],
    };
  });
}

export function useStrategyStatus() {
  const scope = useActiveSession();
  return useQuery<readonly StrategyCardData[]>({
    // Keyed by session so a new run never inherits last run's cards.
    queryKey: ["apex", "strategy-status", sessionKey(scope)],
    queryFn: async () => {
      // Registered plugins (runtime) + guardrails policy (SoT) + the session's
      // closed-trade ledger in parallel so a strategy killed in guardrails.yaml
      // renders as killed, not missing, and trade counts are session-true.
      const [registered, policy, trades] = await Promise.all([
        fetchStrategies(),
        fetchStrategyPolicy(),
        fetchSessionTrades(),
      ]);
      return mapStrategyCards(registered, policy, trades);
    },
    staleTime: 10_000,
    refetchInterval: 30_000,
    placeholderData: keepPreviousData,
  });
}

// ============================================================
// Signals: Supabase signals table → SignalRecord[] + FeedEvent[]
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

/** Killed-by-guardrails ids from the policy, or empty when the policy is unavailable. */
export function killedStrategyIds(policy: BackendStrategyPolicy | null | undefined): ReadonlySet<string> {
  return new Set(policy?.disabledStrategies ?? []);
}

export function mapSignalRecord(row: SignalRow, killed: ReadonlySet<string> = new Set()): SignalRecord {
  const side: SignalSide = row.side?.toUpperCase() === "SELL" ? "SELL" : "BUY";
  const state: SignalState = row.allowed === false ? "REJECTED" : "ACCEPTED";
  const conf = num(row.meta_prob) || num(row.confidence) || num(row.score);
  const strat = row.strategy ?? "—";
  return {
    id: row.id,
    ts: formatTime(row.decided_at),
    sym: row.symbol,
    strat,
    side,
    conf,
    state,
    z: null,
    adx: null,
    note: row.reason ?? "",
    killed: killed.has(strat),
  };
}

export function recordToFeedEvent(r: SignalRecord): FeedEvent {
  return {
    id: `f-${r.id}`,
    ts: r.ts,
    kind: r.state === "ACCEPTED" ? "SIGNAL" : "REJECT",
    msg: `${r.sym} ${r.side} p=${r.conf.toFixed(2)}${r.note ? ` · ${r.note}` : ""}`,
    tag: r.strat,
    score: r.conf,
    killed: r.killed,
  };
}

/**
 * Signals decided since the ACTIVE session opened. `public.signals` has no
 * session_id column (see lib/session-scope.ts), so the scope is the session's
 * time window; with no session the panel is empty rather than showing rows an
 * earlier run wrote.
 */
async function fetchSessionSignals(limit: number, scope: SessionScope): Promise<SignalRecord[]> {
  const window = sessionWindow(scope);
  if (!window) return [];
  const [{ data, error }, policy] = await Promise.all([
    supabase
      .from("signals")
      .select("id,symbol,strategy,decided_at,side,score,confidence,meta_prob,allowed,reason")
      .gte("decided_at", window.since)
      .lte("decided_at", window.until)
      .order("decided_at", { ascending: false })
      .limit(limit),
    fetchStrategyPolicy(),
  ]);
  if (error) throw new Error(`signals fetch: ${error.message}`);
  const killed = killedStrategyIds(policy);
  return (data as SignalRow[] | null)?.map((row) => mapSignalRecord(row, killed)) ?? [];
}

export function useSignalRecords() {
  const scope = useActiveSession();
  return useQuery<readonly SignalRecord[]>({
    queryKey: ["apex", "signal-records", sessionKey(scope)],
    queryFn: async () => fetchSessionSignals(20, scope),
    staleTime: 2_000,
    refetchInterval: hasActiveSession(scope) ? 15_000 : false,
    placeholderData: keepPreviousData,
  });
}

export function useSignalFeed() {
  const scope = useActiveSession();
  return useQuery<readonly FeedEvent[]>({
    queryKey: ["apex", "feed", sessionKey(scope)],
    queryFn: async () => (await fetchSessionSignals(25, scope)).map(recordToFeedEvent),
    staleTime: 2_000,
    refetchInterval: hasActiveSession(scope) ? 15_000 : false,
    placeholderData: keepPreviousData,
  });
}

// ============================================================
// Regime: /api/regime/status → MarketRegime
// ============================================================

function labelFromRegime(r: string): string {
  const k = r.toLowerCase();
  if (k === "strong_trend" || k === "weak_trend") return "TRENDING";
  if (k === "ranging") return "RANGING";
  if (k === "high_volatility") return "CHOPPY";
  if (k === "chop") return "CHOPPY";
  return r.toUpperCase();
}

function buildMeters(r: BackendRegimeEntry): RegimeMeter[] {
  const adxTone: RegimeMeterTone = r.adx > 25 ? "up" : r.adx > 15 ? "info" : "warn";
  const chopTone: RegimeMeterTone = r.choppiness > 60 ? "warn" : "info";
  const confTone: RegimeMeterTone = r.confidence > 0.5 ? "up" : "warn";
  const dirValue = r.trendDirection === "up" ? 80 : r.trendDirection === "down" ? 20 : 50;
  const dirTone: RegimeMeterTone =
    r.trendDirection === "up" ? "up" : r.trendDirection === "down" ? "down" : "info";

  return [
    { key: "adx", label: "ADX", value: r.adx, cap: 60, display: r.adx.toFixed(1), tone: adxTone },
    {
      key: "chop",
      label: "Choppiness",
      value: r.choppiness,
      cap: 100,
      display: r.choppiness.toFixed(0),
      tone: chopTone,
    },
    {
      key: "conf",
      label: "Confidence",
      value: r.confidence * 100,
      cap: 100,
      display: `${(r.confidence * 100).toFixed(0)}%`,
      tone: confTone,
    },
    {
      key: "dir",
      label: "Direction",
      value: dirValue,
      cap: 100,
      display: (r.trendDirection || "flat").toUpperCase(),
      tone: dirTone,
    },
  ];
}

export function useMarketRegime() {
  return useQuery<MarketRegime>({
    queryKey: ["apex", "regime"],
    queryFn: async () => {
      const res = await fetchRegimeStatus();
      const entry = res?.regimes?.[PRIMARY_SYMBOL];
      if (!entry) {
        return {
          label: "—",
          timeframe: "4h",
          meters: [
            { key: "adx", label: "ADX", value: 0, cap: 60, display: "—", tone: "info" },
            { key: "chop", label: "Choppiness", value: 0, cap: 100, display: "—", tone: "info" },
            { key: "conf", label: "Confidence", value: 0, cap: 100, display: "—", tone: "info" },
            { key: "dir", label: "Direction", value: 50, cap: 100, display: "—", tone: "info" },
          ],
        };
      }
      return {
        label: labelFromRegime(entry.regime),
        timeframe: "4h",
        meters: buildMeters(entry),
      };
    },
    staleTime: 5_000,
    refetchInterval: 20_000,
    placeholderData: keepPreviousData,
  });
}

// ============================================================
// KPIs: derived from session + positions + equity
// ============================================================

export function useDashboardKpis(marks: LiveMarks = {}): { data: KpiTile[] } {
  const session = useSessionStats();
  const positions = useOpenPositions();
  const equity = useEquityCurve("ALL");

  const sparkSource =
    equity.data && equity.data.length >= 2 ? equity.data.map((p) => p.v).slice(-24) : [0, 0];

  // Notional at the runtime mark when one exists, else at entry (labelled).
  const exposureUsd = positions.data
    ? positions.data.reduce((acc, p) => acc + (marks[p.sym]?.price ?? p.entry) * p.qty, 0)
    : 0;
  const unmarked = positions.data ? positions.data.filter((p) => marks[p.sym] === undefined).length : 0;

  const tiles: KpiTile[] = [
    {
      key: "win",
      label: "Win rate",
      value: session.data ? `${(session.data.winRate * 100).toFixed(1)}%` : "—",
      delta: session.data
        ? `${session.data.wins} winners / ${session.data.trades} total`
        : "",
      tone: "up",
      sparkline: sparkSource,
    },
    {
      key: "pnl",
      label: "Session P&L",
      value: session.data
        ? `${session.data.pnl >= 0 ? "+" : "-"}$${Math.abs(session.data.pnl).toLocaleString()}`
        : "—",
      delta: session.data ? `${session.data.trades} trades` : "",
      tone: session.data && session.data.pnl >= 0 ? "up" : "down",
      sparkline: sparkSource,
    },
    {
      key: "dd",
      label: "Max DD",
      value: session.data ? `-${session.data.maxDrawDown.toFixed(2)}%` : "—",
      delta: "session",
      tone: "down",
      sparkline: sparkSource,
    },
    {
      key: "exposure",
      label: "Open exposure",
      value: `$${Math.round(exposureUsd).toLocaleString()}`,
      delta: positions.data
        ? `${positions.data.length} positions${unmarked > 0 ? ` · ${unmarked} at entry (no mark)` : ""}`
        : "0 positions",
      tone: "neutral",
      sparkline: sparkSource,
    },
  ];

  return { data: tiles };
}
