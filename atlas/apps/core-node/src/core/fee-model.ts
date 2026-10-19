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
 *
 * Fee books never mix (desk cite rule, 2026-09-21):
 *   - `coinbase.spot`       — paper spot assumption (`PAPER-FeeModel-SPOT-25-40`);
 *                             live spot is layered on via `withRuntimeOverride`
 *                             (`SPOT-INTRO-50-90`).
 *   - `coinbase.perps_intx` — Coinbase International Exchange perps (`*-PERP-INTX`).
 *   - `coinbase.cfm_nano`   — Coinbase Financial Markets / CDE nano futures
 *                             (`*-CDE`), cite `CFM-NANO-H1-v0.2` +
 *                             `CFM-NANO-COSTPLUS-ADV1`. COST-PLUS: a % commission
 *                             PLUS a per-contract exchange floor, STACKED — never
 *                             blended into one bps figure and never averaged with
 *                             the spot book. DRAFT working model, not v1.0.
 */

import type { FeesConfig, GuardrailConfig } from '../config/loadGuardrails';
import { decimalAdd, decimalDiv, decimalMul, decimalRoundToIncrement } from './decimal';

export type Exchange = 'coinbase' | 'hyperliquid';
/**
 * Market bucket. `cfm` = Coinbase Financial Markets / CDE nano futures
 * (`*-CDE` symbols) — a separate fee book from INTX `perps`.
 */
export type Market = 'spot' | 'perps' | 'cfm';
export type Side = 'maker' | 'taker';

/** Internal: how the YAML stores each (exchange, market) bucket. */
interface FeeBucket {
  maker_bps: number;
  taker_bps: number;
  /**
   * Cost-plus exchange floor in USD per contract per side (CFM/CDE only).
   * Absent / 0 for pure-percentage books.
   */
  exchange_fee_per_contract_usd?: number;
}

/**
 * Runtime override for one (venue, product) bucket — used in live mode to
 * replace the yaml assumption with the fee tier Coinbase actually reports
 * (`/transaction_summary`). `product` uses the market vocabulary (`spot` |
 * `perps` | `cfm`) so it composes with `getFeeBps()` / `marketForSymbol()`.
 */
export interface FeeRuntimeOverride {
  venue: Exchange;
  product: Market;
  makerBps: number;
  takerBps: number;
  /** Optional provenance for logs (e.g. Coinbase `pricing_tier`). */
  source?: string;
}

/** Inputs for a cost-plus fill fee computation. */
export interface FillFeeInputs {
  exchange: Exchange | string;
  market: Market;
  side: Side;
  /** Fill notional in USD (size × price, or contracts × contract_size × price). Decimal string or number. */
  notionalUsd: string | number;
  /**
   * Number of contracts the fill represents. Only consulted for buckets that
   * carry an `exchange_fee_per_contract_usd` floor (CFM). Decimal string or number.
   */
  contracts?: string | number;
}

/** Cost-plus fee breakdown — the two components are logged separately (desk rule). */
export interface FillFeeBreakdown {
  /** Percentage commission: notional × rate (decimal string, USD). */
  commissionUsd: string;
  /** Exchange floor: contracts × per-contract fee (decimal string, USD; "0" for non cost-plus books). */
  exchangeFeeUsd: string;
  /** commissionUsd + exchangeFeeUsd (decimal string, USD). */
  totalUsd: string;
  /** Rate actually applied to the notional (decimal, not bps). */
  rate: number;
  /** Per-contract floor actually applied (USD). */
  perContractUsd: number;
}

