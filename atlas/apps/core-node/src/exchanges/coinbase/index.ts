import { EventEmitter } from 'events';
import { Logger } from '../../core/logger';
import { CoinbaseRestClient } from './rest-client';
import { CoinbaseWebSocket } from './websocket';
import {
  CoinbaseConfig,
  CoinbaseOrder,
  OrderRequest,
  Fill,
  Account,
  Product,
  Ticker,
  OrderBook,
  Candle,
  HistoricRatesParams
} from './types';

export * from './types';

export interface CoinbaseEvents {
  ticker: (ticker: Ticker) => void;
  orderbook: (orderbook: OrderBook) => void;
  order: (order: CoinbaseOrder) => void;
  fill: (fill: Fill) => void;
  error: (error: Error) => void;
  connected: () => void;
  disconnected: () => void;
}

export class CoinbaseExchange extends EventEmitter {
  private config: CoinbaseConfig;
  private logger: Logger;
  private restClient: CoinbaseRestClient;
  private wsClient: CoinbaseWebSocket;
  private orderPollingInterval: NodeJS.Timeout | null = null;
  private activeOrders: Map<string, CoinbaseOrder> = new Map();

  constructor(config: CoinbaseConfig, logger: Logger) {
    super();
    this.config = config;
    this.logger = logger;

    // Initialize REST client
    this.restClient = new CoinbaseRestClient(config, logger);

    // Initialize WebSocket client
    this.wsClient = new CoinbaseWebSocket(config, logger);
    this.setupWebSocketHandlers();
  }

  private setupWebSocketHandlers(): void {
    this.wsClient.on('ticker', (ticker: Ticker) => {
      this.emit('ticker', ticker);
    });

    this.wsClient.on('orderbook', (orderbook: OrderBook) => {
      this.emit('orderbook', orderbook);
    });

    this.wsClient.on('error', (error: Error) => {
      this.emit('error', error);
    });

    this.wsClient.on('open', () => {
      this.logger.info('Coinbase WebSocket connected');
      this.emit('connected');
    });

    this.wsClient.on('close', () => {
      this.logger.warn('Coinbase WebSocket disconnected');
      this.emit('disconnected');
    });
  }

  // Connection management
  public async connect(): Promise<void> {
    this.logger.info('Connecting to Coinbase exchange');
    
    // Test REST API connection only if credentials are provided
    // In paper mode we don't require authenticated REST access
    const hasCredentials = Boolean(this.config?.apiKey && this.config?.apiSecret);
    if (hasCredentials) {
      try {
        await this.restClient.getAccounts();
        this.logger.info('REST API connection verified');
      } catch (error) {
        this.logger.error('Failed to connect to REST API with provided credentials:', error);
        // Do not throw here to allow market-data-only operation (e.g., paper mode)
      }
    } else {
      this.logger.info('No Coinbase REST credentials provided - proceeding with market data only');
    }

    // Connect WebSocket (public market data)
    this.wsClient.connect();

    // Start order polling
    this.startOrderPolling();
  }

  public disconnect(): void {
    this.logger.info('Disconnecting from Coinbase exchange');
    
    // Stop order polling
    if (this.orderPollingInterval) {
      clearInterval(this.orderPollingInterval);
      this.orderPollingInterval = null;
    }

    // Disconnect WebSocket
    this.wsClient.disconnect();
  }

  // Market data subscriptions
  public subscribeTicker(productIds: string[]): void {
    this.wsClient.subscribe(['ticker'], productIds);
  }

  public subscribeOrderBook(productIds: string[], level: 'level2' = 'level2'): void {
    this.wsClient.subscribe([level], productIds);
  }

  public unsubscribeTicker(productIds: string[]): void {
    this.wsClient.unsubscribe(['ticker'], productIds);
  }

  public unsubscribeOrderBook(productIds: string[], level: 'level2' = 'level2'): void {
    this.wsClient.unsubscribe([level], productIds);
  }

  // Account methods
  public async getAccounts(): Promise<Account[]> {
    return this.restClient.getAccounts();
  }

  public async getAccount(currency: string): Promise<Account | undefined> {
    const accounts = await this.getAccounts();
    return accounts.find(account => account.currency === currency);
  }

