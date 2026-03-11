/**
 * CoinbaseAdapter — wraps existing CoinbaseExchange to implement IExchangeAdapter.
 *
 * This is a THIN wrapper. All exchange logic stays in the original CoinbaseExchange
 * class and its REST/WS clients. The adapter only translates between the universal
 * adapter types and Coinbase-specific types.
 */

import { EventEmitter } from 'events';
import { Logger } from '../core/logger';
import { CoinbaseExchange } from './coinbase';
import {
  CoinbaseConfig,
  CoinbaseOrder,
  OrderRequest,
  Ticker,
  Account,
  Product,
} from './coinbase';
import {
  IExchangeAdapter,
  ExchangeCredentials,
  ExchangeType,
  AdapterOrderRequest,
  AdapterOrderResult,
  AdapterPosition,
  AdapterBalance,
  AdapterMarketInfo,
  AdapterCandle,
  AdapterOrderBook,
  AdapterTicker,
  OrderStatus,
} from './types';

export class CoinbaseAdapter extends EventEmitter implements IExchangeAdapter {
  readonly id = 'coinbase';
  readonly name = 'Coinbase Advanced Trade';
  readonly exchangeType: ExchangeType = 'spot';

  private exchange: CoinbaseExchange;
  private logger: Logger;
  private _connected = false;

  constructor(logger: Logger) {
    super();
    this.logger = logger;
    this.exchange = null as unknown as CoinbaseExchange;
  }

  // ---- Lifecycle ----

  /** Initialize the adapter with credentials and connect to Coinbase */
  async initialize(credentials: ExchangeCredentials): Promise<void> {
    const config: CoinbaseConfig = {
      apiKey: credentials.apiKey || '',
      apiSecret: credentials.apiSecret || '',
      apiPassphrase: credentials.apiPassphrase,
      environment: (credentials.environment as 'production' | 'sandbox') || 'production',
      wsUrl: credentials.wsUrl || 'wss://advanced-trade-ws.coinbase.com',
      restUrl: credentials.restUrl || 'https://api.coinbase.com',
    };

    this.exchange = new CoinbaseExchange(config, this.logger);
    this.bridgeEvents();
    await this.exchange.connect();
    this._connected = true;
    this.logger.info('CoinbaseAdapter initialized and connected');
  }

  /** Gracefully shut down all Coinbase connections */
  async shutdown(): Promise<void> {
    if (this.exchange) {
      this.exchange.disconnect();
      this._connected = false;
      this.logger.info('CoinbaseAdapter shut down');
    }
  }

  /** Check if the adapter is connected and operational */
  isConnected(): boolean {
    return this._connected && (this.exchange?.isConnected() ?? false);
  }

  // ---- Event Bridging ----

  private bridgeEvents(): void {
    this.exchange.on('ticker', (ticker: Ticker) => {
      const mapped: AdapterTicker = {
        symbol: ticker.product_id,
        bid: ticker.best_bid,
        ask: ticker.best_ask,
        last: ticker.price,
        volume: ticker.volume_24h,
        timestamp: new Date(ticker.time).getTime(),
      };
      this.emit('ticker:update', mapped);
    });

    this.exchange.on('orderbook', (ob: any) => {
      const mapped: AdapterOrderBook = {
        symbol: ob.product_id || '',
        bids: ob.bids || [],
        asks: ob.asks || [],
        timestamp: Date.now(),
      };
      this.emit('orderbook:update', mapped);
    });

    this.exchange.on('order', (order: CoinbaseOrder) => {
      this.emit('order:update', this.mapOrderToResult(order));
    });

    this.exchange.on('connected', () => {
      this._connected = true;
      this.emit('connected');
    });

    this.exchange.on('disconnected', () => {
      this._connected = false;
      this.emit('disconnected');
    });

    this.exchange.on('error', (error: Error) => {
      this.emit('error', error);
    });
  }

  // ---- Market Data ----

  /** Get all tradable products from Coinbase */
  async getMarkets(): Promise<AdapterMarketInfo[]> {
    const products: Product[] = await this.exchange.getProducts();
    return products.map((p) => this.mapProduct(p));
  }

  /** Get info for a specific product */
  async getMarketInfo(symbol: string): Promise<AdapterMarketInfo> {
    const product: Product = await this.exchange.getProduct(symbol);
    return this.mapProduct(product);
  }

  /** Get historical candles for a product */
  async getCandles(
    symbol: string,
    granularity: string,
    start?: number,
    end?: number,
  ): Promise<AdapterCandle[]> {
    const candles = await this.exchange.getCandles(symbol, {
      granularity: (parseInt(granularity, 10) || 300) as any,
      start: start ? new Date(start).toISOString() : undefined,
      end: end ? new Date(end).toISOString() : undefined,
    });
    return candles.map((c) => ({
      timestamp: typeof c.time === 'number' ? c.time * 1000 : new Date(c.time as any).getTime(),
      open: typeof c.open === 'string' ? parseFloat(c.open) : c.open,
      high: typeof c.high === 'string' ? parseFloat(c.high) : c.high,
      low: typeof c.low === 'string' ? parseFloat(c.low) : c.low,
      close: typeof c.close === 'string' ? parseFloat(c.close) : c.close,
      volume: typeof c.volume === 'string' ? parseFloat(c.volume) : c.volume,
    }));
  }

  /** Get current order book snapshot */
  async getOrderBook(symbol: string, depth?: number): Promise<AdapterOrderBook> {
    const ob = await this.exchange.getOrderBook(symbol, 2);
    return {
      symbol,
      bids: (ob.bids || []).slice(0, depth || 50),
      asks: (ob.asks || []).slice(0, depth || 50),
      timestamp: Date.now(),
    };
  }

