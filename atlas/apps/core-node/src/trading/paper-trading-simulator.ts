import { EventEmitter } from 'events';
import { Logger } from '../core/logger';
import { OrderRequest, OrderResponse, OrderStatus, Fill, Ticker } from '../exchanges/coinbase/types';
import { v4 as uuidv4 } from 'uuid';

export interface PaperTradingConfig {
  initialBalances: Map<string, number>; // currency -> amount (e.g., 'USD' -> 10000, 'BTC' -> 0)
  makerFee: number; // 0.004 for 0.4%
  takerFee: number; // 0.006 for 0.6%
  slippage: number; // 0.001 for 0.1%
  latencyMs: number; // Simulated order latency
}

interface SimulatedOrder {
  id: string;
  clientOrderId: string;
  productId: string;
  side: 'buy' | 'sell';
  type: 'limit' | 'market';
  size: number;
  price?: number;
  status: OrderStatus;
  filledSize: number;
  executedValue: number;
  createdAt: Date;
  updatedAt: Date;
  fills: Fill[];
}

export class PaperTradingSimulator extends EventEmitter {
  private config: PaperTradingConfig;
  private logger: Logger;
  private balances: Map<string, number>;
  private orders: Map<string, SimulatedOrder> = new Map();
  private marketPrices: Map<string, number> = new Map();
  private orderSequence = 0;
  private fillSequence = 0;

  constructor(config: PaperTradingConfig, logger: Logger) {
    super();
    this.config = config;
    this.logger = logger;
    this.balances = new Map(config.initialBalances);
  }

  /**
   * Update market price for a product
   */
  public updateMarketPrice(productId: string, price: number): void {
    this.marketPrices.set(productId, price);
    
    // Check if any limit orders can be filled
    this.checkLimitOrders(productId, price);
  }

