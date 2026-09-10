/**
 * LiveAccountTruth — the single source of truth for the LIVE account (Sprint 9 / TASK_011).
 *
 * In live mode the engine must size from the account Coinbase actually holds, charge the
 * fee tier Coinbase actually applies and validate against the product specs Coinbase
 * actually enforces. This service pulls all three through the hardened Advanced Trade
 * client and publishes ONE immutable `LiveAccountSnapshot` that RiskEngine, FeeModel, the
 * EV gate, the live preflight and `/api/status` + `/api/pnl` all consume.
 *
 * Invariants (see docs/plans/SPRINT-9-LIVE-COINBASE.md §2):
 * - Unknown ⇒ refuse. `refresh()` throws when any input (accounts, fee tier, a live
 *   product, a mark price) cannot be determined; nothing is ever back-filled from yaml.
 * - USD and USDC are both quote balance (USDC at 1:1). Legacy code read USD only.
 * - Equity = quote available + quote hold + Σ (base balance × mid) for the bases of the
 *   live symbols only. Other holdings are reported but never counted.
 * - Refreshes every `account_refresh_sec` (default 60 s) and immediately after every fill.
 *   A snapshot older than 3× the interval is STALE: health degrades with
 *   `ACCOUNT_TRUTH_STALE` and RiskEngine blocks new entries until a refresh succeeds.
 * - Fee-tier transitions emit `fee_tier_changed` so the engine can swap its FeeModel.
 * - Logs carry `{status, code, message}` only — never headers, JWTs or raw error objects.
 */

import { EventEmitter } from 'events';
import { Logger } from '../../core/logger';
import { FeeModel } from '../../core/fee-model';
import { decimalAdd, decimalMul, decimalToNumber } from '../../core/decimal';
import type {
  AtAccount,
  AtProduct,
  AtTransactionSummary,
} from '../../exchanges/coinbase/advanced-trade-client';
import { LiveProductSpec, toLiveProductSpec } from '../execution/coinbase-advanced-adapter';

// ============================================================================
// Codes
// ============================================================================

/** Live start / sizing refused because no account snapshot exists. */
export const ACCOUNT_TRUTH_UNAVAILABLE = 'ACCOUNT_TRUTH_UNAVAILABLE';
/** Snapshot older than `staleMultiplier × refreshInterval` — entries blocked. */
export const ACCOUNT_TRUTH_STALE = 'ACCOUNT_TRUTH_STALE';
/** Risk event emitted when Coinbase reports a different maker/taker tier than before. */
export const FEE_TIER_CHANGED = 'FEE_TIER_CHANGED';

/** Quote currencies treated as USD at 1:1. */
export const STABLE_QUOTE_CURRENCIES: ReadonlySet<string> = new Set(['USD', 'USDC']);

const DEFAULT_REFRESH_INTERVAL_SEC = 60;
const DEFAULT_STALE_MULTIPLIER = 3;

// ============================================================================
// Types
// ============================================================================

export interface LiveFeeTier {
  /** Coinbase `pricing_tier` label (e.g. "Intro 1"). */
  name: string;
  /** Maker rate as a decimal fraction (0.006 = 60 bps). */
  makerRate: number;
  /** Taker rate as a decimal fraction (0.012 = 120 bps). */
  takerRate: number;
  /** Same rates in basis points, derived with exact decimal arithmetic. */
  makerBps: number;
  takerBps: number;
  /** Trailing 30-day volume in USD as reported by Coinbase. */
  volume30dUsd: number;
}

export interface LiveBaseBalance {
  available: number;
  hold: number;
}

export interface LiveMark {
  price: number;
  /** `feed` = engine market-data mid; `product` = `/products/{id}` last price (startup fallback). */
  source: 'feed' | 'product';
}

export interface LiveAccountSnapshot {
  fetchedAt: number;
  /** USD + USDC available (USDC treated 1:1). */
  quoteAvailableUsd: number;
  /** USD + USDC on hold (open orders). */
  quoteHoldUsd: number;
  /** Non-quote balances with a non-zero total, e.g. ETH, BTC. */
  baseBalances: Record<string, LiveBaseBalance>;
  /** quote available + quote hold + Σ base × mid — bases of the LIVE symbols only. */
  equityUsd: number;
  feeTier: LiveFeeTier;
  /** Exchange-truth product specs for every live symbol (from `/products/{id}`). */
  products: Record<string, LiveProductSpec>;
  /** Mark price used per live symbol when valuing base holdings. */
  marks: Record<string, LiveMark>;
}

