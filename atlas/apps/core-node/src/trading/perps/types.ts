/**
 * Types for the perpetual futures risk monitoring module.
 */

/** Configuration for the perps risk monitor, loaded from guardrails.yaml perps section */
export interface PerpsRiskConfig {
  /** Risk per trade for leveraged positions (decimal, e.g., 0.015 = 1.5%) */
  riskPerTrade: number;
  /** Default leverage for new positions */
  defaultLeverage: number;
  /** Maximum leverage allowed */
  maxLeverage: number;
  /** Minimum distance from liquidation price before auto-reduce (decimal, e.g., 0.20 = 20%) */
  liquidationBufferPct: number;
  /** Maximum acceptable funding rate in basis points */
  maxFundingRateBps: number;
  /** How often to check funding rates (seconds) */
  fundingCheckIntervalSec: number;
  /** Maker fee (decimal) */
  makerFee: number;
  /** Taker fee (decimal) */
  takerFee: number;
  /** Nano contract size (e.g., 0.01) */
  nanoContractSize: number;
}

/** Snapshot of risk state for a single perpetual position */
export interface PerpsPositionRisk {
  symbol: string;
  side: 'long' | 'short';
  size: string;
  entryPrice: string;
  markPrice: string;
  liquidationPrice: string | null;
  /** Distance to liquidation as decimal (e.g., 0.25 = 25% away) */
  liquidationDistance: number;
  /** Whether position is within the danger zone (< liquidationBufferPct) */
  liquidationDanger: boolean;
  leverage: number;
  unrealizedPnl: string;
  marginUsed: string;
  /** Current funding rate for this symbol (bps) */
  fundingRateBps: number;
  /** Whether funding rate exceeds threshold */
  fundingExcessive: boolean;
  /** Estimated hourly funding cost in USD */
  estimatedHourlyFundingCost: number;
}

/** Aggregate risk summary across all perp positions */
export interface PerpsRiskSummary {
  totalPositions: number;
  totalMarginUsed: string;
  totalUnrealizedPnl: string;
  effectiveLeverage: number;
  maxLeverage: number;
  /** Positions in liquidation danger zone */
  positionsInDanger: string[];
  /** Positions with excessive funding costs */
  positionsWithHighFunding: string[];
  /** Total estimated daily funding cost in USD */
  estimatedDailyFundingCost: number;
  /** Whether any risk threshold is breached */
  riskBreached: boolean;
  /** List of breach reasons */
  breachReasons: string[];
  timestamp: number;
}

/** Events emitted by the PerpsRiskMonitor */
export interface PerpsRiskEvents {
  /** Fired when a position enters liquidation danger zone */
  'perps:liquidation_warning': (risk: PerpsPositionRisk) => void;
  /** Fired when funding rate exceeds threshold */
  'perps:funding_warning': (risk: PerpsPositionRisk) => void;
  /** Fired when effective leverage exceeds max */
  'perps:leverage_warning': (summary: PerpsRiskSummary) => void;
  /** Fired on each risk check cycle with full summary */
  'perps:risk_update': (summary: PerpsRiskSummary) => void;
  /** Fired when auto-reduce is recommended */
  'perps:reduce_recommended': (symbol: string, reason: string) => void;
}
