import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';
import { Logger } from '../core/logger';
import { CoinbaseExchange, CoinbaseOrder, OrderRequest, Fill } from '../exchanges/coinbase';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

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
  side: 'buy' | 'sell';
  type: 'limit' | 'market' | 'twap';
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
}

export interface TWAPOrder extends ManagedOrder {
  type: 'twap';
  totalSize: string;
  remainingSize: string;
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
  private supabase: SupabaseClient;
  private orders: Map<string, ManagedOrder> = new Map();
  private twapOrders: Map<string, TWAPOrder> = new Map();
  private twapTimers: Map<string, NodeJS.Timeout[]> = new Map();

  constructor(
    config: OrderManagerConfig,
    logger: Logger,
    exchange: CoinbaseExchange
  ) {
    super();
    this.config = config;
    this.logger = logger;
    this.exchange = exchange;
    this.supabase = createClient(config.supabaseUrl, config.supabaseKey);

    this.setupExchangeHandlers();
  }

  private setupExchangeHandlers(): void {
    this.exchange.on('order', this.handleExchangeOrder.bind(this));
    this.exchange.on('fill', this.handleExchangeFill.bind(this));
  }

  private async handleExchangeOrder(order: CoinbaseOrder): Promise<void> {
    const managedOrder = this.orders.get(order.id);
    if (!managedOrder) {
      return;
    }

    // Update order status
    managedOrder.status = this.mapExchangeStatus(order.status);
    managedOrder.filledSize = order.filled_size;
    managedOrder.executedValue = order.executed_value;
    managedOrder.fees = order.fill_fees;
    managedOrder.updatedAt = new Date();

    await this.persistOrder(managedOrder);
    this.emit('order:placed', managedOrder);
  }

  private async handleExchangeFill(fill: Fill): Promise<void> {
    const managedOrder = this.orders.get(fill.order_id);
    if (!managedOrder) {
      return;
    }

    managedOrder.filledSize = fill.size;
    managedOrder.executedValue = fill.usd_volume;
    managedOrder.fees = fill.fee;
    managedOrder.updatedAt = new Date();

    await this.persistOrder(managedOrder);
    this.emit('order:filled', managedOrder, fill);

    // Check if this completes a TWAP slice
    if (managedOrder.parentOrderId) {
      await this.checkTWAPProgress(managedOrder.parentOrderId);
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
  public async createOrder(request: Omit<OrderRequest, 'client_oid'>): Promise<ManagedOrder> {
    const clientOrderId = uuidv4();
    const managedOrder: ManagedOrder = {
      id: clientOrderId,
      clientOrderId,
      productId: request.product_id,
      side: request.side,
      type: request.type,
      size: request.size || '0',
      price: request.price,
      status: 'pending',
      filledSize: '0',
      executedValue: '0',
      fees: '0',
      createdAt: new Date(),
      updatedAt: new Date()
    };

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
    
    // Calculate slices
    const numSlices = request.numSlices || Math.ceil(request.duration / this.config.twapConfig.sliceDuration);
    const slices = this.generateTWAPSlices(request.totalSize, numSlices, startTime, endTime);

    const twapOrder: TWAPOrder = {
      id: parentId,
      clientOrderId: parentId,
      productId: request.product_id,
      side: request.side,
      type: 'twap',
      size: request.totalSize,
      price: request.price,
      status: 'pending',
      filledSize: '0',
      executedValue: '0',
      fees: '0',
      totalSize: request.totalSize,
      remainingSize: request.totalSize,
      slices,
      startTime,
      endTime,
      createdAt: new Date(),
      updatedAt: new Date()
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
      lastSlice.size = (parseFloat(lastSlice.size) + remainingSize).toString();
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
          totalFilled += parseFloat(sliceOrder.filledSize);
        }
      }
    }

    twapOrder.filledSize = totalFilled.toString();
    twapOrder.remainingSize = (parseFloat(twapOrder.totalSize) - totalFilled).toString();

    // Check if complete
    const allSlicesExecuted = twapOrder.slices.every(s => s.status !== 'pending');
    if (allSlicesExecuted || totalFilled >= parseFloat(twapOrder.totalSize)) {
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
    try {
      const { error } = await this.supabase
        .from('orders')
        .upsert({
          id: order.id,
          client_order_id: order.clientOrderId,
          exchange_order_id: order.exchangeOrderId,
          product_id: order.product,
          side: order.side,
          type: order.type,
          size: order.size.toString(),
          price: order.price?.toString(),
          status: order.status,
          filled_size: order.filledSize.toString(),
          executed_value: order.executedValue.toString(),
          fees: order.fee.toString(),
          parent_order_id: order.parentOrderId,
          metadata: order.metadata || {},
          created_at: order.createdAt.toISOString(),
          updated_at: order.updatedAt.toISOString()
        });

      if (error) {
        this.logger.error('Failed to persist order:', error);
      }
    } catch (error) {
      this.logger.error('Error persisting order:', error);
    }
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

  // Track paper trading order
  public async trackPaperOrder(order: ManagedOrder): Promise<void> {
    this.orders.set(order.id, order);
    await this.persistOrder(order);
    this.emit('order:created', order);
  }
}
