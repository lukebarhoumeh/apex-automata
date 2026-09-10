/**
 * Coinbase Advanced Trade live execution adapter.
 *
 * Implements `IExecutionAdapter` on top of the hardened `AdvancedTradeRestClient`
 * (CDP key + ES256 JWT) and the `AdvancedTradeUserStream`. This replaces the dead
 * legacy live path (`CoinbaseLiveExecutionAdapter` → HMAC `CoinbaseExchange`), which
 * cannot authenticate a CDP key.
 *
 * Responsibilities
 * - Map `PlaceOrderRequest` → Advanced Trade `order_configuration`
 *   (limit_limit_gtc / market_market_ioc / stop_limit_stop_limit_gtc, optional
 *   attached `trigger_bracket_gtc` from `metadata.protection`, gated by
 *   `enableAttachedProtection` until TASK_013 owns the child-order lifecycle).
 * - Sizes/prices as decimal STRINGS via exact BigInt arithmetic — size rounded DOWN to
 *   `base_increment`; prices rounded to `quote_increment` in the side-conservative
 *   direction (buy limit down / sell limit up; stop triggers toward earlier triggering).
 * - Reject locally (no HTTP) when the product is unknown/not tradable, size is below
 *   `base_min_size`, notional is below `quote_min_size`, metadata is malformed, or a spot
 *   sell exceeds the available base balance (when a balance lookup is wired — TASK_012).
 * - `success:false` ⇒ `order_rejected {code, reason}`; `success:true` ⇒ `order_accepted`.
 *   Transport/5xx failures after retries put the order in an `unknown` state that is
 *   resolved through REST (`listOrders` matched on `client_order_id`); `order_rejected`
 *   is emitted only once the exchange has confirmed the order does not exist.
 * - Cancel emits `order_canceled` only on CONFIRMED success from `batch_cancel`, and a
 *   cancelled/expired order keeps being reconciled until its REST `filled_size` matches
 *   the quantity already surfaced (fills that landed just before the cancel are never lost).
 * - Fills: user stream is primary (cumulative-quantity deltas, deduped per
 *   `(order_id, cumulative_quantity)`); REST `listFills` polling every 5s while any
 *   order is open/unsettled is the fallback, merged without double counting.
 *   `size_in_quote` fills are converted to base quantity.
 * - Health: degraded with `USER_STREAM_STALE` / `USER_STREAM_DISCONNECTED` when the
 *   stream is unhealthy, `USER_STREAM_DISABLED` on polling only, `ORDER_STATE_UNKNOWN`
 *   while any submit outcome is unresolved, `FILL_ADJUSTMENT_SEEN` after a
 *   REVERSAL/CORRECTION fill.
 *
 * Out of scope here (TASK_013): enforcing that every entry carries exchange-side
 * protection and boot-time reconciliation of orders from previous sessions.
 */

import { EventEmitter } from 'events';
import { Logger } from '../../core/logger';
import {
  decimalAdd,
  decimalCompare,
  decimalDiv,
  decimalIsZero,
  decimalMul,
  decimalRoundToIncrement,
  decimalSub,
  decimalToNumber,
  DecimalRoundingMode,
} from '../../core/decimal';
import {
  AdvancedTradeRestClient,
  AtCreateOrderBody,
  AtFill,
  AtOrder,
  AtOrderConfiguration,
  AtOrderSide,
  AtProduct,
  AtStopDirection,
} from '../../exchanges/coinbase/advanced-trade-client';
import { CoinbaseApiError, CoinbaseNetworkError } from '../../exchanges/coinbase/http/errors';
import {
  AdvancedTradeUserStream,
  UserStreamOrderUpdate,
} from '../../exchanges/coinbase/advanced-trade-user-stream';
import {
  AdapterHealth,
  BrokerOrderEvent,
  ExecutionMode,
  FillRecord,
  IExecutionAdapter,
  OpenOrder,
  PlaceOrderRequest,
} from './execution-adapter';

// ============================================================================
// Types
// ============================================================================

/** Exchange-truth product specification (decimal strings, straight from `/products/{id}`). */
export interface LiveProductSpec {
  symbol: string;
  baseCurrency: string;
  quoteCurrency: string;
  baseIncrement: string;
  quoteIncrement: string;
  baseMinSize: string;
  baseMaxSize?: string;
  quoteMinSize: string;
  quoteMaxSize?: string;
  status: string;
  tradable: boolean;
  limitOnly: boolean;
  postOnly: boolean;
  cancelOnly: boolean;
  /** Last price reported by the product endpoint when the spec was loaded. */
  lastPrice?: string;
}

/** Optional exchange-side protection attached to an entry (`trigger_bracket_gtc`). */
export interface OrderProtectionMetadata {
  takeProfit?: number | string;
  stopTrigger?: number | string;
}

export interface CoinbaseAdvancedAdapterConfig {
  logger: Logger;
  /** Hardened REST client (already holds validated CDP credentials). */
  client: AdvancedTradeRestClient;
  /** Symbols whose product specs are loaded (and required tradable) at `start()`. */
  symbols: string[];
  /** Primary fill source. When omitted the adapter runs on REST polling only (degraded). */
  userStream?: AdvancedTradeUserStream | null;
  /** Preloaded specs (tests / static). Symbols without a preloaded spec are fetched at start. */
  productSpecs?: Record<string, LiveProductSpec>;
  /** REST fill/status poll cadence while orders are open (default 5 000 ms). */
  fillPollIntervalMs?: number;
  /** Extra attempts for `POST /orders` on transport failures, same client_order_id (default 1). */
  placeOrderTransportRetries?: number;
  /**
   * Available balance lookup for spot SELL guarding (base currency → decimal string).
   * Returning null/undefined skips the check. Wired by TASK_012.
   */
  baseBalanceLookup?: (currency: string) => Promise<string | number | null | undefined>;
  /**
   * Allow `metadata.protection` to attach a `trigger_bracket_gtc` child order. Default
   * false: requests carrying protection are rejected locally (`PROTECTION_UNSUPPORTED`)
   * rather than placed naked. TASK_013 enables this once the child lifecycle is owned.
   */
  enableAttachedProtection?: boolean;
  /**
   * Cancel non-terminal tracked orders on `stop()` so nothing rests untracked on the
   * exchange (default true). Protection children are never cancelled by stop().
   */
  cancelOpenOrdersOnStop?: boolean;
  now?: () => number;
}

/**
 * `unknown` = the submit outcome could not be determined (transport failure after the
 * request may have been processed). Non-terminal; resolved via REST or the user stream.
 */
type TrackedStatus = 'pending' | 'unknown' | 'open' | 'filled' | 'canceled' | 'rejected';

interface TrackedOrder {
  clientOrderId: string;
  exchangeOrderId?: string;
  symbol: string;
  side: 'buy' | 'sell';
  type: 'market' | 'limit' | 'stop';
  requestedQty: string;
  price?: string;
  stopPrice?: string;
  postOnly: boolean;
  status: TrackedStatus;
  accepted: boolean;
  /** Quantity already surfaced as `fill` events (decimal string, base currency). */
  emittedQty: string;
  /** Fees already surfaced (decimal string). */
  emittedFees: string;
  /** Notional already surfaced (float, informational — used to derive delta prices). */
  emittedValue: number;
  /** Cumulative base size seen through REST fills (decimal string). */
  restCumQty: string;
  restTradeIds: Set<string>;
  /** Polls spent waiting for REST fills to catch up with a terminal status. */
  filledLagPolls: number;
  /** Polls spent trying to resolve an `unknown` submit outcome. */
  unknownPolls: number;
  /** Terminal, but REST must still confirm `filled_size` == emittedQty (fills before cancel). */
  needsFinalReconcile: boolean;
  settlePolls: number;
  /** A REVERSAL/CORRECTION fill was seen — sums of FILL rows are no longer authoritative. */
  adjustmentSeen: boolean;
  /** Set on bracket children: the entry's clientOrderId. */
  protectionChildOf?: string;
  createdAt: number;
  updatedAt: number;
  request: PlaceOrderRequest;
}

