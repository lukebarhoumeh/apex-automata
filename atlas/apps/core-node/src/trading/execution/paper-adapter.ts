/**
 * Paper Execution Adapter
 * 
 * Implements the ExecutionAdapter interface for paper (simulated) trading.
 * Uses REAL Coinbase production market data to simulate realistic fills.
 * 
 * Key design principles:
 * 1. Emits the SAME BrokerOrderEvent shapes as live adapter
 * 2. Uses production market data (not sandbox)
 * 3. Respects tick size, lot size, min notional
 * 4. Post-only behavior matches live (rejects if would cross)
 * 5. Deterministic RNG for testing
 */

import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';
import { Logger } from '../../core/logger';
import {
  IExecutionAdapter,
  ExecutionMode,
  PlaceOrderRequest,
  BrokerOrderEvent,
  AdapterHealth,
  OpenOrder,
  FillRecord,
  ProductSpec,
  DEFAULT_PRODUCT_SPECS,
  roundQuantity,
  roundPrice,
  validateOrderAgainstSpec,
} from './execution-adapter';

/**
 * Paper adapter configuration
 */
export interface PaperAdapterConfig {
  /** Logger instance */
  logger: Logger;
  /** Product specifications */
  productSpecs?: Record<string, ProductSpec>;
  /** Simulated latency range [min, max] in ms */
  latencyMs?: [number, number];
  /** Base slippage percentage (e.g., 0.001 for 0.1%) */
  baseSlippage?: number;
  /** Enable depth-aware slippage */
  depthAwareSlippage?: boolean;
  /** Simulated book depth per level in USD */
  simulatedBookDepthUsd?: number;
  /** Enable partial fills */
  enablePartialFills?: boolean;
  /** Max fill percentage per tick for partial fills */
  maxPartialFillPct?: number;
  /** Random seed for deterministic testing (null = random) */
  randomSeed?: number | null;
}

/**
 * Default paper config
 */
export const DEFAULT_PAPER_CONFIG: Omit<PaperAdapterConfig, 'logger'> = {
  latencyMs: [50, 150],
  baseSlippage: 0.0005, // 0.05%
  depthAwareSlippage: true,
  simulatedBookDepthUsd: 50000,
  enablePartialFills: false,
  maxPartialFillPct: 0.25,
  randomSeed: null,
};

/**
 * Simulated order state
 */
interface SimulatedOrder {
  request: PlaceOrderRequest;
  exchangeOrderId: string;
  status: 'pending' | 'open' | 'filled' | 'partially_filled' | 'canceled' | 'rejected';
  filledQuantity: number;
  filledValue: number;
  totalFees: number;
  fills: FillRecord[];
  createdAt: number;
  updatedAt: number;
}

/**
 * Paper Execution Adapter
 * 
 * Simulates order execution using real production market data.
 * Emits identical BrokerOrderEvent stream as the live adapter.
 */
export class PaperExecutionAdapter extends EventEmitter implements IExecutionAdapter {
  public readonly mode: ExecutionMode = 'paper';

  private logger: Logger;
  private config: Required<PaperAdapterConfig>;
  private productSpecs: Record<string, ProductSpec>;

  // State
  private running = false;
  private eventCallbacks: Array<(event: BrokerOrderEvent) => void> = [];
  private orders: Map<string, SimulatedOrder> = new Map();
  private marketPrices: Map<string, { bid: number; ask: number; last: number }> = new Map();
  private lastEventAt: number | null = null;
  private fillSequence = 0;

  // Seeded RNG for deterministic testing
  private rngState: number;

  constructor(config: PaperAdapterConfig) {
    super();
    this.logger = config.logger;
    this.config = {
      ...DEFAULT_PAPER_CONFIG,
      ...config,
      productSpecs: config.productSpecs || DEFAULT_PRODUCT_SPECS,
    } as Required<PaperAdapterConfig>;
    this.productSpecs = this.config.productSpecs;

    // Initialize RNG
    this.rngState = config.randomSeed ?? Math.floor(Math.random() * 2147483647);
  }

  /**
   * Start the adapter
   */
  public async start(): Promise<void> {
    if (this.running) {
      this.logger.warn('Paper adapter already running');
      return;
    }

    this.logger.info('Starting paper execution adapter');
    this.running = true;
  }

