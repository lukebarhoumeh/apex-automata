/**
 * CFM stop-distance position sizer — caps a single stop-out at the tighter of
 * `max_daily_loss_usd` (per-symbol) and the L1 daily-R budget.
 *
 * Phase 1 (2026-10-19, Risk Master review item 2): on 4H bars the ATR ceiling
 * of 4% × stopAtr 2.5 puts the stop up to 10% away. At max_notional_usd 2000
 * that's $200 of risk — above max_daily_loss_usd 100. The sizer clamps so one
 * stop-out never exceeds the loss cap, and always rounds to whole contracts.
 *
 * Formula:
 *   stopDistance = |entryPrice - stopPrice| / entryPrice   (decimal)
 *   maxLossUsd  = min(max_daily_loss_usd, l1DailyRBudgetUsd)
 *   maxNotional  = maxLossUsd / stopDistance               (USD)
 *   maxSize      = maxNotional / entryPrice                (underlying)
 *   size         = floor(maxSize / contractSize) * contractSize  (whole contracts)
 */

export interface CfmSizingInputs {
  entryPrice: number;
  stopPrice: number;
  contractSize: number;
  maxDailyLossUsd: number;
  maxNotionalUsd: number;
  /** L1 daily-R budget in USD = risk_per_trade × equity × |l1_daily_r|. */
  l1DailyRBudgetUsd: number;
}

export interface CfmSizingResult {
  size: number;
  contracts: number;
  maxLossUsd: number;
  stopDistancePct: number;
  notionalUsd: number;
  cappedBy: 'daily_loss' | 'l1_budget' | 'max_notional' | 'none';
}

export function computeCfmPositionSize(inputs: CfmSizingInputs): CfmSizingResult {
  const { entryPrice, stopPrice, contractSize, maxDailyLossUsd, maxNotionalUsd, l1DailyRBudgetUsd } = inputs;

  if (entryPrice <= 0 || contractSize <= 0) {
    return { size: 0, contracts: 0, maxLossUsd: 0, stopDistancePct: 0, notionalUsd: 0, cappedBy: 'none' };
  }

  const stopDistance = Math.abs(entryPrice - stopPrice);
  const stopDistancePct = stopDistance / entryPrice;

  if (stopDistance <= 0) {
    return { size: 0, contracts: 0, maxLossUsd: 0, stopDistancePct: 0, notionalUsd: 0, cappedBy: 'none' };
  }

  const lossCap = Math.min(maxDailyLossUsd, l1DailyRBudgetUsd);
  let cappedBy: CfmSizingResult['cappedBy'] = lossCap === maxDailyLossUsd ? 'daily_loss' : 'l1_budget';

  let maxNotional = lossCap / stopDistancePct;
  if (maxNotional > maxNotionalUsd) {
    maxNotional = maxNotionalUsd;
    cappedBy = 'max_notional';
  }

  const maxSizeUnderlying = maxNotional / entryPrice;
  const wholeContracts = Math.floor(maxSizeUnderlying / contractSize);
  const size = wholeContracts * contractSize;
  const notionalUsd = size * entryPrice;

  return {
    size,
    contracts: wholeContracts,
    maxLossUsd: lossCap,
    stopDistancePct,
    notionalUsd,
    cappedBy: wholeContracts > 0 ? cappedBy : 'none',
  };
}
