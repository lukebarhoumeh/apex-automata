/**
 * Typed fetchers for the apex dashboard hooks.
 *
 * Semantics:
 * - `status === 400` → backend says "engine not running" (intentional empty).
 *   We map this to `null` data so hooks render a clean pre-session state.
 * - `status === 429/5xx` or a network error → transient. We THROW so that
 *   React Query keeps the last-good data cached instead of replacing it
 *   with an empty array. That's what prevents Dashboard panels (strategy
 *   cards, signal feed, etc.) from flickering when the rate limiter trips.
 */

const API_URL = import.meta.env.VITE_RUNTIME_API_URL || "http://localhost:3001";

type FetchJsonResult<T> = { ok: true; data: T } | { ok: false };

async function fetchJson<T>(path: string, init?: RequestInit): Promise<FetchJsonResult<T>> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, init);
  } catch (err) {
    // Network error — transient, let React Query keep its cache
    throw new Error(`network error: ${path}`);
  }
  if (res.status === 400) return { ok: false }; // intentional "engine not running" empty
  if (res.status === 429) throw new Error(`rate-limited: ${path}`);
  if (res.status >= 500) throw new Error(`server error ${res.status}: ${path}`);
  if (!res.ok) return { ok: false };
  const data = (await res.json()) as T;
  return { ok: true, data };
}

// ============================================================
// Regime
// ============================================================

export interface BackendRegimeEntry {
  regime: string;
  confidence: number;
  trendDirection: "up" | "down" | "flat" | string;
  adx: number;
  choppiness: number;
  lastUpdated: string;
}

export interface BackendRegimeStatus {
  regimes: Record<string, BackendRegimeEntry>;
}

export async function fetchRegimeStatus(): Promise<BackendRegimeStatus | null> {
  const res = await fetchJson<BackendRegimeStatus>("/api/regime/status");
  return res.ok ? res.data : null;
}

// ============================================================
// Session analytics
// ============================================================

export interface BackendSessionStats {
  sessionId: string;
  startTime: string;
  mode: "paper" | "live";
  totalPnl: number;
  grossProfit: number;
  grossLoss: number;
  netProfit: number;
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  breakEvenTrades: number;
  winRate: number;
  profitFactor: number | null;
  payoffRatio: number | null;
  expectancy: number;
  avgWin: number;
  avgLoss: number;
  avgTrade: number;
  avgDuration: number;
  avgSlippageBps: number;
  maxDrawdown: number;
  maxDrawdownPct: number;
  sharpeEstimate: number;
  sortinoEstimate: number;
  calmarEstimate: number;
  avgFillRatio: number;
  avgOrderLatencyMs: number;
  highWaterMark: number;
}

export async function fetchSessionAnalytics(): Promise<BackendSessionStats | null> {
  const res = await fetchJson<BackendSessionStats>("/api/analytics/session");
  return res.ok ? res.data : null;
}

// ============================================================
// Session trades — /api/analytics/trades (TradeAnalytics, in-memory)
// ============================================================

/**
 * Closed trade from the runtime's TradeAnalytics ledger. The ledger is
 * created with the engine and dropped on stop, so every record belongs to
 * the ACTIVE session by construction — the only per-strategy trade source
 * that cannot bleed across sessions.
 */
export interface BackendTradeRecord {
  id: string;
  symbol: string;
  side: "long" | "short" | string;
  entryTime: string;
  exitTime?: string;
  entryPrice: number;
  exitPrice?: number;
  size: number;
  realizedPnl?: number;
  fees?: number;
  outcome?: "win" | "loss" | "breakeven" | string;
  /** Plugin id (trend_follow, momentum, …); absent for engine-originated exits. */
  strategy?: string;
  exitReason?: string;
}

/**
 * `null` when the engine is stopped (400) → "no session"; `[]` when the
 * session is running but has closed no trades yet.
 */
export async function fetchSessionTrades(limit = 500): Promise<readonly BackendTradeRecord[] | null> {
  const res = await fetchJson<{ trades: readonly BackendTradeRecord[] }>(`/api/analytics/trades?limit=${limit}`);
  return res.ok ? res.data.trades ?? [] : null;
}

export interface StrategyTradeSummary {
  trades: number;
  wins: number;
  losses: number;
  /** Sum of realized P&L (USD) over the session's closed trades. */
  pnl: number;
  winRate: number;
}

const EMPTY_SUMMARY: StrategyTradeSummary = { trades: 0, wins: 0, losses: 0, pnl: 0, winRate: 0 };

