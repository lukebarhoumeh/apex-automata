/**
 * Shared CLI → BacktestConfig assembly.
 *
 * `pnpm backtest` (cli/backtest.ts) and the E4 harness (cli/backtest-e4.ts)
 * must build the engine config through the SAME code so fee tiers, EV-gate
 * wiring, per-symbol overrides and realism knobs cannot drift between a
 * plain run and a harness run. Everything here reads from the validated
 * guardrails.yaml (single source of truth) — no strategy constants live in
 * this file beyond the historical `pnpm backtest` defaults it inherited.
 */

import type { GuardrailConfig } from '../config/loadGuardrails';
import { buildPerSymbolDisabledStrategies } from '../strategies/per-symbol-disable';
import { buildRegimeGateConfig } from '../strategies/regime-gate';
import { FeeModel } from '../core/fee-model';
import type { MarketVenue } from '../trading/execution/venue-capabilities';
import type { BacktestConfig, EvGateMode, PerSymbolStrategyOverrides } from './backtest-engine';
import type { FeeTierLabel } from './backtest-runner';

/**
 * Coinbase Advanced Trade spot fee tiers (maker/taker bps), TASK_017 step 7.
 *   intro1 — Intro 1 (< $1K 30d volume): 60 / 120
 *   t1k    — $1K–$10K:                   35 / 75
 *   t10k   — $10K–$50K:                  25 / 40  (guardrails.yaml default)
 * `custom:<maker>,<taker>` sets arbitrary bps.
 */
export const FEE_TIERS: Record<string, { makerBps: number; takerBps: number }> = {
  intro1: { makerBps: 60, takerBps: 120 },
  t1k: { makerBps: 35, takerBps: 75 },
  t10k: { makerBps: 25, takerBps: 40 },
};

/** Strategy selector accepted by `--strategy`. */
export type StrategySelector = 'breakout' | 'vwap' | 'momentum' | 'trend_follow' | 'all';

/**
 * Resolve a `--fee-tier` flag to a labelled maker/taker pair. Without a flag
 * the guardrails.yaml spot bucket is used and labelled by matching the
 * known table so reports still name the tier.
 */
export function resolveFeeTier(
  flag: string | undefined,
  guardrailsSpot: { maker_bps: number; taker_bps: number },
): FeeTierLabel {
  if (!flag) {
    const match = Object.entries(FEE_TIERS).find(
      ([, t]) => t.makerBps === guardrailsSpot.maker_bps && t.takerBps === guardrailsSpot.taker_bps,
    );
    return {
      name: `${match ? match[0] : 'custom'} (guardrails.yaml default)`,
      makerBps: guardrailsSpot.maker_bps,
      takerBps: guardrailsSpot.taker_bps,
    };
  }
  if (flag.startsWith('custom:')) {
    const [maker, taker] = flag.slice('custom:'.length).split(',').map((v) => Number(v));
    if (!Number.isFinite(maker) || !Number.isFinite(taker) || maker < 0 || taker < 0) {
      throw new Error(`--fee-tier custom:<maker>,<taker> expects two non-negative bps numbers, got "${flag}"`);
    }
    return { name: flag, makerBps: maker, takerBps: taker };
  }
  const tier = FEE_TIERS[flag];
  if (!tier) {
    throw new Error(`Unknown --fee-tier "${flag}". Use intro1|t1k|t10k|custom:<maker>,<taker>`);
  }
  return { name: flag, ...tier };
}

/**
 * FeeModel for a run: the tier rewrites ONLY the coinbase.spot bucket;
 * perps buckets stay exactly as configured in guardrails.yaml.
 */
export function buildFeeModel(guardrails: GuardrailConfig, feeTier: FeeTierLabel): FeeModel {
  return new FeeModel({
    ...guardrails.fees,
    coinbase: {
      ...guardrails.fees.coinbase,
      spot: { maker_bps: feeTier.makerBps, taker_bps: feeTier.takerBps },
    },
  });
}

