import { EventEmitter } from 'events';
import { Logger } from '../core/logger';
import { OrderRequest, Fill, Ticker } from '../exchanges/coinbase/types';
import { FeeModel, Exchange, Side, contractsForSize } from '../core/fee-model';
import { marketForSymbol } from '../core/symbol-utils';
import { decimalRoundToIncrement, decimalToNumber } from '../core/decimal';
import type { FeeSide } from './fee-side';
import { v4 as uuidv4 } from 'uuid';

/**
 * Venue contract spec for symbols that trade in contracts (CFM / CDE nano
 * futures). Sizes still flow through the simulator in UNDERLYING units; the
 * spec converts to contracts at the venue boundary (lot rounding + the
 * per-contract exchange floor) and aligns limit prices to the venue tick.
 */
export interface PaperContractSpec {
  /** Underlying units per contract (BIP: 0.01 BTC). */
  contractSize: number;
  /** Minimum price fluctuation per underlying unit, USD (BIP: $5 per BTC). */
  priceIncrementUsd: number;
}

/** Top-of-book quote the simulator prices against. */
export interface PaperQuote {
  bid: number;
  ask: number;
  last: number;
}

export interface PaperTradingConfig {
  initialBalances: Map<string, number>; // currency -> amount (e.g., 'USD' -> 10000, 'BTC' -> 0)

  // Fee resolution — preferred path is `feeModel` + `venue` so per-symbol
  // perps vs spot vs cfm is routed to the correct tier in guardrails.yaml. The
  // flat `makerFee`/`takerFee` decimals remain as a fallback so existing
  // tests + single-venue setups keep working without a FeeModel instance.
  //
  // Sourcing precedence per fill (see `resolveFeeRate` / `computeFillFee`):
  //   1. feeModel.computeFillFeeUsd(venue, market(symbol), side, notional, contracts)
  //      — venue/market-aware, cost-plus aware (CFM: % + $/contract, stacked)
  //   2. flat makerFee/takerFee — legacy single-rate fallback
  //   3. throw — never silently zero
  //
  // The flat values MUST be sourced from FeeModel.getFeeRate(...) at the
  // call site if used — see TradingEngine.initializePaperSimulator. Do not
  // hardcode fee constants here or at any other call site.
  feeModel?: FeeModel;
  /** Default venue for symbol classification. Defaults to 'coinbase'. */
  venue?: Exchange;
  makerFee?: number;
  takerFee?: number;

  slippage: number; // 0.001 for 0.1% base slippage
  latencyMs: number; // Simulated order latency

  // Advanced realism settings
  depthAware?: boolean;           // Enable depth-aware price impact
  simulatedBookDepthUsd?: number; // Simulated book depth per price level (default $50k)
  avgDailyVolumeUsd?: number;     // Average daily volume for slippage calculation
  enablePartialFills?: boolean;   // Enable partial fills for large orders
  maxPartialFillPct?: number;     // Max fill percentage per tick (default 25%)

  /**
   * Contract specs for symbols that trade in contracts (`guardrails.cfm_symbols`).
   * Symbols absent from this map trade in plain underlying units with no lot
   * or tick constraint (spot / INTX paper behaviour, unchanged).
   */
  contractSpecs?: Record<string, PaperContractSpec>;
}

/** Structured reject codes for paper order validation (mapped to `paper_validation` by the engine). */
export type PaperRejectCode =
  | 'INVALID_SIZE'
  | 'INSUFFICIENT_BALANCE'
  | 'NO_MARKET_DATA'
  | 'POST_ONLY_WOULD_CROSS'
  | 'BELOW_MIN_CONTRACT'
  | 'ORDER_NOT_EDITABLE';

/**
 * A paper order (or edit) the simulator refused. Carries a machine-readable
 * `code` so the engine reports it as a `paper_validation` rejection and the
 * router persists it as an attributable miss (card metric: post-only accept %).
 */
export class PaperOrderRejectedError extends Error {
  public readonly code: PaperRejectCode;
  public readonly details?: Record<string, unknown>;

  constructor(code: PaperRejectCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'PaperOrderRejectedError';
    this.code = code;
    this.details = details;
  }
}

/** Order-operation counters for the session (card metric: 429 / edit count). */
export interface PaperOrderOpsStats {
  placed: number;
  filled: number;
  cancelled: number;
  /** Successful in-place `editOrder` calls (edit > cancel+new). */
  edited: number;
  /** Post-only orders refused because they would have crossed (miss logged, never chased). */
  postOnlyRejected: number;
  /** Edits refused because the new price would have crossed a post-only order. */
  editRejected: number;
  /** Fills attributed maker / taker (fee_side mix). */
  makerFills: number;
  takerFills: number;
}

// TWAP order tracking
interface TWAPOrder {
  parentOrderId: string;
  productId: string;
  side: 'buy' | 'sell';
  totalSize: number;
  remainingSize: number;
  sliceSize: number;
  numSlices: number;
  executedSlices: number;
  startTime: Date;
  endTime: Date;
  childOrderIds: string[];
  status: 'active' | 'completed' | 'cancelled';
}

