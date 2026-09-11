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
  /** Plugin runtime parameters (configSchema defaults + guardrails overrides). */
  config?: Record<string, unknown>;
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
    sessionStartEquityUsd?: number;
    dayStartEquityUsd?: number;
    dailyPnlUsd: number;
    dailyPnlR: number;
    /** 1R in USD (equity × risk_per_trade). */
    riskUnitUsd?: number;
    openPositionsCount: number;
    exposureUsd: number;
    maxDrawdownPct?: number;
  } | null;
}

export async function fetchRuntimeStatus(): Promise<BackendRuntimeStatus | null> {
  const res = await fetchJson<BackendRuntimeStatus>("/api/status");
  return res.ok ? res.data : null;
}

// ============================================================
// Open positions — engine PositionTracker (paper session SoT)
// ============================================================

export interface BackendEnginePosition {
  id: string;
  symbol: string;
  side: "long" | "short" | string;
  qty: number;
  entryPrice: number;
  averagePrice: number;
  /** Engine mark; null until the first tick for the symbol. */
  markPrice: number | null;
  unrealizedPnlUsd: number;
  realizedPnlUsd: number;
  stopPrice: number | null;
  takeProfit: number | null;
  strategy: string | null;
  openedAt: string | null;
  lastUpdateAt: string | null;
}

export interface BackendEnginePositions {
  sessionId: string | null;
  mode: "paper" | "live";
  ts: number;
  positions: readonly BackendEnginePosition[];
}

/** `null` when the engine is stopped (400) — callers fall back to the Supabase book. */
export async function fetchEnginePositions(): Promise<BackendEnginePositions | null> {
  const res = await fetchJson<BackendEnginePositions>("/api/positions");
  return res.ok ? res.data : null;
}

// ============================================================
// Session trades — TradeAnalytics closed trades (same SoT as /analytics/session)
// ============================================================

export interface BackendTradeRecord {
  id: string;
  symbol: string;
  side: "long" | "short";
  entryTime: string;
  exitTime?: string;
  entryPrice: number;
  exitPrice?: number;
  size: number;
  realizedPnl?: number;
  fees: number;
  outcome?: "win" | "loss" | "breakeven";
  strategy?: string;
  exitReason?: string;
}

/** `null` when the engine is stopped; `[]` when the session has no closed trades yet. */
export async function fetchSessionTrades(limit = 500): Promise<readonly BackendTradeRecord[] | null> {
  const res = await fetchJson<{ trades: readonly BackendTradeRecord[] }>(`/api/analytics/trades?limit=${limit}`);
  return res.ok ? res.data.trades ?? [] : null;
}

// ============================================================
// Meta-filter (rule-based; there is no ML model in this codebase)
// ============================================================

export interface BackendMetaFilterStats {
  enabled: boolean;
  config?: {
    coldStreakEnabled?: boolean;
    coldStreakThreshold?: number;
    strengthFilterEnabled?: boolean;
    volumeConfirmEnabled?: boolean;
    timeFilterEnabled?: boolean;
    minQualityScore?: number;
  };
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
