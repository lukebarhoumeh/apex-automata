import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { BotMode, SessionStats } from "@/types/session";
import type { Position, PositionSide } from "@/types/positions";
import type { SignalRecord, FeedEvent, SignalScope, SignalState, SignalSide } from "@/types/signals";
import type { StrategyCardData, StrategyStatus } from "@/types/strategy";
import type { MarketRegime, RegimeMeter, RegimeMeterTone } from "@/types/regime";
import type { EquityPoint, EquityRange } from "@/types/equity";
import type { KpiTile } from "@/types/kpi";
import type { LiveMarks } from "@/hooks/apex/useLiveMarks";
import { mergeStrategyPolicy } from "@/lib/strategy-policy";
import { aggregateStrategyStats, emptyStrategyStats, type StrategySessionStatsMap } from "@/lib/strategy-stats";
import { supabase } from "@/integrations/supabase/client";
import {
  countActiveMarkets,
  fetchEnginePositions,
  fetchEquityCurve,
  fetchMetaFilterStats,
  fetchRegimeStatus,
  fetchRuntimeStatus,
  fetchSessionAnalytics,
  fetchSessionTrades,
  fetchStrategies,
  fetchStrategyPolicy,
  type BackendEnginePosition,
  type BackendRegimeEntry,
  type BackendRuntimeStatus,
  type BackendSessionStats,
  type BackendStrategy,
  type BackendStrategyPolicy,
} from "@/services/apexDashboardApi";

const PRIMARY_SYMBOL = "BTC-USD";

/** Open exposure / equity cap — mirrors the Risk page's HEAT_CAP_PCT. */
const HEAT_CAP_PCT = 3.0;

// ============================================================
// Helpers
// ============================================================

function formatTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toISOString().slice(11, 19);
}

function formatUptime(startIso: string | undefined | null): string {
  if (!startIso) return "—";
  const start = new Date(startIso).getTime();
  if (Number.isNaN(start)) return "—";
  const ms = Date.now() - start;
  if (ms < 0) return "0h 0m";
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return `${String(h).padStart(2, "0")}h ${String(m).padStart(2, "0")}m`;
}

