/**
 * FeeModel — single source of truth for exchange fee assumptions.
 *
 * All fee constants used by backtest, paper, and live execution flow
 * through this module so the three layers stay directly comparable.
 * Values are loaded from `guardrails.yaml -> fees:`; there is no
 * fallback constant in any call site (by design).
 *
 * Live mode layers the account's REAL fee tier on top via
 * `withRuntimeOverride()` (immutable: returns a new model), so the yaml
 * numbers are only ever an assumption for paper/backtest.
 *
 * Units: basis points (bps) at the storage layer (1 bps = 0.01%).
 *        Decimal rate helper exposed for callers that need a ratio.
 */

import type { FeesConfig, GuardrailConfig } from '../config/loadGuardrails';

export type Exchange = 'coinbase' | 'hyperliquid';
export type Market = 'spot' | 'perps';
export type Side = 'maker' | 'taker';

/** Internal: how the YAML stores each (exchange, market) bucket. */
interface FeeBucket {
  maker_bps: number;
  taker_bps: number;
}

/**
 * Runtime override for one (venue, product) bucket — used in live mode to
 * replace the yaml assumption with the fee tier Coinbase actually reports
 * (`/transaction_summary`). `product` uses the market vocabulary (`spot` |
 * `perps`) so it composes with `getFeeBps()` / `marketForSymbol()`.
 */
export interface FeeRuntimeOverride {
  venue: Exchange;
  product: Market;
  makerBps: number;
  takerBps: number;
  /** Optional provenance for logs (e.g. Coinbase `pricing_tier`). */
  source?: string;
}

export class FeeModel {
  private readonly fees: FeesConfig;
  private readonly overrides: readonly FeeRuntimeOverride[];

  constructor(fees: FeesConfig, overrides: readonly FeeRuntimeOverride[] = []) {
    this.fees = fees;
    this.overrides = overrides;
  }

  /**
   * Convenience factory — pulls the validated `fees` block off a
   * fully-loaded GuardrailConfig. Keeps wiring sites short.
   */
  static fromGuardrails(guardrails: GuardrailConfig): FeeModel {
    return new FeeModel(guardrails.fees);
  }

  /**
   * Return a NEW FeeModel whose (venue, product) bucket carries the given
   * runtime rates. The receiver is never mutated — callers swap the instance
   * they hold, so every consumer sees one consistent model at a time.
   *
   * Rates must be finite; maker may be negative (rebate), taker may not.
   *
   * Example (Coinbase Intro 1 tier, 60/120 bps):
   *   base.withRuntimeOverride({ venue: 'coinbase', product: 'spot', makerBps: 60, takerBps: 120 })
   */
  withRuntimeOverride(override: FeeRuntimeOverride): FeeModel {
    if (!Number.isFinite(override.makerBps) || !Number.isFinite(override.takerBps) || override.takerBps < 0) {
      throw new Error(
        `FeeModel.withRuntimeOverride: invalid rates for ${override.venue}/${override.product} ` +
          `(maker=${override.makerBps} taker=${override.takerBps} bps)`,
      );
    }
    // Unknown (venue, product) combinations throw here, before anything is cloned.
    this.resolveBucket(override.venue, override.product);
    const bucketOverride: FeeBucket = { maker_bps: override.makerBps, taker_bps: override.takerBps };
    const fees = structuredClone(this.fees) as FeesConfig;
    switch (override.venue) {
      case 'coinbase':
        if (override.product === 'spot') fees.coinbase.spot = bucketOverride;
        else fees.coinbase.perps_intx = bucketOverride;
        break;
      case 'hyperliquid':
        fees.hyperliquid.perps = bucketOverride;
        break;
    }
    const next = this.overrides.filter((o) => !(o.venue === override.venue && o.product === override.product));
    return new FeeModel(fees, [...next, { ...override }]);
  }

  /** Runtime overrides applied to this model (empty for a pure-yaml model). */
  getRuntimeOverrides(): readonly FeeRuntimeOverride[] {
    return this.overrides;
  }

  /** True when the (venue, product) bucket comes from a runtime override rather than yaml. */
  hasRuntimeOverride(venue: Exchange | string, product: Market): boolean {
    return this.overrides.some((o) => o.venue === venue && o.product === product);
  }

  /**
   * Return the configured fee in basis points for the given
   * exchange / market / side. Throws on unknown combinations so
   * callers fail loudly rather than silently using stale defaults.
   *
   * Example:
   *   feeModel.getFeeBps('coinbase', 'spot', 'taker') === 40
   *   feeModel.getFeeBps('hyperliquid', 'perps', 'maker') === -1.5
   */
  getFeeBps(exchange: Exchange | string, market: Market, side: Side): number {
    const bucket = this.resolveBucket(exchange, market);
    return side === 'maker' ? bucket.maker_bps : bucket.taker_bps;
  }

  /**
   * Same as `getFeeBps`, but returned as a decimal rate (bps / 10_000).
   * Use this at call sites that need a ratio (e.g. `notional * rate`)
   * instead of a percentage in bps.
   *
   * Example:
   *   feeModel.getFeeRate('coinbase', 'spot', 'taker') === 0.004
   */
  getFeeRate(exchange: Exchange | string, market: Market, side: Side): number {
    return this.getFeeBps(exchange, market, side) / 10_000;
  }

  /**
   * Resolve the `(exchange, market)` bucket. Defined as a single switch so
   * the YAML schema and the routing logic stay obviously coupled.
   */
  private resolveBucket(exchange: Exchange | string, market: Market): FeeBucket {
    switch (exchange) {
      case 'coinbase':
        if (market === 'spot') return this.fees.coinbase.spot;
        if (market === 'perps') return this.fees.coinbase.perps_intx;
        break;
      case 'hyperliquid':
        if (market === 'perps') return this.fees.hyperliquid.perps;
        // Hyperliquid is perps-only; spot is intentionally unsupported.
        break;
      default:
        break;
    }
    throw new Error(
      `FeeModel: no fee configuration for exchange='${exchange}' market='${market}'. ` +
        `Add it under guardrails.yaml -> fees: before using this combination.`,
    );
  }
}
