/**
 * Coinbase Live Execution Adapter
 * 
 * Implements the ExecutionAdapter interface for live trading on Coinbase.
 * Uses the hardened REST layer (Step 3) for order placement.
 * Integrates with WS + REST reconciliation for fills.
 */

import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';
import { Logger } from '../../core/logger';
import { CoinbaseExchange } from '../../exchanges/coinbase';
import { CoinbaseOrder, Fill, OrderRequest } from '../../exchanges/coinbase/types';
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
 * Live adapter configuration
 */
export interface CoinbaseLiveAdapterConfig {
  /** Logger instance */
  logger: Logger;
  /** Coinbase exchange instance */
  exchange: CoinbaseExchange;
  /** Product specifications (optional, uses defaults) */
  productSpecs?: Record<string, ProductSpec>;
}

/**
 * Coinbase Live Execution Adapter
 * 
 * Responsibilities:
 * - Place/cancel orders via hardened REST layer
 * - Ingest fills via WS + REST reconciliation
 * - Emit standardized BrokerOrderEvent events
 * - Never depends on paper logic
 */
export class CoinbaseLiveExecutionAdapter extends EventEmitter implements IExecutionAdapter {
  public readonly mode: ExecutionMode = 'live';

  private logger: Logger;
  private exchange: CoinbaseExchange;
  private productSpecs: Record<string, ProductSpec>;

  // State
  private running = false;
  private eventCallbacks: Array<(event: BrokerOrderEvent) => void> = [];
  private pendingOrders: Map<string, PlaceOrderRequest> = new Map();
  private clientToExchangeId: Map<string, string> = new Map();
  private seenFills: Set<string> = new Set();
  private lastEventAt: number | null = null;

  constructor(config: CoinbaseLiveAdapterConfig) {
    super();
    this.logger = config.logger;
    this.exchange = config.exchange;
    this.productSpecs = config.productSpecs || DEFAULT_PRODUCT_SPECS;
  }

  /**
   * Start the adapter
   */
  public async start(): Promise<void> {
    if (this.running) {
      this.logger.warn('Live adapter already running');
      return;
    }

    this.logger.info('Starting Coinbase live execution adapter');
    this.running = true;

    // Listen for exchange events
    this.setupExchangeListeners();

    // Start reconciler if available
    this.exchange.startReconciler?.();
  }

  /**
   * Stop the adapter
   */
  public async stop(): Promise<void> {
    if (!this.running) {
      return;
    }

    this.logger.info('Stopping Coinbase live execution adapter');
    this.running = false;

    // Stop reconciler
    this.exchange.stopReconciler?.();

    // Clear state
    this.pendingOrders.clear();
    this.clientToExchangeId.clear();
  }

  /**
   * Place an order
   */
  public async placeOrder(request: PlaceOrderRequest): Promise<void> {
    if (!this.running) {
      throw new Error('Live adapter not running');
    }

    this.logger.info('Live adapter placing order', {
      clientOrderId: request.clientOrderId,
      symbol: request.symbol,
      side: request.side,
      type: request.type,
      quantity: request.quantity,
      price: request.price,
    });

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

    // Validate order
    const validation = validateOrderAgainstSpec(request, spec);
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

    // Track pending order
    this.pendingOrders.set(request.clientOrderId, request);

    try {
      // Build Coinbase order request
      const orderRequest: OrderRequest = {
        product_id: request.symbol,
        side: request.side,
        type: request.type,
        size: quantity.toString(),
        client_oid: request.clientOrderId,
      };

      if (price !== undefined) {
        orderRequest.price = price.toString();
      }

      if (request.postOnly) {
        orderRequest.post_only = true;
      }

      if (request.timeInForce) {
        orderRequest.time_in_force = request.timeInForce;
      }

      // Place order via exchange
      const coinbaseOrder = await this.exchange.createOrder(orderRequest);

      // Map client ID to exchange ID
      this.clientToExchangeId.set(request.clientOrderId, coinbaseOrder.id);

      // Emit accepted event
      this.emitEvent({
        type: 'order_accepted',
        clientOrderId: request.clientOrderId,
        exchangeOrderId: coinbaseOrder.id,
        ts: Date.now(),
        raw: coinbaseOrder,
      });

      // Trigger reconciliation after order
      this.exchange.triggerReconciliation?.().catch(e => {
        this.logger.warn('Post-order reconciliation failed', { error: e.message });
      });

    } catch (error: any) {
      this.pendingOrders.delete(request.clientOrderId);

      const message = error.message || String(error);
      const code = error.coinbaseCode || error.code;

      this.emitEvent({
        type: 'order_rejected',
        clientOrderId: request.clientOrderId,
        reason: message,
        code,
        ts: Date.now(),
        raw: error,
      });

      this.logger.error('Live order placement failed', {
        clientOrderId: request.clientOrderId,
        error: message,
      });
    }
  }

  /**
   * Cancel an order
   */
  public async cancelOrder(clientOrderId: string): Promise<void> {
    if (!this.running) {
      throw new Error('Live adapter not running');
    }

    const exchangeOrderId = this.clientToExchangeId.get(clientOrderId);
    if (!exchangeOrderId) {
      this.logger.warn('Cannot cancel - no exchange order ID for client order', { clientOrderId });
      return;
    }

    try {
      await this.exchange.cancelOrder(exchangeOrderId);

      this.emitEvent({
        type: 'order_canceled',
        clientOrderId,
        exchangeOrderId,
        ts: Date.now(),
      });

      // Cleanup tracking
      this.pendingOrders.delete(clientOrderId);

      // Reconcile after cancel
      this.exchange.triggerReconciliation?.().catch(e => {
        this.logger.warn('Post-cancel reconciliation failed', { error: e.message });
      });

    } catch (error: any) {
      this.logger.error('Live order cancel failed', {
        clientOrderId,
        exchangeOrderId,
        error: error.message,
      });

      // Still emit canceled if cancel might have succeeded
      // (error could be from response timeout after cancel was processed)
      this.emitEvent({
        type: 'order_canceled',
        clientOrderId,
        exchangeOrderId,
        ts: Date.now(),
      });
    }
  }

