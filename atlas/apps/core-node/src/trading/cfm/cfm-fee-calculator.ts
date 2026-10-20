/**
 * CFM round-trip fee calculator — computes the all-in cost for a CFM trade
 * including percentage commission, exchange floor, and slippage. Used by
 * the fee-aware EV gate to reject signals whose expected edge does not
 * cover the round-trip cost.
 *
 * Phase 1 (2026-10-19): the EV gate for CFM symbols must account for the
 * cost-plus fee structure where per-contract fees dominate small tickets.
 *
 * CDE fee schedule (effective 2026-08-17, source:
 * https://assets.ctfassets.net/k3n74unfin40/.../Fee_Schedule_as_of_08172026.pdf):
 *   nano BTC/ETH (BIP/ETP): $0.10/ct/side Professional Electronic.
 *   There is NO separate clearing fee — the $0.10 is the all-in exchange fee.
 *
 * Example: 1 nano BTC round trip @ $77,000
 *   Notional: 0.01 BTC × $77,000 = $770
 *   Entry (maker, post_only): 9.5 bps × $770 = $0.7315 + $0.10 exchange = $0.8315
 *   Exit (taker): 10 bps × $770 = $0.77 + $0.10 exchange = $0.87
 *   Round trip: $0.8315 + $0.87 = $1.7015 (22.1 bps effective)
 *   + slippage 3 bps × $770 × 2 = $0.462
 *   Total: ~$2.16 / round trip for 1 nano contract
 */

import { FeeModel, contractsForSize } from '../../core/fee-model';

export interface CfmRoundTripCost {
  entryFeeUsd: number;
  exitFeeUsd: number;
  slippageUsd: number;
  totalUsd: number;
  effectiveBps: number;
  contracts: number;
}

/**
 * Compute the full round-trip cost for a CFM trade.
 *
 * @param feeModel - FeeModel instance with CFM bucket loaded.
 * @param sizeUnderlying - Position size in underlying units (e.g. 0.01 BTC).
 * @param price - Entry price per underlying unit.
 * @param contractSize - Underlying units per contract.
 * @param slippageBps - Slippage estimate in bps (from `risk.slippage_estimate_bps`).
 */
export function computeCfmRoundTripCost(
  feeModel: FeeModel,
  sizeUnderlying: number,
  price: number,
  contractSize: number,
  slippageBps: number,
): CfmRoundTripCost {
  const notional = sizeUnderlying * price;
  const contracts = Number(contractsForSize(sizeUnderlying, contractSize));

  const entryFee = feeModel.computeFillFeeUsd({
    exchange: 'coinbase',
    market: 'cfm',
    side: 'maker',
    notionalUsd: notional,
    contracts,
  });

  const exitFee = feeModel.computeFillFeeUsd({
    exchange: 'coinbase',
    market: 'cfm',
    side: 'taker',
    notionalUsd: notional,
    contracts,
  });

  const entryFeeUsd = Number(entryFee.totalUsd);
  const exitFeeUsd = Number(exitFee.totalUsd);
  const slippageUsd = notional * (slippageBps / 10_000) * 2;
  const totalUsd = entryFeeUsd + exitFeeUsd + slippageUsd;
  const effectiveBps = notional > 0 ? (totalUsd / notional) * 10_000 : 0;

  return {
    entryFeeUsd,
    exitFeeUsd,
    slippageUsd,
    totalUsd,
    effectiveBps,
    contracts,
  };
}

/**
 * Compute the per-contract round-trip exchange fees (both sides)
 * for use in the EV gate's `perContractFeeUsd` input.
 */
export function computePerContractRoundTripFeeUsd(feeModel: FeeModel): number {
  return 2 * feeModel.getExchangeFeePerContractUsd('coinbase', 'cfm');
}
