import { EventEmitter } from 'events';
import { Logger } from '../core/logger';
import { OrderRequest, Fill, Ticker } from '../exchanges/coinbase/types';
import { FeeModel, Exchange, Side } from '../core/fee-model';
import { marketForSymbol } from '../core/symbol-utils';
import { v4 as uuidv4 } from 'uuid';

export interface PaperTradingConfig {
  initialBalances: Map<string, number>; // currency -> amount (e.g., 'USD' -> 10000, 'BTC' -> 0)

  // Fee resolution — preferred path is `feeModel` + `venue` so per-symbol
  // perps vs spot is routed to the correct tier in guardrails.yaml. The
  // flat `makerFee`/`takerFee` decimals remain as a fallback so existing
  // tests + single-venue setups keep working without a FeeModel instance.
  //
  // Sourcing precedence per fill (see `resolveFeeRate`):
  //   1. feeModel.getFeeRate(venue, market(symbol), side) — venue/market-aware
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
  status: SimulatedOrderStatus;
  filledSize: number;
  executedValue: number;
  createdAt: Date;
  updatedAt: Date;
  fills: Fill[];
}

type SimulatedOrderStatus = 'pending' | 'open' | 'done' | 'cancelled' | 'rejected';

interface PaperOrderResponse {
  id: string;
  product_id: string;
  side: 'buy' | 'sell';
  type: 'limit' | 'market' | 'stop';
  size: string;
  price?: string;
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
  private orderSequence = 0;
  private fillSequence = 0;
  
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
   * Symbol classification (perps vs spot) is delegated to
   * `core/symbol-utils.marketForSymbol` so backtest + paper agree.
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
  public async placeOrder(request: OrderRequest): Promise<PaperOrderResponse> {
    // Simulate network latency
    await new Promise(resolve => setTimeout(resolve, this.config.latencyMs));

    const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    const orderId = (request.client_oid && uuidV4.test(request.client_oid)) ? request.client_oid : uuidv4();
    const [baseCurrency, quoteCurrency] = request.product_id.split('-');
    
    // Validate order
    const validation = this.validateOrder(request);
    if (!validation.valid) {
      throw new Error(validation.reason);
    }

    // Create simulated order
    const rawSize = request.size ? parseFloat(request.size) : 0;
    if (!Number.isFinite(rawSize) || rawSize <= 0) {
      throw new Error('Invalid order size');
    }
    const parsedPrice = request.price !== undefined ? parseFloat(request.price) : undefined;

    const order: SimulatedOrder = {
      id: orderId,
      clientOrderId: request.client_oid || orderId,
      productId: request.product_id,
      side: request.side,
      type: request.type,
      size: rawSize,
      price: parsedPrice,
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
    const response: PaperOrderResponse = {
      id: order.id,
      product_id: order.productId,
      side: order.side,
      type: order.type,
      size: order.size.toString(),
      price: order.price !== undefined ? order.price.toString() : undefined,
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
      price: order.price ?? null,
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

  /**
   * Validate order
   */
  private validateOrder(request: OrderRequest): { valid: boolean; reason?: string } {
    // Product IDs are either 2-part spot (BTC-USD) or 3-part perp (BTC-PERP-INTX).
    // Perps settle in USD-denominated collateral regardless of venue tag.
    const parts = request.product_id.split('-');
    const baseCurrency = parts[0];
    const quoteCurrency = parts.length >= 3 ? 'USD' : parts[1];
    const size = request.size ? parseFloat(request.size) : 0;
    if (!Number.isFinite(size) || size <= 0) {
      return { valid: false, reason: 'Order size must be greater than zero' };
    }
    const price = request.price !== undefined
      ? parseFloat(request.price)
      : this.marketPrices.get(request.product_id) || 0;

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
          reason: `Insufficient ${quoteCurrency} balance. Required: ${requiredAmount.toFixed(2)}, Available: ${available.toFixed(2)}` 
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
            reason: `Insufficient ${quoteCurrency} collateral for short. Required: ${requiredCollateral.toFixed(2)}, Available: ${quoteAvailable.toFixed(2)}`
          };
        }
      }
    }

