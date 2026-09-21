import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { BotMode, SessionStats } from "@/types/session";
import { countHydratedPositions, type Position } from "@/types/positions";
import type { SignalRecord, FeedEvent, SignalState, SignalSide } from "@/types/signals";
import type { StrategyCardData, StrategyStatus } from "@/types/strategy";
import type { MarketRegime, RegimeLabel, RegimeMeter, RegimeMeterTone } from "@/types/regime";
import type { EquityPoint, EquityRange } from "@/types/equity";
import type { KpiTile } from "@/types/kpi";
import type { LiveMarks } from "@/hooks/apex/useLiveMarks";
import { computePortfolioHeatPct } from "@/lib/portfolio-heat";
import { resolvePositionMark } from "@/lib/position-pnl";
import { mergeStrategyPolicy } from "@/lib/strategy-policy";
import {
  formatOpenLive,
  formatWinRate,
  heroSessionSentence,
  resolveStrategySessionCounts,
  type StrategyOpenPositionLike,
} from "@/lib/strategy-session-counts";
import {
  fetchSessionBlotterRows,
  fetchSessionOpenPositions,
  SIGNALS_DISPLAY_TIME_COLUMN,
  type EngineOpenPosition,
  type SessionOpenPositionsResult,
} from "@/lib/session-blotter-fetch";
import { hasActiveSession, sessionKey, type SessionScope } from "@/lib/session-scope";
import { useActiveSession } from "@/runtime/session";
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
  type BackendEquityCurve,
  type BackendPnlSnapshot,
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

function finiteOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
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

  // Heat / exposure / open count: the PnL snapshot on /api/status — the same
  // object the Risk desk reads, so hero heat == Risk heat by construction.
  const snapshot = status?.pnl ?? null;
  const exposureUsd = finiteOrNull(snapshot?.exposureUsd);
  const heat = computePortfolioHeatPct(exposureUsd, finiteOrNull(snapshot?.totalEquityUsd));
  const openPositions = finiteOrNull(snapshot?.openPositionsCount);

  if (!raw) {
    return {
      sessionId,
      sessionStartedAt,
      openedAt: formatEpoch(sessionStartedAt),
      pnl: unrealized ?? 0,
      pnlR: null,
      realized: 0,
      unrealized,
      trades: 0,
      wins: 0,
      losses: 0,
      winRate: null,
      heat,
      heatCap: 3.0,
      exposureUsd,
      openPositions,
      maxDrawDown: 0,
      mode,
      engineVersion: "v2.4.1",
      markets,
    };
  }

  const realized = raw.totalPnl ?? 0;
  const trades = raw.totalTrades ?? 0;
  return {
    sessionId,
    sessionStartedAt,
    openedAt: sessionStartedAt ? formatEpoch(sessionStartedAt) : formatTime(raw.startTime),
    // Session P&L = closed-trade P&L (TradeAnalytics) + open P&L (PositionTracker).
    pnl: realized + (unrealized ?? 0),
    // Rates are undefined until the first close — null, never 0 / 0%.
    pnlR: trades > 0 ? finiteOrNull(raw.expectancy) : null,
    realized,
    unrealized,
    trades,
    wins: raw.winningTrades ?? 0,
    losses: raw.losingTrades ?? 0,
    winRate: trades > 0 ? finiteOrNull(raw.winRate) : null,
    heat,
    heatCap: 3.0,
    exposureUsd,
    openPositions,
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

/**
 * Mark-to-market session equity from the PnL snapshot:
 * `sessionStartEquityUsd + realizedPnlUsd + unrealizedPnlUsd` (the contract
 * definition in runtime/pnl/types.ts). null when any component is missing —
 * never a constant. Used as the curve's live last point so the header does
 * not sit at the closed-trade equity ("$10,000 +0.00%") while the hero's
 * unrealized P&L moves.
 */
export function markToMarketEquity(pnl: BackendPnlSnapshot | null | undefined): number | null {
  if (!pnl) return null;
  const start = finiteOrNull(pnl.sessionStartEquityUsd);
  const realized = finiteOrNull(pnl.realizedPnlUsd);
  const unrealized = finiteOrNull(pnl.unrealizedPnlUsd);
  if (start === null || realized === null || unrealized === null) return null;
  return start + realized + unrealized;
}

/**
 * Equity points for the chart: the TradeAnalytics curve (closed-trade
 * equity, sampled) with the live mark-to-market equity appended as the last
 * point when a snapshot exists. Empty when the engine is stopped.
 */
export function buildEquityPoints(res: BackendEquityCurve | null, pnl: BackendPnlSnapshot | null | undefined): EquityPoint[] {
  if (!res) return [];
  const anchor = finiteOrNull(res.currentEquity) ?? finiteOrNull(res.sessionStartEquity);
  const points: EquityPoint[] = [];
  for (const p of res.equityCurve) {
    const v = finiteOrNull(p.equity) ?? anchor;
    if (v !== null) points.push({ t: points.length, v });
  }
  const mtm = markToMarketEquity(pnl) ?? anchor;
  if (mtm !== null) {
    // Two points minimum so the chart draws a line, not a broken dataset.
    if (points.length === 0) points.push({ t: 0, v: finiteOrNull(res.sessionStartEquity) ?? mtm });
    points.push({ t: points.length, v: mtm });
  }
  return points;
}

export function useEquityCurve(range: EquityRange) {
  return useQuery<EquityPoint[]>({
    queryKey: ["apex", "equity", range],
    queryFn: async () => {
      // Curve + status in parallel: the status PnL snapshot provides the live
      // mark-to-market equity for the last point.
      const [res, status] = await Promise.all([fetchEquityCurve(), fetchRuntimeStatus()]);
      return sliceByRange(buildEquityPoints(res, status?.pnl), range);
    },
    staleTime: 10_000,
    refetchInterval: 30_000,
    placeholderData: keepPreviousData,
  });
}

// ============================================================
// Open positions: GET /api/positions (engine truth, session-scoped)
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

/** Supabase `positions` row → UI position (fallback path only). */
export function mapPosition(row: PositionRow): Position {
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
    // Hydrated rows keep the OPENING session's session_id, so a session_id
    // fallback read never returns one; only the engine path can flag them.
    hydratedFromPriorSession: false,
  };
}