/**
 * Per-symbol strategy overrides exactly as the live API server loads them
 * (`per_symbol` then `perps_symbols`, later blocks win). See F4 follow-up
 * docs/research/2026-05-19_f4-followup-perps-action.md §3.
 */
export function collectPerSymbolOverrides(guardrails: GuardrailConfig): PerSymbolStrategyOverrides {
  const perSymbolOverrides: PerSymbolStrategyOverrides = {};
  for (const [symbol, cfg] of Object.entries(guardrails.per_symbol ?? {})) {
    if (cfg.strategy_overrides) {
      perSymbolOverrides[symbol] = cfg.strategy_overrides as Record<string, Record<string, unknown>>;
    }
  }
  for (const [symbol, cfg] of Object.entries(guardrails.perps_symbols ?? {})) {
    if (cfg.strategy_overrides) {
      perSymbolOverrides[symbol] = cfg.strategy_overrides as Record<string, Record<string, unknown>>;
    }
  }
  return perSymbolOverrides;
}

export interface BacktestConfigInput {
  startDate: Date;
  endDate: Date;
  initialCapital: number;
  products: string[];
  strategy: StrategySelector | string;
  /** Per-symbol routing via FeeModel unless `commissionOverride` is set. */
  feeModel: FeeModel;
  /** Flat decimal override — every fill charged this rate (sensitivity / zero-fee pass). */
  commissionOverride?: number;
  venueOverride?: MarketVenue;
  evGateMode: EvGateMode;
  /** RegimeFilter (regime/strategy compatibility) toggle — `--regime-gates on|off`. */
  regimeGates: boolean;
  /**
   * A6 (2026-05-29) — force-enable the regime-conditional gates
   * (`guardrails.regime_gates`, `--regime-conditional-gates`) for THIS run
   * regardless of the YAML `enabled` flag. Default false: the YAML decides,
   * and it ships `enabled: false`, so `pnpm backtest` and the E4 harness stay
   * at live/paper parity (the gate is a no-op) unless explicitly forced.
   */
  forceRegimeConditionalGates?: boolean;
  /** `--slippage` as a decimal rate; maps onto realism.entrySlippageBps. */
  slippageRate?: number;
  /**
   * Min hold (in BARS) before an opposite-direction signal may close a
   * position — live `trade_cooldown_min` analog on the bar clock. Default 0
   * (`pnpm backtest` unchanged); the E4 harness passes 1.
   */
  minHoldBars?: number;
  /**
   * Apply the live pre-entry ATR volatility filter (`guardrails.filters`).
   * Default true — backtest/live parity. Set false only for legacy comparison.
   */
  applyAtrVolatilityFilter?: boolean;
}

/**
 * Assemble the engine config from CLI-shaped inputs + guardrails. Mirrors
 * the historical `pnpm backtest` wiring one-for-one (strategy toggles,
 * risk caps, account sizing, kill lists, per-symbol overrides, realism).
 */
