/**
 * FeeModel — single source of truth for exchange fee assumptions.
 *
 * All fee constants used by backtest, paper, and live execution flow
 * through this module so the three layers stay directly comparable.
 * Values are loaded from `guardrails.yaml -> fees:`; there is no
 * fallback constant in any call site (by design).
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

export class FeeModel {
  private readonly fees: FeesConfig;

  constructor(fees: FeesConfig) {
    this.fees = fees;
  }

  /**
   * Convenience factory — pulls the validated `fees` block off a
   * fully-loaded GuardrailConfig. Keeps wiring sites short.
   */
  static fromGuardrails(guardrails: GuardrailConfig): FeeModel {
    return new FeeModel(guardrails.fees);
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