interface SimulatedOrder {
  id: string;
  clientOrderId: string;
  productId: string;
  side: 'buy' | 'sell';
  type: 'limit' | 'market' | 'stop';
  size: number;
  price?: number;
  postOnly: boolean;
  status: SimulatedOrderStatus;
  filledSize: number;
  executedValue: number;
  createdAt: Date;
  updatedAt: Date;
  fills: Fill[];
  /** Times this order was re-quoted in place via `editOrder`. */
  editCount: number;
}

type SimulatedOrderStatus = 'pending' | 'open' | 'done' | 'cancelled' | 'rejected';

interface PaperOrderResponse {
  id: string;
  product_id: string;
  side: 'buy' | 'sell';
  type: 'limit' | 'market' | 'stop';
  size: string;
  price?: string;
  post_only: boolean;
  status: SimulatedOrderStatus;
  filled_size: string;
  executed_value: string;
  created_at: string;
  fill_fees: string;
  settled: boolean;
}

export class PaperTradingSimulator extends EventEmitter {
  private config: PaperTradingConfig;
  private logger: Logger;
  private balances: Map<string, number>;
  private orders: Map<string, SimulatedOrder> = new Map();
  private marketPrices: Map<string, number> = new Map();
  private quotes: Map<string, PaperQuote> = new Map();
  private quoteUpdatedAt: Map<string, number> = new Map();
  /** Symbol used to mark a non-USD balance bucket (e.g. BIP → BIP-20DEC30-CDE). */
  private markSymbolByCurrency: Map<string, string> = new Map();
  private orderSequence = 0;
  private fillSequence = 0;
  private ops: PaperOrderOpsStats = emptyOpsStats();

  // Realized P&L tracking (mirrors position-tracker.ts pattern)
  private realizedPnL: number = 0;
  private costBasis: Map<string, { totalCost: number; size: number }> = new Map();

  // TWAP order tracking
  private twapOrders: Map<string, TWAPOrder> = new Map();
  private twapTimer: NodeJS.Timeout | null = null;

  constructor(config: PaperTradingConfig, logger: Logger) {
    super();
    this.config = {
      // Defaults for new realism settings
      depthAware: true,
      simulatedBookDepthUsd: 50000,
      avgDailyVolumeUsd: 1000000,
      enablePartialFills: false,
      maxPartialFillPct: 0.25,
      venue: 'coinbase',
      ...config,
    };
    this.logger = logger;
    this.balances = new Map(config.initialBalances);

    if (!this.config.feeModel && this.config.makerFee === undefined && this.config.takerFee === undefined) {
      throw new Error(
        'PaperTradingSimulator: either `feeModel` or both `makerFee` + `takerFee` must be provided. ' +
          'Fees come from guardrails.yaml — see TradingEngine.initializePaperSimulator.',
      );
    }
  }

  /**
   * Resolve the maker/taker fee RATE (decimal, NOT bps) for a fill on
   * `symbol`. Honors the precedence documented on PaperTradingConfig.
   *
   * The fix this method exists to deliver: prior to 2026-05-14 the simulator
   * stored a SINGLE makerFee/takerFee pair (configured to Coinbase spot
   * rates) and applied it to every symbol, so paper trades on
   * `*-PERP-INTX` were charged ~40 bps taker (spot) instead of the
   * configured ~5 bps (perps_intx). That biased every perp paper EV
   * number by ~55 bps round-trip. See SPRINT-PLAN-FINAL.md §1.4 / B5.
   *
   * Symbol classification (perps vs spot vs cfm) is delegated to
   * `core/symbol-utils.marketForSymbol` so backtest + paper agree.
   *
   * NOTE: for cost-plus books (CFM) this is the percentage leg only; the
   * per-contract floor is added by `computeFillFee`.
   */
  private resolveFeeRate(symbol: string, side: Side): number {
    if (this.config.feeModel) {
      return this.config.feeModel.getFeeRate(
        this.config.venue ?? 'coinbase',
        marketForSymbol(symbol),
        side,
      );
    }
    const flat = side === 'taker' ? this.config.takerFee : this.config.makerFee;
    if (flat === undefined) {
      throw new Error(
        `PaperTradingSimulator: no fee rate configured for side='${side}'. ` +
          'Provide a FeeModel or both makerFee + takerFee.',
      );
    }
    return flat;
  }

  /**
   * All-in fee for a fill plus its cost-plus breakdown. With a FeeModel the
   * computation is exact-decimal and cost-plus aware (CFM: `notional × rate +
   * contracts × $/ct`, legs reported separately); the legacy flat-rate path
   * has no exchange leg.
   */
  private computeFillFee(
    symbol: string,
    side: Side,
    size: number,
    price: number,
  ): { fee: number; commission: string; exchangeFee: string; contracts?: string } {
    const spec = this.contractSpecFor(symbol);
    const contracts = spec ? contractsForSize(String(size), String(spec.contractSize)) : undefined;
    const notional = size * price;
    if (this.config.feeModel) {
      const breakdown = this.config.feeModel.computeFillFeeUsd({
        exchange: this.config.venue ?? 'coinbase',
        market: marketForSymbol(symbol),
        side,
        notionalUsd: String(notional),
        contracts,
      });
      return {
        fee: decimalToNumber(breakdown.totalUsd),
        commission: breakdown.commissionUsd,
        exchangeFee: breakdown.exchangeFeeUsd,
        contracts,
      };
    }
    const rate = this.resolveFeeRate(symbol, side);
    const fee = notional * rate;
    return { fee, commission: String(fee), exchangeFee: '0', contracts };
  }