  /**
   * Cancel all orders
   */
  public async cancelAllOrders(symbol?: string): Promise<void> {
    try {
      await this.exchange.cancelAllOrders(symbol);
      
      // Clear local tracking
      for (const [clientId, request] of this.pendingOrders) {
        if (!symbol || request.symbol === symbol) {
          this.emitEvent({
            type: 'order_canceled',
            clientOrderId: clientId,
            ts: Date.now(),
          });
          this.pendingOrders.delete(clientId);
        }
      }
    } catch (error: any) {
      this.logger.error('Cancel all orders failed', { symbol, error: error.message });
    }
  }

  /**
   * Get open orders
   */
  public async getOpenOrders(): Promise<OpenOrder[]> {
    try {
      const orders = await this.exchange.getOpenOrders();
      
      return orders.map(order => ({
        clientOrderId: (order as any).client_oid || order.id,
        exchangeOrderId: order.id,
        symbol: order.product_id,
        side: order.side as 'buy' | 'sell',
        type: order.type as 'market' | 'limit' | 'stop',
        price: order.price ? parseFloat(order.price) : undefined,
        quantity: parseFloat(order.size),
        filledQuantity: parseFloat(order.filled_size || '0'),
        status: order.status,
        createdAt: new Date(order.created_at).getTime(),
      }));
    } catch (error: any) {
      this.logger.error('Get open orders failed', { error: error.message });
      return [];
    }
  }

  /**
   * Get fills since cursor
   */
  public async getFillsSince(cursor: any): Promise<FillRecord[]> {
    try {
      const fills = await this.exchange.getFills(undefined, undefined, 100);
      
      return fills.map(fill => ({
        tradeId: String(fill.trade_id),
        orderId: fill.order_id,
        clientOrderId: undefined, // Coinbase doesn't return client_oid on fills
        symbol: fill.product_id,
        side: fill.side as 'buy' | 'sell',
        price: parseFloat(fill.price),
        size: parseFloat(fill.size),
        fee: parseFloat(fill.fee),
        feeCurrency: 'USD', // Assume USD fees
        liquidity: fill.liquidity === 'M' ? 'maker' : 'taker',
        ts: new Date(fill.created_at).getTime(),
      }));
    } catch (error: any) {
      this.logger.error('Get fills failed', { error: error.message });
      return [];
    }
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
    const exchangeHealth = this.exchange.getExchangeHealth?.() || {
      degraded: false,
      degradedReasons: [],
    };

    return {
      ok: !exchangeHealth.degraded && this.running,
      degraded: exchangeHealth.degraded,
      reasonCodes: exchangeHealth.degradedReasons || [],
      lastEventAt: this.lastEventAt,
      pendingOrderCount: this.pendingOrders.size,
    };
  }

  /**
   * Setup exchange event listeners
   */
  private setupExchangeListeners(): void {
    // Listen for order updates
    this.exchange.on('order', (order: CoinbaseOrder) => {
      this.handleOrderUpdate(order);
    });

    // Listen for fills
    this.exchange.on('fill', (fill: Fill) => {
      this.handleFill(fill);
    });
  }

  /**
   * Handle order update from exchange
   */
  private handleOrderUpdate(order: CoinbaseOrder): void {
    const clientOrderId = (order as any).client_oid || 
                          this.getClientOrderId(order.id);

    if (!clientOrderId) {
      return;
    }

    // Handle terminal states
    if (order.status === 'done' || order.status === 'settled') {
      this.pendingOrders.delete(clientOrderId);
    } else if (order.status === 'canceled' || order.status === 'cancelled') {
      this.emitEvent({
        type: 'order_canceled',
        clientOrderId,
        exchangeOrderId: order.id,
        ts: Date.now(),
        raw: order,
      });
      this.pendingOrders.delete(clientOrderId);
    }
  }

  /**
   * Handle fill from exchange
   */
  private handleFill(fill: Fill): void {
    const tradeId = String(fill.trade_id);
    
    // Dedupe
    if (this.seenFills.has(tradeId)) {
      return;
    }
    this.seenFills.add(tradeId);

    // Limit set size
    if (this.seenFills.size > 10000) {
      const arr = Array.from(this.seenFills);
      this.seenFills = new Set(arr.slice(-5000));
    }

    // Find client order ID
    const clientOrderId = this.getClientOrderId(fill.order_id);

    const spec = this.productSpecs[fill.product_id];

    this.emitEvent({
      type: 'fill',
      clientOrderId: clientOrderId || fill.order_id,
      exchangeOrderId: fill.order_id,
      tradeId,
      price: parseFloat(fill.price),
      size: parseFloat(fill.size),
      fee: parseFloat(fill.fee),
      feeCurrency: spec?.quoteCurrency || 'USD',
      liquidity: fill.liquidity === 'M' ? 'maker' : 'taker',
      ts: new Date(fill.created_at).getTime(),
      raw: fill,
    });
  }

  /**
   * Get client order ID from exchange order ID
   */
  private getClientOrderId(exchangeOrderId: string): string | undefined {
    for (const [clientId, exchangeId] of this.clientToExchangeId) {
      if (exchangeId === exchangeOrderId) {
        return clientId;
      }
    }
    return undefined;
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

    // Also emit on EventEmitter for flexibility
    this.emit('broker:event', event);
    this.emit(`broker:${event.type}`, event);
  }
}