  /**
   * Stop the adapter
   */
  public async stop(): Promise<void> {
    if (!this.running) {
      return;
    }

    this.logger.info('Stopping paper execution adapter');
    this.running = false;

    // Cancel all open orders
    for (const order of this.orders.values()) {
      if (order.status === 'open' || order.status === 'pending') {
        order.status = 'canceled';
        order.updatedAt = Date.now();
      }
    }
  }

  /**
   * Update market price (called by trading engine on tick)
   */
  public updateMarketPrice(symbol: string, bid: number, ask: number, last?: number): void {
    this.marketPrices.set(symbol, {
      bid,
      ask,
      last: last ?? (bid + ask) / 2,
    });

    // Check limit orders for fills
    this.checkLimitOrders(symbol);
  }

  /**
   * Place an order
   */
  public async placeOrder(request: PlaceOrderRequest): Promise<void> {
    if (!this.running) {
      throw new Error('Paper adapter not running');
    }

    this.logger.info('Paper adapter placing order', {
      clientOrderId: request.clientOrderId,
      symbol: request.symbol,
      side: request.side,
      type: request.type,
      quantity: request.quantity,
      price: request.price,
    });

    // Simulate network latency
    await this.simulateLatency();

    // Get product spec
    const spec = this.productSpecs[request.symbol];
    if (!spec) {
      this.emitEvent({
        type: 'order_rejected',
        clientOrderId: request.clientOrderId,
        reason: `Unknown product: ${request.symbol}`,
        ts: Date.now(),
      });
      return;
    }

    // Get market price
    const market = this.marketPrices.get(request.symbol);
    if (!market) {
      this.emitEvent({
        type: 'order_rejected',
        clientOrderId: request.clientOrderId,
        reason: `No market data for ${request.symbol}`,
        ts: Date.now(),
      });
      return;
    }

    // Validate order
    const validation = validateOrderAgainstSpec(request, spec, market.last);
    if (!validation.valid) {
      this.emitEvent({
        type: 'order_rejected',
        clientOrderId: request.clientOrderId,
        reason: validation.errors.join('; '),
        ts: Date.now(),
      });
      return;
    }

    // Round values
    const quantity = roundQuantity(request.quantity, spec);
    const price = request.price ? roundPrice(request.price, spec) : undefined;

    // Post-only check (would cross spread = reject)
    if (request.postOnly && price !== undefined) {
      const wouldCross = (request.side === 'buy' && price >= market.ask) ||
                         (request.side === 'sell' && price <= market.bid);
      if (wouldCross) {
        this.emitEvent({
          type: 'order_rejected',
          clientOrderId: request.clientOrderId,
          reason: 'Post-only order would have crossed',
          code: 'post_only_rejected',
          ts: Date.now(),
        });
        return;
      }
    }

    // Create simulated order
    const exchangeOrderId = `paper-${uuidv4().slice(0, 8)}`;
    const now = Date.now();

    const order: SimulatedOrder = {
      request: { ...request, quantity, price },
      exchangeOrderId,
      status: request.type === 'market' ? 'pending' : 'open',
      filledQuantity: 0,
      filledValue: 0,
      totalFees: 0,
      fills: [],
      createdAt: now,
      updatedAt: now,
    };

    this.orders.set(request.clientOrderId, order);

    // Emit accepted
    this.emitEvent({
      type: 'order_accepted',
      clientOrderId: request.clientOrderId,
      exchangeOrderId,
      ts: now,
    });

    // Process market orders immediately
    if (request.type === 'market') {
      await this.executeMarketOrder(order, spec, market);
    } else {
      // Check if limit order can fill immediately
      this.checkLimitOrderFill(order, spec, market);
    }
  }