/** Compact, JSON-safe view for `/api/status`, `/api/pnl` and the preflight response. */
export interface LiveAccountSummary {
  equityUsd: number;
  quoteAvailableUsd: number;
  quoteHoldUsd: number;
  feeTier: LiveFeeTier;
  fetchedAt: number;
  stale: boolean;
  products: Record<
    string,
    Pick<LiveProductSpec, 'baseIncrement' | 'quoteIncrement' | 'baseMinSize' | 'quoteMinSize' | 'status' | 'tradable'>
  >;
}

export interface LiveAccountTruthHealth {
  ok: boolean;
  degraded: boolean;
  reasonCodes: string[];
  fetchedAt: number | null;
  ageMs: number | null;
}

/** Minimal client surface the service needs (tests inject a mocked `AdvancedTradeRestClient`). */
export interface LiveAccountTruthClient {
  getAccountsAll(): Promise<AtAccount[]>;
  getTransactionSummary(): Promise<AtTransactionSummary>;
  getProduct(productId: string): Promise<AtProduct>;
}

/** Returns the current mid for a symbol, or null/undefined when the feed has none yet. */
export type MidPriceSource = (symbol: string) => number | null | undefined;

export interface LiveAccountTruthConfig {
  logger: Logger;
  client: LiveAccountTruthClient;
  /** Live symbols (product ids). Specs are loaded for each; only their bases count toward equity. */
  symbols: string[];
  /** Refresh cadence in seconds (`live.account_refresh_sec`, default 60). */
  refreshIntervalSec?: number;
  /** Snapshot age, as a multiple of the interval, after which it is stale (default 3). */
  staleMultiplier?: number;
  /** Market-data mid source; may be attached later via `setPriceSource()`. */
  priceSource?: MidPriceSource;
  now?: () => number;
}

export interface LiveAccountTruthEvents {
  snapshot: (snapshot: LiveAccountSnapshot) => void;
  fee_tier_changed: (change: { previous: LiveFeeTier; next: LiveFeeTier; snapshot: LiveAccountSnapshot }) => void;
  refresh_failed: (error: { status?: number; code?: string; message: string }) => void;
}

// ============================================================================
// Helpers
// ============================================================================

/** `{status, code, message}` view of any error — the only shape that may reach a log line. */
export function describeError(error: unknown): { status?: number; code?: string; message: string } {
  if (error && typeof error === 'object') {
    const e = error as { httpStatus?: unknown; coinbaseCode?: unknown; code?: unknown; message?: unknown };
    return {
      status: typeof e.httpStatus === 'number' ? e.httpStatus : undefined,
      code: typeof e.coinbaseCode === 'string' ? e.coinbaseCode : typeof e.code === 'string' ? e.code : undefined,
      message: typeof e.message === 'string' ? e.message : String(error),
    };
  }
  return { message: String(error) };
}

function bpsFromRate(rate: string): number {
  return decimalToNumber(decimalMul(rate.trim(), '10000'));
}

function isPositiveFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/** Map a Coinbase transaction summary onto the snapshot's fee tier (pure). */
export function toLiveFeeTier(summary: AtTransactionSummary): LiveFeeTier {
  const makerRate = Number.parseFloat(summary.fee_tier.maker_fee_rate);
  const takerRate = Number.parseFloat(summary.fee_tier.taker_fee_rate);
  if (!Number.isFinite(makerRate) || !Number.isFinite(takerRate) || makerRate < 0 || takerRate < 0) {
    throw new Error('Coinbase fee tier rates are not parseable — fee tier unknown');
  }
  return {
    name: summary.fee_tier.pricing_tier || 'unknown',
    makerRate,
    takerRate,
    makerBps: bpsFromRate(summary.fee_tier.maker_fee_rate),
    takerBps: bpsFromRate(summary.fee_tier.taker_fee_rate),
    volume30dUsd: Number.isFinite(summary.total_volume) ? summary.total_volume : 0,
  };
}

/**
 * Overlay the live Coinbase spot tier on a yaml FeeModel. Returns a new model; the
 * receiver is untouched. Only `coinbase/spot` is overridden — perps are not traded live.
 */
export function buildLiveFeeModel(base: FeeModel, tier: LiveFeeTier): FeeModel {
  return base.withRuntimeOverride({
    venue: 'coinbase',
    product: 'spot',
    makerBps: tier.makerBps,
    takerBps: tier.takerBps,
    source: `coinbase:${tier.name}`,
  });
}

