/**
 * Typed fetchers for the apex dashboard hooks.
 *
 * Backend endpoints return 400 when the engine is not running; we surface
 * those as "empty" results rather than throwing so the UI can show a clean
 * pre-session state instead of an error banner.
 */

const API_URL = import.meta.env.VITE_RUNTIME_API_URL || "http://localhost:3001";

type FetchJsonResult<T> = { ok: true; data: T } | { ok: false };

async function fetchJson<T>(path: string, init?: RequestInit): Promise<FetchJsonResult<T>> {
  try {
    const res = await fetch(`${API_URL}${path}`, init);
    if (!res.ok) return { ok: false };
    const data = (await res.json()) as T;
    return { ok: true, data };
  } catch {
    return { ok: false };
  }
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
