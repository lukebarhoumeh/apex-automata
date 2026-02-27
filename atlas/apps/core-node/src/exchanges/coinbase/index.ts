import { EventEmitter } from 'events';
import { Logger } from '../../core/logger';
import { CoinbaseRestClient, RestClientHealth } from './rest-client';
import { CoinbaseWebSocket, CoinbaseWsHealth } from './websocket';
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
import { CoinbaseReconciler, ReconcilerState } from './reconciliation/reconciler';
import { MarketDataGapFiller } from './reconciliation/gap-filler';

export * from './types';
export type { CoinbaseWsHealth } from './websocket';
export type { CoinbaseChannelSpec, ICoinbaseWsClient } from './ws/coinbase-ws.interface';
export { SubscriptionManager } from './ws/coinbase-ws.interface';
export type { RestClientHealth } from './rest-client';
export type { ReconcilerState } from './reconciliation/reconciler';
export * from './http/errors';

/**
 * Comprehensive exchange health status for supervisor/monitoring
 */
export interface ExchangeHealth {
  wsConnected: boolean;
  wsReconnecting: boolean;
  wsStalled: boolean;
  restOk: boolean;
  restCircuitOpen: boolean;
  restRateLimited: boolean;
  reconcilerDegraded: boolean;
  marketDataStale: boolean;
  degraded: boolean;
  degradedReasons: string[];
  timestamp: number;
}

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
  
  // Resilience components
  private reconciler: CoinbaseReconciler | null = null;
  private gapFiller: MarketDataGapFiller | null = null;

  constructor(config: CoinbaseConfig, logger: Logger) {
    super();
    this.config = config;
    this.logger = logger;

    // Initialize REST client (now with resilience)
    this.restClient = new CoinbaseRestClient(config, logger);

    // Initialize WebSocket client
    this.wsClient = new CoinbaseWebSocket(config, logger);
    this.setupWebSocketHandlers();
  }

  /**
   * Initialize reconciler for order/fill synchronization
   * Call this after order manager is available
   */
  public initializeReconciler(orderManager: any): void {
    if (this.reconciler) {
      this.logger.warn('Reconciler already initialized');
      return;
    }

    this.reconciler = new CoinbaseReconciler(
      {
        orderReconcileIntervalMs: 5000,
        fillReconcileIntervalMs: 5000,
        autoReconcile: true,
      },
      this.logger,
      {
        getOrders: (status, productId, limit) => 
          this.restClient.getOrdersResilient(status, productId, limit),
        getOrder: (orderId) => this.restClient.getOrder(orderId),
        getFills: (orderId, productId, limit) => 
          this.restClient.getFillsResilient(orderId, productId, limit),
      },
      orderManager
    );

    // Forward reconciler events
    this.reconciler.on('order:state_changed', (orderId, oldStatus, newStatus, order) => {
      this.emit('order', order);
    });

    this.reconciler.on('fill:ingested', (fill, isNew) => {
      if (isNew) {
        this.emit('fill', fill);
      }
    });

    this.reconciler.on('degraded', (reason) => {
      this.logger.warn('Reconciler degraded', { reason });
      this.emit('reconciler:degraded', reason);
    });

    this.reconciler.on('recovered', () => {
      this.logger.info('Reconciler recovered');
      this.emit('reconciler:recovered');
    });

    this.logger.info('Reconciler initialized');
  }

  /**
   * Initialize gap filler for market data recovery
   */
  public initializeGapFiller(): void {
    if (this.gapFiller) {
      this.logger.warn('Gap filler already initialized');
      return;
    }

    this.gapFiller = new MarketDataGapFiller(
      {
        staleThresholdMs: 30000,
        checkIntervalMs: 5000,
      },
      this.logger,
      {
        getProductCandles: (productId, params) =>
          this.restClient.getProductCandlesResilient(productId, params),
      }
    );

    // Forward gap fill events
    this.gapFiller.on('gapfill:applied', (data) => {
      this.logger.info('Gap fill applied', { 
        symbol: data.symbol, 
        timeframe: data.timeframe,
        newCandles: data.newCandles,
      });
      this.emit('gapfill:applied', data);
    });

    this.logger.info('Gap filler initialized');
  }

  /**
   * Start reconciler
   */
  public startReconciler(): void {
    this.reconciler?.start();
  }

  /**
   * Stop reconciler
   */
  public stopReconciler(): void {
    this.reconciler?.stop();
  }

  /**
   * Start gap filler
   */
  public startGapFiller(): void {
    this.gapFiller?.start();
  }

  /**
   * Stop gap filler
   */
  public stopGapFiller(): void {
    this.gapFiller?.stop();
  }

  /**
   * Register a symbol for gap filling
   */
  public registerForGapFill(symbol: string, timeframe: string): void {
    this.gapFiller?.register(symbol, timeframe);
  }

  /**
   * Record a tick for gap filler (call on WS tick)
   */
  public recordMarketTick(symbol: string): void {
    this.gapFiller?.recordTick(symbol);
  }

  /**
   * Record a candle for gap filler
   */
  public recordMarketCandle(symbol: string, timeframe: string, candle: Candle): void {
    this.gapFiller?.recordCandle(symbol, timeframe, candle);
  }

  /**
   * Trigger immediate reconciliation
   */
  public async triggerReconciliation(): Promise<void> {
    await this.reconciler?.triggerReconciliation();
  }

  private setupWebSocketHandlers(): void {
    // Market data events
    this.wsClient.on('ticker', (ticker: Ticker) => {
      this.emit('ticker', ticker);
    });

    this.wsClient.on('orderbook', (orderbook: OrderBook) => {
      this.emit('orderbook', orderbook);
    });

    this.wsClient.on('error', (error: Error) => {
      this.emit('error', error);
    });

    // Legacy connection events (for backwards compatibility)
    this.wsClient.on('open', () => {
      this.logger.info('Coinbase WebSocket connected');
      this.emit('connected');
    });

    this.wsClient.on('close', () => {
      this.logger.warn('Coinbase WebSocket disconnected');
      this.emit('disconnected');
    });
    
    this.wsClient.on('reconnected', () => {
      this.logger.info('Coinbase WebSocket reconnected successfully');
      this.emit('reconnected');
    });

    // Forward new unified WS events
    this.wsClient.on('ws:connected', () => {
      this.emit('ws:connected');
    });

    this.wsClient.on('ws:disconnected', (code: number, reason: string) => {
      this.emit('ws:disconnected', code, reason);
    });

    this.wsClient.on('ws:reconnecting', (attempt: number, delayMs: number) => {
      this.emit('ws:reconnecting', attempt, delayMs);
    });

    this.wsClient.on('ws:reconnected', () => {
      this.emit('ws:reconnected');
    });

    this.wsClient.on('ws:stalled', (messageAgeMs: number) => {
      this.logger.warn('Coinbase WebSocket stalled detected', { messageAgeMs });
      this.emit('ws:stalled', messageAgeMs);
    });

    this.wsClient.on('ws:resubscribed', (channels: any) => {
      this.emit('ws:resubscribed', channels);
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

    // Start order polling only if we have credentials
    if (hasCredentials) {
      this.startOrderPolling();
    }
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

  // Market data subscriptions - all are IDEMPOTENT via SubscriptionManager
  
  /**
   * Subscribe to ticker updates (idempotent)
   */
  public subscribeTicker(productIds: string[]): void {
    this.wsClient.subscribe(['ticker'], productIds);
  }

  /**
   * Subscribe to order book updates (idempotent)
   */
  public subscribeOrderBook(productIds: string[], level: 'level2' = 'level2'): void {
    this.wsClient.subscribe([level], productIds);
  }

  /**
   * Unsubscribe from ticker updates
   */
  public unsubscribeTicker(productIds: string[]): void {
    this.wsClient.unsubscribe(['ticker'], productIds);
  }

  /**
   * Unsubscribe from order book updates
   */
  public unsubscribeOrderBook(productIds: string[], level: 'level2' = 'level2'): void {
    this.wsClient.unsubscribe([level], productIds);
  }

  /**
   * Generic subscribe method for any channels (idempotent)
   * All subscriptions are automatically restored on reconnect
   */
  public subscribe(channels: string[], productIds: string[]): void {
    this.wsClient.subscribe(channels, productIds);
  }

  /**
   * Generic unsubscribe method for any channels
   */
  public unsubscribe(channels: string[], productIds: string[]): void {
    this.wsClient.unsubscribe(channels, productIds);
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

  // ============ WebSocket Health Surface for Supervisor ============

  /**
   * Get WebSocket health status for supervisor monitoring
   * This is the single health surface for the exchange's WS connection
   */
  public getWsHealth(): CoinbaseWsHealth {
    return this.wsClient.getHealth();
  }

  /**
   * Get direct access to the WebSocket client
   * Used by supervisor for force reconnect operations
   */
  public getWsClient(): CoinbaseWebSocket {
    return this.wsClient;
  }

  /**
   * Force WebSocket reconnection
   * Used by supervisor when connection appears stale
   */
  public forceWsReconnect(): void {
    this.logger.info('Force WebSocket reconnect requested via exchange');
    this.wsClient.forceReconnect();
  }

  /**
   * Check if WebSocket is healthy (connected and not stalled)
   */
  public isWsHealthy(): boolean {
    return this.wsClient.isHealthy();
  }

  // ============ REST Health Surface ============

  /**
   * Get REST client health status
   */
  public getRestHealth(): RestClientHealth {
    return this.restClient.getHealth();
  }

  /**
   * Check if REST client is degraded
   */
  public isRestDegraded(): boolean {
    return this.restClient.isDegraded();
  }

  /**
   * Force close REST circuit breaker (for recovery)
   */
  public forceCloseRestCircuit(): void {
    this.restClient.forceCloseCircuit();
  }

  // ============ Reconciler Health Surface ============

  /**
   * Get reconciler state
   */
  public getReconcilerState(): ReconcilerState | null {
    return this.reconciler?.getState() ?? null;
  }

  /**
   * Check if reconciler is degraded
   */
  public isReconcilerDegraded(): boolean {
    return this.reconciler?.isDegraded() ?? false;
  }

  // ============ Gap Filler Surface ============

  /**
   * Get gap filler status
   */
  public getGapFillerStatus() {
    return this.gapFiller?.getStatus() ?? [];
  }

  /**
   * Check if any market data is stale
   */
  public hasStaleMarketData(): boolean {
    return this.gapFiller?.hasStaleData() ?? false;
  }

  /**
   * Force gap fill for a symbol
   */
  public async forceGapFill(symbol: string, timeframe: string): Promise<number> {
    if (!this.gapFiller) {
      throw new Error('Gap filler not initialized');
    }
    return this.gapFiller.forceGapFill(symbol, timeframe);
  }

  // ============ Comprehensive Exchange Health ============

  /**
   * Get comprehensive exchange health status
   * This is the primary health surface for the EngineSupervisor
   */
  public getExchangeHealth(): ExchangeHealth {
    const wsHealth = this.wsClient.getHealth();
    const restHealth = this.restClient.getHealth();
    const reconcilerState = this.reconciler?.getState();
    const hasStaleData = this.gapFiller?.hasStaleData() ?? false;

    const degradedReasons: string[] = [];

    if (!wsHealth.connected) {
      degradedReasons.push('ws_disconnected');
    }
    if (wsHealth.isStalled) {
      degradedReasons.push('ws_stalled');
    }
    if (restHealth.circuitOpen) {
      degradedReasons.push('rest_circuit_open');
    }
    if (restHealth.rateLimited) {
      degradedReasons.push('rest_rate_limited');
    }
    if (reconcilerState?.degraded) {
      degradedReasons.push('reconciler_degraded');
    }
    if (hasStaleData) {
      degradedReasons.push('market_data_stale');
    }

    return {
      wsConnected: wsHealth.connected,
      wsReconnecting: wsHealth.reconnecting,
      wsStalled: wsHealth.isStalled,
      restOk: !restHealth.degraded,
      restCircuitOpen: restHealth.circuitOpen,
      restRateLimited: restHealth.rateLimited,
      reconcilerDegraded: reconcilerState?.degraded ?? false,
      marketDataStale: hasStaleData,
      degraded: degradedReasons.length > 0,
      degradedReasons,
      timestamp: Date.now(),
    };
  }

  /**
   * Check if exchange is degraded (entries should be paused)
   */
  public isDegraded(): boolean {
    const health = this.getExchangeHealth();
    return health.degraded;
  }

  /**
   * Check if exchange allows new entries
   * Returns false if degraded in a way that should block new positions
   */
  public allowsNewEntries(): boolean {
    const health = this.getExchangeHealth();
    
    // Block entries if REST circuit is open (can't place orders)
    if (health.restCircuitOpen) {
      return false;
    }
    
    // Block entries if WS is down AND reconciler is degraded
    // (can't get reliable market data or order status)
    if (!health.wsConnected && health.reconcilerDegraded) {
      return false;
    }

    return true;
  }

  /**
   * Check if exchange allows exits (more permissive than entries)
   * Returns true unless completely unable to communicate
   */
  public allowsExits(): boolean {
    const restHealth = this.restClient.getHealth();
    
    // Only block exits if circuit is fully open
    // Even with rate limiting, we should try to exit
    return !restHealth.circuitOpen;
  }
}
