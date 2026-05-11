import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';
import { createClient } from '@supabase/supabase-js';
import { Logger } from '../core/logger';
import { CoinbaseExchange, CoinbaseOrder, OrderRequest, Fill } from '../exchanges/coinbase';
import { IExchangeAdapter, AdapterOrderResult } from '../exchanges/types';

export interface OrderManagerConfig {
  supabaseUrl: string;
  supabaseKey: string;
  defaultTimeInForce: 'GTC' | 'GTT' | 'IOC' | 'FOK';
  maxOrderRetries: number;
  postOnlyRetries: number;
  twapConfig: {
    minSliceSize: number;
    maxSliceSize: number;
    sliceDuration: number; // milliseconds
    randomizeSize: boolean;
    randomizeTime: boolean;
  };
}

export interface ManagedOrder {
  id: string;
  clientOrderId: string;
  exchangeOrderId?: string;
  product: string;
  productId?: string;
  side: 'buy' | 'sell';
  type: 'limit' | 'market' | 'stop' | 'twap';
  size: number;
  price?: number;
  status: string; // Aligns with OrderStatus from Coinbase types
  filledSize: number;
  executedValue: number;
  fee: number;
  createdAt: Date;
  updatedAt: Date;
  parentOrderId?: string; // For TWAP child orders
  metadata?: Record<string, any>;
  fills: Fill[];
  strategy?: string;
}

export interface TWAPOrder extends ManagedOrder {
  type: 'twap';
  totalSize: number;
  remainingSize: number;
  slices: TWAPSlice[];
  startTime: Date;
  endTime: Date;
}

export interface TWAPSlice {
  id: string;
  size: string;
  scheduledTime: Date;
  executedTime?: Date;
  orderId?: string;
  status: 'pending' | 'executed' | 'failed';
}

export interface OrderManagerEvents {
  'order:created': (order: ManagedOrder) => void;
  'order:placed': (order: ManagedOrder) => void;
  'order:filled': (order: ManagedOrder, fill: Fill) => void;
  'order:cancelled': (order: ManagedOrder) => void;
  'order:failed': (order: ManagedOrder, error: Error) => void;
  'twap:slice': (parentId: string, slice: TWAPSlice) => void;
  'twap:complete': (order: TWAPOrder) => void;
}

export class OrderManager extends EventEmitter {
  private config: OrderManagerConfig;
  private logger: Logger;
  private exchange: CoinbaseExchange;
  private exchangeAdapter: IExchangeAdapter | null = null;
  private orders: Map<string, ManagedOrder> = new Map();
  private exchangeIdToManagedId: Map<string, string> = new Map();
  private twapOrders: Map<string, TWAPOrder> = new Map();
  private twapTimers: Map<string, NodeJS.Timeout[]> = new Map();
  private fillLocks: Set<string> = new Set();

  constructor(
    config: OrderManagerConfig,
    logger: Logger,
    exchange: CoinbaseExchange
  ) {
    super();
    this.config = config;
    this.logger = logger;
    this.exchange = exchange;

    this.setupExchangeHandlers();
  }

  private setupExchangeHandlers(): void {
    this.exchange.on('order', this.handleExchangeOrder.bind(this));
    this.exchange.on('fill', this.handleExchangeFill.bind(this));
  }

  /**
   * Set an exchange adapter for decoupled exchange access.
   * When set, order update events from the adapter are bridged into the existing
   * event flow, so downstream handlers (position tracker, risk engine) work unchanged.
   * This enables multi-exchange support without modifying existing order logic.
   */
  public setExchangeAdapter(adapter: IExchangeAdapter): void {
    this.exchangeAdapter = adapter;
    this.logger.info(`OrderManager: Exchange adapter set to '${adapter.id}'`);

    adapter.on('order:update', (result: AdapterOrderResult) => {
      const mappedOrder: any = {
        id: result.orderId,
        product_id: result.symbol,
        side: result.side,
        type: result.type,
        status: result.status === 'filled' ? 'done' : result.status === 'cancelled' ? 'canceled' : result.status,
        filled_size: result.filledSize,
        executed_value: String(parseFloat(result.filledSize) * parseFloat(result.avgFillPrice)),
        fill_fees: result.fees,
        created_at: new Date(result.timestamp).toISOString(),
        settled: result.status === 'filled',
        size: result.size,
        price: result.avgFillPrice,
      };
      this.handleExchangeOrder(mappedOrder);
    });
  }

