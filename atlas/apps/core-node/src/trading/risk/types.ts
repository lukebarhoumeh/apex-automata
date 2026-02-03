/**
 * Risk Evaluation Types
 * 
 * These types are used for the pure risk evaluation pipeline.
 * The evaluation is mode-agnostic: same inputs → same outputs.
 */

/**
 * Execution mode for the trading engine
 */
export type ExecutionMode = 'paper' | 'live';

/**
 * Complete risk snapshot for evaluation
 * 
 * This is the ONLY input to the risk evaluator.
 * Mode-specific behavior is NOT allowed unless gated by explicit override flags.
 */
export interface RiskEvaluationSnapshot {
  /** Timestamp of the snapshot */
  ts: number;
  
  /** Session identifier */
  sessionId: string;
  
  /** Execution mode (paper or live) - only used for explicit overrides */
  executionMode: ExecutionMode;

  // ============ Canonical P&L (from RiskMath) ============
  
  /** Equity at start of risk day */
  dayStartEquityUsd: number;
  
  /** Realized P&L from closed trades */
  realizedPnlUsd: number;
  
  /** Unrealized P&L from open positions */
  unrealizedPnlUsd: number;
  
  /** Daily P&L (realized + unrealized) */
  dailyPnlUsd: number;
  
  /** Daily P&L in R units */
  dailyPnlR: number;
  
  /** Risk unit (1R) in USD */
  riskUnitUsd: number;
  
  /** Max drawdown percentage from intraday high */
  maxDrawdownPct: number;
  
  /** Weekly P&L */
  weeklyPnlUsd: number;

  // ============ Exposure & Positions ============
  
  /** Total portfolio exposure in USD */
  exposureUsd: number;
  
  /** Exposure by symbol */
  exposureBySymbolUsd: Record<string, number>;
  
  /** Number of open positions */
  openPositionsCount: number;
  
  /** Number of open orders */
  openOrdersCount: number;

  // ============ Performance Stats ============
  
  /** Current consecutive loss streak */
  consecutiveLosses: number;

  // ============ Reliability Stats ============
  
  /**
   * Error rate (percentage, 0-100)
   * 
   * Definition: (error_events / total_operations) * 100 in rolling window
   * 
   * Error events:
   * - Exchange REST hard failures (timeout/5xx/429 after retries)
   * - WebSocket disconnect/stall events
   * - Order placement failures (after retries)
   * - Internal engine loop exceptions
   * 
   * Total operations: REST calls + WS messages + order actions
   */
  errorRatePct: number;
  
  /**
   * Average latency in milliseconds (rolling window)
   * 
   * Definition: Average of REST request latencies in window
   */
  avgLatencyMs: number;
  
  /**
   * Market data staleness in milliseconds
   * 
   * Definition: now() - lastMarketDataAt
   */
  marketDataStaleMs: number;

  // ============ Per-Symbol Stats ============
  
  /** Daily loss per symbol */
  dailyLossPerSymbolUsd: Record<string, number>;
}

/**
 * Risk thresholds configuration
 * 
 * Single source of truth for all risk limits.
 * Must be the same in paper and live (unless explicit override).
 */
export interface RiskThresholds {
  /** Daily stop in R units (e.g., -2.0 for -2R) */
  dailyStopR: number;
  
  /** Daily stop in USD (absolute) */
  dailyStopUsd: number;
  
  /** Weekly stop in USD */
  weeklyStopUsd: number;
  
  /** Max drawdown percentage (e.g., 0.05 for 5%) */
  maxDrawdownPct: number;
  
  /** Max total exposure in USD */
  maxExposureUsd: number;
  
  /** Max exposure per symbol in USD */
  maxExposurePerSymbolUsd: Record<string, number>;
  
  /** Max daily loss per symbol in USD */
  maxDailyLossPerSymbolUsd: Record<string, number>;
  
  /** Max position notional in USD */
  maxPositionNotionalUsd: number;
  
  /** Min order notional in USD */
  minOrderNotionalUsd: number;
  
  /** Max order notional in USD */
  maxOrderNotionalUsd: number;
  
  /** Max concurrent open positions */
  maxOpenPositions: number;
  
  /** Max concurrent open orders */
  maxOpenOrders: number;
  
  /** Max consecutive losses */
  maxConsecutiveLosses: number;
  
  /** Max error rate percentage */
  maxErrorRatePct: number;
  
  /** Max average latency in milliseconds */
  maxLatencyMs: number;
  
  /** Max market data staleness in milliseconds */
  maxMarketDataStaleMs: number;
}

/**
 * Paper mode override flags
 * 
 * These are the ONLY allowed divergences between paper and live.
 * All default to FALSE (parity behavior).
 */
export interface PaperOverrideFlags {
  /**
   * Reset risk state (clear halts) on paper mode startup.
   * Default: false (parity - persisted state is restored)
   */
  resetRiskStateOnStart: boolean;
  
  /**
   * Disable error rate limit in paper mode.
   * Default: false (parity - error rate limit applies)
   */
  disableErrorRateLimit: boolean;
  
  /**
   * Disable latency limit in paper mode.
   * Default: false (parity - latency limit applies)
   */
  disableLatencyLimit: boolean;
  
  /**
   * Disable market data staleness limit in paper mode.
   * Default: false (parity - staleness limit applies)
   */
  disableDataGapLimit: boolean;
  
  /**
   * Disable soft launch constraints in paper mode.
   * Default: false (parity - soft launch applies if configured)
   */
  disableSoftLaunch: boolean;
}

/**
 * Default paper override flags (all false = parity)
 */
export const DEFAULT_PAPER_OVERRIDES: PaperOverrideFlags = {
  resetRiskStateOnStart: false,
  disableErrorRateLimit: false,
  disableLatencyLimit: false,
  disableDataGapLimit: false,
  disableSoftLaunch: false,
};

/**
 * Risk decision types
 */
export type RiskDecision =
  | { type: 'ALLOW' }
  | { type: 'BLOCK_ENTRY'; reasons: string[] }
  | { type: 'HALT_TRADING'; reasonCode: string; reasonText: string; daily: boolean };

/**
 * Individual guardrail check result
 */
export interface GuardrailCheckResult {
  /** Guardrail name */
  name: string;
  
  /** Whether the check passed */
  passed: boolean;
  
  /** Current value */
  currentValue: number | string;
  
  /** Threshold value */
  thresholdValue: number | string;
  
  /** Reason if failed */
  reason?: string;
  
  /** Whether this guardrail should halt trading (vs just block entry) */
  haltsTrading: boolean;
  
  /** Whether this is a daily halt (can auto-clear on rollover) */
  daily: boolean;
}

/**
 * Complete risk evaluation result
 */
export interface RiskEvaluationResult {
  /** The final decision */
  decision: RiskDecision;
  
  /** All guardrail check results */
  checks: GuardrailCheckResult[];
  
  /** Timestamp of evaluation */
  evaluatedAt: number;
  
  /** The snapshot that was evaluated */
  snapshot: RiskEvaluationSnapshot;
  
  /** Whether any paper overrides were applied */
  paperOverridesApplied: string[];
}
