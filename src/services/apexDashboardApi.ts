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
  activeSymbols?: readonly string[];
  candlesBuffered?: Record<string, number>;
}

export async function fetchRuntimeStatus(): Promise<BackendRuntimeStatus | null> {
  const res = await fetchJson<BackendRuntimeStatus>("/api/status");
  return res.ok ? res.data : null;
}

/** Union of spot + perps currently streaming candles. 0 when engine stopped. */
export function countActiveMarkets(status: BackendRuntimeStatus | null): number {
  if (!status) return 0;
  const buffered = status.candlesBuffered ? Object.keys(status.candlesBuffered).length : 0;
  if (buffered > 0) return buffered;
  return status.activeSymbols?.length ?? 0;
}