  private resolveManagedOrderByExchangeId(exchangeOrderId: string): ManagedOrder | undefined {
    // Paper mode often uses the client order id as the order id.
    const direct = this.orders.get(exchangeOrderId);
    if (direct) {
      return direct;
    }
    
    const managedId = this.exchangeIdToManagedId.get(exchangeOrderId);
    if (!managedId) {
      return undefined;
    }
    return this.orders.get(managedId);
  }
  
  private resolveManagedOrderFromExchangeOrder(order: CoinbaseOrder): ManagedOrder | undefined {
    const byExchangeId = this.resolveManagedOrderByExchangeId(order.id);
    if (byExchangeId) {
      return byExchangeId;
    }
    
    // Coinbase often echoes client_oid (or similar) back on order payloads.
    const clientOid = (order as any).client_oid || (order as any).client_order_id || (order as any).clientOrderId;
    if (typeof clientOid === 'string' && clientOid.length > 0) {
      const byClient = this.orders.get(clientOid);
      if (byClient) {
        byClient.exchangeOrderId = order.id;
        this.exchangeIdToManagedId.set(order.id, byClient.id);
        return byClient;
      }
    }
    
    return undefined;
  }

  private async handleExchangeOrder(order: CoinbaseOrder): Promise<void> {
    const managedOrder = this.resolveManagedOrderFromExchangeOrder(order);
    if (!managedOrder) {
      return;
    }
    
    // Ensure the exchange id mapping exists for subsequent fills.
    if (managedOrder.exchangeOrderId) {
      this.exchangeIdToManagedId.set(managedOrder.exchangeOrderId, managedOrder.id);
    } else {
      managedOrder.exchangeOrderId = order.id;
      this.exchangeIdToManagedId.set(order.id, managedOrder.id);
    }

    // Update order status
    managedOrder.status = this.mapExchangeStatus(order.status);
    managedOrder.filledSize = order.filled_size ? parseFloat(order.filled_size) : managedOrder.filledSize;
    managedOrder.executedValue = order.executed_value ? parseFloat(order.executed_value) : managedOrder.executedValue;
    managedOrder.fee = order.fill_fees ? parseFloat(order.fill_fees) : managedOrder.fee;
    managedOrder.updatedAt = new Date();

    await this.persistOrder(managedOrder);
    this.emit('order:placed', managedOrder);
  }

  private async handleExchangeFill(fill: Fill): Promise<void> {
    const orderId = fill.order_id;

    while (this.fillLocks.has(orderId)) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    this.fillLocks.add(orderId);

    try {
      const managedOrder = this.resolveManagedOrderByExchangeId(orderId);
      if (!managedOrder) {
        return;
      }

      const fillSize = Number.parseFloat(fill.size);
      const fillPrice = Number.parseFloat(fill.price);
      const fillFee = Number.parseFloat(fill.fee);
      const fillUsdValue = fill.usd_volume
        ? Number.parseFloat(fill.usd_volume)
        : (fillPrice * fillSize);

      const safeFillSize = Number.isFinite(fillSize) ? fillSize : 0;
      const safeFillUsdValue = Number.isFinite(fillUsdValue) ? fillUsdValue : 0;
      const safeFillFee = Number.isFinite(fillFee) ? fillFee : 0;

      managedOrder.filledSize = Math.max(0, managedOrder.filledSize + safeFillSize);
      managedOrder.executedValue = Math.max(0, managedOrder.executedValue + safeFillUsdValue);
      managedOrder.fee = Math.max(0, managedOrder.fee + safeFillFee);

      const epsilon = 1e-12;
      if (managedOrder.size > 0 && managedOrder.filledSize + epsilon >= managedOrder.size) {
        managedOrder.status = 'filled';
        managedOrder.filledSize = managedOrder.size;
      } else if (safeFillSize > 0) {
        managedOrder.status = 'partially_filled';
      }
      managedOrder.updatedAt = new Date(fill.created_at);
      managedOrder.fills = [...managedOrder.fills, fill];

      await this.persistOrder(managedOrder);
      this.emit('order:filled', managedOrder, fill);

      if (managedOrder.parentOrderId) {
        await this.checkTWAPProgress(managedOrder.parentOrderId);
      }
    } finally {
      this.fillLocks.delete(orderId);
    }
  }