/** JSON-safe summary of a snapshot for API surfaces. */
export function summarizeSnapshot(snapshot: LiveAccountSnapshot, stale: boolean): LiveAccountSummary {
  const products: LiveAccountSummary['products'] = {};
  for (const [symbol, spec] of Object.entries(snapshot.products)) {
    products[symbol] = {
      baseIncrement: spec.baseIncrement,
      quoteIncrement: spec.quoteIncrement,
      baseMinSize: spec.baseMinSize,
      quoteMinSize: spec.quoteMinSize,
      status: spec.status,
      tradable: spec.tradable,
    };
  }
  return {
    equityUsd: snapshot.equityUsd,
    quoteAvailableUsd: snapshot.quoteAvailableUsd,
    quoteHoldUsd: snapshot.quoteHoldUsd,
    feeTier: snapshot.feeTier,
    fetchedAt: snapshot.fetchedAt,
    stale,
    products,
  };
}

// ============================================================================
// Service
// ============================================================================

/**
 * Periodically refreshed, fail-closed view of the live Coinbase account.
 *
 * Lifecycle: construct → `refresh()` (preflight; throws on any unknown) → `start()` (arms the
 * periodic refresh; performs the initial refresh if none succeeded yet) → `stop()`.
 */
export class LiveAccountTruth extends EventEmitter {
  private readonly logger: Logger;
  private readonly client: LiveAccountTruthClient;
  private readonly symbols: string[];
  private readonly refreshIntervalMs: number;
  private readonly staleMultiplier: number;
  private readonly now: () => number;
  private priceSource: MidPriceSource | null;

  private snapshot: LiveAccountSnapshot | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;
  private inFlight: Promise<LiveAccountSnapshot> | null = null;
  private refreshQueued = false;
  private lastFailure: { at: number; status?: number; code?: string; message: string } | null = null;

  constructor(config: LiveAccountTruthConfig) {
    super();
    this.logger = config.logger;
    this.client = config.client;
    this.symbols = [...new Set(config.symbols.map((s) => s.trim().toUpperCase()).filter(Boolean))];
    const intervalSec = config.refreshIntervalSec ?? DEFAULT_REFRESH_INTERVAL_SEC;
    if (!Number.isFinite(intervalSec) || intervalSec <= 0) {
      throw new Error(`LiveAccountTruth: refreshIntervalSec must be positive (got ${intervalSec})`);
    }
    this.refreshIntervalMs = intervalSec * 1000;
    this.staleMultiplier = config.staleMultiplier ?? DEFAULT_STALE_MULTIPLIER;
    this.priceSource = config.priceSource ?? null;
    this.now = config.now ?? (() => Date.now());
    if (this.symbols.length === 0) {
      throw new Error('LiveAccountTruth: at least one live symbol is required');
    }
  }

  /** Live symbols this service tracks (normalised, de-duplicated). */
  public getSymbols(): readonly string[] {
    return this.symbols;
  }

  /** Refresh cadence in milliseconds. */
  public getRefreshIntervalMs(): number {
    return this.refreshIntervalMs;
  }

  /** Attach (or replace) the market-data mid source once the engine's feed exists. */
  public setPriceSource(source: MidPriceSource | null): void {
    this.priceSource = source;
  }

  /** Latest snapshot, or null when no refresh has ever succeeded. */
  public getSnapshot(): LiveAccountSnapshot | null {
    return this.snapshot;
  }

  /** Latest snapshot; throws `ACCOUNT_TRUTH_UNAVAILABLE` when none exists. */
  public requireSnapshot(): LiveAccountSnapshot {
    if (!this.snapshot) {
      throw new Error(
        `${ACCOUNT_TRUTH_UNAVAILABLE}: no live account snapshot from Coinbase — refusing to size from yaml` +
          (this.lastFailure ? ` (last refresh error: ${this.lastFailure.message})` : ''),
      );
    }
    return this.snapshot;
  }

  /** Age of the latest snapshot in ms (null when none). */
  public getAgeMs(now: number = this.now()): number | null {
    return this.snapshot ? Math.max(0, now - this.snapshot.fetchedAt) : null;
  }

  /** True when no snapshot exists or it is older than `staleMultiplier × refreshInterval`. */
  public isStale(now: number = this.now()): boolean {
    const age = this.getAgeMs(now);
    return age === null || age > this.staleMultiplier * this.refreshIntervalMs;
  }