/**
 * In-memory engine position (`/api/positions` → `engineOpenPositions`) → UI
 * position. This is the PositionTracker's own list, so the dashboard and
 * Orders open counts equal the engine's by construction, hydrated positions
 * included (flagged, never hidden and never counted as this session's trades).
 */
export function mapEnginePosition(p: EngineOpenPosition): Position {
  const side = (p.side ?? "").toLowerCase() === "short" ? "SHORT" : "LONG";
  const openedMs =
    typeof p.openTime === "number" ? p.openTime : typeof p.openTime === "string" ? Date.parse(p.openTime) : NaN;
  const mark = num(p.marketPrice);
  return {
    id: p.id,
    sym: p.symbol,
    side,
    qty: num(p.size),
    entry: num(p.averagePrice),
    stop: num(p.stopPrice),
    target: num(p.takeProfit),
    opened: Number.isFinite(openedMs) ? formatEpoch(openedMs) : "—",
    strat: p.strategy ?? "—",
    conf: 0,
    // The engine's own mark (what its unrealized P&L is computed at). Live WS
    // marks still take precedence at render time; this is the fallback so an
    // engine-marked position is never valued "at entry".
    mark: mark > 0 ? mark : undefined,
    sparkline: [],
    hydratedFromPriorSession: Boolean(p.hydratedFromPriorSession),
  };
}

/**
 * Open positions for the fetched session result: engine opens when the API
 * provided them (truth, incl. hydrated), else the session-scoped rows.
 */
export function mapSessionOpenPositions(result: SessionOpenPositionsResult): Position[] {
  if (result.engineOpenPositions !== null) {
    return result.engineOpenPositions
      .filter((p) => (p.side ?? "").toLowerCase() !== "flat" && num(p.size) > 0)
      .map(mapEnginePosition);
  }
  return (result.rows as PositionRow[]).map(mapPosition);
}

/**
 * Open positions of the ACTIVE session only. Prefers
 * `GET /api/positions?session_id=&execution_mode=&status=open` (engine
 * `engineOpenPositions`, hydrated flagged); Supabase fallback is filtered by
 * `session_id` + `closed_at IS NULL`. Empty without a session — never an
 * unscoped `closed_at IS NULL` sweep across prior runs.
 */