  private mapExchangeStatus(status: string): ManagedOrder['status'] {
    switch (status) {
      case 'pending':
      case 'open':
      case 'active':
        return 'open';
      case 'done':
        return 'filled';
      case 'canceled':
      case 'rejected':
        return 'cancelled';
      default:
        return 'pending';
    }
  }

  // Create a standard order
  public async createOrder(
    request: Omit<OrderRequest, 'client_oid'>,
    init?: {
      metadata?: Record<string, any>;
      strategy?: string;
    }
  ): Promise<ManagedOrder> {
    const clientOrderId = uuidv4();
    const parsedSize = request.size ? parseFloat(request.size) : 0;
    const parsedPrice = request.price ? parseFloat(request.price) : undefined;
    const managedOrder: ManagedOrder = {
      id: clientOrderId,
      clientOrderId,
      product: request.product_id,
      productId: request.product_id,
      side: request.side,
      type: request.type,
      size: Number.isFinite(parsedSize) ? parsedSize : 0,
      price: parsedPrice,
      status: 'pending',
      filledSize: 0,
      executedValue: 0,
      fee: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
      metadata: init?.metadata ?? {},
      fills: []
    };
    
    if (init?.strategy) {
      managedOrder.strategy = init.strategy;
    }

    this.orders.set(clientOrderId, managedOrder);
    await this.persistOrder(managedOrder);
    this.emit('order:created', managedOrder);

    try {
      managedOrder.status = 'placing';
      const exchangeOrder = await this.placeOrderWithRetry({
        ...request,
        client_oid: clientOrderId
      });

      managedOrder.exchangeOrderId = exchangeOrder.id;
      this.exchangeIdToManagedId.set(exchangeOrder.id, managedOrder.id);
      managedOrder.status = 'open';
      await this.persistOrder(managedOrder);

      return managedOrder;
    } catch (error) {
      managedOrder.status = 'failed';
      await this.persistOrder(managedOrder);
      this.emit('order:failed', managedOrder, error as Error);
      throw error;
    }
  }

  // Create a TWAP order
  public async createTWAPOrder(
    request: Omit<OrderRequest, 'client_oid' | 'size'> & {
      totalSize: string;
      duration: number; // milliseconds
      numSlices?: number;
    }
  ): Promise<TWAPOrder> {
    const parentId = uuidv4();
    const startTime = new Date();
    const endTime = new Date(startTime.getTime() + request.duration);
    const totalSize = request.totalSize ? parseFloat(request.totalSize) : 0;
    const price = request.price ? parseFloat(request.price) : undefined;
    
    // Calculate slices
    const numSlices = request.numSlices || Math.ceil(request.duration / this.config.twapConfig.sliceDuration);
    const slices = this.generateTWAPSlices(request.totalSize, numSlices, startTime, endTime);

    const twapOrder: TWAPOrder = {
      id: parentId,
      clientOrderId: parentId,
      product: request.product_id,
      productId: request.product_id,
      side: request.side,
      type: 'twap',
      size: Number.isFinite(totalSize) ? totalSize : 0,
      price,
      status: 'pending',
      filledSize: 0,
      executedValue: 0,
      fee: 0,
      totalSize: Number.isFinite(totalSize) ? totalSize : 0,
      remainingSize: Number.isFinite(totalSize) ? totalSize : 0,
      slices,
      startTime,
      endTime,
      createdAt: new Date(),
      updatedAt: new Date(),
      metadata: {},
      fills: []
    };

    this.twapOrders.set(parentId, twapOrder);
    await this.persistOrder(twapOrder);
    this.emit('order:created', twapOrder);

    // Schedule slice executions
    this.scheduleTWAPSlices(twapOrder, request);

    return twapOrder;
  }