  private contractSpecFor(symbol: string): PaperContractSpec | undefined {
    return this.config.contractSpecs?.[symbol];
  }

  /**
   * Calculate depth-aware price impact for market orders.
   * Larger orders relative to book depth = more slippage.
   */
  private calculatePriceImpact(notionalUsd: number, side: 'buy' | 'sell'): number {
    if (!this.config.depthAware) {
      return this.config.slippage;
    }

    const bookDepth = this.config.simulatedBookDepthUsd || 50000;
    const avgVolume = this.config.avgDailyVolumeUsd || 1000000;

    // Base slippage + depth impact + volume impact
    const depthImpact = (notionalUsd / bookDepth) * 0.001; // 0.1% per full book depth
    const volumeImpact = (notionalUsd / avgVolume) * 0.0005; // 0.05% per avg daily volume

    const totalImpact = this.config.slippage + depthImpact + volumeImpact;

    // Cap slippage at 2%
    return Math.min(totalImpact, 0.02);
  }

  /**
   * Create a TWAP order that executes over a time period.
   */
  public async createTWAPOrder(
    productId: string,
    side: 'buy' | 'sell',
    totalSize: number,
    durationMs: number,
    numSlices: number = 10
  ): Promise<{ parentOrderId: string; sliceSize: number }> {
    const parentOrderId = uuidv4();
    const sliceSize = totalSize / numSlices;
    const sliceIntervalMs = durationMs / numSlices;

    const twapOrder: TWAPOrder = {
      parentOrderId,
      productId,
      side,
      totalSize,
      remainingSize: totalSize,
      sliceSize,
      numSlices,
      executedSlices: 0,
      startTime: new Date(),
      endTime: new Date(Date.now() + durationMs),
      childOrderIds: [],
      status: 'active',
    };

    this.twapOrders.set(parentOrderId, twapOrder);

    this.logger.info('TWAP order created', {
      parentOrderId,
      productId,
      side,
      totalSize,
      numSlices,
      sliceSize,
      durationMs,
    });

    // Execute slices over time
    this.executeTWAPSlices(parentOrderId, sliceIntervalMs);

    return { parentOrderId, sliceSize };
  }

  /**
   * Execute TWAP slices at intervals.
   */
  private async executeTWAPSlices(parentOrderId: string, intervalMs: number): Promise<void> {
    const twap = this.twapOrders.get(parentOrderId);
    if (!twap || twap.status !== 'active') {
      return;
    }

    // Add randomization to timing (+/- 20%)
    const randomizedInterval = intervalMs * (0.8 + Math.random() * 0.4);

    setTimeout(async () => {
      const currentTwap = this.twapOrders.get(parentOrderId);
      if (!currentTwap || currentTwap.status !== 'active') {
        return;
      }

      // Add randomization to slice size (+/- 10%)
      const randomizedSize = currentTwap.sliceSize * (0.9 + Math.random() * 0.2);
      const actualSize = Math.min(randomizedSize, currentTwap.remainingSize);

      if (actualSize <= 0) {
        currentTwap.status = 'completed';
        this.logger.info('TWAP order completed', { parentOrderId });
        return;
      }

      try {
        // Execute slice as market order
        const response = await this.placeOrder({
          product_id: currentTwap.productId,
          side: currentTwap.side,
          type: 'market',
          size: actualSize.toString(),
          client_oid: `${parentOrderId}_slice_${currentTwap.executedSlices}`,
        });

        currentTwap.childOrderIds.push(response.id);
        currentTwap.executedSlices++;
        currentTwap.remainingSize -= actualSize;

        this.logger.debug('TWAP slice executed', {
          parentOrderId,
          sliceNum: currentTwap.executedSlices,
          size: actualSize,
          remaining: currentTwap.remainingSize,
        });

        // Schedule next slice if more remain
        if (currentTwap.remainingSize > 0 && currentTwap.executedSlices < currentTwap.numSlices) {
          this.executeTWAPSlices(parentOrderId, intervalMs);
        } else {
          currentTwap.status = 'completed';
          this.logger.info('TWAP order completed', {
            parentOrderId,
            totalSlices: currentTwap.executedSlices,
          });
        }
      } catch (error) {
        this.logger.error('TWAP slice execution failed', { parentOrderId, error });
      }
    }, randomizedInterval);
  }

  /**
   * Cancel a TWAP order.
   */
  public cancelTWAPOrder(parentOrderId: string): boolean {
    const twap = this.twapOrders.get(parentOrderId);
    if (!twap || twap.status !== 'active') {
      return false;
    }

    twap.status = 'cancelled';
    this.logger.info('TWAP order cancelled', {
      parentOrderId,
      executedSlices: twap.executedSlices,
      remainingSize: twap.remainingSize,
    });

    return true;
  }

  /**
   * Get TWAP order status.
   */
  public getTWAPOrder(parentOrderId: string): TWAPOrder | undefined {
    return this.twapOrders.get(parentOrderId);
  }

  // ------------------------------------------------------------------ quotes

  /**
   * Update market price for a product from a single trade/mark price (no
   * spread information: bid = ask = last). Kept for callers that only have a
   * price; prefer `updateMarketQuote` when best bid/ask are known.
   */
  public updateMarketPrice(productId: string, price: number): void {
    if (!Number.isFinite(price) || price <= 0) return;
    this.updateMarketQuote(productId, { bid: price, ask: price, last: price });
  }