/** Closed-trade totals keyed by plugin id, for strategy cards. */
export function summarizeTradesByStrategy(
  trades: readonly BackendTradeRecord[] | null | undefined,
): Record<string, StrategyTradeSummary> {
  const out: Record<string, StrategyTradeSummary> = {};
  for (const t of trades ?? []) {
    if (!t.strategy) continue;
    const bucket = out[t.strategy] ?? { ...EMPTY_SUMMARY };
    const pnl = typeof t.realizedPnl === "number" && Number.isFinite(t.realizedPnl) ? t.realizedPnl : 0;
    bucket.trades += 1;
    bucket.pnl += pnl;
    const outcome = t.outcome ?? (pnl > 0 ? "win" : pnl < 0 ? "loss" : "breakeven");
    if (outcome === "win") bucket.wins += 1;
    else if (outcome === "loss") bucket.losses += 1;
    out[t.strategy] = bucket;
  }
  for (const bucket of Object.values(out)) {
    bucket.winRate = bucket.trades > 0 ? bucket.wins / bucket.trades : 0;
  }
  return out;
}

// ============================================================
// Equity curve
// ============================================================

export interface BackendEquityCurvePoint {
  timestamp: number;
  equity: number;
  pnl: number;
}

export interface BackendEquityCurve {
  equityCurve: readonly BackendEquityCurvePoint[];
  highWaterMark: number;
  currentEquity: number;
  maxDrawdown: number;
}

export async function fetchEquityCurve(): Promise<BackendEquityCurve | null> {
  const res = await fetchJson<BackendEquityCurve>("/api/analytics/equity-curve");
  return res.ok ? res.data : null;
}

// ============================================================
// Strategies
// ============================================================

export interface BackendStrategy {
  id: string;
  name: string;
  description: string;
  category: "trend" | "mean-reversion" | string;
  enabled: boolean;
  stats?: {
    signalsGenerated?: number;
    lastSignalTime?: string;
    signalsByDirection?: { buy: number; sell: number };
    avgSignalStrength?: number;
  };
}

export interface BackendStrategiesPayload {
  strategies: readonly BackendStrategy[];
}

export async function fetchStrategies(): Promise<readonly BackendStrategy[]> {
  const res = await fetchJson<BackendStrategiesPayload>("/api/strategies");
  return res.ok ? res.data.strategies : [];
}

// ============================================================
// Runtime status (for live active-markets count, etc.)
// ============================================================

export interface BackendRuntimeStatus {
  engineRunning: boolean;
  mode: "paper" | "live" | null;
  sessionId: string | null;
  /** Epoch ms the active session opened; null when stopped. */
  sessionStartedAt?: number | null;
  paused?: boolean;
  killSwitch?: { active: boolean; reasons?: readonly string[] };
  engineState?: string;
  activeSymbols?: readonly string[];
  candlesBuffered?: Record<string, number>;
  /** PositionTracker/RiskEngine snapshot; null while the engine is stopped. */
  pnl?: {
    realizedPnlUsd: number;
    unrealizedPnlUsd: number;
    totalEquityUsd: number;
    dailyPnlUsd: number;
    dailyPnlR: number;
    openPositionsCount: number;
    exposureUsd: number;
  } | null;
}

export async function fetchRuntimeStatus(): Promise<BackendRuntimeStatus | null> {
  const res = await fetchJson<BackendRuntimeStatus>("/api/status");
  return res.ok ? res.data : null;
}

// ============================================================
// Meta-filter (rule-based; there is no ML model in this codebase)
// ============================================================

export interface BackendMetaFilterStats {
  enabled: boolean;
}

/** `null` when the engine is stopped (signal processor not running). */
export async function fetchMetaFilterStats(): Promise<BackendMetaFilterStats | null> {
  const res = await fetchJson<BackendMetaFilterStats>("/api/metafilter/stats");
  return res.ok ? res.data : null;
}

// ============================================================
// Strategy policy — guardrails.yaml single source of truth
// ============================================================

export interface BackendStrategyPolicyEntry {
  id: string;
  name: string;
  description: string;
  category: string;
  disabledByGuardrails: boolean;
}

export interface BackendStrategyPolicy {
  source: string;
  disabledStrategies: readonly string[];
  perSymbolDisabledStrategies: Record<string, readonly string[]>;
  strategies: readonly BackendStrategyPolicyEntry[];
}

/**
 * Served from the loaded guardrails regardless of engine state, so the UI can
 * show a strategy as killed-by-SoT even when the signal processor is not
 * running (killed plugins are never registered, so /api/strategies omits them).
 */
export async function fetchStrategyPolicy(): Promise<BackendStrategyPolicy | null> {
  const res = await fetchJson<BackendStrategyPolicy>("/api/strategies/policy");
  return res.ok ? res.data : null;
}

/** Union of spot + perps currently streaming candles. 0 when engine stopped. */
export function countActiveMarkets(status: BackendRuntimeStatus | null): number {
  if (!status) return 0;
  const buffered = status.candlesBuffered ? Object.keys(status.candlesBuffered).length : 0;
  if (buffered > 0) return buffered;
  return status.activeSymbols?.length ?? 0;
}