/** USD precision used when rendering fee breakdowns (1e-8, matches NUMERIC(20,8)). */
const FEE_USD_INCREMENT = '0.00000001';

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
   * A cost-plus bucket (CFM) keeps its per-contract exchange floor: the
   * account fee tier only reports the percentage legs.
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
    const current = this.resolveBucket(override.venue, override.product);
    const bucketOverride: FeeBucket = {
      maker_bps: override.makerBps,
      taker_bps: override.takerBps,
      ...(current.exchange_fee_per_contract_usd !== undefined
        ? { exchange_fee_per_contract_usd: current.exchange_fee_per_contract_usd }
        : {}),
    };
    const fees = structuredClone(this.fees) as FeesConfig;
    switch (override.venue) {
      case 'coinbase':
        if (override.product === 'spot') fees.coinbase.spot = bucketOverride;
        else if (override.product === 'cfm') fees.coinbase.cfm_nano = bucketOverride as NonNullable<FeesConfig['coinbase']['cfm_nano']>;
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
   *   feeModel.getFeeBps('coinbase', 'cfm', 'maker')  === 9.5
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
   * NOTE: for cost-plus books (CFM) this is the PERCENTAGE LEG ONLY — the
   * per-contract exchange floor is a separate component. Use
   * `computeFillFeeUsd()` for the all-in fee of a fill.
   *
   * Example:
   *   feeModel.getFeeRate('coinbase', 'spot', 'taker') === 0.004
   */
  getFeeRate(exchange: Exchange | string, market: Market, side: Side): number {
    return this.getFeeBps(exchange, market, side) / 10_000;
  }

  /**
   * Per-contract exchange floor (USD, per side) for a cost-plus book.
   * Returns 0 for pure-percentage buckets. Throws on unknown combinations.
   *
   * Example:
   *   feeModel.getExchangeFeePerContractUsd('coinbase', 'cfm')  === 0.10
   *   feeModel.getExchangeFeePerContractUsd('coinbase', 'spot') === 0
   */
  getExchangeFeePerContractUsd(exchange: Exchange | string, market: Market): number {
    const bucket = this.resolveBucket(exchange, market);
    return bucket.exchange_fee_per_contract_usd ?? 0;
  }

  /** True when the bucket stacks a per-contract exchange floor on top of the % commission. */
  isCostPlus(exchange: Exchange | string, market: Market): boolean {
    return this.getExchangeFeePerContractUsd(exchange, market) > 0;
  }

  /**
   * All-in fee for one fill, computed with exact decimal arithmetic:
   *
   *   commission   = notionalUsd × rate(side)
   *   exchangeFee  = contracts × exchange_fee_per_contract_usd   (cost-plus books only)
   *   total        = commission + exchangeFee
   *
   * The two legs are returned separately so they can be logged separately
   * (desk rule: "stack, don't blend"). For non cost-plus books
   * `exchangeFeeUsd` is `"0"` and `contracts` is ignored.
   *
   * Example (CFM working model, Luke 10-ct preview reconcile):
   *   computeFillFeeUsd({ exchange: 'coinbase', market: 'cfm', side: 'taker',
   *                       notionalUsd: '7771.50', contracts: 10 })
   *   → commission 7.77150, exchangeFee 1.00, total 8.77150
   */
  computeFillFeeUsd(inputs: FillFeeInputs): FillFeeBreakdown {
    const rate = this.getFeeRate(inputs.exchange, inputs.market, inputs.side);
    const perContractUsd = this.getExchangeFeePerContractUsd(inputs.exchange, inputs.market);

    const commissionUsd = roundUsd(decimalMul(toDecimalString(inputs.notionalUsd), rate));
    const contracts = inputs.contracts !== undefined ? toDecimalString(inputs.contracts) : '0';
    const exchangeFeeUsd = perContractUsd > 0 ? roundUsd(decimalMul(contracts, perContractUsd)) : '0';
    const totalUsd = roundUsd(decimalAdd(commissionUsd, exchangeFeeUsd));

    return { commissionUsd, exchangeFeeUsd, totalUsd, rate, perContractUsd };
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
        if (market === 'cfm' && this.fees.coinbase.cfm_nano) return this.fees.coinbase.cfm_nano;
        break;
      case 'hyperliquid':
        if (market === 'perps') return this.fees.hyperliquid.perps;
        // Hyperliquid is perps-only; spot / cfm are intentionally unsupported.
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

/** Decimal-string view of a number/string input; negative fee legs are never valid fill inputs. */
function toDecimalString(value: string | number): string {
  const text = typeof value === 'number' ? String(value) : value.trim();
  if (!Number.isFinite(Number.parseFloat(text))) {
    throw new Error(`FeeModel: non-finite fee input "${value}"`);
  }
  return text;
}

/** Round a USD decimal string to 1e-8 (half-up) so breakdown legs always add up exactly. */
function roundUsd(value: string): string {
  const negative = value.startsWith('-');
  const abs = negative ? value.slice(1) : value;
  const rounded = decimalRoundToIncrement(abs, FEE_USD_INCREMENT, 'nearest');
  return negative ? `-${rounded}` : rounded;
}

/** Contracts for a base-unit size at a given contract size, exact (`size / contractSize`). */
export function contractsForSize(size: string | number, contractSize: string | number): string {
  return decimalDiv(toDecimalString(size), toDecimalString(contractSize), 8);
}
