/**
 * Pure risk-based position sizing.
 *
 * This is the canonical formula used by both the live RiskEngine and the
 * BacktestEngine. Keeping the math in one place is the only way the two
 * runtimes can produce comparable P&L.
 *
 *   size = (equity * riskPerTrade) / |entryPrice - stopPrice|
 *
 * Then the result is capped by exposure (max_position_exposure_pct of equity,
 * with a 2% safety margin to absorb rounding) and rejected when notional
 * falls below the minimum order size.
 *
 * No state, no logging, no I/O — call sites layer their own context on top.
 */
export interface RiskBasedSizingInputs {
  /** Equity used for sizing (live: dynamic equity; backtest: rolling equity) */
  equity: number;
  /** Fraction of equity to risk per trade (e.g. 0.005 = 0.5%) */
  riskPerTrade: number;
  /** Filled entry price */
  entryPrice: number;
  /** Strategy stop-loss price */
  stopPrice: number;
  /**
   * Absolute USD cap on per-position exposure. Live RiskEngine uses
   * `accountEquity * max_position_exposure_pct`; backtest uses
   * `currentEquity * max_position_exposure_pct`. Helper stays agnostic.
   */
  maxPositionExposureUsd?: number;
  /** Minimum order notional in USD; sizes below this are rejected */
  minNotionalUsd?: number;
  /** Decimal places to round size to (default 6) */
  sizeDecimals?: number;
}

export interface RiskBasedSizingResult {
  /** Position size in base units (0 if rejected) */
  size: number;
  /** Resulting notional value (size * entryPrice) */
  notional: number;
  /** USD risk on the trade if stop is hit (size * stopDistance) */
  riskUsd: number;
  /** When 0, explains why */
  rejectedReason?: string;
}

const EXPOSURE_SAFETY_MARGIN = 0.98; // 2% buffer matches RiskEngine.computeOrderSize

/**
 * Compute risk-based position size. Pure function — same inputs always
 * produce the same outputs.
 *
 * Mirrors `RiskEngine.computeOrderSize` (atlas/apps/core-node/src/trading/risk-engine.ts:929)
 * minus the stateful pieces (soft-launch, dynamic equity), which the caller
 * passes in as `equity`.
 */
export function computeRiskBasedSize(inputs: RiskBasedSizingInputs): RiskBasedSizingResult {
  const {
    equity,
    riskPerTrade,
    entryPrice,
    stopPrice,
    maxPositionExposureUsd,
    minNotionalUsd,
    sizeDecimals = 6,
  } = inputs;

  if (!Number.isFinite(equity) || equity <= 0) {
    return { size: 0, notional: 0, riskUsd: 0, rejectedReason: 'invalid_equity' };
  }
  if (!Number.isFinite(riskPerTrade) || riskPerTrade <= 0) {
    return { size: 0, notional: 0, riskUsd: 0, rejectedReason: 'invalid_risk_per_trade' };
  }
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
    return { size: 0, notional: 0, riskUsd: 0, rejectedReason: 'invalid_entry_price' };
  }
  if (!Number.isFinite(stopPrice) || stopPrice <= 0) {
    return { size: 0, notional: 0, riskUsd: 0, rejectedReason: 'invalid_stop_price' };
  }

  const stopDistance = Math.abs(entryPrice - stopPrice);
  if (!Number.isFinite(stopDistance) || stopDistance === 0) {
    return { size: 0, notional: 0, riskUsd: 0, rejectedReason: 'zero_stop_distance' };
  }

  const riskUsd = equity * riskPerTrade;
  let size = riskUsd / stopDistance;
  if (!Number.isFinite(size) || size <= 0) {
    return { size: 0, notional: 0, riskUsd, rejectedReason: 'non_positive_size' };
  }

  if (
    typeof maxPositionExposureUsd === 'number' &&
    Number.isFinite(maxPositionExposureUsd) &&
    maxPositionExposureUsd > 0
  ) {
    const exposureCapUsd = maxPositionExposureUsd * EXPOSURE_SAFETY_MARGIN;
    const maxSizeByExposure = exposureCapUsd / entryPrice;
    if (Number.isFinite(maxSizeByExposure)) {
      size = Math.min(size, maxSizeByExposure);
    }
  }

  // Round to broker-friendly precision before the min-notional check so the
  // rejection threshold matches what the live order would actually submit.
  const factor = Math.pow(10, sizeDecimals);
  size = Math.floor(size * factor) / factor;

  const notional = size * entryPrice;

  if (
    typeof minNotionalUsd === 'number' &&
    Number.isFinite(minNotionalUsd) &&
    minNotionalUsd > 0 &&
    notional < minNotionalUsd
  ) {
    return { size: 0, notional, riskUsd, rejectedReason: 'below_min_notional' };
  }

  if (!Number.isFinite(size) || size <= 0) {
    return { size: 0, notional: 0, riskUsd, rejectedReason: 'non_positive_size' };
  }

  return {
    size,
    notional,
    riskUsd: size * stopDistance,
  };
}