  /**
   * Update the top-of-book quote for a product. Post-only checks and
   * maker/taker attribution are evaluated against `bid` / `ask`; `last`
   * feeds balance checks and market-order pricing. Non-finite or crossed
   * (bid > ask) inputs fall back to `last` for both sides.
   */
  public updateMarketQuote(productId: string, quote: { bid?: number; ask?: number; last: number }): void {
    const last = quote.last;
    if (!Number.isFinite(last) || last <= 0) return;
    let bid = Number.isFinite(quote.bid) && (quote.bid as number) > 0 ? (quote.bid as number) : last;
    let ask = Number.isFinite(quote.ask) && (quote.ask as number) > 0 ? (quote.ask as number) : last;
    if (bid > ask) {
      bid = last;
      ask = last;
    }
    this.quotes.set(productId, { bid, ask, last });
    this.quoteUpdatedAt.set(productId, Date.now());
    this.marketPrices.set(productId, last);

    // Check if any resting limit orders can be filled
    this.checkLimitOrders(productId);
  }

  /** Quote plus its wall-clock age (status / quote-path observability). */
  public getQuoteSnapshot(productId: string): (PaperQuote & { updatedAt: number; ageMs: number }) | null {
    const quote = this.quotes.get(productId);
    const updatedAt = this.quoteUpdatedAt.get(productId);
    if (!quote || updatedAt === undefined) return null;
    return { ...quote, updatedAt, ageMs: Math.max(0, Date.now() - updatedAt) };
  }

  /**
   * Update market data from ticker. Uses `best_bid` / `best_ask` when the
   * feed carries them so post-only orders are evaluated against the real
   * touch, and falls back to the trade price otherwise.
   */
  public updateFromTicker(ticker: Ticker): void {
    const last = parseFloat(ticker.price);
    const bid = parseFloat(ticker.best_bid);
    const ask = parseFloat(ticker.best_ask);
    this.updateMarketQuote(ticker.product_id, { bid, ask, last });
  }

  /** Current top-of-book quote for a product, if any tick has been seen. */
  public getQuote(productId: string): PaperQuote | undefined {
    return this.quotes.get(productId);
  }

  /**
   * Get account balance
   */
  public getBalance(currency: string): number {
    return this.balances.get(currency) || 0;
  }

  /**
   * Get all balances
   */
  public getAllBalances(): Map<string, number> {
    return new Map(this.balances);
  }

  /** Session order-operation counters (placed / filled / cancelled / edited / post-only misses / fee_side mix). */
  public getOrderOpsStats(): PaperOrderOpsStats {
    return { ...this.ops };
  }

  // ------------------------------------------------------------------ orders

  /**
   * Place an order.
   *
   * Limit semantics (venue truth, evaluated against the current quote):
   *   - `post_only` + would cross the spread (buy ≥ ask / sell ≤ bid) →
   *     REJECTED with `POST_ONLY_WOULD_CROSS`. The price is never adjusted
   *     and nothing is retried: a post-only miss is a logged miss, not a chase.
   *   - not post-only + would cross → fills immediately as a TAKER at the
   *     touch (ask for buys, bid for sells).
   *   - otherwise rests `open`; a later tick that reaches the limit fills it
   *     as a MAKER at the limit price.
   *   - `*-CDE` symbols: price is aligned to the venue tick (buy down / sell
   *     up), size is rounded DOWN to whole contracts and must be ≥ 1 contract.
   *
   * @throws PaperOrderRejectedError for every validation failure (code attached).
   */
  public async placeOrder(request: OrderRequest): Promise<PaperOrderResponse> {
    // Simulate network latency
    await new Promise(resolve => setTimeout(resolve, this.config.latencyMs));

    const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    const orderId = (request.client_oid && uuidV4.test(request.client_oid)) ? request.client_oid : uuidv4();
    const [baseCurrency] = request.product_id.split('-');
    const postOnly = Boolean(request.post_only) && request.type === 'limit';

    // Validate order
    const validation = this.validateOrder(request);
    if (!validation.valid) {
      throw new PaperOrderRejectedError(validation.code ?? 'INVALID_SIZE', validation.reason ?? 'Invalid order');
    }

    // Create simulated order
    const rawSize = request.size ? parseFloat(request.size) : 0;
    if (!Number.isFinite(rawSize) || rawSize <= 0) {
      throw new PaperOrderRejectedError('INVALID_SIZE', 'Invalid order size');
    }
    const size = this.normalizeSize(request.product_id, rawSize);
    const parsedPrice = request.price !== undefined ? parseFloat(request.price) : undefined;
    const price =
      request.type !== 'market' && parsedPrice !== undefined && Number.isFinite(parsedPrice)
        ? this.normalizePrice(request.product_id, request.side, parsedPrice)
        : parsedPrice;

    const quote = this.quotes.get(request.product_id);

    // True post-only: refuse anything that would take liquidity. Never re-priced.
    if (postOnly) {
      if (!quote) {
        throw new PaperOrderRejectedError('NO_MARKET_DATA', `No market data for ${request.product_id}; cannot verify post-only`, {
          productId: request.product_id,
        });
      }
      if (price === undefined) {
        throw new PaperOrderRejectedError('INVALID_SIZE', 'Post-only orders require a limit price');
      }
      if (this.wouldCross(request.side, price, quote)) {
        this.ops.postOnlyRejected += 1;
        this.logger.warn('PAPER: post-only order rejected — would cross the spread (no chase)', {
          orderId,
          productId: request.product_id,
          side: request.side,
          price,
          bid: quote.bid,
          ask: quote.ask,
        });
        throw new PaperOrderRejectedError(
          'POST_ONLY_WOULD_CROSS',
          `Post-only ${request.side} at ${price} would cross (bid ${quote.bid} / ask ${quote.ask})`,
          { productId: request.product_id, side: request.side, price, bid: quote.bid, ask: quote.ask },
        );
      }
    }

    const order: SimulatedOrder = {
      id: orderId,
      clientOrderId: request.client_oid || orderId,
      productId: request.product_id,
      side: request.side,
      type: request.type,
      size,
      price,
      postOnly,
      status: request.type === 'market' ? 'pending' : 'open',
      filledSize: 0,
      executedValue: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
      fills: [],
      editCount: 0,
    };

    this.orders.set(orderId, order);
    this.ops.placed += 1;
    if (baseCurrency) this.markSymbolByCurrency.set(baseCurrency, request.product_id);

    // Process order based on type
    if (order.type === 'market') {
      await this.executeMarketOrder(order);
    } else if (quote) {
      this.checkLimitOrderFill(order, quote, { onPlacement: true });
    }

    const response = this.toResponse(order);

    this.logger.info('Paper order placed', {
      orderId: order.id,
      productId: order.productId,
      side: order.side,
      type: order.type,
      size: order.size,
      price: order.price ?? null,
      postOnly: order.postOnly,
      status: response.status
    });

    return response;
  }