  /** Get current ticker for a product */
  async getTicker(symbol: string): Promise<AdapterTicker> {
    const ticker = await this.exchange.getTicker(symbol);
    return {
      symbol,
      bid: ticker.best_bid || ticker.bid || '0',
      ask: ticker.best_ask || ticker.ask || '0',
      last: ticker.price || ticker.last || '0',
      volume: ticker.volume_24h || ticker.volume || '0',
      timestamp: Date.now(),
    };
  }

  // ---- Trading ----

  /** Place an order on Coinbase */
  async placeOrder(order: AdapterOrderRequest): Promise<AdapterOrderResult> {
    const cbOrder: OrderRequest = {
      product_id: order.symbol,
      side: order.side,
      type: order.type === 'stop_limit' ? 'stop' : order.type,
      size: order.size,
      price: order.price,
      stop_price: order.stopPrice,
      time_in_force: order.timeInForce,
      client_oid: order.clientOrderId,
    };

    const result = await this.exchange.createOrder(cbOrder);
    return this.mapOrderToResult(result);
  }

  /** Cancel a specific order */
  async cancelOrder(orderId: string): Promise<boolean> {
    return this.exchange.cancelOrder(orderId);
  }

  /** Cancel all open orders, optionally filtered by symbol */
  async cancelAllOrders(symbol?: string): Promise<number> {
    const cancelled = await this.exchange.cancelAllOrders(symbol);
    return cancelled.length;
  }

  /** Get current status of an order */
  async getOrder(orderId: string): Promise<AdapterOrderResult> {
    const order = await this.exchange.getOrder(orderId);
    return this.mapOrderToResult(order);
  }

  /** Get all open orders, optionally filtered by symbol */
  async getOpenOrders(symbol?: string): Promise<AdapterOrderResult[]> {
    const orders = await this.exchange.getOpenOrders(symbol);
    return orders.map((o) => this.mapOrderToResult(o));
  }

  // ---- Account ----

  /** Get all currency balances */
  async getBalances(): Promise<AdapterBalance[]> {
    const accounts: Account[] = await this.exchange.getAccounts();
    return accounts.map((a) => ({
      currency: a.currency,
      available: a.available || '0',
      held: a.hold || '0',
      total: String(parseFloat(a.available || '0') + parseFloat(a.hold || '0')),
    }));
  }

  /** Spot exchange — no perpetual positions */
  async getPositions(): Promise<AdapterPosition[]> {
    return [];
  }

  // ---- WebSocket Subscriptions ----

  /** Subscribe to order book updates for a symbol */
  async subscribeOrderBook(symbol: string): Promise<void> {
    this.exchange.subscribeOrderBook([symbol]);
  }

  /** Subscribe to ticker updates for a symbol */
  async subscribeTicker(symbol: string): Promise<void> {
    this.exchange.subscribeTicker([symbol]);
  }

  /** Subscribe to public trade feed (Coinbase 'matches' channel) */
  async subscribeTrades(symbol: string): Promise<void> {
    this.exchange.subscribe(['matches'], [symbol]);
  }

  /** Subscribe to user order updates (handled via REST polling on Coinbase) */
  async subscribeUserOrders(): Promise<void> {
    this.logger.info('CoinbaseAdapter: User order updates via REST polling (Coinbase pattern)');
  }

  /** Unsubscribe from all channels (handled via disconnect on Coinbase) */
  async unsubscribeAll(): Promise<void> {
    this.logger.info('CoinbaseAdapter: Unsubscribe handled via disconnect');
  }

  // ---- Internal Mapping ----

  private mapProduct(p: Product): AdapterMarketInfo {
    return {
      symbol: p.id,
      baseCurrency: p.base_currency,
      quoteCurrency: p.quote_currency,
      minOrderSize: p.base_min_size || '0',
      maxOrderSize: p.base_max_size || '999999',
      tickSize: p.quote_increment || '0.01',
      stepSize: p.base_increment || '0.00000001',
      makerFee: '0.004',
      takerFee: '0.006',
      exchangeType: 'spot',
    };
  }

  private mapOrderToResult(order: CoinbaseOrder): AdapterOrderResult {
    return {
      orderId: order.id,
      clientOrderId: (order as any).client_oid || undefined,
      symbol: order.product_id,
      side: order.side,
      type: order.type === 'stop' ? 'stop_limit' : order.type as any,
      status: this.mapOrderStatus(order.status),
      size: order.size || order.funds || '0',
      filledSize: order.filled_size || '0',
      avgFillPrice: this.calcAvgPrice(order),
      fees: order.fill_fees || '0',
      feeCurrency: order.product_id.split('-')[1] || 'USD',
      timestamp: new Date(order.created_at).getTime(),
      raw: order,
    };
  }

  private mapOrderStatus(cbStatus: string): OrderStatus {
    const statusMap: Record<string, OrderStatus> = {
      pending: 'pending',
      open: 'open',
      active: 'open',
      done: 'filled',
      canceled: 'cancelled',
      rejected: 'rejected',
    };
    return statusMap[cbStatus] || 'pending';
  }

  private calcAvgPrice(order: CoinbaseOrder): string {
    const filled = parseFloat(order.filled_size || '0');
    const executed = parseFloat(order.executed_value || '0');
    if (filled > 0 && executed > 0) {
      return (executed / filled).toFixed(8);
    }
    return order.price || '0';
  }

  // ---- Direct Access (backward compatibility) ----

  /**
   * Get the underlying CoinbaseExchange instance.
   * Use ONLY for features not yet abstracted (reconciler, gap filler, health).
   * This escape hatch will be deprecated once those features move into the adapter.
   */
  getUnderlyingExchange(): CoinbaseExchange {
    return this.exchange;
  }
}