export const LIVE_PRODUCT_UNAVAILABLE = 'LIVE_PRODUCT_UNAVAILABLE';
export const USER_STREAM_DISABLED = 'USER_STREAM_DISABLED';
export const ORDER_STATE_UNKNOWN = 'ORDER_STATE_UNKNOWN';
export const FILL_ADJUSTMENT_SEEN = 'FILL_ADJUSTMENT_SEEN';
/** Reject code when REST confirms an unresolved submit never reached the exchange. */
export const SUBMIT_UNCONFIRMED = 'SUBMIT_UNCONFIRMED';
export const PROTECTION_UNSUPPORTED = 'PROTECTION_UNSUPPORTED';
export const INVALID_ORDER_METADATA = 'INVALID_ORDER_METADATA';

const DEFAULT_FILL_POLL_MS = 5_000;
const TERMINAL_RETENTION_MS = 60 * 60 * 1000;
const MAX_TRACKED_ORDERS = 5_000;
/** Polls to wait for `listFills` before surfacing a terminal order's remainder from order truth. */
const TERMINAL_LAG_POLLS_BEFORE_SYNTHETIC = 3;
/** Polls to search REST for an `unknown` submit before declaring it never happened. */
const UNKNOWN_POLLS_BEFORE_REJECT = 3;
/** Max polls spent confirming a cancelled/expired order's final fills. */
const SETTLE_POLLS_MAX = 12;
/** Look-back applied to `start_date` when searching REST for an unresolved submit. */
const UNKNOWN_LOOKBACK_MS = 5 * 60 * 1000;
const TERMINAL: ReadonlySet<TrackedStatus> = new Set(['filled', 'canceled', 'rejected']);
const TERMINAL_EXCHANGE_STATUSES: ReadonlySet<string> = new Set(['FILLED', 'CANCELLED', 'EXPIRED', 'FAILED']);

// ============================================================================
// Product spec mapping
// ============================================================================

/** Convert an Advanced Trade product into the adapter's spec (pure). */
export function toLiveProductSpec(product: AtProduct): LiveProductSpec {
  const status = (product.status ?? '').toLowerCase();
  const tradable =
    status === 'online' &&
    !product.trading_disabled &&
    !product.is_disabled &&
    !product.cancel_only &&
    !product.view_only &&
    !product.auction_mode;
  const [baseFromId, quoteFromId] = product.product_id.split('-');
  return {
    symbol: product.product_id,
    baseCurrency: product.base_currency_id || baseFromId,
    quoteCurrency: product.quote_currency_id || quoteFromId,
    baseIncrement: product.base_increment,
    quoteIncrement: product.quote_increment,
    baseMinSize: product.base_min_size,
    baseMaxSize: product.base_max_size || undefined,
    quoteMinSize: product.quote_min_size,
    quoteMaxSize: product.quote_max_size || undefined,
    status,
    tradable,
    limitOnly: Boolean(product.limit_only),
    postOnly: Boolean(product.post_only),
    cancelOnly: Boolean(product.cancel_only),
    lastPrice: product.price || undefined,
  };
}

// ============================================================================
// Adapter
// ============================================================================

/**
 * Live execution adapter for Coinbase Advanced Trade (spot).
 */
export class CoinbaseAdvancedExecutionAdapter extends EventEmitter implements IExecutionAdapter {
  public readonly mode: ExecutionMode = 'live';

  private readonly logger: Logger;
  private readonly client: AdvancedTradeRestClient;
  private readonly symbols: string[];
  private readonly userStream: AdvancedTradeUserStream | null;
  private readonly fillPollIntervalMs: number;
  private readonly placeOrderTransportRetries: number;
  private readonly baseBalanceLookup?: CoinbaseAdvancedAdapterConfig['baseBalanceLookup'];
  private readonly enableAttachedProtection: boolean;
  private readonly cancelOpenOrdersOnStop: boolean;
  private readonly now: () => number;

  private readonly productSpecs = new Map<string, LiveProductSpec>();
  private readonly lastPrices = new Map<string, string>();
  private readonly orders = new Map<string, TrackedOrder>();
  private readonly exchangeToClient = new Map<string, string>();
  private readonly eventCallbacks: Array<(event: BrokerOrderEvent) => void> = [];

  private running = false;
  private lastEventAt: number | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private pollInFlight = false;
  private streamHandlers: { order: (u: UserStreamOrderUpdate) => void; reconnected: () => void } | null = null;

  constructor(config: CoinbaseAdvancedAdapterConfig) {
    super();
    this.logger = config.logger;
    this.client = config.client;
    this.symbols = [...new Set(config.symbols)];
    this.userStream = config.userStream ?? null;
    this.fillPollIntervalMs = config.fillPollIntervalMs ?? DEFAULT_FILL_POLL_MS;
    this.placeOrderTransportRetries = Math.max(0, config.placeOrderTransportRetries ?? 1);
    this.baseBalanceLookup = config.baseBalanceLookup;
    this.enableAttachedProtection = config.enableAttachedProtection ?? false;
    this.cancelOpenOrdersOnStop = config.cancelOpenOrdersOnStop ?? true;
    this.now = config.now ?? (() => Date.now());
    for (const spec of Object.values(config.productSpecs ?? {})) {
      this.productSpecs.set(spec.symbol, spec);
    }
  }

  // ------------------------------------------------------------- lifecycle

  /**
   * Load/validate product specs for every live symbol (refuses to start if any is
   * missing or not tradable), connect the user stream and arm the poll fallback.
   */
  public async start(): Promise<void> {
    if (this.running) {
      this.logger.warn('Advanced Trade adapter already running');
      return;
    }
    await this.loadProductSpecs();
    this.running = true;

    if (this.userStream) {
      this.streamHandlers = {
        order: (update) => this.handleUserOrderUpdate(update),
        reconnected: () => {
          void this.reconcileTrackedOrders('stream_reconnected');
        },
      };
      this.userStream.on('order', this.streamHandlers.order);
      this.userStream.on('reconnected', this.streamHandlers.reconnected);
      await this.userStream.start();
    } else {
      this.logger.warn('Advanced Trade adapter running WITHOUT user stream — fills rely on REST polling', {
        pollIntervalMs: this.fillPollIntervalMs,
      });
    }

    this.pollTimer = setInterval(() => {
      void this.pollTick();
    }, this.fillPollIntervalMs);

    this.logger.info('Advanced Trade live adapter started', {
      symbols: this.symbols,
      userStream: Boolean(this.userStream),
      attachedProtection: this.enableAttachedProtection,
    });
  }