  /**
   * Update market data from ticker
   */
  public updateFromTicker(ticker: Ticker): void {
    const price = parseFloat(ticker.price);
    this.updateMarketPrice(ticker.product_id, price);
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

  /**
   * Place an order
   */
  public async placeOrder(request: OrderRequest): Promise<OrderResponse> {
    // Simulate network latency
    await new Promise(resolve => setTimeout(resolve, this.config.latencyMs));

    const orderId = `paper_${uuidv4()}`;
    const [baseCurrency, quoteCurrency] = request.product_id.split('-');
    
    // Validate order
    const validation = this.validateOrder(request);
    if (!validation.valid) {
      throw new Error(validation.reason);
    }

    // Create simulated order
    const order: SimulatedOrder = {
      id: orderId,
      clientOrderId: request.client_oid || uuidv4(),
      productId: request.product_id,
      side: request.side,
      type: request.type,
      size: parseFloat(request.size),
      price: request.price ? parseFloat(request.price) : undefined,
      status: request.type === 'market' ? 'pending' : 'open',
      filledSize: 0,
      executedValue: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
      fills: []
    };

    this.orders.set(orderId, order);

    // Process order based on type
    if (order.type === 'market') {
      await this.executeMarketOrder(order);
    } else {
      // Check if limit order can be filled immediately
      const marketPrice = this.marketPrices.get(order.productId);
      if (marketPrice) {
        this.checkLimitOrderFill(order, marketPrice);
      }
    }

    // Return order response
    const response: OrderResponse = {
      id: order.id,
      product_id: order.productId,
      side: order.side,
      type: order.type,
      size: order.size.toString(),
      price: order.price?.toString(),
      status: order.status,
      filled_size: order.filledSize.toString(),
      executed_value: order.executedValue.toString(),
      created_at: order.createdAt.toISOString(),
      fill_fees: this.calculateFees(order).toString(),
      settled: order.status === 'done'
    };

    this.logger.info('Paper order placed', {
      orderId: order.id,
      productId: order.productId,
      side: order.side,
      type: order.type,
      size: order.size,
      price: order.price,
      status: order.status
    });

    return response;
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
  public getOrders(productId?: string, status?: OrderStatus[]): SimulatedOrder[] {
    let orders = Array.from(this.orders.values());
    
    if (productId) {
      orders = orders.filter(o => o.productId === productId);
    }
    
    if (status && status.length > 0) {
      orders = orders.filter(o => status.includes(o.status));
    }
    
    return orders;
  }

  /**
   * Validate order
   */
  private validateOrder(request: OrderRequest): { valid: boolean; reason?: string } {
    const [baseCurrency, quoteCurrency] = request.product_id.split('-');
    const size = parseFloat(request.size);
    const price = request.price ? parseFloat(request.price) : this.marketPrices.get(request.product_id) || 0;

    if (request.side === 'buy') {
      // Check quote currency balance
      const requiredAmount = size * price * (1 + this.config.takerFee);
      const available = this.getBalance(quoteCurrency);
      
      if (available < requiredAmount) {
        return { 
          valid: false, 
          reason: `Insufficient ${quoteCurrency} balance. Required: ${requiredAmount.toFixed(2)}, Available: ${available.toFixed(2)}` 
        };
      }
    } else {
      // Check base currency balance
      const available = this.getBalance(baseCurrency);
      
      if (available < size) {
        return { 
          valid: false, 
          reason: `Insufficient ${baseCurrency} balance. Required: ${size}, Available: ${available}` 
        };
      }
    }

    return { valid: true };
  }

  /**
   * Execute market order
   */
  private async executeMarketOrder(order: SimulatedOrder): Promise<void> {
    const marketPrice = this.marketPrices.get(order.productId);
    if (!marketPrice) {
      order.status = 'rejected';
      order.updatedAt = new Date();
      return;
    }

    // Apply slippage
    const executionPrice = order.side === 'buy' 
      ? marketPrice * (1 + this.config.slippage)
      : marketPrice * (1 - this.config.slippage);

    // Create fill
    const fill: Fill = {
      trade_id: `fill_${++this.fillSequence}`,
      product_id: order.productId,
      order_id: order.id,
      user_id: 'paper_trader',
      profile_id: 'default',
      liquidity: 'T', // Taker
      price: executionPrice.toString(),
      size: order.size.toString(),
      fee: (order.size * executionPrice * this.config.takerFee).toString(),
      side: order.side,
      settled: true,
      created_at: new Date().toISOString()
    };

    // Update order
    order.fills.push(fill);
    order.filledSize = order.size;
    order.executedValue = order.size * executionPrice;
    order.status = 'done';
    order.updatedAt = new Date();

    // Update balances
    this.updateBalances(order, fill);

    // Emit fill event
    this.emit('fill', fill);

    this.logger.info('Paper market order executed', {
      orderId: order.id,
      price: executionPrice,
      size: order.size,
      side: order.side
    });
  }

  /**
   * Check if limit order can be filled
   */
  private checkLimitOrderFill(order: SimulatedOrder, marketPrice: number): void {
    if (!order.price || order.status !== 'open') {
      return;
    }

    const canFill = (order.side === 'buy' && marketPrice <= order.price) ||
                   (order.side === 'sell' && marketPrice >= order.price);

    if (canFill) {
      // Create fill at limit price (maker)
      const fill: Fill = {
        trade_id: `fill_${++this.fillSequence}`,
        product_id: order.productId,
        order_id: order.id,
        user_id: 'paper_trader',
        profile_id: 'default',
        liquidity: 'M', // Maker
        price: order.price.toString(),
        size: order.size.toString(),
        fee: (order.size * order.price * this.config.makerFee).toString(),
        side: order.side,
        settled: true,
        created_at: new Date().toISOString()
      };

      // Update order
      order.fills.push(fill);
      order.filledSize = order.size;
      order.executedValue = order.size * order.price;
      order.status = 'done';
      order.updatedAt = new Date();

      // Update balances
      this.updateBalances(order, fill);

      // Emit fill event
      this.emit('fill', fill);

      this.logger.info('Paper limit order filled', {
        orderId: order.id,
        price: order.price,
        size: order.size,
        side: order.side
      });
    }
  }

  /**
   * Check all limit orders for a product
   */
  private checkLimitOrders(productId: string, marketPrice: number): void {
    for (const order of this.orders.values()) {
      if (order.productId === productId && order.type === 'limit' && order.status === 'open') {
        this.checkLimitOrderFill(order, marketPrice);
      }
    }
  }

  /**
   * Update balances after fill
   */
  private updateBalances(order: SimulatedOrder, fill: Fill): void {
    const [baseCurrency, quoteCurrency] = order.productId.split('-');
    const fillSize = parseFloat(fill.size);
    const fillPrice = parseFloat(fill.price);
    const fee = parseFloat(fill.fee);

    if (order.side === 'buy') {
      // Deduct quote currency
      const quoteCost = fillSize * fillPrice + fee;
      this.balances.set(quoteCurrency, this.getBalance(quoteCurrency) - quoteCost);
      
      // Add base currency
      this.balances.set(baseCurrency, this.getBalance(baseCurrency) + fillSize);
    } else {
      // Deduct base currency
      this.balances.set(baseCurrency, this.getBalance(baseCurrency) - fillSize);
      
      // Add quote currency (minus fee)
      const quoteReceived = fillSize * fillPrice - fee;
      this.balances.set(quoteCurrency, this.getBalance(quoteCurrency) + quoteReceived);
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
        // Look for market price
        const productId = `${currency}-USD`;
        const price = this.marketPrices.get(productId) || 0;
        totalValue += balance * price;
      }
    }

    // Calculate initial value
    let initialValue = this.config.initialBalances.get('USD') || 0;
    for (const [currency, balance] of this.config.initialBalances) {
      if (currency !== 'USD' && balance > 0) {
        const productId = `${currency}-USD`;
        const price = this.marketPrices.get(productId) || 0;
        initialValue += balance * price;
      }
    }

    const unrealizedPnL = totalValue - initialValue;
    const returnPercent = initialValue > 0 ? (unrealizedPnL / initialValue) * 100 : 0;

    return {
      totalValue,
      initialValue,
      unrealizedPnL,
      realizedPnL: 0, // TODO: Track realized P&L from closed positions
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
    this.orderSequence = 0;
    this.fillSequence = 0;
    
    this.logger.info('Paper trading simulator reset');
  }
}
