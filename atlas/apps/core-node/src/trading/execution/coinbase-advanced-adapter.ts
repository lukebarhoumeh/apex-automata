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
 *   attached `trigger_bracket_gtc` from `metadata.protection`).
 * - Sizes/prices as decimal STRINGS, size rounded DOWN to `base_increment`, prices
 *   rounded to `quote_increment` — using exact BigInt arithmetic, never floats.
 * - Reject locally (no HTTP) when the product is unknown/not tradable, size is below
 *   `base_min_size`, notional is below `quote_min_size`, or a spot sell exceeds the
 *   available base balance (when a balance lookup is wired — TASK_012).
 * - `success:false` ⇒ `order_rejected {code, reason}`; `success:true` ⇒ `order_accepted`.
 * - Cancel emits `order_canceled` only on CONFIRMED success from `batch_cancel`.
 * - Fills: user stream is primary (cumulative-quantity deltas, deduped per
 *   `(order_id, cumulative_quantity)`); REST `listFills` polling every 5s while any
 *   order is open is the fallback, merged without double counting.
 * - Health: degraded with `USER_STREAM_STALE` / `USER_STREAM_DISCONNECTED` when the
 *   stream is unhealthy, `USER_STREAM_DISABLED` when running on polling only.
 *
 * Out of scope here (TASK_013): enforcing that every entry carries exchange-side
 * protection and boot-time reconciliation of orders from previous sessions. The
 * bracket mapping is implemented so TASK_013 can switch it on.
 */

import { EventEmitter } from 'events';
import { Logger } from '../../core/logger';
import {
  decimalAdd,
  decimalCompare,
  decimalIsZero,
  decimalMul,
  decimalRoundToIncrement,
  decimalSub,
  decimalToNumber,
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
  now?: () => number;
}

type TrackedStatus = 'pending' | 'open' | 'filled' | 'canceled' | 'rejected';

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
  /** Quantity already surfaced as `fill` events (decimal string). */
  emittedQty: string;
  /** Fees already surfaced (decimal string). */
  emittedFees: string;
  /** Notional already surfaced (float, informational — used to derive delta prices). */
  emittedValue: number;
  /** Cumulative size seen through REST fills (decimal string). */
  restCumQty: string;
  restTradeIds: Set<string>;
  /** Polls spent waiting for REST fills to catch up with a FILLED status. */
  filledLagPolls: number;
  createdAt: number;
  updatedAt: number;
  request: PlaceOrderRequest;
}

export const LIVE_PRODUCT_UNAVAILABLE = 'LIVE_PRODUCT_UNAVAILABLE';
export const USER_STREAM_DISABLED = 'USER_STREAM_DISABLED';