  /**
   * Cancel an order
   */
  public async cancelOrder(clientOrderId: string): Promise<void> {
    const order = this.orders.get(clientOrderId);
    if (!order) {
      this.logger.warn('Paper cancel: order not found', { clientOrderId });
      return;
    }

    if (order.status === 'filled' || order.status === 'canceled') {
      this.logger.warn('Paper cancel: order already terminal', { 
        clientOrderId, 
        status: order.status 
      });
      return;
    }

    await this.simulateLatency();

    order.status = 'canceled';
    order.updatedAt = Date.now();

    this.emitEvent({
      type: 'order_canceled',
      clientOrderId,
      exchangeOrderId: order.exchangeOrderId,
      ts: Date.now(),
    });
  }

  /**
   * Cancel all orders
   */
  public async cancelAllOrders(symbol?: string): Promise<void> {
    for (const [clientOrderId, order] of this.orders) {
      if (order.status !== 'open' && order.status !== 'pending') {
        continue;
      }
      if (symbol && order.request.symbol !== symbol) {
        continue;
      }

      order.status = 'canceled';
      order.updatedAt = Date.now();

      this.emitEvent({
        type: 'order_canceled',
        clientOrderId,
        exchangeOrderId: order.exchangeOrderId,
        ts: Date.now(),
      });
    }
  }

  /**
   * Get open orders
   */
  public async getOpenOrders(): Promise<OpenOrder[]> {
    const open: OpenOrder[] = [];

    for (const [clientOrderId, order] of this.orders) {
      if (order.status !== 'open' && order.status !== 'pending') {
        continue;
      }

      open.push({
        clientOrderId,
        exchangeOrderId: order.exchangeOrderId,
        symbol: order.request.symbol,
        side: order.request.side,
        type: order.request.type,
        price: order.request.price,
        quantity: order.request.quantity,
        filledQuantity: order.filledQuantity,
        status: order.status,
        createdAt: order.createdAt,
      });
    }

    return open;
  }

  /**
   * Get fills since cursor
   */
  public async getFillsSince(cursor: any): Promise<FillRecord[]> {
    const fills: FillRecord[] = [];
    const cursorTs = typeof cursor === 'number' ? cursor : 0;

    for (const order of this.orders.values()) {
      for (const fill of order.fills) {
        if (fill.ts > cursorTs) {
          fills.push(fill);
        }
      }
    }

    return fills.sort((a, b) => a.ts - b.ts);
  }

  /**
   * Register event callback
   */
  public onEvent(callback: (event: BrokerOrderEvent) => void): void {
    this.eventCallbacks.push(callback);
  }

  /**
   * Get adapter health
   */
  public getHealth(): AdapterHealth {
    return {
      ok: this.running,
      degraded: false,
      reasonCodes: [],
      lastEventAt: this.lastEventAt,
      pendingOrderCount: Array.from(this.orders.values())
        .filter(o => o.status === 'open' || o.status === 'pending').length,
    };
  }

  // ============ Private Methods ============

  /**
   * Execute a market order
   */
  private async executeMarketOrder(
    order: SimulatedOrder,
    spec: ProductSpec,
    market: { bid: number; ask: number; last: number }
  ): Promise<void> {
    // Calculate execution price with slippage
    const basePrice = order.request.side === 'buy' ? market.ask : market.bid;
    const slippage = this.calculateSlippage(order.request.quantity, basePrice, spec);
    
    const executionPrice = order.request.side === 'buy'
      ? basePrice * (1 + slippage)
      : basePrice * (1 - slippage);

    // Round to tick size
    const roundedPrice = roundPrice(executionPrice, spec);

    // Create fill
    this.createFill(order, spec, roundedPrice, order.request.quantity, 'taker');
  }

  /**
   * Check if a limit order can fill
   */
  private checkLimitOrderFill(
    order: SimulatedOrder,
    spec: ProductSpec,
    market: { bid: number; ask: number; last: number }
  ): void {
    if (order.status !== 'open' || order.request.price === undefined) {
      return;
    }

    const price = order.request.price;
    const remainingQty = order.request.quantity - order.filledQuantity;

    if (remainingQty <= 0) {
      return;
    }

    // Check if price crosses
    const canFill = (order.request.side === 'buy' && market.ask <= price) ||
                    (order.request.side === 'sell' && market.bid >= price);

    if (canFill) {
      // Fill at limit price (maker)
      this.createFill(order, spec, price, remainingQty, 'maker');
    }
  }

