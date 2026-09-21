/**
 * Pre-trade gate hook — lets venue-specific guards (e.g. `trading/cfm/cfm-guard.ts`)
 * veto an order inside `RiskEngine.checkOrder()` without the RiskEngine
 * learning anything about a venue.
 *
 * A gate receives the engine's exposure simulation for the order and returns:
 *   - `null`                     — "not my symbol / no opinion", next gate runs;
 *   - `{ allowed: true }`        — pass;
 *   - `{ allowed: false, code, reason }` — veto; the RiskEngine fails the check
 *                                   with `"<code>: <reason>"` and stops evaluating.
 *
 * Gates run after the kill-switch / account-truth checks and BEFORE the sizing
 * limits, for every order (reduce-only included — gates decide themselves
 * whether exits pass; the CFM guard always lets reduce-only through).
 */

export interface PreTradeGateContext {
  symbol: string;
  side: 'buy' | 'sell';
  /** True when the order only reduces existing inventory (exits are never blocked by limits). */
  isReduceOnly: boolean;
  /** Absolute position notional (USD) AFTER the order. */
  newAbsNotional: number;
  /** Absolute position notional (USD) BEFORE the order. */
  currentAbsNotional: number;
  /** Order notional (USD). */
  orderValueUsd: number;
  /** Equity the engine sizes against right now (USD). */
  equityUsd: number;
}

export interface PreTradeGateDecision {
  allowed: boolean;
  /** Machine-readable veto code (e.g. `CFM_LEVERAGE_CAP`, `CDE_HOURS_GAP`). */
  code?: string;
  /** Operator-readable veto reason. */
  reason?: string;
}

export type PreTradeGate = (ctx: PreTradeGateContext) => PreTradeGateDecision | null;