export function useOpenPositions() {
  const scope = useActiveSession();
  return useQuery<readonly Position[]>({
    queryKey: ["apex", "positions", sessionKey(scope)],
    queryFn: async () => mapSessionOpenPositions(await fetchSessionOpenPositions(scope, 50)),
    staleTime: 2_000,
    refetchInterval: hasActiveSession(scope) ? 20_000 : false,
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
 * Strategy cards — three DISTINCT session counts per strategy, resolved by
 * `resolveStrategySessionCounts` (shared with the Signals page so the two
 * never disagree):
 *
 * - signals emitted  `sessionStats.signalsGenerated` (session-scoped, #72)
 * - closed (session) `sessionStats.closedTrades` / TradeAnalytics ledger
 * - open (live)      engine open positions (`/api/positions`), hydrated
 *                    positions included and counted separately
 *
 * P&L is the CLOSED-trade realized P&L (labelled as such); the engine's
 * unrealized P&L over open positions is carried alongside so a strategy
 * holding three hydrated longs never renders as "flat".
 *
 * @param trades `null` when the engine is stopped (no session ledger).
 * @param openPositions engine opens for the active session; `null` when unavailable.
 */
export function mapStrategyCards(
  registered: readonly BackendStrategy[],
  policy: BackendStrategyPolicy | null,
  trades: readonly BackendTradeRecord[] | null = null,
  openPositions: readonly StrategyOpenPositionLike[] | null = null,
): StrategyCardData[] {
  const byStrategy = summarizeTradesByStrategy(trades);
  return mergeStrategyPolicy(registered, policy).map((m) => {
    const status: StrategyStatus =
      m.disabledBy === "guardrails" ? "killed" : m.enabled ? "on" : "off";
    const c = resolveStrategySessionCounts(m.id, m.registered, byStrategy[m.id], openPositions);
    return {
      id: m.id,
      name: m.name,
      status,
      disabledBy: m.disabledBy,
      pnlSession: c.pnlClosed,
      pnlOpen: c.pnlOpen,
      closed: c.closed,
      open: c.open,
      hydratedOpen: c.hydratedOpen,
      signals: c.signals,
      winRate: c.winRate,
      sessionScoped: trades !== null || m.registered?.sessionStats != null,
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
      // Registered plugins (runtime, with sessionStats) + guardrails policy
      // (SoT) + the session's closed-trade ledger + the engine's open
      // positions in parallel so a strategy killed in guardrails.yaml renders
      // as killed, not missing, and every count is session-true.
      const [registered, policy, trades, positions] = await Promise.all([
        fetchStrategies(),
        fetchStrategyPolicy(),
        fetchSessionTrades(),
        fetchSessionOpenPositions(scope, 50),
      ]);
      return mapStrategyCards(registered, policy, trades, positions.engineOpenPositions);
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

/** Signals for the ACTIVE session (session_id SoT via API or Supabase). */
async function fetchSessionSignals(
  limit: number,
  scope: SessionScope & { mode?: "paper" | "live" | null },
): Promise<SignalRecord[]> {
  const [rows, policy] = await Promise.all([
    fetchSessionBlotterRows("signals", scope, limit, {
      select: "id,symbol,strategy,decided_at,side,score,confidence,meta_prob,allowed,reason",
      orderColumn: "decided_at",
      timeWindowColumn: SIGNALS_DISPLAY_TIME_COLUMN,
    }),
    fetchStrategyPolicy(),
  ]);
  const killed = killedStrategyIds(policy);
  return (rows as SignalRow[]).map((row) => mapSignalRecord(row, killed));
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

/**
 * Desk word + detail for a detector regime. One vocabulary everywhere —
 * `/api/status.regime` says `trend` | `chop`, so the primary word is "Trend"
 * or "Chop" and the detector's finer state ("ranging conditions") is the
 * subtitle. The panel used to headline "RANGING" while the status chip said
 * chop.
 */
export function deskRegime(r: string | null | undefined): { label: RegimeLabel | string; subtitle: string | null } {
  const k = (r ?? "").trim().toLowerCase();
  if (k === "") return { label: "—", subtitle: null };
  if (k === "strong_trend") return { label: "Trend", subtitle: "strong trend" };
  if (k === "weak_trend") return { label: "Trend", subtitle: "weak trend" };
  if (k === "trend" || k === "trending") return { label: "Trend", subtitle: null };
  if (k === "ranging") return { label: "Chop", subtitle: "ranging conditions" };
  if (k === "chop" || k === "choppy") return { label: "Chop", subtitle: "choppy conditions" };
  if (k === "high_volatility") return { label: "Chop", subtitle: "high volatility" };
  // Unknown detector state: show it verbatim rather than guess a desk word.
  return { label: r as string, subtitle: null };
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
          subtitle: null,
          detectorRegime: null,
          timeframe: "4h",
          meters: [
            { key: "adx", label: "ADX", value: 0, cap: 60, display: "—", tone: "info" },
            { key: "chop", label: "Choppiness", value: 0, cap: 100, display: "—", tone: "info" },
            { key: "conf", label: "Confidence", value: 0, cap: 100, display: "—", tone: "info" },
            { key: "dir", label: "Direction", value: 50, cap: 100, display: "—", tone: "info" },
          ],
        };
      }
      const desk = deskRegime(entry.regime);
      return {
        label: desk.label,
        subtitle: desk.subtitle,
        detectorRegime: entry.regime,
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

/**
 * KPI tiles from the session stats + open positions. Pure so the tile copy
 * (win-rate dash at zero closes, exposure SoT, hydrated opens) is testable.
 */
export function buildDashboardKpis(
  session: SessionStats | undefined,
  positions: readonly Position[] | undefined,
  marks: LiveMarks,
  sparkSource: readonly number[],
): KpiTile[] {
  // Exposure: the PnL snapshot's exposureUsd is the SoT (same number as Risk
  // and the hero heat). Only when the snapshot is missing do we sum positions
  // at the runtime mark (WS, else engine) — never at entry.
  const snapshotExposure = session?.exposureUsd ?? null;
  const marked = positions ? positions.filter((p) => resolvePositionMark(p, marks).mark !== undefined) : [];
  const unmarked = positions ? positions.length - marked.length : 0;
  const derivedExposure =
    positions && marked.length > 0
      ? marked.reduce((acc, p) => acc + (resolvePositionMark(p, marks).mark as number) * p.qty, 0)
      : null;
  const exposureUsd = snapshotExposure ?? derivedExposure;
  const hydrated = positions ? countHydratedPositions(positions) : 0;
  const openCount = positions ? positions.length : (session?.openPositions ?? null);

  const closed = session?.trades ?? 0;
  const winRate = session ? formatWinRate(session.winRate, closed, 1) : "—";

  return [
    {
      key: "win",
      label: "Win rate",
      value: winRate,
      delta: !session
        ? ""
        : closed === 0
          ? "no closed trades this session — rate not defined"
          : `${session.wins} winners / ${closed} closed`,
      tone: "up",
      sparkline: sparkSource,
    },
    {
      key: "pnl",
      label: "Session P&L",
      value: session ? `${session.pnl >= 0 ? "+" : "-"}$${Math.abs(session.pnl).toLocaleString()}` : "—",
      delta: session ? heroSessionSentence(closed, openCount, hydrated > 0 ? hydrated : null) : "",
      tone: session && session.pnl >= 0 ? "up" : "down",
      sparkline: sparkSource,
    },
    {
      key: "dd",
      label: "Max DD",
      value: session ? `-${session.maxDrawDown.toFixed(2)}%` : "—",
      delta: "session",
      tone: "down",
      sparkline: sparkSource,
    },
    {
      key: "exposure",
      label: "Open exposure",
      value: exposureUsd === null ? "—" : `$${Math.round(exposureUsd).toLocaleString()}`,
      delta:
        openCount === null
          ? "open positions unknown"
          : `${formatOpenLive(openCount, hydrated > 0 ? hydrated : null)}${
              snapshotExposure === null && unmarked > 0 ? ` · ${unmarked} without mark (excluded)` : ""
            }`,
      tone: "neutral",
      sparkline: sparkSource,
    },
  ];
}

export function useDashboardKpis(marks: LiveMarks = {}): { data: KpiTile[] } {
  const session = useSessionStats();
  const positions = useOpenPositions();
  const equity = useEquityCurve("ALL");

  const sparkSource =
    equity.data && equity.data.length >= 2 ? equity.data.map((p) => p.v).slice(-24) : [0, 0];

  return { data: buildDashboardKpis(session.data, positions.data, marks, sparkSource) };
}
