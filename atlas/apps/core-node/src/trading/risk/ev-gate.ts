/**
 * A3 — Fee-adjusted pre-trade EV gate (#A3, 2026-05-18; live hardening TASK_011, 2026-09-10).
 *
 * Computes the expected USD value of a candidate signal given a win-rate estimate,
 * signal-supplied stop/TP geometry (or realized payoff), the configured fee model,
 * and current size. Rejects when EV falls below the configured threshold.
 *
 * EV formula:
 *
 *   EV = p * W - (1 - p) * L - fees
 *
 *   where
 *     L         = SL_R * size                       expected gross loss (USD)
 *                 SL_R = |entryPrice - stopPrice|   per-unit gross-loss distance
 *     W         = payoffRatio * L                   expected gross win (USD), where
 *                 payoffRatio = realized avg win / avg loss when available (live), else
 *                               haircut * TP_R / SL_R  (TP_R = |takeProfit - entryPrice|)
 *     fees      = (entryFeeRate + exitFeeRate) * notional
 *                 exit leg is always taker (stops/TPs cross the spread); entry leg is
 *                 maker only when the entry is post-only
 *     p         = win-rate estimate (see below)
 *     notional  = size * entryPrice (USD)
 *
 * Legacy (paper / backtest) semantics are preserved bit-for-bit for the default inputs:
 * taker both sides (2 * fee * notional), W = TP_R * size (haircut 1), and a missing win
 * rate default-ALLOWS with a structured warn (cold-start safe).
 *
 * Live semantics (TASK_011) are opt-in through the extra inputs RiskEngine supplies in
 * live mode:
 *   - `winRatePrior` — Beta prior (p0 = 0.40, n0 = 30 ⇔ Beta(12, 18)). A missing or
 *     zero-sample win rate uses p0 and is NEVER allowed by default; an observed win rate
 *     is shrunk toward the prior: p = (p0*n0 + winRate*n) / (n0 + n).
 *   - `realizedPayoffRatio` — avg win / avg loss from recent closed trades; when absent
 *     the TP geometry is used with `geometryHaircut` (0.6 in live: not every winner
 *     reaches TP).
 *   - `entryLiquidity` — 'maker' when the entry is post-only, else 'taker'.
 *   - `mode` — 'enforce' rejects; 'shadow' converts every would-be reject into an allow
 *     and logs `EV_GATE_SHADOW_ALLOW` so the decision stays auditable.
 *
 * Threshold is a plain USD number from `guardrails.yaml -> risk.min_ev_threshold`.
 * 0 (default) rejects strictly negative EV; positive values require a minimum edge.
 *
 * See:
 *   - docs/research/2026-05-18_a1-hl-fee-aware-param-retune.md §5.4 (A3 scope)
 *   - docs/research/2026-05-18_f4-hl-backtest-validation.md §4.1 (A3 motivation)
 *   - docs/plans/SPRINT-9-LIVE-COINBASE.md §3 (shadow mode / Door B)
 */

import type { Logger } from '../../core/logger';
import { FeeModel, type Exchange } from '../../core/fee-model';
import { marketForSymbol } from '../../core/symbol-utils';

/** Logged for every would-be reject that shadow mode lets through. */
export const EV_GATE_SHADOW_ALLOW = 'EV_GATE_SHADOW_ALLOW';

/** Live win-rate prior: Beta(12, 18) ⇔ p0 = 0.40 with pseudo-count n0 = 30. */
export const LIVE_WIN_RATE_PRIOR: Readonly<EvWinRatePrior> = Object.freeze({ p0: 0.4, n0: 30 });

/** Live haircut on TP geometry when no realized payoff exists (not every winner reaches TP). */
export const LIVE_GEOMETRY_HAIRCUT = 0.6;

export type EvGateMode = 'enforce' | 'shadow';

/**
 * Win-rate prior consumed by `evaluateEvGate` in live mode. Same shape as
 * `WinRatePrior` (the backtest engine's `estimateWinRateWithPrior` input) so the
 * live router and the backtester share one prior definition.
 */