  /**
   * Re-quote an OPEN limit order in place (the paper analogue of Advanced
   * Trade `POST /orders/edit`): same order id, new `price` and/or `size`.
   * Preferred over cancel+new so the harness can count re-quotes and keep
   * one lifecycle per attempt.
   *
   *   - Only `open`, unfilled limit orders are editable (`ORDER_NOT_EDITABLE`).
   *   - A post-only order whose new price would cross is REFUSED and left
   *     untouched (`POST_ONLY_WOULD_CROSS`) — never chased.
   *   - A non-post-only order whose new price crosses fills as a taker at the touch.
   *   - `*-CDE`: tick / lot rules apply to the new values.
   *
   * @returns The updated order response.
   * @throws PaperOrderRejectedError with the reason the edit was refused.
   */
  public async editOrder(orderId: string, changes: { price?: number; size?: number }): Promise<PaperOrderResponse> {
    await new Promise(resolve => setTimeout(resolve, this.config.latencyMs));

    const order = this.orders.get(orderId);
    if (!order) {
      throw new PaperOrderRejectedError('ORDER_NOT_EDITABLE', `Order ${orderId} not found`);
    }
    if (order.type !== 'limit' || order.status !== 'open' || order.filledSize > 0) {
      throw new PaperOrderRejectedError(
        'ORDER_NOT_EDITABLE',
        `Order ${orderId} is not an open, unfilled limit order (type=${order.type}, status=${order.status}, filled=${order.filledSize})`,
      );
    }
    if (changes.price === undefined && changes.size === undefined) {
      throw new PaperOrderRejectedError('ORDER_NOT_EDITABLE', 'editOrder requires a new price and/or size');
    }

    const newPrice =
      changes.price !== undefined ? this.normalizePrice(order.productId, order.side, changes.price) : order.price;
    if (newPrice === undefined || !Number.isFinite(newPrice) || newPrice <= 0) {
      throw new PaperOrderRejectedError('INVALID_SIZE', `Invalid edit price ${changes.price}`);
    }
    let newSize = order.size;
    if (changes.size !== undefined) {
      if (!Number.isFinite(changes.size) || changes.size <= 0) {
        throw new PaperOrderRejectedError('INVALID_SIZE', `Invalid edit size ${changes.size}`);
      }
      newSize = this.normalizeSize(order.productId, changes.size);
    }

    const quote = this.quotes.get(order.productId);
    if (order.postOnly) {
      if (!quote) {
        throw new PaperOrderRejectedError('NO_MARKET_DATA', `No market data for ${order.productId}; cannot verify post-only edit`);
      }
      if (this.wouldCross(order.side, newPrice, quote)) {
        this.ops.editRejected += 1;
        this.logger.warn('PAPER: post-only edit rejected — new price would cross (order left resting, no chase)', {
          orderId,
          productId: order.productId,
          side: order.side,
          currentPrice: order.price,
          requestedPrice: newPrice,
          bid: quote.bid,
          ask: quote.ask,
        });
        throw new PaperOrderRejectedError(
          'POST_ONLY_WOULD_CROSS',
          `Post-only edit to ${newPrice} would cross (bid ${quote.bid} / ask ${quote.ask}); order ${orderId} left at ${order.price}`,
          { productId: order.productId, side: order.side, price: newPrice, bid: quote.bid, ask: quote.ask },
        );
      }
    }

    const previous = { price: order.price, size: order.size };
    order.price = newPrice;
    order.size = newSize;
    order.editCount += 1;
    order.updatedAt = new Date();
    this.ops.edited += 1;

    this.logger.info('Paper order edited in place', {
      orderId,
      productId: order.productId,
      from: previous,
      to: { price: newPrice, size: newSize },
      editCount: order.editCount,
    });

    if (quote) {
      this.checkLimitOrderFill(order, quote, { onPlacement: true });
    }

    return this.toResponse(order);
  }