  private generateTWAPSlices(
    totalSize: string,
    numSlices: number,
    startTime: Date,
    endTime: Date
  ): TWAPSlice[] {
    const slices: TWAPSlice[] = [];
    const totalSizeNum = parseFloat(totalSize);
    const baseSliceSize = totalSizeNum / numSlices;
    const timeDelta = (endTime.getTime() - startTime.getTime()) / numSlices;

    let remainingSize = totalSizeNum;

    for (let i = 0; i < numSlices; i++) {
      let sliceSize = baseSliceSize;

      // Randomize size if configured
      if (this.config.twapConfig.randomizeSize) {
        const variation = 0.2; // 20% variation
        sliceSize = baseSliceSize * (1 + (Math.random() - 0.5) * variation);
      }

      // Ensure we don't exceed remaining size
      sliceSize = Math.min(sliceSize, remainingSize);

      // Round to appropriate precision
      sliceSize = Math.round(sliceSize * 100000000) / 100000000; // 8 decimal places

      let scheduledTime = new Date(startTime.getTime() + i * timeDelta);

      // Randomize time if configured
      if (this.config.twapConfig.randomizeTime && i > 0) {
        const timeVariation = timeDelta * 0.1; // 10% time variation
        const randomOffset = (Math.random() - 0.5) * timeVariation;
        scheduledTime = new Date(scheduledTime.getTime() + randomOffset);
      }

      slices.push({
        id: uuidv4(),
        size: sliceSize.toString(),
        scheduledTime,
        status: 'pending'
      });

      remainingSize -= sliceSize;
    }

    // Add any remaining size to the last slice due to rounding
    if (remainingSize > 0 && slices.length > 0) {
      const lastSlice = slices[slices.length - 1];
      if (lastSlice) {
        lastSlice.size = (parseFloat(lastSlice.size) + remainingSize).toString();
      }
    }

    return slices;
  }

  private scheduleTWAPSlices(twapOrder: TWAPOrder, request: any): void {
    const timers: NodeJS.Timeout[] = [];

    for (const slice of twapOrder.slices) {
      const delay = slice.scheduledTime.getTime() - Date.now();
      
      if (delay > 0) {
        const timer = setTimeout(async () => {
          await this.executeTWAPSlice(twapOrder, slice, request);
        }, delay);

        timers.push(timer);
      } else {
        // Execute immediately if scheduled time has passed
        this.executeTWAPSlice(twapOrder, slice, request);
      }
    }

    this.twapTimers.set(twapOrder.id, timers);
  }

  private async executeTWAPSlice(
    twapOrder: TWAPOrder,
    slice: TWAPSlice,
    request: any
  ): Promise<void> {
    try {
      this.logger.info(`Executing TWAP slice ${slice.id} for order ${twapOrder.id}`);
      
      slice.executedTime = new Date();
      this.emit('twap:slice', twapOrder.id, slice);

      const sliceOrder = await this.createOrder({
        product_id: request.product_id,
        side: request.side,
        type: request.type || 'limit',
        size: slice.size,
        price: request.price,
        time_in_force: this.config.defaultTimeInForce,
        post_only: true
      });

      // Link slice to parent
      sliceOrder.parentOrderId = twapOrder.id;
      slice.orderId = sliceOrder.id;
      slice.status = 'executed';

      await this.persistOrder(twapOrder);
    } catch (error) {
      this.logger.error(`Failed to execute TWAP slice ${slice.id}:`, error);
      slice.status = 'failed';
      await this.persistOrder(twapOrder);
    }
  }

  private async checkTWAPProgress(parentId: string): Promise<void> {
    const twapOrder = this.twapOrders.get(parentId);
    if (!twapOrder) {
      return;
    }

    // Calculate filled amount
    let totalFilled = 0;
    for (const slice of twapOrder.slices) {
      if (slice.orderId) {
        const sliceOrder = this.orders.get(slice.orderId);
        if (sliceOrder) {
          totalFilled += sliceOrder.filledSize;
        }
      }
    }

    twapOrder.filledSize = totalFilled;
    twapOrder.remainingSize = Math.max(twapOrder.totalSize - totalFilled, 0);

    // Check if complete
    const allSlicesExecuted = twapOrder.slices.every(s => s.status !== 'pending');
    if (allSlicesExecuted || totalFilled >= twapOrder.totalSize) {
      twapOrder.status = 'filled';
      this.emit('twap:complete', twapOrder);
      
      // Clear timers
      const timers = this.twapTimers.get(parentId);
      if (timers) {
        timers.forEach(timer => clearTimeout(timer));
        this.twapTimers.delete(parentId);
      }
    }

    await this.persistOrder(twapOrder);
  }