  /**
   * Stop polling, cancel non-terminal tracked orders (never protection children), detach
   * and close the user stream, clear session tracking.
   */
  public async stop(): Promise<void> {
    if (!this.running) return;
    if (this.cancelOpenOrdersOnStop) {
      await this.cancelTrackedOnStop();
    }
    this.running = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.userStream && this.streamHandlers) {
      this.userStream.off('order', this.streamHandlers.order);
      this.userStream.off('reconnected', this.streamHandlers.reconnected);
      this.streamHandlers = null;
      await this.userStream.stop();
    }
    this.orders.clear();
    this.exchangeToClient.clear();
    this.logger.info('Advanced Trade live adapter stopped');
  }

  /** Feed a reference price (used only for min-notional checks on market orders). */
  public updateMarketPrice(symbol: string, price: number | string): void {
    const text = typeof price === 'number' ? String(price) : price;
    if (Number.isFinite(Number.parseFloat(text)) && Number.parseFloat(text) > 0) {
      this.lastPrices.set(symbol, text);
    }
  }

  /** Product spec cache (read-only view for preflight / TASK_011). */
  public getProductSpec(symbol: string): LiveProductSpec | undefined {
    return this.productSpecs.get(symbol);
  }

  // ------------------------------------------------------------- orders

  /**
   * Place an order. Emits `order_accepted` or `order_rejected` (at most one of each per
   * clientOrderId); fills follow via the user stream or the poll fallback. When the
   * submit outcome is unknown (transport failure) nothing is emitted until REST resolves it.
   */
  public async placeOrder(request: PlaceOrderRequest): Promise<void> {
    if (!this.running) {
      throw new Error('Advanced Trade live adapter not running');
    }

    const existing = this.orders.get(request.clientOrderId);
    if (existing && !TERMINAL.has(existing.status)) {
      this.logger.warn('placeOrder ignored — clientOrderId already in flight (idempotent no-op)', {
        clientOrderId: request.clientOrderId,
        status: existing.status,
      });
      return;
    }

    const spec = this.productSpecs.get(request.symbol);
    if (!spec) {
      return this.rejectLocal(request, 'UNKNOWN_PRODUCT', `No product spec loaded for ${request.symbol}`);
    }
    if (!spec.tradable) {
      return this.rejectLocal(request, 'PRODUCT_NOT_TRADABLE', `${request.symbol} is not tradable (status=${spec.status})`);
    }
    if (!Number.isFinite(request.quantity) || request.quantity <= 0) {
      return this.rejectLocal(request, 'INVALID_QUANTITY', `Quantity must be > 0, got ${request.quantity}`);
    }

    const baseSize = decimalRoundToIncrement(request.quantity, spec.baseIncrement, 'down');
    if (decimalIsZero(baseSize) || decimalCompare(baseSize, spec.baseMinSize) < 0) {
      return this.rejectLocal(
        request,
        'BELOW_MIN_SIZE',
        `Size ${baseSize} below base_min_size ${spec.baseMinSize} for ${request.symbol}`,
      );
    }
    if (spec.baseMaxSize && decimalCompare(baseSize, spec.baseMaxSize) > 0) {
      return this.rejectLocal(request, 'ABOVE_MAX_SIZE', `Size ${baseSize} above base_max_size ${spec.baseMaxSize}`);
    }

    let limitPrice: string | undefined;
    let stopPrice: string | undefined;
    if (request.type === 'limit' || request.type === 'stop') {
      if (request.price === undefined || !Number.isFinite(request.price) || request.price <= 0) {
        return this.rejectLocal(request, 'PRICE_REQUIRED', `${request.type} orders require a positive price`);
      }
      limitPrice = decimalRoundToIncrement(request.price, spec.quoteIncrement, limitRounding(request.side));
    }
    if (request.type === 'stop') {
      if (request.stopPrice === undefined || !Number.isFinite(request.stopPrice) || request.stopPrice <= 0) {
        return this.rejectLocal(request, 'STOP_PRICE_REQUIRED', 'stop orders require a positive stopPrice');
      }
      stopPrice = decimalRoundToIncrement(request.stopPrice, spec.quoteIncrement, stopTriggerRounding(request.side));
    }
    if (spec.limitOnly && request.type !== 'limit') {
      return this.rejectLocal(request, 'LIMIT_ONLY', `${request.symbol} accepts limit orders only right now`);
    }
    if (spec.postOnly && (request.type !== 'limit' || !request.postOnly)) {
      return this.rejectLocal(request, 'POST_ONLY_MODE', `${request.symbol} accepts post-only limit orders only right now`);
    }

    const referencePrice = limitPrice ?? this.lastPrices.get(request.symbol) ?? spec.lastPrice;
    if (referencePrice) {
      const notional = decimalMul(baseSize, referencePrice);
      if (decimalCompare(notional, spec.quoteMinSize) < 0) {
        return this.rejectLocal(
          request,
          'BELOW_MIN_NOTIONAL',
          `Notional ${notional} below quote_min_size ${spec.quoteMinSize} for ${request.symbol}`,
        );
      }
    }

    const protection = request.metadata?.protection as OrderProtectionMetadata | undefined;
    if (protection && !this.enableAttachedProtection) {
      return this.rejectLocal(
        request,
        PROTECTION_UNSUPPORTED,
        'metadata.protection requested but attached bracket orders are disabled (enableAttachedProtection=false, TASK_013)',
      );
    }

    if (request.side === 'sell' && this.baseBalanceLookup) {
      let available: string | number | null | undefined;
      try {
        available = await this.baseBalanceLookup(spec.baseCurrency);
      } catch (error) {
        this.logger.warn('Base balance lookup failed; skipping spot sell guard', {
          symbol: request.symbol,
          message: error instanceof Error ? error.message : String(error),
        });
      }
      if (available !== null && available !== undefined && decimalCompare(String(available), baseSize) < 0) {
        return this.rejectLocal(
          request,
          'INSUFFICIENT_BASE_BALANCE',
          `Sell ${baseSize} ${spec.baseCurrency} exceeds available ${available}`,
        );
      }
    }

    let body: AtCreateOrderBody;
    try {
      body = this.buildOrderBody(request, spec, baseSize, limitPrice, stopPrice, protection);
    } catch (error) {
      return this.rejectLocal(
        request,
        INVALID_ORDER_METADATA,
        `Could not build order body: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const tracked = this.newTracked(request, baseSize, limitPrice, stopPrice);
    this.orders.set(request.clientOrderId, tracked);

    this.logger.info('Advanced Trade placing order', {
      clientOrderId: request.clientOrderId,
      symbol: request.symbol,
      side: request.side,
      type: request.type,
      baseSize,
      limitPrice,
      stopPrice,
      bracket: Boolean(body.attached_order_configuration),
    });

    const maxAttempts = 1 + this.placeOrderTransportRetries;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const result = await this.client.createOrderRaw(body);
        if (result.ok) {
          this.bindExchangeId(tracked, result.orderId);
          // The user stream can deliver fills (even FILLED/FAILED) before this response
          // resolves; never emit a second order_accepted or regress a terminal status.
          if (!tracked.accepted && !TERMINAL.has(tracked.status)) {
            tracked.accepted = true;
            tracked.status = request.type === 'market' ? 'pending' : 'open';
            tracked.updatedAt = this.now();
            this.emitEvent({
              type: 'order_accepted',
              clientOrderId: request.clientOrderId,
              exchangeOrderId: result.orderId,
              ts: this.now(),
              raw: result.raw,
            });
          }
          if (result.attachedOrderId) {
            this.trackProtectionChild(tracked, result.attachedOrderId, baseSize, result.raw);
          }
        } else if (result.code === 'MISSING_ORDER_ID') {
          // Exchange said success but gave no id: the order exists — resolve it via REST.
          this.markUnknown(tracked, result.code, result.message);
        } else {
          this.orders.delete(request.clientOrderId);
          if (tracked.exchangeOrderId) this.exchangeToClient.delete(tracked.exchangeOrderId);
          if (!TERMINAL.has(tracked.status)) {
            tracked.status = 'rejected';
            this.emitEvent({
              type: 'order_rejected',
              clientOrderId: request.clientOrderId,
              reason: result.message,
              code: result.code,
              ts: this.now(),
              raw: result.raw,
            });
          }
        }
        return;
      } catch (error) {
        const transient = isTransientError(error);
        if (transient && attempt < maxAttempts) {
          this.logger.warn('Advanced Trade order submit transport failure — retrying with same client_order_id', {
            clientOrderId: request.clientOrderId,
            attempt,
            message: error instanceof Error ? error.message : String(error),
          });
          continue;
        }
        const message = error instanceof Error ? error.message : String(error);
        if (tracked.accepted) {
          // The user stream already proved the order exists (response was lost in transit);
          // the accepted/fill events it produced are the truth — do not contradict them.
          this.logger.warn('Order submit failed after the user stream confirmed the order — keeping stream truth', {
            clientOrderId: request.clientOrderId,
            message,
          });
          return;
        }
        if (isDefinitiveReject(error)) {
          // The request was refused before processing (auth / not found / rate limited): safe to reject.
          const code = (error as CoinbaseApiError).coinbaseCode ?? (error as CoinbaseApiError).kind;
          this.orders.delete(request.clientOrderId);
          this.logger.error('Advanced Trade order submit refused', {
            clientOrderId: request.clientOrderId,
            symbol: request.symbol,
            code,
            message,
            attempt,
          });
          this.emitEvent({
            type: 'order_rejected',
            clientOrderId: request.clientOrderId,
            reason: message,
            code,
            ts: this.now(),
          });
          return;
        }
        // Timeout / network / 5xx / body-read failure: the exchange may have processed the
        // order. Do NOT emit order_rejected — resolve the truth via REST first.
        const code = error instanceof CoinbaseApiError ? error.coinbaseCode ?? error.kind : transient ? 'TRANSPORT_ERROR' : 'SUBMIT_ERROR';
        this.markUnknown(tracked, code, message);
        return;
      }
    }
  }

  /** Cancel by client order id. `order_canceled` is emitted ONLY on confirmed success. */
  public async cancelOrder(clientOrderId: string): Promise<void> {
    if (!this.running) {
      throw new Error('Advanced Trade live adapter not running');
    }
    const tracked = this.orders.get(clientOrderId);
    if (!tracked?.exchangeOrderId) {
      this.logger.warn('Cannot cancel — no exchange order id for client order', {
        clientOrderId,
        status: tracked?.status,
      });
      return;
    }
    if (TERMINAL.has(tracked.status)) {
      this.logger.warn('Cancel skipped — order already terminal', { clientOrderId, status: tracked.status });
      return;
    }

    let results;
    try {
      results = await this.client.cancelOrders([tracked.exchangeOrderId]);
    } catch (error) {
      this.logger.error('Advanced Trade cancel request failed', {
        clientOrderId,
        exchangeOrderId: tracked.exchangeOrderId,
        message: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    const outcome = results[0];
    if (outcome?.success) {
      this.markCanceled(tracked, { source: 'batch_cancel' });
      return;
    }
    this.logger.warn('Advanced Trade cancel not confirmed', {
      clientOrderId,
      exchangeOrderId: tracked.exchangeOrderId,
      failureReason: outcome?.failure_reason,
    });
    // The order may already be filled/cancelled; ask the exchange for the truth.
    await this.reconcileOrder(tracked);
  }

  /**
   * Cancel every open order for this adapter's symbols (or one symbol) via `batch_cancel`.
   * Never touches other products on the account; emits `order_canceled` only for orders
   * this session tracks (untracked cancellations are logged).
   */
  public async cancelAllOrders(symbol?: string): Promise<void> {
    if (!this.running) {
      throw new Error('Advanced Trade live adapter not running');
    }
    const products = symbol ? [symbol] : this.symbols;

    const targets = new Map<string, string | undefined>(); // exchangeOrderId → clientOrderId (tracked only)
    for (const tracked of this.orders.values()) {
      if (tracked.exchangeOrderId && !TERMINAL.has(tracked.status) && products.includes(tracked.symbol)) {
        targets.set(tracked.exchangeOrderId, tracked.clientOrderId);
      }
    }
    try {
      const open = await this.client.listOrdersAll({ order_status: ['OPEN'], product_ids: products });
      for (const order of open) {
        if (!targets.has(order.order_id)) {
          targets.set(order.order_id, undefined);
        }
      }
    } catch (error) {
      this.logger.warn('cancelAllOrders: listing open orders failed; cancelling locally tracked orders only', {
        products,
        message: error instanceof Error ? error.message : String(error),
      });
    }
    if (targets.size === 0) return;

    let results;
    try {
      results = await this.client.cancelOrders([...targets.keys()]);
    } catch (error) {
      this.logger.error('Advanced Trade batch cancel failed', {
        products,
        count: targets.size,
        message: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    for (const result of results) {
      const clientOrderId = targets.get(result.order_id);
      if (!result.success) {
        this.logger.warn('Batch cancel: order not cancelled', {
          exchangeOrderId: result.order_id,
          clientOrderId,
          failureReason: result.failure_reason,
        });
        continue;
      }
      const tracked = clientOrderId ? this.orders.get(clientOrderId) : undefined;
      if (tracked) {
        this.markCanceled(tracked, { source: 'batch_cancel_all' });
      } else {
        this.logger.info('Batch cancel: cancelled an order not tracked by this session', {
          exchangeOrderId: result.order_id,
        });
      }
    }
  }

  /** Open + pending orders from the exchange (source of truth), mapped to `OpenOrder`. */
  public async getOpenOrders(): Promise<OpenOrder[]> {
    const orders: AtOrder[] = [];
    try {
      orders.push(...(await this.client.listOrdersAll({ order_status: ['OPEN'] })));
    } catch (error) {
      this.logger.error('getOpenOrders: listing OPEN orders failed', {
        message: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
    try {
      // OPEN cannot be combined with other statuses in the same query.
      orders.push(...(await this.client.listOrdersAll({ order_status: ['PENDING', 'QUEUED', 'CANCEL_QUEUED'] })));
    } catch (error) {
      this.logger.warn('getOpenOrders: listing PENDING orders failed; returning OPEN only', {
        message: error instanceof Error ? error.message : String(error),
      });
    }
    return orders.map((order) => this.toOpenOrder(order));
  }

  /**
   * Fills since a cursor. Accepts epoch-ms, an ISO timestamp, or
   * `{ since?, productIds?, orderIds? }`. Paginates `listFills`. Quote-sized fills are
   * converted to base quantity.
   */
  public async getFillsSince(cursor: unknown): Promise<FillRecord[]> {
    const params = fillsCursorToParams(cursor);
    let fills: AtFill[];
    try {
      fills = await this.client.listFillsAll(params);
    } catch (error) {
      this.logger.error('getFillsSince failed', { message: error instanceof Error ? error.message : String(error) });
      return [];
    }
    return fills
      .filter((f) => (f.trade_type ?? 'FILL') === 'FILL')
      .map((f) => this.toFillRecord(f))
      .sort((a, b) => a.ts - b.ts);
  }

  /** Register a broker event callback. */
  public onEvent(callback: (event: BrokerOrderEvent) => void): void {
    this.eventCallbacks.push(callback);
  }

  /** Adapter health, folding in user-stream staleness and unresolved order state. */
  public getHealth(): AdapterHealth {
    const reasonCodes: string[] = [];
    if (this.running) {
      if (this.userStream) {
        reasonCodes.push(...this.userStream.getHealth().reasonCodes);
      } else {
        reasonCodes.push(USER_STREAM_DISABLED);
      }
      let unknown = false;
      let adjustment = false;
      for (const order of this.orders.values()) {
        if (order.status === 'unknown') unknown = true;
        if (order.adjustmentSeen) adjustment = true;
      }
      if (unknown) reasonCodes.push(ORDER_STATE_UNKNOWN);
      if (adjustment) reasonCodes.push(FILL_ADJUSTMENT_SEEN);
    }
    const degraded = reasonCodes.length > 0;
    return {
      ok: this.running && !degraded,
      degraded,
      reasonCodes,
      lastEventAt: this.lastEventAt,
      pendingOrderCount: [...this.orders.values()].filter((o) => !TERMINAL.has(o.status)).length,
    };
  }

  // ------------------------------------------------------------- user stream

  /**
   * Apply a `user` channel order update: recover exchange ids, emit cumulative fill
   * deltas (deduped on `(order_id, cumulative_quantity)`), and apply terminal statuses.
   * Public so tests / replay tooling can drive it directly.
   */
  public handleUserOrderUpdate(update: UserStreamOrderUpdate): void {
    const tracked = this.findTracked(update.orderId, update.clientOrderId);
    if (!tracked) {
      return; // not placed by this session — boot reconciliation is TASK_013
    }
    this.bindExchangeId(tracked, update.orderId);
    this.ensureAccepted(tracked, update.raw, update.status);

    if (decimalCompare(update.cumulativeQuantity, tracked.emittedQty) > 0) {
      const deltaQty = decimalSub(update.cumulativeQuantity, tracked.emittedQty);
      const avgPrice = safeNumber(update.avgPrice);
      const newValue = avgPrice > 0 ? decimalToNumber(decimalMul(update.cumulativeQuantity, update.avgPrice)) : 0;
      const deltaValue = newValue - tracked.emittedValue;
      const deltaQtyNum = decimalToNumber(deltaQty);
      let price = deltaValue > 0 ? deltaValue / deltaQtyNum : avgPrice;
      if (!(price > 0)) {
        price = tracked.price ? decimalToNumber(tracked.price) : 0;
      }
      const totalFees = safeNumber(update.totalFees) >= 0 ? update.totalFees : '0';
      const feeDelta = decimalCompare(totalFees, tracked.emittedFees) > 0 ? decimalSub(totalFees, tracked.emittedFees) : '0';
      const spec = this.productSpecs.get(tracked.symbol);

      this.emitEvent({
        type: 'fill',
        clientOrderId: tracked.clientOrderId,
        exchangeOrderId: update.orderId,
        tradeId: `${update.orderId}:${update.cumulativeQuantity}`,
        price,
        size: deltaQtyNum,
        fee: decimalToNumber(feeDelta),
        feeCurrency: spec?.quoteCurrency ?? 'USD',
        liquidity: inferLiquidity(tracked),
        ts: parseTimestamp(update.timestamp) ?? this.now(),
        raw: update.raw,
      });

      tracked.emittedQty = update.cumulativeQuantity;
      tracked.emittedFees = decimalCompare(totalFees, tracked.emittedFees) > 0 ? totalFees : tracked.emittedFees;
      tracked.emittedValue = newValue > 0 ? newValue : tracked.emittedValue + deltaQtyNum * price;
      tracked.updatedAt = this.now();
    }

    this.applyStatus(tracked, update.status, {
      rejectReason: update.rejectReason,
      raw: update.raw,
      source: 'user_stream',
    });
  }

  // ------------------------------------------------------------- REST fallback

  private async pollTick(): Promise<void> {
    if (!this.running || this.pollInFlight) return;
    this.pruneTerminal();
    if (!this.needsReconcile()) return;
    this.pollInFlight = true;
    try {
      await this.reconcileTrackedOrders('poll');
    } finally {
      this.pollInFlight = false;
    }
  }

  /**
   * REST reconciliation: (1) resolve `unknown` submits by `client_order_id`, (2) fills for
   * every open or unsettled order, (3) statuses. Fills first so a terminal status is applied
   * after its trade-level fills have been surfaced.
   */
  private async reconcileTrackedOrders(reason: string): Promise<void> {
    if (!this.running) return;

    await this.resolveUnknownSubmits(reason);

    const active = [...this.orders.values()].filter(
      (o) => o.exchangeOrderId && (!TERMINAL.has(o.status) || o.needsFinalReconcile),
    );
    if (active.length === 0) return;
    const ids = active.map((o) => o.exchangeOrderId as string);

    try {
      const fills = await this.client.listFillsAll({ order_ids: ids });
      for (const fill of fills) {
        this.handleRestFill(fill);
      }
    } catch (error) {
      this.logger.warn('Fill reconciliation failed', {
        reason,
        message: error instanceof Error ? error.message : String(error),
      });
    }

    try {
      const orders = await this.client.listOrdersAll({ order_ids: ids });
      for (const order of orders) {
        this.applyOrderTruth(order);
      }
    } catch (error) {
      this.logger.warn('Order status reconciliation failed', {
        reason,
        message: error instanceof Error ? error.message : String(error),
      });
    }

    if (reason === 'poll') {
      for (const order of active) {
        if (order.needsFinalReconcile) {
          order.settlePolls += 1;
          if (order.settlePolls >= SETTLE_POLLS_MAX) {
            order.needsFinalReconcile = false;
            this.logger.warn('Gave up confirming final fills for terminal order', {
              clientOrderId: order.clientOrderId,
              exchangeOrderId: order.exchangeOrderId,
              emittedQty: order.emittedQty,
            });
          }
        }
      }
    }
  }

  /**
   * Orders whose submit outcome is unknown have no exchange id. Coinbase lists them with
   * our `client_order_id`, so search recent orders per product; after
   * `UNKNOWN_POLLS_BEFORE_REJECT` misses the order provably never reached the exchange.
   */
  private async resolveUnknownSubmits(reason: string): Promise<void> {
    const unknown = [...this.orders.values()].filter((o) => o.status === 'unknown' && !o.exchangeOrderId);
    if (unknown.length === 0) return;

    const bySymbol = new Map<string, TrackedOrder[]>();
    for (const order of unknown) {
      const list = bySymbol.get(order.symbol) ?? [];
      list.push(order);
      bySymbol.set(order.symbol, list);
    }

    for (const [symbol, list] of bySymbol) {
      const earliest = Math.min(...list.map((o) => o.createdAt));
      try {
        const recent = await this.client.listOrdersAll({
          product_ids: [symbol],
          start_date: new Date(earliest - UNKNOWN_LOOKBACK_MS).toISOString(),
        });
        for (const order of recent) {
          const tracked = order.client_order_id ? this.orders.get(order.client_order_id) : undefined;
          if (tracked && tracked.status === 'unknown') {
            this.logger.info('Unresolved submit found on exchange — recovering', {
              clientOrderId: tracked.clientOrderId,
              exchangeOrderId: order.order_id,
              status: order.status,
            });
            this.applyOrderTruth(order);
          }
        }
      } catch (error) {
        this.logger.warn('Unresolved submit lookup failed', {
          reason,
          symbol,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (reason !== 'poll') return;
    for (const order of unknown) {
      if (order.status !== 'unknown') continue;
      order.unknownPolls += 1;
      if (order.unknownPolls < UNKNOWN_POLLS_BEFORE_REJECT) continue;
      order.status = 'rejected';
      order.updatedAt = this.now();
      this.logger.error('Submit never reached the exchange — rejecting after REST confirmation', {
        clientOrderId: order.clientOrderId,
        symbol: order.symbol,
        polls: order.unknownPolls,
      });
      this.emitEvent({
        type: 'order_rejected',
        clientOrderId: order.clientOrderId,
        reason: `Order submit could not be confirmed and was not found on the exchange after ${order.unknownPolls} REST checks`,
        code: SUBMIT_UNCONFIRMED,
        ts: this.now(),
      });
    }
  }

  private async reconcileOrder(tracked: TrackedOrder): Promise<void> {
    if (!tracked.exchangeOrderId) return;
    try {
      const fills = await this.client.listFillsAll({ order_ids: [tracked.exchangeOrderId] });
      for (const fill of fills) {
        this.handleRestFill(fill);
      }
      const order = await this.client.getOrder(tracked.exchangeOrderId);
      this.applyOrderTruth(order);
    } catch (error) {
      this.logger.warn('Single-order reconciliation failed', {
        clientOrderId: tracked.clientOrderId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Merge a REST fill without double counting quantity already surfaced from the stream. */
  private handleRestFill(fill: AtFill): void {
    const clientOrderId = this.exchangeToClient.get(fill.order_id);
    const tracked = clientOrderId ? this.orders.get(clientOrderId) : undefined;
    if (!tracked) return;
    if (tracked.restTradeIds.has(fill.trade_id)) return;
    tracked.restTradeIds.add(fill.trade_id);
    if ((fill.trade_type ?? 'FILL') !== 'FILL') {
      // REVERSAL / CORRECTION / SYNTHETIC rows change the order's true quantity; the REST
      // fill sum is no longer authoritative. Surface it loudly and rely on order truth.
      tracked.adjustmentSeen = true;
      tracked.needsFinalReconcile = true;
      this.logger.error('Fill adjustment received — REST fill sum no longer authoritative', {
        clientOrderId: tracked.clientOrderId,
        tradeId: fill.trade_id,
        tradeType: fill.trade_type,
        size: fill.size,
      });
      return;
    }

    const spec = this.productSpecs.get(tracked.symbol);
    const baseSize = fillBaseSize(fill, spec);
    tracked.restCumQty = decimalAdd(tracked.restCumQty, baseSize);
    if (decimalCompare(tracked.restCumQty, tracked.emittedQty) <= 0) {
      return; // already surfaced via the user stream
    }

    const deltaQty = decimalSub(tracked.restCumQty, tracked.emittedQty);
    const fullFill = decimalCompare(deltaQty, baseSize) >= 0;
    const fee = fullFill
      ? safeNumber(fill.commission)
      : (safeNumber(fill.commission) * decimalToNumber(deltaQty)) / Math.max(decimalToNumber(baseSize), Number.EPSILON);
    const price = safeNumber(fill.price);

    this.emitEvent({
      type: 'fill',
      clientOrderId: tracked.clientOrderId,
      exchangeOrderId: fill.order_id,
      tradeId: fill.trade_id,
      price,
      size: decimalToNumber(deltaQty),
      fee,
      feeCurrency: spec?.quoteCurrency ?? 'USD',
      liquidity: fill.liquidity_indicator === 'MAKER' ? 'maker' : 'taker',
      ts: parseTimestamp(fill.trade_time) ?? this.now(),
      raw: fill,
    });

    tracked.emittedQty = tracked.restCumQty;
    tracked.emittedFees = decimalAdd(tracked.emittedFees, String(fee));
    tracked.emittedValue += decimalToNumber(deltaQty) * price;
    tracked.updatedAt = this.now();
  }

  /**
   * Apply a REST order record: bind ids, recover acceptance, surface any remainder that the
   * fills endpoint has not delivered for a terminal order, and apply the status. Also
   * settles cancelled/expired orders once `filled_size` matches what was surfaced.
   */
  private applyOrderTruth(order: AtOrder): void {
    const tracked = this.findTracked(order.order_id, order.client_order_id);
    if (!tracked) return;
    this.bindExchangeId(tracked, order.order_id);
    const status = (order.status ?? '').toUpperCase();
    this.ensureAccepted(tracked, order, status);

    const filledSize = order.filled_size ?? '0';
    if (TERMINAL_EXCHANGE_STATUSES.has(status)) {
      if (decimalCompare(filledSize, tracked.emittedQty) > 0) {
        tracked.filledLagPolls += 1;
        if (tracked.filledLagPolls < TERMINAL_LAG_POLLS_BEFORE_SYNTHETIC && !tracked.adjustmentSeen) {
          tracked.needsFinalReconcile = true;
          return; // give listFills a chance to deliver trade-level fills first
        }
        // Fill feed is lagging (or adjusted); surface the remainder from order truth so PnL is not silently short.
        const deltaQty = decimalSub(filledSize, tracked.emittedQty);
        const price = safeNumber(order.average_filled_price) || (tracked.price ? decimalToNumber(tracked.price) : 0);
        const totalFees = order.total_fees ?? '0';
        const feeDelta = decimalCompare(totalFees, tracked.emittedFees) > 0 ? decimalSub(totalFees, tracked.emittedFees) : '0';
        const spec = this.productSpecs.get(tracked.symbol);
        this.logger.warn('Emitting fill delta from order truth (fills endpoint lagging or adjusted)', {
          clientOrderId: tracked.clientOrderId,
          deltaQty,
          status,
        });
        this.emitEvent({
          type: 'fill',
          clientOrderId: tracked.clientOrderId,
          exchangeOrderId: order.order_id,
          tradeId: `${order.order_id}:${filledSize}`,
          price,
          size: decimalToNumber(deltaQty),
          fee: decimalToNumber(feeDelta),
          feeCurrency: spec?.quoteCurrency ?? 'USD',
          liquidity: inferLiquidity(tracked),
          ts: parseTimestamp(order.last_fill_time) ?? this.now(),
          raw: order,
        });
        tracked.emittedQty = filledSize;
        tracked.emittedFees = decimalCompare(totalFees, tracked.emittedFees) > 0 ? totalFees : tracked.emittedFees;
        tracked.emittedValue += decimalToNumber(deltaQty) * price;
      }
      // Exchange truth and surfaced quantity agree: nothing left to settle.
      tracked.needsFinalReconcile = false;
    }

    this.applyStatus(tracked, status, {
      rejectReason: order.reject_reason || order.reject_message,
      raw: order,
      source: 'rest',
    });
  }

  // ------------------------------------------------------------- internals

  private async loadProductSpecs(): Promise<void> {
    const missing: string[] = [];
    const notTradable: string[] = [];
    for (const symbol of this.symbols) {
      let spec = this.productSpecs.get(symbol);
      if (!spec) {
        try {
          spec = toLiveProductSpec(await this.client.getProduct(symbol));
          this.productSpecs.set(symbol, spec);
        } catch (error) {
          this.logger.error('Product spec load failed', {
            symbol,
            message: error instanceof Error ? error.message : String(error),
          });
          missing.push(symbol);
          continue;
        }
      }
      if (!spec.tradable) {
        notTradable.push(`${symbol} (status=${spec.status}${spec.cancelOnly ? ', cancel_only' : ''})`);
      }
    }
    if (missing.length > 0 || notTradable.length > 0) {
      const parts = [
        missing.length ? `missing: ${missing.join(', ')}` : null,
        notTradable.length ? `not tradable: ${notTradable.join(', ')}` : null,
      ].filter(Boolean);
      throw new Error(`${LIVE_PRODUCT_UNAVAILABLE}: refusing to start live adapter — ${parts.join('; ')}`);
    }
  }

  /** Best-effort cancel of non-terminal tracked orders during stop(); protection children are left resting. */
  private async cancelTrackedOnStop(): Promise<void> {
    const cancellable: TrackedOrder[] = [];
    const protectionLeft: TrackedOrder[] = [];
    for (const tracked of this.orders.values()) {
      if (TERMINAL.has(tracked.status) || !tracked.exchangeOrderId) continue;
      if (tracked.protectionChildOf) {
        protectionLeft.push(tracked);
      } else {
        cancellable.push(tracked);
      }
    }
    if (protectionLeft.length > 0) {
      this.logger.warn('stop(): leaving exchange-side protection orders resting (not cancelled)', {
        orders: protectionLeft.map((o) => ({ clientOrderId: o.clientOrderId, exchangeOrderId: o.exchangeOrderId })),
      });
    }
    if (cancellable.length === 0) return;
    this.logger.warn('stop(): cancelling non-terminal tracked orders', {
      count: cancellable.length,
      clientOrderIds: cancellable.map((o) => o.clientOrderId),
    });
    try {
      const results = await this.client.cancelOrders(cancellable.map((o) => o.exchangeOrderId as string));
      for (const result of results) {
        const clientOrderId = this.exchangeToClient.get(result.order_id);
        const tracked = clientOrderId ? this.orders.get(clientOrderId) : undefined;
        if (!tracked) continue;
        if (result.success) {
          this.markCanceled(tracked, { source: 'stop' });
        } else {
          this.logger.error('stop(): order could not be cancelled — it may still rest on the exchange', {
            clientOrderId: tracked.clientOrderId,
            exchangeOrderId: result.order_id,
            failureReason: result.failure_reason,
          });
        }
      }
    } catch (error) {
      this.logger.error('stop(): batch cancel failed — orders may still rest on the exchange', {
        clientOrderIds: cancellable.map((o) => o.clientOrderId),
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private newTracked(
    request: PlaceOrderRequest,
    baseSize: string,
    limitPrice: string | undefined,
    stopPrice: string | undefined,
  ): TrackedOrder {
    return {
      clientOrderId: request.clientOrderId,
      symbol: request.symbol,
      side: request.side,
      type: request.type,
      requestedQty: baseSize,
      price: limitPrice,
      stopPrice,
      postOnly: Boolean(request.postOnly),
      status: 'pending',
      accepted: false,
      emittedQty: '0',
      emittedFees: '0',
      emittedValue: 0,
      restCumQty: '0',
      restTradeIds: new Set(),
      filledLagPolls: 0,
      unknownPolls: 0,
      needsFinalReconcile: false,
      settlePolls: 0,
      adjustmentSeen: false,
      createdAt: this.now(),
      updatedAt: this.now(),
      request,
    };
  }

  /**
   * Track the attached bracket child so its fills (the position EXIT) are surfaced under
   * `<entry clientOrderId>:protection` instead of being dropped as an unknown order.
   */
  private trackProtectionChild(parent: TrackedOrder, attachedOrderId: string, baseSize: string, raw: unknown): void {
    const childClientId = `${parent.clientOrderId}:protection`;
    if (this.orders.has(childClientId)) return;
    const child: TrackedOrder = {
      ...this.newTracked(
        {
          clientOrderId: childClientId,
          symbol: parent.symbol,
          side: parent.side === 'buy' ? 'sell' : 'buy',
          type: 'stop',
          quantity: decimalToNumber(baseSize),
          metadata: { protectionChildOf: parent.clientOrderId },
        },
        baseSize,
        undefined,
        undefined,
      ),
      exchangeOrderId: attachedOrderId,
      status: 'open',
      accepted: true,
      protectionChildOf: parent.clientOrderId,
    };
    this.orders.set(childClientId, child);
    this.exchangeToClient.set(attachedOrderId, childClientId);
    this.logger.info('Tracking attached protection order', {
      parentClientOrderId: parent.clientOrderId,
      childClientOrderId: childClientId,
      exchangeOrderId: attachedOrderId,
    });
    this.emitEvent({
      type: 'order_accepted',
      clientOrderId: childClientId,
      exchangeOrderId: attachedOrderId,
      ts: this.now(),
      raw: { protectionChildOf: parent.clientOrderId, response: raw },
    });
  }

  private buildOrderBody(
    request: PlaceOrderRequest,
    spec: LiveProductSpec,
    baseSize: string,
    limitPrice: string | undefined,
    stopPrice: string | undefined,
    protection: OrderProtectionMetadata | undefined,
  ): AtCreateOrderBody {
    const side: AtOrderSide = request.side === 'buy' ? 'BUY' : 'SELL';
    const configuration: AtOrderConfiguration = {};
    const metadata = request.metadata ?? {};

    switch (request.type) {
      case 'market': {
        const quoteSize = request.side === 'buy' && metadata.quoteSize !== undefined ? requirePositiveDecimal(metadata.quoteSize, 'metadata.quoteSize') : undefined;
        configuration.market_market_ioc = quoteSize
          ? { quote_size: decimalRoundToIncrement(quoteSize, spec.quoteIncrement, 'down') }
          : { base_size: baseSize };
        break;
      }
      case 'limit': {
        const price = limitPrice as string;
        switch (request.timeInForce) {
          case 'IOC':
            configuration.sor_limit_ioc = { base_size: baseSize, limit_price: price };
            break;
          case 'FOK':
            configuration.limit_limit_fok = { base_size: baseSize, limit_price: price };
            break;
          case 'GTT': {
            const endTime = typeof metadata.endTime === 'string' ? metadata.endTime : undefined;
            if (endTime) {
              configuration.limit_limit_gtd = {
                base_size: baseSize,
                limit_price: price,
                end_time: endTime,
                post_only: Boolean(request.postOnly),
              };
              break;
            }
            configuration.limit_limit_gtc = { base_size: baseSize, limit_price: price, post_only: Boolean(request.postOnly) };
            break;
          }
          default:
            configuration.limit_limit_gtc = { base_size: baseSize, limit_price: price, post_only: Boolean(request.postOnly) };
        }
        break;
      }
      case 'stop': {
        const direction: AtStopDirection =
          metadata.stopDirection === 'up' || metadata.stopDirection === 'STOP_DIRECTION_STOP_UP'
            ? 'STOP_DIRECTION_STOP_UP'
            : metadata.stopDirection === 'down' || metadata.stopDirection === 'STOP_DIRECTION_STOP_DOWN'
              ? 'STOP_DIRECTION_STOP_DOWN'
              : request.side === 'sell'
                ? 'STOP_DIRECTION_STOP_DOWN'
                : 'STOP_DIRECTION_STOP_UP';
        configuration.stop_limit_stop_limit_gtc = {
          base_size: baseSize,
          limit_price: limitPrice as string,
          stop_price: stopPrice as string,
          stop_direction: direction,
        };
        break;
      }
    }

    const body: AtCreateOrderBody = {
      client_order_id: request.clientOrderId,
      product_id: request.symbol,
      side,
      order_configuration: configuration,
    };

    if (request.type !== 'stop' && protection) {
      if (protection.takeProfit === undefined || protection.stopTrigger === undefined) {
        throw new Error('metadata.protection requires both takeProfit and stopTrigger');
      }
      // The bracket exits the position: for a long entry the TP is a sell (round down so it
      // fills no later) and the stop trigger rounds toward earlier triggering.
      const exitSide: 'buy' | 'sell' = request.side === 'buy' ? 'sell' : 'buy';
      body.attached_order_configuration = {
        trigger_bracket_gtc: {
          limit_price: decimalRoundToIncrement(
            requirePositiveDecimal(protection.takeProfit, 'metadata.protection.takeProfit'),
            spec.quoteIncrement,
            exitSide === 'sell' ? 'down' : 'up',
          ),
          stop_trigger_price: decimalRoundToIncrement(
            requirePositiveDecimal(protection.stopTrigger, 'metadata.protection.stopTrigger'),
            spec.quoteIncrement,
            stopTriggerRounding(exitSide),
          ),
        },
      };
    }
    return body;
  }

  private rejectLocal(request: PlaceOrderRequest, code: string, reason: string): void {
    this.logger.warn('Advanced Trade order rejected locally', {
      clientOrderId: request.clientOrderId,
      symbol: request.symbol,
      code,
      reason,
    });
    this.emitEvent({
      type: 'order_rejected',
      clientOrderId: request.clientOrderId,
      reason,
      code,
      ts: this.now(),
    });
  }

  /** Transition to `unknown`: no event yet; REST/user stream decide whether the order exists. */
  private markUnknown(tracked: TrackedOrder, code: string, message: string): void {
    tracked.status = 'unknown';
    tracked.updatedAt = this.now();
    this.logger.error('Advanced Trade order submit outcome UNKNOWN — resolving via REST by client_order_id', {
      clientOrderId: tracked.clientOrderId,
      symbol: tracked.symbol,
      code,
      message,
      resolveAfterPolls: UNKNOWN_POLLS_BEFORE_REJECT,
    });
  }

  private findTracked(exchangeOrderId: string, clientOrderId?: string): TrackedOrder | undefined {
    const viaExchange = this.exchangeToClient.get(exchangeOrderId);
    if (viaExchange) {
      const tracked = this.orders.get(viaExchange);
      if (tracked) return tracked;
    }
    if (clientOrderId) {
      return this.orders.get(clientOrderId);
    }
    return undefined;
  }

  private bindExchangeId(tracked: TrackedOrder, exchangeOrderId: string): void {
    if (!tracked.exchangeOrderId) {
      tracked.exchangeOrderId = exchangeOrderId;
    }
    if (!this.exchangeToClient.has(exchangeOrderId)) {
      this.exchangeToClient.set(exchangeOrderId, tracked.clientOrderId);
    }
  }

  /**
   * Emit `order_accepted` for orders the exchange reports before/without a submit
   * response (fast fills racing the HTTP reply, or an unknown outcome after a transport
   * failure). A first sighting that is already FAILED is not an acceptance.
   */
  private ensureAccepted(tracked: TrackedOrder, raw: unknown, exchangeStatus: string): void {
    if (tracked.accepted) return;
    if (exchangeStatus === 'FAILED') return;
    if (tracked.status === 'unknown') {
      this.logger.info('Order with unknown submit outcome EXISTS on exchange — recovered', {
        clientOrderId: tracked.clientOrderId,
        exchangeOrderId: tracked.exchangeOrderId,
      });
    }
    tracked.accepted = true;
    tracked.status = 'open';
    tracked.updatedAt = this.now();
    this.emitEvent({
      type: 'order_accepted',
      clientOrderId: tracked.clientOrderId,
      exchangeOrderId: tracked.exchangeOrderId,
      ts: this.now(),
      raw,
    });
  }

  private applyStatus(
    tracked: TrackedOrder,
    status: string,
    context: { rejectReason?: string; raw: unknown; source: string },
  ): void {
    if (TERMINAL.has(tracked.status)) return;
    switch (status) {
      case 'FILLED':
        tracked.status = 'filled';
        tracked.updatedAt = this.now();
        if (decimalCompare(tracked.emittedQty, tracked.requestedQty) < 0 && context.source === 'user_stream') {
          this.logger.info('Order FILLED with less base quantity than requested (quote-sized or rounding)', {
            clientOrderId: tracked.clientOrderId,
            emittedQty: tracked.emittedQty,
            requestedQty: tracked.requestedQty,
          });
        }
        break;
      case 'CANCELLED':
      case 'EXPIRED':
        this.markCanceled(tracked, { source: context.source, raw: context.raw });
        break;
      case 'FAILED':
        tracked.status = 'rejected';
        tracked.updatedAt = this.now();
        this.emitEvent({
          type: 'order_rejected',
          clientOrderId: tracked.clientOrderId,
          reason: context.rejectReason || 'Order FAILED on exchange',
          code: context.rejectReason || 'FAILED',
          ts: this.now(),
          raw: context.raw,
        });
        break;
      case 'OPEN':
      case 'PENDING':
      case 'QUEUED':
      case 'CANCEL_QUEUED':
      case 'EDIT_QUEUED':
        if ((tracked.status === 'pending' || tracked.status === 'unknown') && status === 'OPEN') {
          tracked.status = 'open';
        }
        break;
      default:
        break;
    }
  }

  /**
   * Confirmed cancellation. Fills that executed just before the cancel may not have been
   * surfaced yet, so the order stays in the REST reconcile set until `filled_size` agrees.
   */
  private markCanceled(tracked: TrackedOrder, context: { source: string; raw?: unknown }): void {
    if (TERMINAL.has(tracked.status)) return;
    tracked.status = 'canceled';
    tracked.needsFinalReconcile = true;
    tracked.updatedAt = this.now();
    this.logger.info('Order cancelled (confirmed)', {
      clientOrderId: tracked.clientOrderId,
      exchangeOrderId: tracked.exchangeOrderId,
      source: context.source,
    });
    this.emitEvent({
      type: 'order_canceled',
      clientOrderId: tracked.clientOrderId,
      exchangeOrderId: tracked.exchangeOrderId,
      ts: this.now(),
      raw: context.raw,
    });
  }

  private needsReconcile(): boolean {
    for (const order of this.orders.values()) {
      if (!TERMINAL.has(order.status) || order.needsFinalReconcile) return true;
    }
    return false;
  }

  private pruneTerminal(): void {
    const cutoff = this.now() - TERMINAL_RETENTION_MS;
    for (const [clientOrderId, order] of this.orders) {
      if (TERMINAL.has(order.status) && !order.needsFinalReconcile && order.updatedAt < cutoff) {
        this.orders.delete(clientOrderId);
        if (order.exchangeOrderId) this.exchangeToClient.delete(order.exchangeOrderId);
      }
    }
    if (this.orders.size > MAX_TRACKED_ORDERS) {
      const terminal = [...this.orders.values()]
        .filter((o) => TERMINAL.has(o.status) && !o.needsFinalReconcile)
        .sort((a, b) => a.updatedAt - b.updatedAt);
      for (const order of terminal.slice(0, this.orders.size - MAX_TRACKED_ORDERS)) {
        this.orders.delete(order.clientOrderId);
        if (order.exchangeOrderId) this.exchangeToClient.delete(order.exchangeOrderId);
      }
    }
  }

  private toOpenOrder(order: AtOrder): OpenOrder {
    const config = order.order_configuration ?? {};
    const baseSize =
      config.limit_limit_gtc?.base_size ??
      config.limit_limit_gtd?.base_size ??
      config.limit_limit_fok?.base_size ??
      config.sor_limit_ioc?.base_size ??
      config.stop_limit_stop_limit_gtc?.base_size ??
      config.stop_limit_stop_limit_gtd?.base_size ??
      config.trigger_bracket_gtc?.base_size ??
      config.market_market_ioc?.base_size ??
      order.filled_size ??
      '0';
    const price =
      config.limit_limit_gtc?.limit_price ??
      config.limit_limit_gtd?.limit_price ??
      config.limit_limit_fok?.limit_price ??
      config.sor_limit_ioc?.limit_price ??
      config.stop_limit_stop_limit_gtc?.limit_price ??
      config.stop_limit_stop_limit_gtd?.limit_price ??
      config.trigger_bracket_gtc?.limit_price;
    const type = (order.order_type ?? '').toUpperCase();
    return {
      clientOrderId: order.client_order_id || order.order_id,
      exchangeOrderId: order.order_id,
      symbol: order.product_id,
      side: order.side === 'SELL' ? 'sell' : 'buy',
      type: type === 'MARKET' ? 'market' : type.startsWith('STOP') || type === 'BRACKET' ? 'stop' : 'limit',
      price: price !== undefined ? safeNumber(price) : undefined,
      quantity: safeNumber(baseSize),
      filledQuantity: safeNumber(order.filled_size ?? '0'),
      status: (order.status ?? '').toLowerCase(),
      createdAt: parseTimestamp(order.created_time) ?? 0,
    };
  }

  private toFillRecord(fill: AtFill): FillRecord {
    const clientOrderId = this.exchangeToClient.get(fill.order_id);
    const spec = this.productSpecs.get(fill.product_id);
    return {
      tradeId: fill.trade_id,
      orderId: fill.order_id,
      clientOrderId,
      symbol: fill.product_id,
      side: fill.side === 'SELL' ? 'sell' : 'buy',
      price: safeNumber(fill.price),
      size: decimalToNumber(fillBaseSize(fill, spec)),
      fee: safeNumber(fill.commission),
      feeCurrency: spec?.quoteCurrency ?? fill.product_id.split('-')[1] ?? 'USD',
      liquidity: fill.liquidity_indicator === 'MAKER' ? 'maker' : 'taker',
      ts: parseTimestamp(fill.trade_time) ?? 0,
    };
  }

  private emitEvent(event: BrokerOrderEvent): void {
    this.lastEventAt = this.now();
    for (const callback of this.eventCallbacks) {
      try {
        callback(event);
      } catch (error) {
        this.logger.error('Event callback error', {
          eventType: event.type,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    this.emit('broker:event', event);
    this.emit(`broker:${event.type}`, event);
  }
}

// ============================================================================
// Helpers
// ============================================================================

function isTransientError(error: unknown): boolean {
  if (error instanceof CoinbaseNetworkError) return true;
  if (error instanceof CoinbaseApiError) {
    return error.kind === 'rate_limit' || error.kind === 'server' || error.kind === 'timeout';
  }
  return false;
}

/**
 * Errors that prove the request was refused BEFORE processing (safe to reject outright).
 * Anything else — timeouts, network, 5xx, body-read failures, unexpected throws — leaves
 * the outcome unknown.
 */
function isDefinitiveReject(error: unknown): boolean {
  if (!(error instanceof CoinbaseApiError)) return false;
  return ['auth', 'not_found', 'bad_request', 'rate_limit', 'post_only', 'insufficient_funds', 'order_rejected'].includes(error.kind);
}

/** Limit prices round in the side-conservative direction: buys never pay more, sells never receive less. */
function limitRounding(side: 'buy' | 'sell'): DecimalRoundingMode {
  return side === 'buy' ? 'down' : 'up';
}

/** Stop triggers round toward earlier triggering: sell stops up, buy stops down. */
function stopTriggerRounding(side: 'buy' | 'sell'): DecimalRoundingMode {
  return side === 'sell' ? 'up' : 'down';
}

/** Base-currency size of a fill (quote-sized fills report `size` in quote currency). */
function fillBaseSize(fill: AtFill, spec: LiveProductSpec | undefined): string {
  if (!fill.size_in_quote) return fill.size;
  const price = safeNumber(fill.price);
  if (!(price > 0)) return '0';
  const raw = decimalDiv(fill.size, fill.price, 12);
  return decimalRoundToIncrement(raw, spec?.baseIncrement ?? '0.00000001', 'nearest');
}

function requirePositiveDecimal(value: unknown, label: string): string {
  const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : '';
  const parsed = Number.parseFloat(text);
  if (!text || !Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive decimal, got ${JSON.stringify(value)}`);
  }
  return text;
}

