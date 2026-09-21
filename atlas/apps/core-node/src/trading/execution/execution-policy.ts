/**
 * Entry execution policy — which order shape the router sends for a symbol.
 *
 * Today the router derived everything from the single global
 * `guardrails.execution.order_type` (`marketable_limit` with a +2 bps offset).
 * Card SH-QMAKER-CFM-PAPER-v0 (blocker 1) needs the CFM venue on a TRUE
 * post-only, never-chased path while spot keeps its legacy profile, so the
 * policy is resolved per symbol:
 *
 *   - `*-CDE` (cfm)  → `guardrails.cfm.execution`: limit, post_only, no chase,
 *                      price = the signal's entry price (never nudged toward
 *                      the market). The schema admits nothing else for this venue.
 *   - everything else → legacy `guardrails.execution.order_type`:
 *       `market`            → market order
 *       `marketable_limit`  → limit at entry ± price_offset_ticks bps (crosses)
 *       `post_only`         → post-only limit at entry
 *       otherwise           → plain limit at entry
 *
 * Pure: no I/O, no logging.
 */

import type { CfmConfig } from '../../config/loadGuardrails';
import { resolveCfmConfig } from '../../config/loadGuardrails';
import { isCfmSymbol } from '../../core/symbol-utils';

export type EntryExecutionPolicy = 'cfm_post_only' | 'market' | 'marketable_limit' | 'post_only' | 'limit';

export interface EntryExecution {
  policy: EntryExecutionPolicy;
  orderType: 'limit' | 'market';
  postOnly: boolean;
  /** Limit price to send (equals `entryPrice` for market orders, informational). */
  limitPrice: number;
  /** True when a venue post-only rejection must be terminal (no passive re-quote loop). */
  noChase: boolean;
}

export interface ExecutionPolicySource {
  execution: { order_type: string; price_offset_ticks: number };
  cfm?: CfmConfig;
}

/**
 * Resolve the entry order shape for `symbol`.
 *
 * @param symbol Product id.
 * @param guardrails Parsed guardrails (`execution` + optional `cfm`).
 * @param entryPrice Signal entry price.
 * @param direction Signal direction.
 */
export function resolveEntryExecution(
  symbol: string,
  guardrails: ExecutionPolicySource,
  entryPrice: number,
  direction: 'buy' | 'sell',
): EntryExecution {
  if (isCfmSymbol(symbol)) {
    const cfm = resolveCfmConfig(guardrails);
    return {
      policy: 'cfm_post_only',
      orderType: 'limit',
      postOnly: cfm.execution.order_type === 'post_only',
      limitPrice: entryPrice,
      noChase: cfm.execution.no_chase,
    };
  }

  const setting = guardrails.execution.order_type;
  if (setting === 'market') {
    return { policy: 'market', orderType: 'market', postOnly: false, limitPrice: entryPrice, noChase: false };
  }
  if (setting === 'marketable_limit') {
    const priceDelta = entryPrice * (guardrails.execution.price_offset_ticks / 10_000);
    let limitPrice = direction === 'buy' ? entryPrice + priceDelta : entryPrice - priceDelta;
    if (limitPrice <= 0) limitPrice = entryPrice;
    return { policy: 'marketable_limit', orderType: 'limit', postOnly: false, limitPrice, noChase: false };
  }
  if (setting === 'post_only') {
    return { policy: 'post_only', orderType: 'limit', postOnly: true, limitPrice: entryPrice, noChase: false };
  }
  return { policy: 'limit', orderType: 'limit', postOnly: false, limitPrice: entryPrice, noChase: false };
}