  /** Wire-shaped view of a simulated order (status read fresh — fills may have just landed). */
  private toResponse(order: SimulatedOrder): PaperOrderResponse {
    const status: SimulatedOrderStatus = order.status;
    return {
      id: order.id,
      product_id: order.productId,
      side: order.side,
      type: order.type,
      size: order.size.toString(),
      price: order.price !== undefined ? order.price.toString() : undefined,
      post_only: order.postOnly,
      status,
      filled_size: order.filledSize.toString(),
      executed_value: order.executedValue.toString(),
      created_at: order.createdAt.toISOString(),
      fill_fees: this.calculateFees(order).toString(),
      settled: status === 'done',
    };
  }

  /**
   * Cancel an order
   */
  public async cancelOrder(orderId: string): Promise<boolean> {
    const order = this.orders.get(orderId);
    if (!order) {
      return false;
    }

    if (order.status === 'done' || order.status === 'cancelled' || order.status === 'rejected') {
      return false;
    }

    order.status = 'cancelled';
    order.updatedAt = new Date();
    this.ops.cancelled += 1;

    this.logger.info('Paper order cancelled', { orderId });
    return true;
  }

  /**
   * Get order by ID
   */
  public getOrder(orderId: string): SimulatedOrder | undefined {
    return this.orders.get(orderId);
  }

  /**
   * Get all orders
   */
  public getOrders(productId?: string, status?: SimulatedOrderStatus[]): SimulatedOrder[] {
    let orders = Array.from(this.orders.values());

    if (productId) {
      orders = orders.filter(o => o.productId === productId);
    }

    if (status && status.length > 0) {
      orders = orders.filter(o => status.includes(o.status));
    }

    return orders;
  }

  // -------------------------------------------------------------- internals

  /** True when a limit at `price` would take liquidity against `quote`. */
  private wouldCross(side: 'buy' | 'sell', price: number, quote: PaperQuote): boolean {
    return side === 'buy' ? price >= quote.ask : price <= quote.bid;
  }

  /**
   * Align a limit price to the venue tick for contract symbols, in the
   * side-conservative direction (buy rounds down, sell rounds up). Symbols
   * without a contract spec are returned unchanged.
   */
  private normalizePrice(symbol: string, side: 'buy' | 'sell', price: number): number {
    const spec = this.contractSpecFor(symbol);
    if (!spec || !(spec.priceIncrementUsd > 0)) return price;
    return decimalToNumber(
      decimalRoundToIncrement(String(price), String(spec.priceIncrementUsd), side === 'buy' ? 'down' : 'up'),
    );
  }

  /**
   * Round a size DOWN to whole contracts for contract symbols and refuse
   * sub-contract sizes. Symbols without a contract spec are returned unchanged.
   */
  private normalizeSize(symbol: string, size: number): number {
    const spec = this.contractSpecFor(symbol);
    if (!spec || !(spec.contractSize > 0)) return size;
    const rounded = decimalToNumber(decimalRoundToIncrement(String(size), String(spec.contractSize), 'down'));
    if (rounded <= 0) {
      throw new PaperOrderRejectedError(
        'BELOW_MIN_CONTRACT',
        `Size ${size} is below one contract (${spec.contractSize}) for ${symbol}`,
        { symbol, size, contractSize: spec.contractSize },
      );
    }
    return rounded;
  }

  /**
   * Validate order
   */
  private validateOrder(request: OrderRequest): { valid: boolean; reason?: string; code?: PaperRejectCode } {
    // Product IDs are either 2-part spot (BTC-USD) or 3-part derivative
    // (BTC-PERP-INTX, BIP-20DEC30-CDE). Derivatives settle in USD-denominated
    // collateral regardless of venue tag.
    const parts = request.product_id.split('-');
    const baseCurrency = parts[0];
    const quoteCurrency = parts.length >= 3 ? 'USD' : parts[1];
    const size = request.size ? parseFloat(request.size) : 0;
    if (!Number.isFinite(size) || size <= 0) {
      return { valid: false, reason: 'Order size must be greater than zero', code: 'INVALID_SIZE' };
    }
    const price = request.price !== undefined
      ? parseFloat(request.price)
      : this.quotes.get(request.product_id)?.last || 0;

    // Pre-trade balance/collateral check uses the symbol's taker rate so
    // perp trades don't reserve spot-tier amounts (and vice versa).
    const takerRate = this.resolveFeeRate(request.product_id, 'taker');

    if (request.side === 'buy') {
      // Check quote currency balance
      const requiredAmount = size * price * (1 + takerRate);
      const available = this.getBalance(quoteCurrency);

      if (available < requiredAmount) {
        return {
          valid: false,
          reason: `Insufficient ${quoteCurrency} balance. Required: ${requiredAmount.toFixed(2)}, Available: ${available.toFixed(2)}`,
          code: 'INSUFFICIENT_BALANCE',
        };
      }
    } else {
      const baseBalance = this.getBalance(baseCurrency);

      if (baseBalance >= size) {
        // Closing a long position — we hold enough of the base asset
      } else {
        // Short sell: check quote currency (USD) for collateral
        const notional = size * price;
        const requiredCollateral = notional * (1 + takerRate);
        const quoteAvailable = this.getBalance(quoteCurrency);

        if (quoteAvailable < requiredCollateral) {
          return {
            valid: false,
            reason: `Insufficient ${quoteCurrency} collateral for short. Required: ${requiredCollateral.toFixed(2)}, Available: ${quoteAvailable.toFixed(2)}`,
            code: 'INSUFFICIENT_BALANCE',
          };
        }
      }
    }

    return { valid: true };
  }

