/**
 * A3 — Fee-adjusted pre-trade EV gate (#A3, 2026-05-18).
 *
 * Computes the expected USD value of a candidate signal given empirical
 * win rate, signal-supplied stop/TP geometry, the configured fee model,
 * and current size. Rejects when EV falls below the configured threshold.
 *
 * EV formula (per A1 doc §5.4 and the prompt spec):
 *
 *   EV = p * (TP_R * size) - (1 - p) * (SL_R * size) - 2 * fee_rate * notional
 *
 *   where
 *     p         = MetaFilter empirical win rate for the signal's strategy
 *     TP_R      = |takeProfit - entryPrice|       (per-unit gross-win distance)
 *     SL_R      = |entryPrice - stopPrice|        (per-unit gross-loss distance)
 *     size      = computed base-unit position size
 *     notional  = size * entryPrice                (USD)
 *     fee_rate  = FeeModel.getFeeRate(venue, marketForSymbol(symbol), 'taker')
 *     round-trip fee = 2 * fee_rate * notional     (entry + exit, both taker)
 *
 * Design constraints:
 *   - Pure function so it can be unit-tested without RiskEngine's heavy
 *     constructor (Supabase client, PositionTracker, etc.). RiskEngine
 *     wraps this in `evaluateSignalEv()` and forwards.
 *   - Default-ALLOW on missing/invalid data (no win-rate yet, broken
 *     geometry, no FeeModel configured). The gate must never block
 *     trading during cold-start; we log loudly and let the existing
 *     pipeline take over.
 *   - Threshold is a plain USD number from `guardrails.yaml -> risk.min_ev_threshold`.
 *     0 (default) rejects strictly negative EV; positive values require a
 *     minimum edge per trade.
 *
 * See:
 *   - docs/research/2026-05-18_a1-hl-fee-aware-param-retune.md §5.4 (A3 scope)
 *   - docs/research/2026-05-18_f4-hl-backtest-validation.md §4.1 (A3 motivation)
 */

import type { Logger } from '../../core/logger';
import { FeeModel, type Exchange } from '../../core/fee-model';
import { marketForSymbol } from '../../core/symbol-utils';

export interface EvGateInputs {
  /** Product symbol, used both for logging and for FeeModel routing via marketForSymbol(). */
  symbol: string;
  /** Strategy id (e.g. 'momentum', 'trend_follow') — used for logging + counter labels. */
  strategy: string;
  /** Direction — informational only; EV math is symmetric across long/short. */
  direction: 'buy' | 'sell';
  /** Entry fill estimate (the price the signal expects to enter at). */
  entryPrice: number;
  /** Stop-loss price level (absolute). */
  stopPrice: number;
  /** Take-profit price level (absolute). */
  takeProfit: number;
  /** Computed position size in base units (post-sizing, pre-clamp). */
  size: number;
  /**
   * Empirical win rate from `MetaFilter.getStrategyPerformance(strategy)?.winRate`.
   * Pass `null`/`undefined` when no perf data is available yet — the gate
   * default-ALLOWS in that case (cold-start safe).
   */
  winRate: number | null | undefined;
  /**
   * Optional flat fee-rate (decimal) override for sensitivity analysis
   * (mirrors backtest `--commission` semantics). When set, used instead
   * of `feeModel`-driven per-symbol resolution.
   */
  feeRateOverride?: number;
  /** FeeModel for per-symbol rate resolution. Either this or feeRateOverride must be set. */
  feeModel?: FeeModel;
  /** Min EV in USD; signals with EV < threshold are rejected. */
  minEvThreshold: number;
  /** Exchange venue for FeeModel lookups. Defaults to 'coinbase'. */
  venue?: Exchange;
}

/**
 * Beta-prior parameters for the win-rate estimator (TASK_011 step 2):
 * `p0 = 0.40` with pseudo-count `n0 = 30` is Beta(12, 18). With no
 * history the estimate is exactly 0.40; each observed outcome moves it by
 * ~1/31 so a handful of early wins cannot talk the gate into allowing a
 * fee-negative setup.
 */
export interface WinRatePrior {
  /** Prior mean win rate. */
  p0: number;
  /** Prior pseudo-count (strength of the prior in trades). */
  n0: number;
}

export const DEFAULT_WIN_RATE_PRIOR: WinRatePrior = { p0: 0.40, n0: 30 };

/**
 * Posterior-mean win rate under a Beta prior:
 *
 *   p̂ = (wins + p0 · n0) / (wins + losses + n0)
 *
 * Breakeven trades are excluded from both counts. Pass `null` when no
 * performance record exists yet — the estimate collapses to `p0`, so the
 * caller never has to default-allow on cold start. Pure; shared by the
 * backtest engine and (per TASK_011) the live router so the two use one
 * p estimator.
 */