  // Place order with retry logic for post-only
  private async placeOrderWithRetry(request: OrderRequest): Promise<CoinbaseOrder> {
    let retries = 0;
    const maxRetries = request.post_only ? this.config.postOnlyRetries : this.config.maxOrderRetries;

    while (retries < maxRetries) {
      try {
        const order = await this.exchange.createOrder(request);
        return order;
      } catch (error: any) {
        retries++;
        
        // Check if it's a post-only rejection
        if (request.post_only && error.message?.includes('post-only')) {
          this.logger.warn(`Post-only order rejected, retry ${retries}/${maxRetries}`);
          
          // Adjust price slightly to make it post-only
          if (request.price && request.side === 'buy') {
            request.price = (parseFloat(request.price) * 0.9995).toFixed(2);
          } else if (request.price && request.side === 'sell') {
            request.price = (parseFloat(request.price) * 1.0005).toFixed(2);
          }
          
          // Wait before retry
          await new Promise(resolve => setTimeout(resolve, 1000 * retries));
        } else {
          throw error;
        }
      }
    }

    throw new Error(`Failed to place order after ${maxRetries} retries`);
  }

  // Cancel order
  public async cancelOrder(orderId: string): Promise<boolean> {
    if (this.twapOrders.has(orderId)) {
      return this.cancelTWAPOrder(orderId);
    }

    const order = this.orders.get(orderId);
    if (!order) {
      throw new Error(`Order ${orderId} not found`);
    }

    if (order.exchangeOrderId) {
      const cancelled = await this.exchange.cancelOrder(order.exchangeOrderId);
      if (cancelled) {
        order.status = 'cancelled';
        order.updatedAt = new Date();
        await this.persistOrder(order);
        this.emit('order:cancelled', order);
        return true;
      }
    }

    return false;
  }

  // Cancel TWAP order
  public async cancelTWAPOrder(orderId: string): Promise<boolean> {
    const twapOrder = this.twapOrders.get(orderId);
    if (!twapOrder) {
      throw new Error(`TWAP order ${orderId} not found`);
    }

    // Cancel all pending slices
    const timers = this.twapTimers.get(orderId);
    if (timers) {
      timers.forEach(timer => clearTimeout(timer));
      this.twapTimers.delete(orderId);
    }

    // Cancel any open slice orders
    for (const slice of twapOrder.slices) {
      if (slice.orderId && slice.status === 'executed') {
        await this.cancelOrder(slice.orderId);
      }
    }

    twapOrder.status = 'cancelled';
    twapOrder.updatedAt = new Date();
    await this.persistOrder(twapOrder);
    this.emit('order:cancelled', twapOrder);

    return true;
  }

  // Persist order to database
  private async persistOrder(order: ManagedOrder | TWAPOrder): Promise<void> {
    // Persistence is handled upstream in the API layer when events emit.
    return;
  }

  // Get all active orders
  public getActiveOrders(): ManagedOrder[] {
    return Array.from(this.orders.values()).filter(
      order => ['pending', 'placing', 'open'].includes(order.status)
    );
  }

  // Get order by ID
  public getOrder(orderId: string): ManagedOrder | undefined {
    return this.orders.get(orderId) || this.twapOrders.get(orderId);
  }
  
  public getOrderByExchangeOrderId(exchangeOrderId: string): ManagedOrder | undefined {
    return this.resolveManagedOrderByExchangeId(exchangeOrderId);
  }