  /**
   * Execute market order with depth-aware price impact. Always a taker fill
   * against the far side of the quote (ask for buys, bid for sells).
   */
  private async executeMarketOrder(order: SimulatedOrder): Promise<void> {
    const quote = this.quotes.get(order.productId);
    if (!quote) {
      order.status = 'rejected';
      order.updatedAt = new Date();
      return;
    }

    const touch = order.side === 'buy' ? quote.ask : quote.bid;

    // Calculate notional value for price impact
    const notionalUsd = order.size * touch;

    // Calculate depth-aware slippage
    const priceImpact = this.calculatePriceImpact(notionalUsd, order.side);

    // Apply slippage with price impact
    const executionPrice = order.side === 'buy'
      ? touch * (1 + priceImpact)
      : touch * (1 - priceImpact);

    this.recordFill(order, executionPrice, order.size, 'taker');

    this.logger.info('PAPER: Simulated market fill', {
      orderId: order.id,
      price: executionPrice,
      size: order.size,
      side: order.side,
      slippage: (priceImpact * 100).toFixed(4) + '%',
      notionalUsd: notionalUsd.toFixed(2),
    });
  }

  /**
   * Check if a limit order can fill against `quote`.
   *
   * `onPlacement` (placement / edit): a crossing order is a TAKER at the touch
   * (buy ≥ ask fills at ask, sell ≤ bid fills at bid). Post-only orders never
   * reach here crossing — they are rejected upstream.
   *
   * Tick-driven (resting): the market moved to the limit — a MAKER fill at the
   * limit price (buy when ask ≤ limit, sell when bid ≥ limit).
   */
  private checkLimitOrderFill(order: SimulatedOrder, quote: PaperQuote, options: { onPlacement?: boolean } = {}): void {
    if (!order.price || order.status !== 'open') {
      return;
    }

    const limitPrice = order.price;
    const crossesOnPlacement = options.onPlacement === true && this.wouldCross(order.side, limitPrice, quote);

    if (crossesOnPlacement) {
      if (order.postOnly) {
        // Defensive: placeOrder/editOrder already refused this; never take liquidity on a post-only order.
        return;
      }
      const touch = order.side === 'buy' ? quote.ask : quote.bid;
      this.recordFill(order, touch, order.size, 'taker');
      this.logger.info('PAPER: Simulated crossing-limit fill (TAKER at touch)', {
        orderId: order.id,
        limitPrice,
        fillPrice: touch,
        size: order.size,
        side: order.side,
      });
      return;
    }

    const reached = (order.side === 'buy' && quote.ask <= limitPrice) ||
                    (order.side === 'sell' && quote.bid >= limitPrice);
    if (!reached) return;

    this.recordFill(order, limitPrice, order.size, 'maker');
    this.logger.info('PAPER: Simulated limit fill (MAKER at limit)', {
      orderId: order.id,
      price: limitPrice,
      size: order.size,
      side: order.side
    });
  }

  /**
   * Check all resting limit orders for a product against its latest quote.
   */
  private checkLimitOrders(productId: string): void {
    const quote = this.quotes.get(productId);
    if (!quote) return;
    for (const order of this.orders.values()) {
      if (order.productId === productId && order.status === 'open' && order.type !== 'market') {
        this.checkLimitOrderFill(order, quote);
      }
    }
  }

  /**
   * Build + apply a fill with explicit fee-side attribution and cost-plus
   * fee breakdown, update balances, and emit it.
   */
  private recordFill(order: SimulatedOrder, price: number, size: number, feeSide: FeeSide): void {
    const { fee, commission, exchangeFee, contracts } = this.computeFillFee(order.productId, feeSide, size, price);
    const fillId = ++this.fillSequence;
    const fill: Fill = {
      trade_id: fillId,
      product_id: order.productId,
      order_id: order.id,
      user_id: 'paper_trader',
      profile_id: 'default',
      liquidity: feeSide === 'maker' ? 'M' : 'T',
      fee_side: feeSide,
      fee_side_source: 'simulated',
      commission,
      exchange_fee: exchangeFee,
      ...(contracts !== undefined ? { contracts } : {}),
      price: price.toString(),
      size: size.toString(),
      fee: fee.toString(),
      side: order.side,
      settled: true,
      created_at: new Date().toISOString(),
      usd_volume: (size * price).toString()
    };

    // Update order
    order.fills.push(fill);
    order.filledSize = size;
    order.executedValue = size * price;
    order.status = 'done';
    order.updatedAt = new Date();

    this.ops.filled += 1;
    if (feeSide === 'maker') this.ops.makerFills += 1;
    else this.ops.takerFills += 1;

    // Update balances
    this.updateBalances(order, fill);

    // Emit fill event
    this.emit('fill', fill);
  }