function inferLiquidity(tracked: TrackedOrder): 'maker' | 'taker' {
  if (tracked.type === 'limit' && tracked.postOnly) return 'maker';
  return 'taker';
}

function safeNumber(value: string | number | undefined): number {
  if (value === undefined || value === null || value === '') return 0;
  const parsed = typeof value === 'number' ? value : Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseTimestamp(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function fillsCursorToParams(cursor: unknown): {
  start_sequence_timestamp?: string;
  product_ids?: string[];
  order_ids?: string[];
} {
  if (typeof cursor === 'number' && Number.isFinite(cursor) && cursor > 0) {
    return { start_sequence_timestamp: new Date(cursor).toISOString() };
  }
  if (typeof cursor === 'string' && cursor && Number.isFinite(Date.parse(cursor))) {
    return { start_sequence_timestamp: new Date(Date.parse(cursor)).toISOString() };
  }
  if (cursor && typeof cursor === 'object') {
    const record = cursor as { since?: number | string; productIds?: string[]; orderIds?: string[] };
    const since =
      typeof record.since === 'number'
        ? new Date(record.since).toISOString()
        : typeof record.since === 'string' && Number.isFinite(Date.parse(record.since))
          ? new Date(Date.parse(record.since)).toISOString()
          : undefined;
    return {
      start_sequence_timestamp: since,
      product_ids: record.productIds?.length ? record.productIds : undefined,
      order_ids: record.orderIds?.length ? record.orderIds : undefined,
    };
  }
  return {};
}