  /**
   * Rehydrate active (open / pending / partially_filled) orders from Supabase.
   * Called by TradingEngine on startup so PM2/start.cjs restarts don't lose
   * track of in-flight orders.
   *
   * - Supabase column shape (per syncOrderToSupabase): id, external_order_id,
   *   symbol, side, type, status (working|new|partially_filled|filled|...),
   *   price, quantity, strategy, created_at, updated_at.
   * - We hydrate everything that isn't terminal so cancel paths still work.
   * - Idempotent: clears the active set first.
   * - Failure throws so the engine can log it as a hydration failure branch.
   */
  public async hydrateOpenOrders(
    userId: string,
    creds: { supabaseUrl: string; supabaseKey: string }
  ): Promise<number> {
    if (!userId) {
      this.logger.warn('hydrateOpenOrders called with empty userId — skipping');
      return 0;
    }
    if (!creds?.supabaseUrl || !creds?.supabaseKey) {
      this.logger.warn('hydrateOpenOrders called without supabase credentials — skipping');
      return 0;
    }

    const supabase = createClient(creds.supabaseUrl, creds.supabaseKey);

    // syncOrderToSupabase maps engine status -> 'working' | 'new' | 'partially_filled' | 'filled' | 'canceled' | 'rejected' | 'expired'.
    // Anything not terminal is in-flight from the engine's perspective.
    const activeStatuses = ['working', 'new', 'partially_filled'];

    const { data, error } = await supabase
      .from('orders')
      .select('id, external_order_id, symbol, side, type, status, price, quantity, strategy, created_at, updated_at, meta_prob')
      .eq('user_id', userId)
      .in('status', activeStatuses);

    if (error) {
      throw new Error(`orders hydrate query failed: ${error.message}`);
    }

    // Reset both maps so a stale in-memory order can't shadow a re-hydrated one.
    this.orders.clear();
    this.exchangeIdToManagedId.clear();

    let hydrated = 0;
    for (const row of data ?? []) {
      try {
        const size = Number(row.quantity ?? 0);
        if (!Number.isFinite(size) || size <= 0) {
          this.logger.warn('Skipping malformed open order during hydrate', {
            id: row.id,
            symbol: row.symbol,
            quantity: row.quantity,
          });
          continue;
        }
        // Map Supabase status back to engine status. We pick conservative
        // values that keep the order in getActiveOrders() so cancel paths
        // still work without forcing a fill.
        const supabaseStatus = String(row.status ?? '').toLowerCase();
        let engineStatus = 'open';
        if (supabaseStatus === 'new') engineStatus = 'pending';
        else if (supabaseStatus === 'partially_filled') engineStatus = 'partially_filled';
        else engineStatus = 'open';

        const side: ManagedOrder['side'] = row.side === 'sell' ? 'sell' : 'buy';
        const type: ManagedOrder['type'] = ['limit', 'market', 'stop', 'twap'].includes(row.type) ? row.type : 'limit';

        const managed: ManagedOrder = {
          id: row.id,
          clientOrderId: row.id,
          exchangeOrderId: row.external_order_id ?? undefined,
          product: row.symbol,
          productId: row.symbol,
          side,
          type,
          size,
          price: row.price !== null && row.price !== undefined ? Number(row.price) : undefined,
          status: engineStatus,
          filledSize: 0,
          executedValue: 0,
          fee: 0,
          createdAt: row.created_at ? new Date(row.created_at) : new Date(),
          updatedAt: row.updated_at ? new Date(row.updated_at) : new Date(),
          fills: [],
          strategy: row.strategy ?? undefined,
          metadata: { hydratedFromSupabase: true, metaProb: row.meta_prob ?? undefined },
        };

        this.orders.set(managed.id, managed);
        if (managed.exchangeOrderId) {
          this.exchangeIdToManagedId.set(managed.exchangeOrderId, managed.id);
        }
        hydrated++;
      } catch (err) {
        this.logger.error('Failed to materialize hydrated order', {
          id: row?.id,
          symbol: row?.symbol,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    this.logger.info('OrderManager hydrated open orders', {
      userId,
      rowsReturned: data?.length ?? 0,
      hydrated,
      activeStatuses,
    });

    return hydrated;
  }

  // Track paper trading order
  public async trackPaperOrder(order: ManagedOrder): Promise<void> {
    this.orders.set(order.id, order);
    if (order.exchangeOrderId) {
      this.exchangeIdToManagedId.set(order.exchangeOrderId, order.id);
    } else {
      // In paper mode, we typically use the client id as the order id.
      this.exchangeIdToManagedId.set(order.id, order.id);
    }
    await this.persistOrder(order);
    this.emit('order:created', order);
  }
  
  /**
   * Clean up all timers and locks. Call on engine shutdown.
   */
  public destroy(): void {
    for (const [id, timers] of this.twapTimers) {
      timers.forEach(timer => clearTimeout(timer));
    }
    this.twapTimers.clear();
    this.fillLocks.clear();
  }

  // Mark an order cancelled without calling the exchange (paper mode, local cancels)
  public cancelLocalOrder(orderId: string): ManagedOrder | null {
    const order = this.orders.get(orderId);
    if (!order) {
      return null;
    }
    
    const terminal = new Set(['filled', 'done', 'cancelled', 'canceled', 'rejected', 'failed']);
    if (terminal.has(String(order.status || '').toLowerCase())) {
      return order;
    }
    
    order.status = 'cancelled';
    order.updatedAt = new Date();
    this.emit('order:cancelled', order);
    return order;
  }
}