  /**
   * Update balances after fill and track realized P&L.
   * Realized P&L is computed using average cost basis (same approach as position-tracker.ts).
   */
  private updateBalances(order: SimulatedOrder, fill: Fill): void {
    // Keep parsing identical to validateOrder so derivative fills hit the USD wallet, not a fake 'PERP' / 'CDE' bucket.
    const parts = order.productId.split('-');
    const baseCurrency = parts[0];
    const quoteCurrency = parts.length >= 3 ? 'USD' : parts[1];
    if (!baseCurrency || !quoteCurrency) {
      this.logger.warn('Unable to update balances: invalid product id', { productId: order.productId });
      return;
    }
    const fillSize = parseFloat(fill.size);
    const fillPrice = parseFloat(fill.price);
    const fee = parseFloat(fill.fee);

    if (order.side === 'buy') {
      // Deduct quote currency
      const quoteCost = fillSize * fillPrice + fee;
      this.balances.set(quoteCurrency, this.getBalance(quoteCurrency) - quoteCost);

      // Add base currency
      this.balances.set(baseCurrency, this.getBalance(baseCurrency) + fillSize);

      // Update cost basis (average cost method)
      const existing = this.costBasis.get(baseCurrency) || { totalCost: 0, size: 0 };
      existing.totalCost += fillSize * fillPrice + fee;
      existing.size += fillSize;
      this.costBasis.set(baseCurrency, existing);
    } else {
      // Deduct base currency
      this.balances.set(baseCurrency, this.getBalance(baseCurrency) - fillSize);

      // Add quote currency (minus fee)
      const quoteReceived = fillSize * fillPrice - fee;
      this.balances.set(quoteCurrency, this.getBalance(quoteCurrency) + quoteReceived);

      // Compute realized P&L from cost basis
      const existing = this.costBasis.get(baseCurrency);
      if (existing && existing.size > 0) {
        const avgCost = existing.totalCost / existing.size;
        const pnl = (fillPrice - avgCost) * fillSize - fee;
        this.realizedPnL += pnl;

        // Reduce cost basis proportionally
        const proportion = Math.min(fillSize / existing.size, 1);
        existing.totalCost *= (1 - proportion);
        existing.size -= fillSize;
        if (existing.size <= 0) {
          this.costBasis.delete(baseCurrency);
        }
      }
    }

    this.logger.debug('Balances updated', {
      baseCurrency,
      quoteCurrency,
      baseBalance: this.getBalance(baseCurrency),
      quoteBalance: this.getBalance(quoteCurrency)
    });
  }

  /**
   * Calculate fees for an order
   */
  private calculateFees(order: SimulatedOrder): number {
    let totalFees = 0;

    for (const fill of order.fills) {
      totalFees += parseFloat(fill.fee);
    }

    return totalFees;
  }

  /** Mark price for a non-USD balance bucket: the symbol that produced it, else `${currency}-USD`. */
  private markPriceFor(currency: string): number {
    const markSymbol = this.markSymbolByCurrency.get(currency);
    if (markSymbol) {
      const price = this.marketPrices.get(markSymbol);
      if (price !== undefined) return price;
    }
    return this.marketPrices.get(`${currency}-USD`) || 0;
  }

  /**
   * Get P&L summary
   */
  public getPnLSummary(): {
    totalValue: number;
    initialValue: number;
    unrealizedPnL: number;
    realizedPnL: number;
    returnPercent: number;
  } {
    // Calculate total value in USD
    let totalValue = this.getBalance('USD');

    // Add value of crypto holdings
    for (const [currency, balance] of this.balances) {
      if (currency !== 'USD' && balance > 0) {
        totalValue += balance * this.markPriceFor(currency);
      }
    }

    // Calculate initial value
    let initialValue = this.config.initialBalances.get('USD') || 0;
    for (const [currency, balance] of this.config.initialBalances) {
      if (currency !== 'USD' && balance > 0) {
        initialValue += balance * this.markPriceFor(currency);
      }
    }

    const totalPnL = totalValue - initialValue;
    const unrealizedPnL = totalPnL - this.realizedPnL;
    const returnPercent = initialValue > 0 ? (totalPnL / initialValue) * 100 : 0;

    return {
      totalValue,
      initialValue,
      unrealizedPnL,
      realizedPnL: this.realizedPnL,
      returnPercent
    };
  }

  /**
   * Reset simulator
   */
  public reset(): void {
    this.balances = new Map(this.config.initialBalances);
    this.orders.clear();
    this.marketPrices.clear();
    this.quotes.clear();
    this.quoteUpdatedAt.clear();
    this.markSymbolByCurrency.clear();
    this.orderSequence = 0;
    this.fillSequence = 0;
    this.realizedPnL = 0;
    this.costBasis.clear();
    this.ops = emptyOpsStats();

    this.logger.info('Paper trading simulator reset');
  }
}

function emptyOpsStats(): PaperOrderOpsStats {
  return {
    placed: 0,
    filled: 0,
    cancelled: 0,
    edited: 0,
    postOnlyRejected: 0,
    editRejected: 0,
    makerFills: 0,
    takerFills: 0,
  };
}