export type EvWinRatePrior = WinRatePrior;

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
   * Pass `null`/`undefined` when no perf data is available yet — without a
   * `winRatePrior` the gate default-ALLOWS (legacy, cold-start safe); with a prior it
   * uses `p0`.
   */
  winRate: number | null | undefined;
  /**
   * Optional flat fee-rate (decimal) override for sensitivity analysis
   * (mirrors backtest `--commission` semantics). When set, used for both
   * legs instead of `feeModel`-driven per-symbol resolution.
   */
  feeRateOverride?: number;
  /** FeeModel for per-symbol rate resolution. Either this or feeRateOverride must be set. */
  feeModel?: FeeModel;
  /** Min EV in USD; signals with EV < threshold are rejected. */
  minEvThreshold: number;
  /** Exchange venue for FeeModel lookups. Defaults to 'coinbase'. */
  venue?: Exchange;
  /** Liquidity of the entry leg. 'maker' only for post-only entries. Default 'taker'. */
  entryLiquidity?: 'maker' | 'taker';
  /** Live: Beta prior for the win rate (see module doc). Absent = legacy default-allow. */
  winRatePrior?: EvWinRatePrior;
  /** Closed trades behind `winRate` (n). Unknown ⇒ treated as 0 when a prior is set. */
  sampleSize?: number | null;
  /** Live: realized avg win / avg loss from recent closed trades. Absent ⇒ TP geometry. */
  realizedPayoffRatio?: number | null;
  /** Haircut on the TP-geometry payoff when no realized payoff exists. Default 1 (legacy). */
  geometryHaircut?: number;
  /** 'enforce' (default) rejects; 'shadow' allows + logs EV_GATE_SHADOW_ALLOW. */
  mode?: EvGateMode;
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
  /** Human-readable reason; populated on reject AND on default-allow / shadow paths. */
  reason?: string;
  /** Expected USD value of the trade (negative = bad). */
  ev: number;
  /** Configured min EV threshold ($USD). */
  threshold: number;
  /** Win rate actually used in the math (0 on default-allow paths). */
  p: number;
  /** Round-trip fee in USD (entry + exit legs). */
  feeUsd: number;
  /** Decimal fee rates charged per leg (absent on early default-allow paths). */
  entryFeeRate?: number;
  exitFeeRate?: number;
  /** Expected gross win / loss in USD used in the math. */
  expectedWinUsd?: number;
  expectedLossUsd?: number;
  /** How `p` was derived. */
  pSource?: 'observed' | 'prior' | 'shrunk';
  /** How the payoff was derived. */
  payoffSource?: 'realized' | 'geometry' | 'geometry_haircut';
  /** True when shadow mode converted a reject into an allow. */
  shadowed?: boolean;
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
  const mode: EvGateMode = inputs.mode ?? 'enforce';

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

  // Resolve fee rates per leg: explicit override > FeeModel lookup > default-allow.
  // Exit is always taker; entry is maker only for post-only entries.
  let entryFeeRate: number;
  let exitFeeRate: number;
  if (typeof inputs.feeRateOverride === 'number' && Number.isFinite(inputs.feeRateOverride)) {
    entryFeeRate = inputs.feeRateOverride;
    exitFeeRate = inputs.feeRateOverride;
  } else if (inputs.feeModel) {
    const venue = inputs.venue ?? 'coinbase';
    const market = marketForSymbol(symbol);
    exitFeeRate = inputs.feeModel.getFeeRate(venue, market, 'taker');
    entryFeeRate = inputs.entryLiquidity === 'maker'
      ? inputs.feeModel.getFeeRate(venue, market, 'maker')
      : exitFeeRate;
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
  const feeUsd = (entryFeeRate + exitFeeRate) * notional;

  // Win-rate estimate.
  const prior = inputs.winRatePrior;
  const pRaw = inputs.winRate;
  const sampleSize = typeof inputs.sampleSize === 'number' && Number.isFinite(inputs.sampleSize) && inputs.sampleSize > 0
    ? inputs.sampleSize
    : 0;
  const hasObservedWinRate = pRaw !== null && pRaw !== undefined && Number.isFinite(pRaw);

  let p: number;
  let pSource: EvGateResult['pSource'];
  if (prior) {
    if (!Number.isFinite(prior.p0) || prior.p0 < 0 || prior.p0 > 1 || !Number.isFinite(prior.n0) || prior.n0 < 0) {
      throw new Error(`EV gate: invalid winRatePrior (p0=${prior.p0}, n0=${prior.n0})`);
    }
    if (!hasObservedWinRate || sampleSize === 0) {
      // Never allow-by-default in live: fall back to the prior mean.
      p = prior.p0;
      pSource = 'prior';
    } else {
      const observed = Math.max(0, Math.min(1, pRaw as number));
      p = (prior.p0 * prior.n0 + observed * sampleSize) / (prior.n0 + sampleSize);
      pSource = 'shrunk';
    }
  } else {
    // Legacy default-ALLOW when MetaFilter has no perf data yet for this strategy.
    // Cold-start must not block paper trading; we need outcomes to bootstrap p.
    if (!hasObservedWinRate) {
      logger?.warn('EV gate: no MetaFilter win-rate — default-allow', { symbol, strategy });
      return {
        allowed: true,
        reason: 'missing_win_rate_default_allow',
        ev: 0,
        threshold: minEvThreshold,
        p: 0,
        feeUsd,
        entryFeeRate,
        exitFeeRate,
      };
    }
    p = Math.max(0, Math.min(1, pRaw as number));
    pSource = 'observed';
  }

  // Payoff: realized avg win / avg loss when available, else TP geometry (with haircut).
  const expectedLossUsd = slDistance * size;
  let expectedWinUsd: number;
  let payoffSource: EvGateResult['payoffSource'];
  const realized = inputs.realizedPayoffRatio;
  if (typeof realized === 'number' && Number.isFinite(realized) && realized > 0) {
    expectedWinUsd = realized * expectedLossUsd;
    payoffSource = 'realized';
  } else {
    const haircut = typeof inputs.geometryHaircut === 'number' && Number.isFinite(inputs.geometryHaircut)
      ? Math.max(0, Math.min(1, inputs.geometryHaircut))
      : 1;
    expectedWinUsd = haircut * tpDistance * size;
    payoffSource = haircut < 1 ? 'geometry_haircut' : 'geometry';
  }

  // EV in USD: expected gross win - expected gross loss - round-trip fees.
  const ev = p * expectedWinUsd - (1 - p) * expectedLossUsd - feeUsd;

  const detail: Omit<EvGateResult, 'allowed' | 'reason'> = {
    ev,
    threshold: minEvThreshold,
    p,
    feeUsd,
    entryFeeRate,
    exitFeeRate,
    expectedWinUsd,
    expectedLossUsd,
    pSource,
    payoffSource,
  };

  if (ev < minEvThreshold) {
    const reason =
      `EV $${ev.toFixed(2)} < threshold $${minEvThreshold.toFixed(2)} ` +
      `(p=${p.toFixed(3)}[${pSource}], tpDist=$${tpDistance.toFixed(2)}, ` +
      `slDist=$${slDistance.toFixed(2)}, feeRT=$${feeUsd.toFixed(2)}, ` +
      `W=$${expectedWinUsd.toFixed(2)}[${payoffSource}])`;
    if (mode === 'shadow') {
      logger?.warn(`${EV_GATE_SHADOW_ALLOW}: EV gate would reject — shadow mode allows`, {
        symbol,
        strategy,
        reason,
        ev,
        threshold: minEvThreshold,
        p,
        pSource,
        feeUsd,
        expectedWinUsd,
        expectedLossUsd,
        payoffSource,
        notionalUsd: notional,
      });
      return { allowed: true, reason: `${EV_GATE_SHADOW_ALLOW}: ${reason}`, shadowed: true, ...detail };
    }
    return { allowed: false, reason, ...detail };
  }

  return { allowed: true, ...detail };
}

/**
 * Realized payoff ratio (avg win / avg loss) from a window of closed-trade PnLs.
 * Returns null unless there are at least `minTrades` trades with both a win and a
 * loss, so thin or one-sided history falls back to TP geometry instead of a
 * spurious ratio.
 */
export function computeRealizedPayoffRatio(
  closedTradePnls: readonly number[],
  minTrades = 10,
): number | null {
  const finite = closedTradePnls.filter((pnl) => Number.isFinite(pnl));
  if (finite.length < minTrades) return null;
  const wins = finite.filter((pnl) => pnl > 0);
  const losses = finite.filter((pnl) => pnl < 0);
  if (wins.length === 0 || losses.length === 0) return null;
  const avgWin = wins.reduce((sum, pnl) => sum + pnl, 0) / wins.length;
  const avgLoss = Math.abs(losses.reduce((sum, pnl) => sum + pnl, 0) / losses.length);
  if (!(avgLoss > 0) || !Number.isFinite(avgWin / avgLoss)) return null;
  return avgWin / avgLoss;
}