  /**
   * Check all limit orders for a symbol
   */
  private checkLimitOrders(symbol: string): void {
    const market = this.marketPrices.get(symbol);
    if (!market) return;

    for (const order of this.orders.values()) {
      if (order.request.symbol !== symbol) continue;
      if (order.status !== 'open') continue;

      const spec = this.productSpecs[symbol];
      if (spec) {
        this.checkLimitOrderFill(order, spec, market);
      }
    }
  }

  /**
   * Create a fill for an order
   */
  private createFill(
    order: SimulatedOrder,
    spec: ProductSpec,
    price: number,
    size: number,
    liquidity: 'maker' | 'taker'
  ): void {
    const feeRate = liquidity === 'maker' ? spec.makerFee : spec.takerFee;
    const fee = size * price * feeRate;
    const tradeId = `paper-fill-${++this.fillSequence}`;
    const now = Date.now();

    const fill: FillRecord = {
      tradeId,
      orderId: order.exchangeOrderId,
      clientOrderId: order.request.clientOrderId,
      symbol: order.request.symbol,
      side: order.request.side,
      price,
      size,
      fee,
      feeCurrency: spec.quoteCurrency,
      liquidity,
      ts: now,
    };

    // Update order
    order.fills.push(fill);
    order.filledQuantity += size;
    order.filledValue += size * price;
    order.totalFees += fee;
    order.updatedAt = now;

    // Check if fully filled
    if (order.filledQuantity >= order.request.quantity - spec.lotSize * 0.5) {
      order.status = 'filled';
      order.filledQuantity = order.request.quantity; // Ensure exact match
    } else {
      order.status = 'partially_filled';
    }

    // Emit fill event
    this.emitEvent({
      type: 'fill',
      clientOrderId: order.request.clientOrderId,
      exchangeOrderId: order.exchangeOrderId,
      tradeId,
      price,
      size,
      fee,
      feeCurrency: spec.quoteCurrency,
      liquidity,
      ts: now,
    });

    this.logger.info('Paper fill', {
      clientOrderId: order.request.clientOrderId,
      tradeId,
      price,
      size,
      fee,
      liquidity,
    });
  }

  /**
   * Calculate slippage based on order size and market conditions
   */
  private calculateSlippage(quantity: number, price: number, spec: ProductSpec): number {
    if (!this.config.depthAwareSlippage) {
      return this.config.baseSlippage;
    }

    const notionalUsd = quantity * price;
    const bookDepth = this.config.simulatedBookDepthUsd;

    // Depth impact: larger orders eat through the book
    const depthImpact = (notionalUsd / bookDepth) * 0.001;

    // Add some randomness
    const randomFactor = 0.8 + this.random() * 0.4;

    const totalSlippage = (this.config.baseSlippage + depthImpact) * randomFactor;

    // Cap at 2%
    return Math.min(totalSlippage, 0.02);
  }

  /**
   * Simulate network latency
   */
  private async simulateLatency(): Promise<void> {
    const [min, max] = this.config.latencyMs;
    const latency = min + this.random() * (max - min);
    await new Promise(resolve => setTimeout(resolve, latency));
  }

  /**
   * Seeded random number generator (for deterministic testing)
   */
  private random(): number {
    // Simple LCG
    this.rngState = (this.rngState * 1103515245 + 12345) % 2147483648;
    return this.rngState / 2147483648;
  }

  /**
   * Emit an event to all callbacks
   */
  private emitEvent(event: BrokerOrderEvent): void {
    this.lastEventAt = Date.now();

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

    // Also emit on EventEmitter
    this.emit('broker:event', event);
    this.emit(`broker:${event.type}`, event);
  }

  // ============ Testing Helpers ============

  /**
   * Reset RNG state (for deterministic tests)
   */
  public setRandomSeed(seed: number): void {
    this.rngState = seed;
  }

  /**
   * Get order by client ID (for testing)
   */
  public getOrder(clientOrderId: string): SimulatedOrder | undefined {
    return this.orders.get(clientOrderId);
  }

  /**
   * Clear all orders (for testing)
   */
  public reset(): void {
    this.orders.clear();
    this.marketPrices.clear();
    this.fillSequence = 0;
    this.lastEventAt = null;
  }
}
