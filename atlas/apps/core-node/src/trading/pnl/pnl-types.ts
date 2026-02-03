/**
 * P&L Types - Canonical Definitions
 * 
 * This is the single source of truth for all P&L and equity calculations.
 * 
 * Definition rules (DO NOT DEVIATE):
 * - unrealizedPnlUsd = Σ (markPrice - entryPrice) × qty × direction (net of entry fees)
 * - realizedPnlUsd = Σ closed trade P&L (net of entry + exit fees)
 * - totalEquityUsd = sessionStartEquityUsd + realizedPnlUsd + unrealizedPnlUsd
 */

export type ExecutionMode = 'paper' | 'live';
export type MarketDataEnv = 'production' | 'sandbox';

/**
 * Startup position policy
 * 
 * When engine starts with existing positions (live account):
 * - 'import_mark_to_market': Create positions with entryPrice = current mark (unrealized starts at 0)
 * - 'flatten': Close all positions on startup (dangerous, usually not recommended)
 */
export type StartupPositionPolicy = 'import_mark_to_market' | 'flatten';

/**
 * The canonical P&L snapshot
 * 
 * This is the ONLY P&L structure used by:
 * - RiskEngine (kill switch + exposure gating)
 * - TradeAnalytics (session stats)
 * - API endpoints (/api/status, /api/analytics/*)
 * - Supabase persistence
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
  
  /** Market data environment */
  marketDataEnv: MarketDataEnv;

  // ============ Baselines ============
  
  /** Equity at session start */
  sessionStartEquityUsd: number;
  
  /** Equity at risk day start */
  dayStartEquityUsd: number;
  
  /** Current risk day (YYYY-MM-DD) */
  riskDay: string;

  // ============ Performance ============
  
  /** Realized P&L from closed trades (session total, net of fees) */
  realizedPnlUsd: number;
  
  /** Unrealized P&L from open positions (mark-to-market, net of entry fees) */
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
  lastMarkPriceBySymbol: Record<string, number>;
  
  /** Positions by symbol */
  positionsBySymbol: Record<string, PositionSnapshot>;
}

/**
 * Position snapshot for P&L tracking
 */
export interface PositionSnapshot {
  symbol: string;
  side: 'long' | 'short';
  quantity: number;
  entryPrice: number;
  markPrice: number;
  unrealizedPnl: number;
  notional: number;
}

/**
 * Equity curve data point (for time-series)
 */
export interface EquityCurvePoint {
  ts: number;
  totalEquityUsd: number;
  realizedPnlUsd: number;
  unrealizedPnlUsd: number;
  dayStartEquityUsd: number;
  openPositionsCount: number;
}

/**
 * P&L service configuration
 */
export interface PnLServiceConfig {
  userId: string;
  sessionId: string;
  executionMode: ExecutionMode;
  marketDataEnv: MarketDataEnv;
  
  /** Initial equity at session start */
  sessionStartEquityUsd: number;
  
  /** Per-trade risk fraction (e.g., 0.01 = 1%) */
  perTradeRiskFraction: number;
  
  /** Risk day timezone */
  riskDayTz?: string;
  
  /** Risk day rollover hour (0-23) */
  riskDayRolloverHour?: number;
  
  /** Startup position policy */
  startupPositionPolicy?: StartupPositionPolicy;
  
  /** Snapshot emit throttle (ms) */
  snapshotThrottleMs?: number;
  
  /** Equity curve buffer size */
  equityCurveBufferSize?: number;
}

/**
 * Validated config with defaults applied
 */
export function applyPnLConfigDefaults(config: PnLServiceConfig): Required<PnLServiceConfig> {
  return {
    ...config,
    riskDayTz: config.riskDayTz ?? 'UTC',
    riskDayRolloverHour: config.riskDayRolloverHour ?? 0,
    startupPositionPolicy: config.startupPositionPolicy ?? 'import_mark_to_market',
    snapshotThrottleMs: config.snapshotThrottleMs ?? 1000,
    equityCurveBufferSize: config.equityCurveBufferSize ?? 3600, // 1 hour at 1s
  };
}