export function estimateWinRateWithPrior(
  perf: { wins: number; losses: number } | null | undefined,
  prior: WinRatePrior = DEFAULT_WIN_RATE_PRIOR,
): number {
  const wins = Math.max(0, Number(perf?.wins) || 0);
  const losses = Math.max(0, Number(perf?.losses) || 0);
  const n0 = Math.max(0, prior.n0);
  const p0 = Math.min(1, Math.max(0, prior.p0));
  const denominator = wins + losses + n0;
  if (denominator <= 0) return p0;
  return (wins + p0 * n0) / denominator;
}

export interface EvGateResult {
  allowed: boolean;
  /** Human-readable reason; populated on reject AND on default-allow paths. */
  reason?: string;
  /** Expected USD value of the trade (negative = bad). */
  ev: number;
  /** Configured min EV threshold ($USD). */
  threshold: number;
  /** Win rate actually used in the math (0 on default-allow paths). */
  p: number;
  /** Round-trip taker fee in USD (entry + exit). */
  feeUsd: number;
}

/**
 * Pure-math EV gate. See module-level doc for formula + design constraints.
 *
 * Returns `{ allowed: true, reason: '<default_allow_path>' }` when inputs
 * are insufficient to compute EV — callers should propagate the reason
 * into structured logs so we can audit how often we're cold-start-allowing.
 */
export function evaluateEvGate(
  inputs: EvGateInputs,
  logger?: Logger,
): EvGateResult {
  const {
    symbol,
    strategy,
    entryPrice,
    stopPrice,
    takeProfit,
    size,
    minEvThreshold,
  } = inputs;

  // Sanity on price/size — broken numerics are not the gate's job to
  // catch (risk-engine.checkOrder + sizing already guard). Default-allow.
  if (
    !Number.isFinite(entryPrice) || entryPrice <= 0 ||
    !Number.isFinite(size) || size <= 0
  ) {
    logger?.warn('EV gate: invalid entry/size — default-allow', {
      symbol, strategy, entryPrice, size,
    });
    return {
      allowed: true,
      reason: 'invalid_inputs_default_allow',
      ev: 0,
      threshold: minEvThreshold,
      p: 0,
      feeUsd: 0,
    };
  }

  // Need both TP and stop geometry to compute EV. Without them, default-allow.
  const tpDistance = Number.isFinite(takeProfit) && takeProfit > 0
    ? Math.abs(takeProfit - entryPrice)
    : 0;
  const slDistance = Number.isFinite(stopPrice) && stopPrice > 0
    ? Math.abs(entryPrice - stopPrice)
    : 0;
  if (tpDistance <= 0 || slDistance <= 0) {
    logger?.warn('EV gate: missing TP/SL geometry — default-allow', {
      symbol, strategy, takeProfit, stopPrice, tpDistance, slDistance,
    });
    return {
      allowed: true,
      reason: 'missing_geometry_default_allow',
      ev: 0,
      threshold: minEvThreshold,
      p: 0,
      feeUsd: 0,
    };
  }

  // Resolve fee rate: explicit override > FeeModel lookup > default-allow.
  let feeRate: number;
  if (typeof inputs.feeRateOverride === 'number' && Number.isFinite(inputs.feeRateOverride)) {
    feeRate = inputs.feeRateOverride;
  } else if (inputs.feeModel) {
    feeRate = inputs.feeModel.getFeeRate(
      inputs.venue ?? 'coinbase',
      marketForSymbol(symbol),
      'taker',
    );
  } else {
    logger?.warn('EV gate: no FeeModel + no override — default-allow', { symbol, strategy });
    return {
      allowed: true,
      reason: 'no_fee_model_default_allow',
      ev: 0,
      threshold: minEvThreshold,
      p: 0,
      feeUsd: 0,
    };
  }

  const notional = size * entryPrice;
  const feeUsd = 2 * feeRate * notional;

  // Default-ALLOW when MetaFilter has no perf data yet for this strategy.
  // Cold-start must not block trading; we need outcomes to bootstrap p.
  const pRaw = inputs.winRate;
  if (pRaw === null || pRaw === undefined || !Number.isFinite(pRaw)) {
    logger?.warn('EV gate: no MetaFilter win-rate — default-allow', { symbol, strategy });
    return {
      allowed: true,
      reason: 'missing_win_rate_default_allow',
      ev: 0,
      threshold: minEvThreshold,
      p: 0,
      feeUsd,
    };
  }
  const p = Math.max(0, Math.min(1, pRaw));

  // EV in USD: expected gross win - expected gross loss - round-trip fees.
  const ev = p * (tpDistance * size) - (1 - p) * (slDistance * size) - feeUsd;

  if (ev < minEvThreshold) {
    return {
      allowed: false,
      reason:
        `EV $${ev.toFixed(2)} < threshold $${minEvThreshold.toFixed(2)} ` +
        `(p=${p.toFixed(3)}, tpDist=$${tpDistance.toFixed(2)}, ` +
        `slDist=$${slDistance.toFixed(2)}, feeRT=$${feeUsd.toFixed(2)})`,
      ev,
      threshold: minEvThreshold,
      p,
      feeUsd,
    };
  }

  return { allowed: true, ev, threshold: minEvThreshold, p, feeUsd };
}