  public async getBalance(currency: string): Promise<number> {
    const account = await this.getAccount(currency);
    return account ? parseFloat(account.available) : 0;
  }

  // Order methods
  public async createOrder(order: OrderRequest): Promise<CoinbaseOrder> {
    try {
      const result = await this.restClient.createOrder(order);
      this.activeOrders.set(result.id, result);
      this.emit('order', result);
      return result;
    } catch (error) {
      this.logger.error('Failed to create order:', error);
      throw error;
    }
  }

  public async cancelOrder(orderId: string): Promise<boolean> {
    try {
      await this.restClient.cancelOrder(orderId);
      this.activeOrders.delete(orderId);
      return true;
    } catch (error) {
      this.logger.error('Failed to cancel order:', error);
      return false;
    }
  }

  public async cancelAllOrders(productId?: string): Promise<string[]> {
    const canceledIds = await this.restClient.cancelAllOrders(productId);
    canceledIds.forEach(id => this.activeOrders.delete(id));
    return canceledIds;
  }

  public async getOrder(orderId: string): Promise<CoinbaseOrder> {
    return this.restClient.getOrder(orderId);
  }

  public async getOrders(
    status?: string[],
    productId?: string,
    limit?: number
  ): Promise<CoinbaseOrder[]> {
    return this.restClient.getOrders(status, productId, limit);
  }

  public async getOpenOrders(productId?: string): Promise<CoinbaseOrder[]> {
    return this.getOrders(['open', 'pending'], productId);
  }

  // Fill methods
  public async getFills(
    orderId?: string,
    productId?: string,
    limit?: number
  ): Promise<Fill[]> {
    return this.restClient.getFills(orderId, productId, limit);
  }

  // Product methods
  public async getProducts(): Promise<Product[]> {
    return this.restClient.getProducts();
  }

  public async getProduct(productId: string): Promise<Product> {
    return this.restClient.getProduct(productId);
  }

  public async getTicker(productId: string): Promise<any> {
    return this.restClient.getProductTicker(productId);
  }

  public async getOrderBook(productId: string, level: 1 | 2 | 3 = 2): Promise<any> {
    return this.restClient.getProductOrderBook(productId, level);
  }

  public async getCandles(
    productId: string,
    params: HistoricRatesParams
  ): Promise<Candle[]> {
    return this.restClient.getProductCandles(productId, params);
  }

  // Order polling for fill detection
  private startOrderPolling(): void {
    if (this.orderPollingInterval) {
      return;
    }

    this.orderPollingInterval = setInterval(async () => {
      try {
        await this.pollOrders();
      } catch (error) {
        this.logger.error('Error polling orders:', error);
      }
    }, 5000); // Poll every 5 seconds
  }

  private async pollOrders(): Promise<void> {
    const openOrders = await this.getOpenOrders();
    
    // Update active orders
    for (const order of openOrders) {
      const existing = this.activeOrders.get(order.id);
      if (!existing || existing.status !== order.status) {
        this.activeOrders.set(order.id, order);
        this.emit('order', order);
      }
    }

    // Check for filled/cancelled orders
    for (const [orderId, order] of this.activeOrders) {
      const stillOpen = openOrders.find(o => o.id === orderId);
      if (!stillOpen) {
        // Order is no longer open, fetch its final status
        try {
          const finalOrder = await this.getOrder(orderId);
          this.activeOrders.delete(orderId);
          this.emit('order', finalOrder);

          // If filled, get fill details
          if (finalOrder.status === 'done' && finalOrder.settled) {
            const fills = await this.getFills(orderId);
            fills.forEach(fill => this.emit('fill', fill));
          }
        } catch (error) {
          this.logger.error(`Failed to get final status for order ${orderId}:`, error);
          this.activeOrders.delete(orderId);
        }
      }
    }
  }

  // Utility methods
  public isConnected(): boolean {
    return this.wsClient.isActive();
  }

  public getRateLimitInfo() {
    return this.restClient.getRateLimitInfo();
  }

  public async waitForRateLimit(): Promise<void> {
    return this.restClient.waitForRateLimit();
  }
}