const DEFAULT_FILL_POLL_MS = 5_000;
const TERMINAL_RETENTION_MS = 60 * 60 * 1000;
const MAX_TRACKED_ORDERS = 5_000;
const FILLED_LAG_POLLS_BEFORE_SYNTHETIC = 3;
const TERMINAL: ReadonlySet<TrackedStatus> = new Set(['filled', 'canceled', 'rejected']);

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
    });
  }

  /** Stop polling, detach and close the user stream, clear session tracking. */
  public async stop(): Promise<void> {
    if (!this.running) return;
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
   * Place an order. Emits exactly one of `order_accepted` / `order_rejected`; fills
   * follow via the user stream or the poll fallback.
   */
  public async placeOrder(request: PlaceOrderRequest): Promise<void> {
    if (!this.running) {
      throw new Error('Advanced Trade live adapter not running');
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
      limitPrice = decimalRoundToIncrement(request.price, spec.quoteIncrement, 'nearest');
    }
    if (request.type === 'stop') {
      if (request.stopPrice === undefined || !Number.isFinite(request.stopPrice) || request.stopPrice <= 0) {
        return this.rejectLocal(request, 'STOP_PRICE_REQUIRED', 'stop orders require a positive stopPrice');
      }
      stopPrice = decimalRoundToIncrement(request.stopPrice, spec.quoteIncrement, 'nearest');
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

    const body = this.buildOrderBody(request, spec, baseSize, limitPrice, stopPrice);

    const tracked: TrackedOrder = {
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
      createdAt: this.now(),
      updatedAt: this.now(),
      request,
    };
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
          tracked.exchangeOrderId = result.orderId;
          tracked.accepted = true;
          tracked.status = request.type === 'market' ? 'pending' : 'open';
          tracked.updatedAt = this.now();
          this.exchangeToClient.set(result.orderId, request.clientOrderId);
          this.emitEvent({
            type: 'order_accepted',
            clientOrderId: request.clientOrderId,
            exchangeOrderId: result.orderId,
            ts: this.now(),
            raw: result.raw,
          });
        } else {
          this.orders.delete(request.clientOrderId);
          this.emitEvent({
            type: 'order_rejected',
            clientOrderId: request.clientOrderId,
            reason: result.message,
            code: result.code,
            ts: this.now(),
            raw: result.raw,
          });
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
        const code = error instanceof CoinbaseApiError ? error.coinbaseCode ?? error.kind : transient ? 'TRANSPORT_ERROR' : 'SUBMIT_ERROR';
        const message = error instanceof Error ? error.message : String(error);
        // The order may still exist on the exchange after a transport failure; keep the
        // tracked record so a later user-stream update can reconcile it (truth wins).
        tracked.status = 'rejected';
        tracked.updatedAt = this.now();
        if (!transient) {
          this.orders.delete(request.clientOrderId);
        }
        this.logger.error('Advanced Trade order submit failed', {
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
    }
  }

  /** Cancel by client order id. `order_canceled` is emitted ONLY on confirmed success. */
  public async cancelOrder(clientOrderId: string): Promise<void> {
    if (!this.running) {
      throw new Error('Advanced Trade live adapter not running');
    }
    const tracked = this.orders.get(clientOrderId);
    if (!tracked?.exchangeOrderId) {
      this.logger.warn('Cannot cancel — no exchange order id for client order', { clientOrderId });
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

  /** Cancel every open order (optionally one symbol) via `batch_cancel`. */
  public async cancelAllOrders(symbol?: string): Promise<void> {
    if (!this.running) {
      throw new Error('Advanced Trade live adapter not running');
    }

    const targets = new Map<string, string | undefined>(); // exchangeOrderId → clientOrderId
    for (const tracked of this.orders.values()) {
      if (tracked.exchangeOrderId && !TERMINAL.has(tracked.status) && (!symbol || tracked.symbol === symbol)) {
        targets.set(tracked.exchangeOrderId, tracked.clientOrderId);
      }
    }
    try {
      const open = await this.client.listOrdersAll({
        order_status: ['OPEN'],
        product_ids: symbol ? [symbol] : undefined,
      });
      for (const order of open) {
        if (!targets.has(order.order_id)) {
          targets.set(order.order_id, order.client_order_id || undefined);
        }
      }
    } catch (error) {
      this.logger.warn('cancelAllOrders: listing open orders failed; cancelling locally tracked orders only', {
        symbol,
        message: error instanceof Error ? error.message : String(error),
      });
    }
    if (targets.size === 0) return;

    let results;
    try {
      results = await this.client.cancelOrders([...targets.keys()]);
    } catch (error) {
      this.logger.error('Advanced Trade batch cancel failed', {
        symbol,
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
      } else if (clientOrderId) {
        this.emitEvent({
          type: 'order_canceled',
          clientOrderId,
          exchangeOrderId: result.order_id,
          ts: this.now(),
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
   * `{ since?, productIds?, orderIds? }`. Paginates `listFills`.
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

  /** Adapter health, folding in user-stream staleness. */
  public getHealth(): AdapterHealth {
    const reasonCodes: string[] = [];
    if (this.running) {
      if (this.userStream) {
        reasonCodes.push(...this.userStream.getHealth().reasonCodes);
      } else {
        reasonCodes.push(USER_STREAM_DISABLED);
      }
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
    this.ensureAccepted(tracked, update.raw);

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
    if (!this.hasOpenOrders()) return;
    this.pollInFlight = true;
    try {
      await this.reconcileTrackedOrders('poll');
    } finally {
      this.pollInFlight = false;
    }
  }

  /** REST reconciliation of every non-terminal tracked order (fills first, then statuses). */
  private async reconcileTrackedOrders(reason: string): Promise<void> {
    if (!this.running) return;
    const open = [...this.orders.values()].filter((o) => o.exchangeOrderId && !TERMINAL.has(o.status));
    if (open.length === 0) return;
    const ids = open.map((o) => o.exchangeOrderId as string);

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
      this.logger.warn('Non-standard fill type ignored', { tradeId: fill.trade_id, tradeType: fill.trade_type });
      return;
    }

    tracked.restCumQty = decimalAdd(tracked.restCumQty, fill.size);
    if (decimalCompare(tracked.restCumQty, tracked.emittedQty) <= 0) {
      return; // already surfaced via the user stream
    }

    const deltaQty = decimalSub(tracked.restCumQty, tracked.emittedQty);
    const fullFill = decimalCompare(deltaQty, fill.size) >= 0;
    const fee = fullFill
      ? safeNumber(fill.commission)
      : (safeNumber(fill.commission) * decimalToNumber(deltaQty)) / Math.max(safeNumber(fill.size), Number.EPSILON);
    const price = safeNumber(fill.price);
    const spec = this.productSpecs.get(tracked.symbol);

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

  /** Apply a REST order record (status + id binding; fills come from `listFills`). */
  private applyOrderTruth(order: AtOrder): void {
    const tracked = this.findTracked(order.order_id, order.client_order_id);
    if (!tracked) return;
    this.bindExchangeId(tracked, order.order_id);
    this.ensureAccepted(tracked, order);

    const status = (order.status ?? '').toUpperCase();
    const filledSize = order.filled_size ?? '0';
    if (status === 'FILLED' && decimalCompare(filledSize, tracked.emittedQty) > 0) {
      tracked.filledLagPolls += 1;
      if (tracked.filledLagPolls < FILLED_LAG_POLLS_BEFORE_SYNTHETIC) {
        return; // give listFills a chance to deliver trade-level fills first
      }
      // Fill feed is lagging; surface the remainder from order truth so PnL is not silently short.
      const deltaQty = decimalSub(filledSize, tracked.emittedQty);
      const price = safeNumber(order.average_filled_price) || (tracked.price ? decimalToNumber(tracked.price) : 0);
      const totalFees = order.total_fees ?? '0';
      const feeDelta = decimalCompare(totalFees, tracked.emittedFees) > 0 ? decimalSub(totalFees, tracked.emittedFees) : '0';
      const spec = this.productSpecs.get(tracked.symbol);
      this.logger.warn('Emitting synthetic fill delta from order truth (fills endpoint lagging)', {
        clientOrderId: tracked.clientOrderId,
        deltaQty,
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

  private buildOrderBody(
    request: PlaceOrderRequest,
    spec: LiveProductSpec,
    baseSize: string,
    limitPrice: string | undefined,
    stopPrice: string | undefined,
  ): AtCreateOrderBody {
    const side: AtOrderSide = request.side === 'buy' ? 'BUY' : 'SELL';
    const configuration: AtOrderConfiguration = {};
    const metadata = request.metadata ?? {};

    switch (request.type) {
      case 'market': {
        const quoteSize = request.side === 'buy' && metadata.quoteSize !== undefined ? String(metadata.quoteSize) : undefined;
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

    const protection = metadata.protection as OrderProtectionMetadata | undefined;
    if (request.type !== 'stop' && protection && protection.takeProfit !== undefined && protection.stopTrigger !== undefined) {
      body.attached_order_configuration = {
        trigger_bracket_gtc: {
          limit_price: decimalRoundToIncrement(String(protection.takeProfit), spec.quoteIncrement, 'nearest'),
          stop_trigger_price: decimalRoundToIncrement(String(protection.stopTrigger), spec.quoteIncrement, 'nearest'),
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

  /** Emit `order_accepted` for orders whose submit response was lost (transport failure). */
  private ensureAccepted(tracked: TrackedOrder, raw: unknown): void {
    if (tracked.accepted) return;
    if (tracked.status === 'rejected') {
      this.logger.warn('Order rejected locally after transport failure but EXISTS on exchange — recovering', {
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
        if (tracked.status === 'pending' && status === 'OPEN') {
          tracked.status = 'open';
        }
        break;
      default:
        break;
    }
  }

  private markCanceled(tracked: TrackedOrder, context: { source: string; raw?: unknown }): void {
    if (TERMINAL.has(tracked.status)) return;
    tracked.status = 'canceled';
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

  private hasOpenOrders(): boolean {
    for (const order of this.orders.values()) {
      if (!TERMINAL.has(order.status)) return true;
    }
    return false;
  }

  private pruneTerminal(): void {
    const cutoff = this.now() - TERMINAL_RETENTION_MS;
    for (const [clientOrderId, order] of this.orders) {
      if (TERMINAL.has(order.status) && order.updatedAt < cutoff) {
        this.orders.delete(clientOrderId);
        if (order.exchangeOrderId) this.exchangeToClient.delete(order.exchangeOrderId);
      }
    }
    if (this.orders.size > MAX_TRACKED_ORDERS) {
      const terminal = [...this.orders.values()]
        .filter((o) => TERMINAL.has(o.status))
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
      size: safeNumber(fill.size),
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