function num(v: unknown): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  if (typeof v === "string") {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function finiteOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** ISO lower bound for session-scoped Supabase reads; null when no session is active. */
export function sessionSinceIso(sessionStartedAt: number | null | undefined): string | null {
  if (!sessionStartedAt || !Number.isFinite(sessionStartedAt)) return null;
  const d = new Date(sessionStartedAt);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// ============================================================
// Session stats: /api/analytics/session + /api/status → SessionStats
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
  metaFilterEnabled: boolean | null = null,
): SessionStats {
  const markets = countActiveMarkets(status);
  const mode = deriveBotMode(status);
  const snapshot = status?.engineRunning ? status.pnl ?? null : null;

  // Everything below the fold comes from the PositionTracker/RiskEngine
  // snapshot on /api/status — the numbers the engine itself risks against.
  // null (rendered "—") when the engine is stopped; never a hard-coded 0.
  const unrealized = finiteOrNull(snapshot?.unrealizedPnlUsd);
  const equity = finiteOrNull(snapshot?.totalEquityUsd);
  const startEquity = finiteOrNull(snapshot?.sessionStartEquityUsd);
  const exposure = finiteOrNull(snapshot?.exposureUsd);
  const riskUnit = finiteOrNull(snapshot?.riskUnitUsd);
  const heat = equity !== null && equity > 0 && exposure !== null ? (exposure / equity) * 100 : null;
  const openPositions = snapshot?.openPositionsCount ?? 0;
  const engineState = status?.engineState ?? (status?.engineRunning ? "running" : "stopped");

  const realized = raw?.totalPnl ?? 0;
  // Session P&L = closed-trade P&L (TradeAnalytics) + open P&L (PositionTracker).
  const pnl = realized + (unrealized ?? 0);

  return {
    openedAt: raw ? formatTime(raw.startTime) : "—",
    pnl,
    pnlR: riskUnit !== null && riskUnit > 0 ? pnl / riskUnit : null,
    realized,
    unrealized,
    equity,
    startEquity,
    trades: raw?.totalTrades ?? 0,
    wins: raw?.winningTrades ?? 0,
    losses: raw?.losingTrades ?? 0,
    winRate: raw?.winRate ?? 0,
    heat,
    heatCap: HEAT_CAP_PCT,
    maxDrawDown: raw?.maxDrawdownPct ?? 0,
    openPositions,
    uptime: raw ? formatUptime(raw.startTime) : "—",
    mode,
    engineState,
    markets,
    metaFilterEnabled: status?.engineRunning ? metaFilterEnabled : null,
  };
}

export function useSessionStats() {
  return useQuery<SessionStats>({
    queryKey: ["apex", "session-stats"],
    queryFn: async () => {
      // Session analytics + runtime status + meta-filter gate fetched in
      // parallel; all three describe the same paper session.
      const [raw, status, meta] = await Promise.all([
        fetchSessionAnalytics(),
        fetchRuntimeStatus(),
        fetchMetaFilterStats(),
      ]);
      return mapSessionStats(raw, status, meta ? Boolean(meta.enabled) : null);
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
// Open positions: engine PositionTracker (running) → Supabase book (stopped)
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

function toSide(raw: string | null | undefined): PositionSide {
  return raw?.toUpperCase() === "SHORT" ? "SHORT" : "LONG";
}

/** Supabase row → book position. No mark: the table stores none. */
export function mapBookPosition(row: PositionRow): Position {
  return {
    id: row.id,
    sym: row.symbol,
    side: toSide(row.side),
    qty: num(row.qty_open),
    entry: num(row.entry_price),
    stop: num(row.stop_price_at_entry),
    target: num(row.take_profit_price),
    opened: formatTime(row.opened_at),
    strat: row.strategy ?? "—",
    conf: 0,
    source: "book",
    sparkline: [],
  };
}

/** GET /api/positions entry → engine position with the engine's own mark and unrealized P&L. */
export function mapEnginePosition(p: BackendEnginePosition): Position {
  const side = toSide(p.side);
  const mark = p.markPrice !== null && Number.isFinite(p.markPrice) && p.markPrice > 0 ? p.markPrice : undefined;
  const entry = num(p.entryPrice);
  const pnl = mark !== undefined ? p.unrealizedPnlUsd : undefined;
  const pnlPct =
    mark !== undefined && entry > 0 ? ((side === "LONG" ? mark - entry : entry - mark) / entry) * 100 : undefined;
  return {
    id: p.id,
    sym: p.symbol,
    side,
    qty: num(p.qty),
    entry,
    stop: num(p.stopPrice),
    target: num(p.takeProfit),
    opened: formatTime(p.openedAt),
    strat: p.strategy ?? "—",
    conf: 0,
    source: "engine",
    mark,
    pnl,
    pnlPct,
    sparkline: [],
  };
}

export interface OpenPositions {
  source: "engine" | "book";
  positions: readonly Position[];
}

async function fetchBookPositions(): Promise<readonly Position[]> {
  const { data, error } = await supabase
    .from("positions")
    .select("id,symbol,strategy,side,qty_open,entry_price,stop_price_at_entry,take_profit_price,opened_at,closed_at")
    .is("closed_at", null)
    .order("opened_at", { ascending: false })
    .limit(50);
  // Throw on transient errors so React Query keeps the last-good list
  // instead of clearing the positions table while a refetch stumbles.
  if (error) throw new Error(`positions fetch: ${error.message}`);
  return (data as PositionRow[] | null)?.map(mapBookPosition) ?? [];
}

/**
 * Engine positions are the paper session's truth (marks, unrealized, stops
 * from the PositionTracker). Only while the engine is stopped do we fall back
 * to the Supabase book — the rows a restart would hydrate — and label it so.
 */
export function useOpenPositions() {
  return useQuery<OpenPositions>({
    queryKey: ["apex", "positions"],
    queryFn: async () => {
      const engine = await fetchEnginePositions();
      if (engine) return { source: "engine", positions: engine.positions.map(mapEnginePosition) };
      return { source: "book", positions: await fetchBookPositions() };
    },
    staleTime: 2_000,
    refetchInterval: 5_000,
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
// Strategies: /api/strategies + policy + session trades → StrategyCardData[]
// ============================================================

export function mapStrategyCards(
  registered: readonly BackendStrategy[],
  policy: BackendStrategyPolicy | null,
  sessionStats: StrategySessionStatsMap = {},
): StrategyCardData[] {
  return mergeStrategyPolicy(registered, policy).map((m) => {
    const status: StrategyStatus =
      m.disabledBy === "guardrails" ? "killed" : m.enabled ? "on" : "off";
    const s = sessionStats[m.id] ?? emptyStrategyStats();
    return {
      id: m.id,
      name: m.name,
      status,
      disabledBy: m.disabledBy,
      pnlSession: s.pnl,
      trades: s.trades,
      winRate: s.winRate,
      signals: m.registered?.stats?.signalsGenerated ?? 0,
      sparkline: [],
    };
  });
}

/** Registered plugins + guardrails policy + the session's closed trades, fetched together. */
export async function fetchStrategyInputs() {
  const [registered, policy, trades, status] = await Promise.all([
    fetchStrategies(),
    fetchStrategyPolicy(),
    fetchSessionTrades(),
    fetchRuntimeStatus(),
  ]);
  const riskUnit = status?.engineRunning ? status.pnl?.riskUnitUsd ?? null : null;
  return { registered, policy, sessionStats: aggregateStrategyStats(trades, riskUnit) };
}

export function useStrategyStatus() {
  return useQuery<readonly StrategyCardData[]>({
    queryKey: ["apex", "strategy-status"],
    queryFn: async () => {
      // Trades come from the same TradeAnalytics object that /analytics/session
      // counts, so card trade counts reconcile with the hero (TASK_016 P5).
      const { registered, policy, sessionStats } = await fetchStrategyInputs();
      return mapStrategyCards(registered, policy, sessionStats);
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

export function mapSignalRecord(row: SignalRow, killed: ReadonlySet<string> = new Set()): SignalRecord {
  const side: SignalSide = row.side?.toUpperCase() === "SELL" ? "SELL" : "BUY";
  const strat = row.strategy ?? "—";
  const state: SignalState = killed.has(strat) ? "KILLED" : row.allowed === false ? "REJECTED" : "ACCEPTED";
  const conf = num(row.meta_prob) || num(row.confidence) || num(row.score);
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
  };
}

function recordToFeedEvent(r: SignalRecord): FeedEvent {
  return {
    id: `f-${r.id}`,
    ts: r.ts,
    kind: r.state === "ACCEPTED" ? "SIGNAL" : "REJECT",
    msg: `${r.sym} ${r.side} p=${r.conf.toFixed(2)}${r.note ? ` · ${r.note}` : ""}`,
    tag: r.strat,
    score: r.conf,
  };
}

/**
 * Recent signals, scoped to the active session when one exists, with the
 * guardrails kill list applied: killed strategies never run, so their rows
 * are historical — `excludeKilled` drops them (live feed) or they are badged
 * KILLED (audit stream).
 */
export async function fetchRecentSignals(
  limit: number,
  scope: SignalScope,
  excludeKilled: boolean,
): Promise<SignalRecord[]> {
  let query = supabase
    .from("signals")
    .select("id,symbol,strategy,decided_at,side,score,confidence,meta_prob,allowed,reason")
    .order("decided_at", { ascending: false })
    .limit(limit);
  if (scope.sinceIso) query = query.gte("decided_at", scope.sinceIso);
  const { data, error } = await query;
  if (error) throw new Error(`signals fetch: ${error.message}`);
  const killed = new Set(scope.killedStrategies);
  const rows = (data as SignalRow[] | null) ?? [];
  return rows
    .filter((r) => !excludeKilled || !killed.has(r.strategy ?? "—"))
    .map((r) => mapSignalRecord(r, killed));
}

/** Guardrails kill list for signal scoping; empty when the policy endpoint is unavailable. */
async function fetchKilledStrategies(): Promise<readonly string[]> {
  const policy = await fetchStrategyPolicy();
  return policy?.disabledStrategies ?? [];
}

export function useSignalRecords(sessionStartedAt: number | null) {
  const sinceIso = sessionSinceIso(sessionStartedAt);
  return useQuery<readonly SignalRecord[]>({
    queryKey: ["apex", "signal-records", sinceIso],
    queryFn: async () =>
      fetchRecentSignals(20, { sinceIso, killedStrategies: await fetchKilledStrategies() }, false),
    staleTime: 2_000,
    refetchInterval: 15_000,
    placeholderData: keepPreviousData,
  });
}

export function useSignalFeed(sessionStartedAt: number | null) {
  const sinceIso = sessionSinceIso(sessionStartedAt);
  return useQuery<readonly FeedEvent[]>({
    queryKey: ["apex", "feed", sinceIso],
    queryFn: async () =>
      (await fetchRecentSignals(25, { sinceIso, killedStrategies: await fetchKilledStrategies() }, true)).map(
        recordToFeedEvent,
      ),
    staleTime: 2_000,
    refetchInterval: 15_000,
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
  const open = useOpenPositions();
  const equity = useEquityCurve("ALL");

  const positions = open.data?.positions;
  const sparkSource =
    equity.data && equity.data.length >= 2 ? equity.data.map((p) => p.v).slice(-24) : [0, 0];

  // Notional at the freshest mark (WS tick → engine poll), else at entry (labelled).
  const markOf = (p: Position): number | undefined => marks[p.sym]?.price ?? p.mark;
  const exposureUsd = positions ? positions.reduce((acc, p) => acc + (markOf(p) ?? p.entry) * p.qty, 0) : 0;
  const unmarked = positions ? positions.filter((p) => markOf(p) === undefined).length : 0;
  const bookLabel = open.data?.source === "book" && (positions?.length ?? 0) > 0 ? " · book (engine stopped)" : "";

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
      delta: positions
        ? `${positions.length} positions${unmarked > 0 ? ` · ${unmarked} at entry (no mark)` : ""}${bookLabel}`
        : "0 positions",
      tone: "neutral",
      sparkline: sparkSource,
    },
  ];

  return { data: tiles };
}