  /** Health in the same vocabulary as `AdapterHealth` so the adapter/preflight can fold it in. */
  public getHealth(now: number = this.now()): LiveAccountTruthHealth {
    const reasonCodes: string[] = [];
    if (!this.snapshot) {
      reasonCodes.push(ACCOUNT_TRUTH_UNAVAILABLE);
    } else if (this.isStale(now)) {
      reasonCodes.push(ACCOUNT_TRUTH_STALE);
    }
    return {
      ok: reasonCodes.length === 0,
      degraded: reasonCodes.length > 0,
      reasonCodes,
      fetchedAt: this.snapshot?.fetchedAt ?? null,
      ageMs: this.getAgeMs(now),
    };
  }

  /** Most recent refresh failure (for surfaces), or null. */
  public getLastFailure(): { at: number; status?: number; code?: string; message: string } | null {
    return this.lastFailure;
  }

  /** JSON-safe summary of the current snapshot, or null when none exists. */
  public getSummary(now: number = this.now()): LiveAccountSummary | null {
    return this.snapshot ? summarizeSnapshot(this.snapshot, this.isStale(now)) : null;
  }

  /**
   * Pull `/accounts` (all pages), `/transaction_summary` and `/products/{id}` for every live
   * symbol, mark bases at the feed mid (or the product's last price before the feed is up),
   * and publish a new snapshot. Throws when any input is unknown — the previous snapshot is
   * kept (and will go stale) rather than being patched with guesses.
   *
   * Concurrent calls coalesce onto the in-flight request.
   */
  public async refresh(): Promise<LiveAccountSnapshot> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.doRefresh().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  /**
   * Refresh immediately after a fill. Never throws (failures are logged and surfaced
   * through health); a refresh already in flight is followed by one more so the fill's
   * balance change is always captured.
   */
  public refreshAfterFill(): void {
    if (this.inFlight) {
      if (!this.refreshQueued) {
        this.refreshQueued = true;
        void this.inFlight
          .catch(() => undefined)
          .then(() => {
            this.refreshQueued = false;
            return this.refresh();
          })
          .catch(() => undefined);
      }
      return;
    }
    void this.refresh().catch(() => undefined);
  }

  /**
   * Arm the periodic refresh. Performs the initial refresh first when no snapshot exists
   * yet, so a caller that reaches `running` is guaranteed a snapshot. Idempotent.
   */
  public async start(): Promise<void> {
    if (!this.snapshot) {
      await this.refresh();
    }
    if (this.refreshTimer) return;
    this.refreshTimer = setInterval(() => {
      void this.refresh().catch(() => undefined);
    }, this.refreshIntervalMs);
    this.logger.info('LiveAccountTruth started', {
      symbols: this.symbols,
      refreshIntervalMs: this.refreshIntervalMs,
      staleAfterMs: this.staleMultiplier * this.refreshIntervalMs,
    });
  }