export function buildBacktestConfig(input: BacktestConfigInput, guardrails: GuardrailConfig): BacktestConfig {
  const { strategy, initialCapital } = input;
  // A6: same normalised shape the live API server passes to SignalProcessor.
  // Rules always come from guardrails.yaml; only `enabled` may be forced on.
  const regimeConditionalGates = buildRegimeGateConfig(guardrails);
  if (input.forceRegimeConditionalGates) {
    regimeConditionalGates.enabled = true;
  }
  return {
    startDate: input.startDate,
    endDate: input.endDate,
    initialCapital,
    feeModel: input.feeModel,
    venue: 'coinbase',
    ...(input.commissionOverride !== undefined ? { commission: input.commissionOverride } : {}),
    // TASK_017 B2/B3: venue capability + EV gate + regime gate wiring.
    venueOverride: input.venueOverride,
    allowShort: guardrails.strategy.allow_short,
    evGate: {
      mode: input.evGateMode,
      minEvThreshold: guardrails.risk.min_ev_threshold,
    },
    regimeGates: input.regimeGates,
    products: input.products,
    // Strategy parameters mirror atlas/config/guardrails.yaml. trend_follow
    // is wired here too — defect #1: prior backtests silently dropped it.
    signals: {
      breakout: {
        enabled: strategy === 'breakout' || strategy === 'all',
        parameters: {
          period: 20,
          atrPeriod: 14,
          atrMultiplier: 2,
          volumeThreshold: 1.5,
        },
      },
      vwapMeanReversion: {
        enabled: strategy === 'vwap' || strategy === 'all',
        parameters: {
          deviationEntry: 2,
          deviationExit: 0.5,
          minVolume: 1000,
        },
      },
      momentum: {
        enabled: strategy === 'momentum' || strategy === 'all',
        parameters: {
          // strategy-tuning: was 55/40 — restored to canonical 70/30 to
          // match the plugin schema and guardrails.yaml.
          rsiPeriod: 10,
          rsiOverbought: 70,
          rsiOversold: 30,
          macdFast: 8,
          macdSlow: 21,
          macdSignal: 5,
        },
      },
      trendFollow: {
        enabled: strategy === 'trend_follow' || strategy === 'all',
        parameters: {},
      },
    },
    risk: {
      // Hard ceiling on per-position notional. Risk-based sizing is now
      // primary; this is a guardrail, not the sizing function (defect #5).
      maxPositionSize: initialCapital * guardrails.risk.max_position_exposure_pct,
      // Total exposure = equity × max_account_leverage (matches live).
      maxTotalExposure: initialCapital * guardrails.account.max_account_leverage,
      stopLossPercent: 0.02, // fallback only; signals carry ATR-based stops
      takeProfitPercent: 0.04, // fallback only; signals carry ATR-based TPs
    },
    account: {
      equityUsd: initialCapital,
      riskPerTrade: guardrails.account.risk_per_trade,
      maxPositionExposurePct: guardrails.risk.max_position_exposure_pct,
      minNotionalBuffer: guardrails.account.min_notional_buffer,
    },
    // Defect #2: honour the same kill list live uses.
    disabledStrategies: guardrails.disabled_strategies,
    // F4 follow-up §8 (2026-05-19): same shape as the live API server reads.
    perSymbolDisabledStrategies: buildPerSymbolDisabledStrategies(guardrails),
    // A6 (2026-05-29): regime-conditional gates — disabled by default via
    // guardrails.regime_gates.enabled; see `forceRegimeConditionalGates`.
    regimeConditionalGates,
    // Defect #1: forward per-symbol parameter overrides.
    perSymbolOverrides: collectPerSymbolOverrides(guardrails),
    realism: {
      ...(guardrails.backtest
        ? {
            nextBarFill: guardrails.backtest.next_bar_fill,
            entrySlippageBps: guardrails.backtest.entry_slippage_bps,
            stopOvershootBarRangePct: guardrails.backtest.stop_overshoot_bar_range_pct,
            stopOvershootMinBps: guardrails.backtest.stop_overshoot_min_bps,
            sizeDecimals: guardrails.backtest.size_decimals,
          }
        : {}),
      // TASK_017 B5: `--slippage` (decimal) overrides the guardrails bps.
      ...(input.slippageRate !== undefined ? { entrySlippageBps: input.slippageRate * 10_000 } : {}),
    },
    // Live parity (E4 card 2026-09-10): the same pre-entry ATR volatility
    // filter api/server.ts applies (`filters.atr_volatility_min/max`).
    ...(input.applyAtrVolatilityFilter === false
      ? {}
      : {
          filters: {
            atrVolatilityMin: guardrails.filters.atr_volatility_min,
            atrVolatilityMax: guardrails.filters.atr_volatility_max,
          },
        }),
    ...(input.minHoldBars ? { execution: { minHoldBars: input.minHoldBars } } : {}),
  };
}