    return { valid: true };
  }

  /**
   * Execute market order with depth-aware price impact.
   */
  private async executeMarketOrder(order: SimulatedOrder): Promise<void> {
    const marketPrice = this.marketPrices.get(order.productId);
    if (!marketPrice) {
      order.status = 'rejected';
      order.updatedAt = new Date();
      return;
    }

    // Calculate notional value for price impact
    const notionalUsd = order.size * marketPrice;
    
    // Calculate depth-aware slippage
    const priceImpact = this.calculatePriceImpact(notionalUsd, order.side);
    
    // Apply slippage with price impact
    const executionPrice = order.side === 'buy' 
      ? marketPrice * (1 + priceImpact)
      : marketPrice * (1 - priceImpact);

    // Create fill. Fee rate is resolved per-symbol so perp products are
    // charged at the perps tier and spot products at the spot tier — see
    // resolveFeeRate for the precedence + the B5 bug context.
    const takerRate = this.resolveFeeRate(order.productId, 'taker');
    const fillId = ++this.fillSequence;
    const fill: Fill = {
      trade_id: fillId,
      product_id: order.productId,
      order_id: order.id,
      user_id: 'paper_trader',
      profile_id: 'default',
      liquidity: 'T', // Taker
      price: executionPrice.toString(),
      size: order.size.toString(),
      fee: (order.size * executionPrice * takerRate).toString(),
      side: order.side,
      settled: true,
      created_at: new Date().toISOString(),
      usd_volume: (order.size * executionPrice).toString()
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
   * Check if limit order can be filled
   */
  private checkLimitOrderFill(order: SimulatedOrder, marketPrice: number): void {
    if (!order.price || order.status !== 'open') {
      return;
    }

    const limitPrice = order.price ?? marketPrice;
    const canFill = (order.side === 'buy' && marketPrice <= limitPrice) ||
                   (order.side === 'sell' && marketPrice >= limitPrice);

    if (canFill) {
      // Create fill at limit price (maker). Per-symbol rate as above.
      const makerRate = this.resolveFeeRate(order.productId, 'maker');
      const fillId = ++this.fillSequence;
      const fill: Fill = {
        trade_id: fillId,
        product_id: order.productId,
        order_id: order.id,
        user_id: 'paper_trader',
        profile_id: 'default',
        liquidity: 'M', // Maker
        price: limitPrice.toString(),
        size: order.size.toString(),
        fee: (order.size * limitPrice * makerRate).toString(),
        side: order.side,
        settled: true,
        created_at: new Date().toISOString(),
        usd_volume: (order.size * limitPrice).toString()
      };

      // Update order
      order.fills.push(fill);
      order.filledSize = order.size;
      order.executedValue = order.size * limitPrice;
      order.status = 'done';
      order.updatedAt = new Date();

      // Update balances
      this.updateBalances(order, fill);

      // Emit fill event
      this.emit('fill', fill);

      this.logger.info('PAPER: Simulated limit fill', {
        orderId: order.id,
        price: limitPrice,
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
      if (order.productId === productId && order.status === 'open' && order.type !== 'market') {
        this.checkLimitOrderFill(order, marketPrice);
      }
    }
  }

  /**
   * Update balances after fill and track realized P&L.
   * Realized P&L is computed using average cost basis (same approach as position-tracker.ts).
   */
  private updateBalances(order: SimulatedOrder, fill: Fill): void {
    // Keep parsing identical to validateOrder so perp fills hit the USD wallet, not a fake 'PERP' bucket.
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
    this.orderSequence = 0;
    this.fillSequence = 0;
    this.realizedPnL = 0;
    this.costBasis.clear();
    
    this.logger.info('Paper trading simulator reset');
  }
}