  /** Stop the periodic refresh (the last snapshot stays readable). */
  public stop(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  // ------------------------------------------------------------------ internals

  private async doRefresh(): Promise<LiveAccountSnapshot> {
    try {
      const [accounts, summary, productList] = await Promise.all([
        this.client.getAccountsAll(),
        this.client.getTransactionSummary(),
        Promise.all(this.symbols.map((symbol) => this.client.getProduct(symbol))),
      ]);

      const products: Record<string, LiveProductSpec> = {};
      for (let i = 0; i < this.symbols.length; i++) {
        const symbol = this.symbols[i];
        const product = productList[i];
        if (!product || (product.product_id ?? symbol).toUpperCase() !== symbol) {
          throw new Error(`Coinbase returned no product for live symbol ${symbol}`);
        }
        products[symbol] = toLiveProductSpec(product);
      }

      const feeTier = toLiveFeeTier(summary);
      const snapshot = this.buildSnapshot(accounts, feeTier, products, productList);
      const previous = this.snapshot;
      this.snapshot = snapshot;
      this.lastFailure = null;

      this.logger.info('Live account snapshot refreshed', {
        equityUsd: snapshot.equityUsd,
        quoteAvailableUsd: snapshot.quoteAvailableUsd,
        quoteHoldUsd: snapshot.quoteHoldUsd,
        feeTier: `${feeTier.name} ${feeTier.makerBps}/${feeTier.takerBps} bps`,
        bases: Object.keys(snapshot.baseBalances),
        marks: Object.fromEntries(Object.entries(snapshot.marks).map(([s, m]) => [s, `${m.price} (${m.source})`])),
      });

      this.emit('snapshot', snapshot);
      if (previous && (previous.feeTier.makerBps !== feeTier.makerBps || previous.feeTier.takerBps !== feeTier.takerBps)) {
        this.logger.warn(`${FEE_TIER_CHANGED}: Coinbase fee tier changed`, {
          previous: `${previous.feeTier.name} ${previous.feeTier.makerBps}/${previous.feeTier.takerBps} bps`,
          next: `${feeTier.name} ${feeTier.makerBps}/${feeTier.takerBps} bps`,
        });
        this.emit('fee_tier_changed', { previous: previous.feeTier, next: feeTier, snapshot });
      }
      return snapshot;
    } catch (error) {
      const described = describeError(error);
      this.lastFailure = { at: this.now(), ...described };
      this.logger.error('Live account refresh failed — keeping previous snapshot (will go stale)', {
        ...described,
        hasSnapshot: Boolean(this.snapshot),
      });
      this.emit('refresh_failed', described);
      throw error;
    }
  }

  private buildSnapshot(
    accounts: AtAccount[],
    feeTier: LiveFeeTier,
    products: Record<string, LiveProductSpec>,
    productList: AtProduct[],
  ): LiveAccountSnapshot {
    let quoteAvailable = '0';
    let quoteHold = '0';
    const baseAvailable = new Map<string, string>();
    const baseHold = new Map<string, string>();

    for (const account of accounts) {
      const currency = (account.currency ?? '').toUpperCase();
      if (!currency) continue;
      const available = account.available_balance?.value ?? '0';
      const hold = account.hold?.value ?? '0';
      if (STABLE_QUOTE_CURRENCIES.has(currency)) {
        quoteAvailable = decimalAdd(quoteAvailable, available);
        quoteHold = decimalAdd(quoteHold, hold);
      } else {
        baseAvailable.set(currency, decimalAdd(baseAvailable.get(currency) ?? '0', available));
        baseHold.set(currency, decimalAdd(baseHold.get(currency) ?? '0', hold));
      }
    }

    const baseBalances: Record<string, LiveBaseBalance> = {};
    for (const [currency, available] of baseAvailable) {
      const hold = baseHold.get(currency) ?? '0';
      const availableNum = decimalToNumber(available);
      const holdNum = decimalToNumber(hold);
      if (availableNum !== 0 || holdNum !== 0) {
        baseBalances[currency] = { available: availableNum, hold: holdNum };
      }
    }

    // Value only the bases of the live symbols, each at exactly one mark.
    const marks: Record<string, LiveMark> = {};
    let baseValueUsd = '0';
    const valued = new Set<string>();
    for (let i = 0; i < this.symbols.length; i++) {
      const symbol = this.symbols[i];
      const spec = products[symbol];
      const mark = this.resolveMark(symbol, productList[i]);
      marks[symbol] = mark;
      const base = spec.baseCurrency.toUpperCase();
      if (valued.has(base)) continue; // e.g. ETH-USD and ETH-USDC share a base
      valued.add(base);
      const total = decimalAdd(baseAvailable.get(base) ?? '0', baseHold.get(base) ?? '0');
      baseValueUsd = decimalAdd(baseValueUsd, decimalMul(total, mark.price));
    }

    const equity = decimalAdd(decimalAdd(quoteAvailable, quoteHold), baseValueUsd);
    return {
      fetchedAt: this.now(),
      quoteAvailableUsd: decimalToNumber(quoteAvailable),
      quoteHoldUsd: decimalToNumber(quoteHold),
      baseBalances,
      equityUsd: decimalToNumber(equity),
      feeTier,
      products,
      marks,
    };
  }

  /** Feed mid first; `/products/{id}` last price before the feed is warm. Unknown ⇒ throw. */
  private resolveMark(symbol: string, product: AtProduct | undefined): LiveMark {
    const fromFeed = this.priceSource ? this.priceSource(symbol) : null;
    if (isPositiveFinite(fromFeed)) {
      return { price: fromFeed, source: 'feed' };
    }
    const fromProduct = Number.parseFloat(product?.price ?? '');
    if (Number.isFinite(fromProduct) && fromProduct > 0) {
      return { price: fromProduct, source: 'product' };
    }
    throw new Error(`No mark price available for live symbol ${symbol} (feed empty, product price missing)`);
  }
}
