/**
 * P&L Types - Frontend Canonical Definitions
 * 
 * This is the single source of truth for all P&L display in the UI.
 * All metrics derive from the backend PnLService pnl:snapshot events.
 * 
 * Definition rules (MUST match backend):
 * - unrealizedPnlUsd = Σ (markPrice - entryPrice) × qty × direction
 * - realizedPnlUsd = Σ closed trade P&L (net of fees)
 * - totalEquityUsd = sessionStartEquityUsd + realizedPnlUsd + unrealizedPnlUsd
 */

export type ExecutionMode = 'paper' | 'live';

/**
 * The canonical P&L snapshot from backend PnLService
 * 
 * This is the ONLY P&L structure the UI should consume.
 * DO NOT calculate equity or P&L locally - use this snapshot.
 */
export interface PnLSnapshot {
  /** Timestamp of this snapshot */
  ts: number;
  
  /** User ID */
  userId: string;
  
  /** Session ID (from SessionContext) */
  sessionId: string;
  
  /** Execution mode */
  executionMode: ExecutionMode;
  
  /** Risk day (YYYY-MM-DD) */
  riskDay: string;

  // ============ Baselines ============
  
  /** Equity at session start */
  sessionStartEquityUsd: number;
  
  /** Equity at risk day start */
  dayStartEquityUsd: number;

  // ============ Performance ============
  
  /** Realized P&L from closed trades (session total, net of fees) */
  realizedPnlUsd: number;
  
  /** Unrealized P&L from open positions (mark-to-market) */
  unrealizedPnlUsd: number;
  
  /** Total equity = sessionStart + realized + unrealized */
  totalEquityUsd: number;

  // ============ Daily View ============
  
  /** Daily P&L = totalEquity - dayStartEquity */
  dailyPnlUsd: number;
  
  /** Daily P&L in R units (1R = per_trade_risk × dayStartEquity) */
  dailyPnlR: number;
  
  /** Risk unit (1R) in USD */
  riskUnitUsd: number;

  // ============ Context ============
  
  /** Number of open positions */
  openPositionsCount: number;
  
  /** Total notional exposure */
  exposureUsd: number;
  
  /** Last mark price by symbol */
  lastMarkPriceBySymbol?: Record<string, number>;
}

/**
 * Snapshot state for the usePnLSnapshot hook
 */
export interface PnLSnapshotState {
  /** Current snapshot (null if unavailable) */
  snapshot: PnLSnapshot | null;
  /** Milliseconds since last snapshot */
  freshnessMs: number | null;
  /** Source of the snapshot */
  source: 'ws' | 'rest' | 'supabase' | 'none';
  /** Whether data is stale (>10s old) */
  isStale: boolean;
  /** Whether we're loading initial data */
  isLoading: boolean;
}

/**
 * Staleness threshold in ms - snapshot older than this is considered stale
 */
export const PNL_STALE_THRESHOLD_MS = 10_000;

/**
 * Check if a snapshot is stale
 */
export function isSnapshotStale(snapshot: PnLSnapshot | null): boolean {
  if (!snapshot) return true;
  return Date.now() - snapshot.ts > PNL_STALE_THRESHOLD_MS;
}

/**
 * Create an empty/default snapshot (for fallback UI states)
 * This should ONLY be used for display, not for calculations
 */
export function createEmptySnapshot(): PnLSnapshot {
  const now = Date.now();
  const today = new Date().toISOString().split('T')[0];
  
  return {
    ts: now,
    userId: '',
    sessionId: '',
    executionMode: 'paper',
    riskDay: today,
    sessionStartEquityUsd: 0,
    dayStartEquityUsd: 0,
    realizedPnlUsd: 0,
    unrealizedPnlUsd: 0,
    totalEquityUsd: 0,
    dailyPnlUsd: 0,
    dailyPnlR: 0,
    riskUnitUsd: 0,
    openPositionsCount: 0,
    exposureUsd: 0,
  };
}
