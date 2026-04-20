import axios, { AxiosInstance, AxiosResponse, InternalAxiosRequestConfig, AxiosRequestConfig } from 'axios';
import crypto from 'crypto';
import { Logger } from '../../core/logger';
import {
  CoinbaseConfig,
  CoinbaseCredentials,
  CoinbaseOrder,
  OrderRequest,
  Fill,
  Account,
  Product,
  Candle,
  HistoricRatesParams,
  RateLimitInfo,
  CoinbasePerpsProduct,
  CoinbaseIntxPosition,
  CoinbaseIntxPortfolio,
  CoinbaseFundingRate,
} from './types';
import {
  ResilientHttpClient,
  DEFAULT_COINBASE_HTTP_CONFIG,
  RequestOptions,
} from './http/resilient-http';
import {
  CoinbaseRateLimiter,
  getDefaultRateLimiter,
} from './http/rate-limiter';
import {
  CoinbaseApiError,
  CoinbaseNetworkError,
  isBusinessError,
} from './http/errors';

/**
 * REST client health status
 */
export interface RestClientHealth {
  circuitOpen: boolean;
  rateLimited: boolean;
  consecutiveFailures: number;
  lastFailureAt: number | null;
  degraded: boolean;
  degradedReasons: string[];
}

/**
 * Coinbase REST Client with resilience features
 * 
 * Uses the resilient HTTP layer for:
 * - Automatic retries with backoff
 * - Rate limiting
 * - Circuit breaker
 * - Structured errors
 */
export class CoinbaseRestClient {
  private client: AxiosInstance; // Legacy client for backward compat
  private resilientClient: ResilientHttpClient;
  private config: CoinbaseConfig;
  private logger: Logger;
  private credentials: CoinbaseCredentials;
  private rateLimiter: CoinbaseRateLimiter;
  private rateLimitInfo: RateLimitInfo = {
    limit: 10,
    remaining: 10,
    reset: Date.now() + 1000
  };

  constructor(config: CoinbaseConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;
    this.credentials = {
      key: config.apiKey,
      secret: config.apiSecret,
      passphrase: config.apiPassphrase
    };
    this.rateLimiter = getDefaultRateLimiter();

    // Initialize resilient HTTP client
    this.resilientClient = new ResilientHttpClient({
      ...DEFAULT_COINBASE_HTTP_CONFIG,
      baseUrl: config.restUrl,
      logger,
      rateLimiter: this.rateLimiter,
    });

    // Setup circuit breaker event handlers
    this.resilientClient.on('circuit:opened', (data) => {
      this.logger.error('REST circuit breaker opened', data);
    });
    this.resilientClient.on('circuit:closed', () => {
      this.logger.info('REST circuit breaker closed');
    });

    // Legacy axios client (kept for backward compatibility during transition)
    this.client = axios.create({
      baseURL: config.restUrl,
      timeout: 10000,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'AtlasBot/1.0'
      }
    });

    // Add request interceptor for authentication
    this.client.interceptors.request.use(
      this.addAuthHeaders.bind(this),
      error => Promise.reject(error)
    );

    // Add response interceptor for rate limit tracking
    this.client.interceptors.response.use(
      this.handleResponse.bind(this),
      this.handleError.bind(this)
    );
  }

  private addAuthHeaders(config: InternalAxiosRequestConfig): InternalAxiosRequestConfig {
    const timestamp = Date.now() / 1000;
    const method = config.method?.toUpperCase() || 'GET';
    const path = config.url || '';
    const body = config.data ? JSON.stringify(config.data) : '';

    // Create the prehash string
    const what = timestamp + method + path + body;

    // Decode the base64 secret
    const key = Buffer.from(this.credentials.secret, 'base64');

    // Create a sha256 hmac with the secret
    const hmac = crypto.createHmac('sha256', key);

    // Sign the prehash string
    const signature = hmac.update(what).digest('base64');

    // Add headers
    const headers = config.headers;
    if (headers && typeof (headers as any).set === 'function') {
      const axiosHeaders = headers as any;
      axiosHeaders.set('CB-ACCESS-KEY', this.credentials.key);
      axiosHeaders.set('CB-ACCESS-SIGN', signature);
      axiosHeaders.set('CB-ACCESS-TIMESTAMP', timestamp.toString());
      axiosHeaders.set('CB-ACCESS-PASSPHRASE', this.credentials.passphrase || '');
    } else {
      config.headers = {
        ...(headers ?? {}),
        'CB-ACCESS-KEY': this.credentials.key,
        'CB-ACCESS-SIGN': signature,
        'CB-ACCESS-TIMESTAMP': timestamp.toString(),
        'CB-ACCESS-PASSPHRASE': this.credentials.passphrase || ''
      } as any;
    }

    return config;
  }

  private handleResponse(response: AxiosResponse): AxiosResponse {
    // Extract rate limit info from headers
    const limit = parseInt(response.headers['x-ratelimit-limit'] || '10');
    const remaining = parseInt(response.headers['x-ratelimit-remaining'] || '10');
    const reset = parseInt(response.headers['x-ratelimit-reset'] || '0') * 1000;

    this.rateLimitInfo = { limit, remaining, reset };

    // Log rate limit warnings
    if (remaining < limit * 0.2) {
      this.logger.warn(`Rate limit warning: ${remaining}/${limit} requests remaining`);
    }

    return response;
  }

  private async handleError(error: any): Promise<never> {
    if (error.response) {
      const { status, data } = error.response;
      this.logger.error(`API Error ${status}:`, data);

      // Handle rate limiting
      if (status === 429) {
        const retryAfter = error.response.headers['retry-after'] || 60;
        this.logger.error(`Rate limited. Retry after ${retryAfter} seconds`);
        throw new Error(`Rate limited. Retry after ${retryAfter} seconds`);
      }

      throw new Error(data.message || `API Error: ${status}`);
    }

    throw error;
  }

  // Account endpoints
  public async getAccounts(): Promise<Account[]> {
    const response = await this.client.get<Account[]>('/accounts');
    return response.data;
  }

  public async getAccount(accountId: string): Promise<Account> {
    const response = await this.client.get<Account>(`/accounts/${accountId}`);
    return response.data;
  }

  // Order endpoints
  public async createOrder(order: OrderRequest): Promise<CoinbaseOrder> {
    this.logger.info('Creating order:', order);
    const response = await this.client.post<CoinbaseOrder>('/orders', order);
    return response.data;
  }

  public async cancelOrder(orderId: string): Promise<string[]> {
    const response = await this.client.delete<string[]>(`/orders/${orderId}`);
    return response.data;
  }

  public async cancelAllOrders(productId?: string): Promise<string[]> {
    const params = productId ? { product_id: productId } : {};
    const response = await this.client.delete<string[]>('/orders', { params });
    return response.data;
  }

  public async getOrder(orderId: string): Promise<CoinbaseOrder> {
    try {
      const response = await this.client.get(`/api/v3/brokerage/orders/historical/${orderId}`);
      const o = response.data?.order || response.data;
      return {
        id: o.order_id || o.id || orderId,
        product_id: o.product_id,
        side: (o.side || '').toLowerCase() as 'buy' | 'sell',
        type: (o.order_type || o.type || 'market').toLowerCase(),
        size: o.filled_size || o.base_size || '0',
        price: o.average_filled_price || o.limit_price || '0',
        status: o.status ? o.status.toLowerCase() : 'pending',
        created_at: o.created_time || o.created_at || '',
        done_at: o.last_fill_time || '',
        fill_fees: o.total_fees || o.fee || '0',
        filled_size: o.filled_size || '0',
        executed_value: o.filled_value || '0',
        settled: o.status === 'FILLED',
        post_only: false,
      };
    } catch (error: any) {
      if (error?.response?.status === 404 || error?.response?.status === 401) {
        throw new Error(`Order ${orderId} not found`);
      }
      throw error;
    }
  }

  public async getOrders(
    status?: string[],
    productId?: string,
    limit?: number
  ): Promise<CoinbaseOrder[]> {
    const params: any = {};
    if (productId) params.product_id = productId;
    if (limit) params.limit = limit;
    if (status && status.length > 0) {
      params.order_status = status.map(s => s.toUpperCase());
    }

    try {
      const response = await this.client.get('/api/v3/brokerage/orders/historical', { params });
      const orders = response.data?.orders || response.data || [];
      return Array.isArray(orders) ? orders.map((o: any) => ({
        id: o.order_id || o.id,
        product_id: o.product_id,
        side: (o.side || '').toLowerCase() as 'buy' | 'sell',
        type: (o.order_type || o.type || 'market').toLowerCase(),
        size: o.filled_size || o.base_size || '0',
        price: o.average_filled_price || o.limit_price || '0',
        status: o.status ? o.status.toLowerCase() : 'pending',
        created_at: o.created_time || o.created_at || '',
        done_at: o.last_fill_time || '',
        fill_fees: o.total_fees || o.fee || '0',
        filled_size: o.filled_size || '0',
        executed_value: o.filled_value || '0',
        settled: o.status === 'FILLED',
        post_only: false,
      })) : [];
    } catch (error: any) {
      if (error?.response?.status === 404 || error?.response?.status === 401) {
        return [];
      }
      throw error;
    }
  }

  // Fills endpoints
  public async getFills(
    orderId?: string,
    productId?: string,
    limit?: number
  ): Promise<Fill[]> {
    const params: any = {};
    if (orderId) params.order_id = orderId;
    if (productId) params.product_id = productId;
    if (limit) params.limit = limit;

    const response = await this.client.get<Fill[]>('/fills', { params });
    return response.data;
  }

  // Product endpoints
  public async getProducts(): Promise<Product[]> {
    const response = await this.client.get<Product[]>('/products');
    return response.data;
  }

  public async getProduct(productId: string): Promise<Product> {
    const response = await this.client.get<Product>(`/products/${productId}`);
    return response.data;
  }

  public async getProductTicker(productId: string): Promise<any> {
    const response = await this.client.get(`/products/${productId}/ticker`);
    return response.data;
  }

  public async getProductOrderBook(productId: string, level: 1 | 2 | 3 = 2): Promise<any> {
    const response = await this.client.get(`/products/${productId}/book`, {
      params: { level }
    });
    return response.data;
  }

  public async getProductCandles(
    productId: string,
    params: HistoricRatesParams
  ): Promise<Candle[]> {
    const response = await this.client.get(`/products/${productId}/candles`, { params });
    return response.data.map((candle: number[]) => ({
      time: candle[0],
      low: candle[1],
      high: candle[2],
      open: candle[3],
      close: candle[4],
      volume: candle[5]
    }));
  }

  // ============ Perpetual Futures Endpoints ============

  /**
   * List all perpetual futures products.
   * Uses the standard products endpoint with product_type=FUTURE filter.
   * Falls back to filtering the full product list if the filter param isn't supported.
   */
  public async getPerpsProducts(): Promise<CoinbasePerpsProduct[]> {
    try {
      const response = await this.client.get('/api/v3/brokerage/products', {
        params: {
          product_type: 'FUTURE',
          contract_expiry_type: 'PERPETUAL',
        },
      });
      const products = response.data?.products || response.data || [];
      return products.filter((p: any) =>
        p.product_type === 'FUTURE' && (p.contract_expiry_type === 'PERPETUAL' || p.product_id?.includes('-PERP-'))
      );
    } catch (error) {
      this.logger.warn('Failed to fetch perps products via v3 endpoint, falling back to product list filter');
      try {
        const allProducts = await this.getProducts();
        return allProducts
          .filter((p: any) => p.product_id?.includes('-PERP-') || p.product_type === 'FUTURE')
          .map((p: any) => ({
            product_id: p.product_id || p.id,
            product_type: 'FUTURE' as const,
            contract_expiry_type: 'PERPETUAL' as const,
            base_currency: p.base_currency || p.product_id?.split('-')[0] || '',
            quote_currency: p.quote_currency || 'USD',
            contract_size: p.contract_size || '0.01',
            max_leverage: p.max_leverage || '10',
            base_increment: p.base_increment || '0.01',
            quote_increment: p.quote_increment || '0.01',
            status: p.status || 'online',
            trading_disabled: p.trading_disabled || false,
          }));
      } catch (fallbackError) {
        this.logger.warn('Fallback product list fetch also failed — returning empty perps list', {
          primaryError: error instanceof Error ? error.message : String(error),
          fallbackError: fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
        });
        return [];
      }
    }
  }

  /**
   * Get all INTX (perpetual futures) positions for the portfolio.
   * Returns open positions with PnL, leverage, and liquidation data.
   */
  public async getIntxPositions(): Promise<CoinbaseIntxPosition[]> {
    try {
      const response = await this.client.get('/api/v3/brokerage/intx/positions');
      return response.data?.positions || response.data || [];
    } catch (error) {
      this.logger.warn('Failed to fetch INTX positions:', error);
      return [];
    }
  }

  /**
   * Get a specific INTX position by product ID.
   */
  public async getIntxPosition(productId: string): Promise<CoinbaseIntxPosition | null> {
    try {
      const response = await this.client.get(`/api/v3/brokerage/intx/positions/${productId}`);
      return response.data?.position || response.data || null;
    } catch (error) {
      this.logger.warn(`Failed to fetch INTX position for ${productId}:`, error);
      return null;
    }
  }

  /**
   * Get INTX portfolio summary (collateral, margin, buying power).
   */
  public async getIntxPortfolio(): Promise<CoinbaseIntxPortfolio | null> {
    try {
      const response = await this.client.get('/api/v3/brokerage/intx/portfolio');
      return response.data?.portfolio || response.data || null;
    } catch (error) {
      this.logger.warn('Failed to fetch INTX portfolio:', error);
      return null;
    }
  }

  /**
   * Get current funding rate for a perpetual contract.
   * Funding accrues hourly, settles twice daily on Coinbase.
   */
  public async getFundingRate(productId: string): Promise<CoinbaseFundingRate | null> {
    try {
      const response = await this.client.get(`/api/v3/brokerage/products/${productId}/funding`, {});
      return response.data || null;
    } catch (error) {
      this.logger.warn(`Failed to fetch funding rate for ${productId}:`, error);
      return null;
    }
  }

  /**
   * Set leverage for a perpetual futures product.
   * Leverage is per-product, not per-position. Max: 10x intraday.
   */
  public async setLeverage(productId: string, leverage: number): Promise<boolean> {
    try {
      await this.client.post('/api/v3/brokerage/intx/leverage', {
        product_id: productId,
        leverage: String(leverage),
      });
      this.logger.info(`Leverage set to ${leverage}x for ${productId}`);
      return true;
    } catch (error) {
      this.logger.error(`Failed to set leverage for ${productId}:`, error);
      return false;
    }
  }

  // Rate limit info
  public getRateLimitInfo(): RateLimitInfo {
    return { ...this.rateLimitInfo };
  }

  public async waitForRateLimit(): Promise<void> {
    if (this.rateLimitInfo.remaining === 0) {
      const waitTime = Math.max(0, this.rateLimitInfo.reset - Date.now());
      this.logger.warn(`Rate limit exhausted. Waiting ${waitTime}ms`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
  }

  // ============ Health & Circuit Breaker APIs ============

  /**
   * Get REST client health status
   */
  public getHealth(): RestClientHealth {
    const circuitState = this.resilientClient.getCircuitState();
    const rateLimiterState = this.rateLimiter.getState();
    
    const degradedReasons: string[] = [];
    if (circuitState.state === 'open') {
      degradedReasons.push('circuit_breaker_open');
    }
    if (rateLimiterState.limited) {
      degradedReasons.push('rate_limited');
    }

    return {
      circuitOpen: circuitState.state === 'open',
      rateLimited: rateLimiterState.limited,
      consecutiveFailures: circuitState.consecutiveFailures,
      lastFailureAt: circuitState.lastFailure?.timestamp ?? null,
      degraded: degradedReasons.length > 0,
      degradedReasons,
    };
  }

  /**
   * Check if REST client is degraded
   */
  public isDegraded(): boolean {
    return this.resilientClient.isCircuitOpen() || this.rateLimiter.isLimited();
  }

  /**
   * Check if circuit breaker is open
   */
  public isCircuitOpen(): boolean {
    return this.resilientClient.isCircuitOpen();
  }

  /**
   * Force close the circuit breaker (for recovery)
   */
  public forceCloseCircuit(): void {
    this.resilientClient.forceCloseCircuit();
  }

  /**
   * Get the resilient HTTP client (for advanced usage)
   */
  public getResilientClient(): ResilientHttpClient {
    return this.resilientClient;
  }

  // ============ Resilient Request Methods ============

  /**
   * Make a resilient GET request
   * Uses retry, rate limiting, and circuit breaker
   */
  private async resilientGet<T>(
    route: string,
    config?: AxiosRequestConfig,
    options?: RequestOptions
  ): Promise<T> {
    // Add auth headers to config
    const authConfig = await this.getAuthConfig('GET', route, config);
    return this.resilientClient.get<T>(route, authConfig, options);
  }

  /**
   * Make a resilient POST request
   */
  private async resilientPost<T>(
    route: string,
    data?: any,
    config?: AxiosRequestConfig,
    options?: RequestOptions
  ): Promise<T> {
    const authConfig = await this.getAuthConfig('POST', route, config, data);
    return this.resilientClient.post<T>(route, data, authConfig, options);
  }

  /**
   * Make a resilient DELETE request
   */
  private async resilientDelete<T>(
    route: string,
    config?: AxiosRequestConfig,
    options?: RequestOptions
  ): Promise<T> {
    const authConfig = await this.getAuthConfig('DELETE', route, config);
    return this.resilientClient.delete<T>(route, authConfig, options);
  }

  /**
   * Get authentication config for a request
   */
  private async getAuthConfig(
    method: string,
    route: string,
    config?: AxiosRequestConfig,
    data?: any
  ): Promise<AxiosRequestConfig> {
    const timestamp = Date.now() / 1000;
    const body = data ? JSON.stringify(data) : '';
    const what = timestamp + method + route + body;
    const key = Buffer.from(this.credentials.secret, 'base64');
    const hmac = crypto.createHmac('sha256', key);
    const signature = hmac.update(what).digest('base64');

    return {
      ...config,
      headers: {
        ...config?.headers,
        'CB-ACCESS-KEY': this.credentials.key,
        'CB-ACCESS-SIGN': signature,
        'CB-ACCESS-TIMESTAMP': timestamp.toString(),
        'CB-ACCESS-PASSPHRASE': this.credentials.passphrase || '',
      },
    };
  }

  // ============ Resilient API Methods (New) ============

  /**
   * Get accounts with resilience (retries, circuit breaker)
   */
  public async getAccountsResilient(): Promise<Account[]> {
    return this.resilientGet<Account[]>('/accounts');
  }

  /**
   * Get orders with resilience
   * Marked as reconciliation request to allow during circuit half-open
   */
  public async getOrdersResilient(
    status?: string[],
    productId?: string,
    limit?: number
  ): Promise<CoinbaseOrder[]> {
    const params: any = {};
    if (status) params.status = status;
    if (productId) params.product_id = productId;
    if (limit) params.limit = limit;

    return this.resilientGet<CoinbaseOrder[]>('/orders', { params }, {
      isReconciliation: true,
      priority: 0, // High priority for reconciliation
    });
  }

  /**
   * Get fills with resilience
   * Marked as reconciliation request
   */
  public async getFillsResilient(
    orderId?: string,
    productId?: string,
    limit?: number
  ): Promise<Fill[]> {
    const params: any = {};
    if (orderId) params.order_id = orderId;
    if (productId) params.product_id = productId;
    if (limit) params.limit = limit;

    return this.resilientGet<Fill[]>('/fills', { params }, {
      isReconciliation: true,
      priority: 0,
    });
  }

  /**
   * Create order with resilience
   * Uses client_oid for idempotency
   */
  public async createOrderResilient(order: OrderRequest): Promise<CoinbaseOrder> {
    this.logger.info('Creating order (resilient):', { 
      product_id: order.product_id,
      side: order.side,
      type: order.type,
      size: order.size,
    });

    try {
      return await this.resilientPost<CoinbaseOrder>('/orders', order);
    } catch (error) {
      // Re-throw business errors without retry
      if (isBusinessError(error)) {
        this.logger.warn('Order rejected (business error)', {
          error: (error as CoinbaseApiError).toJSON(),
        });
      }
      throw error;
    }
  }

  /**
   * Cancel order with resilience
   */
  public async cancelOrderResilient(orderId: string): Promise<string[]> {
    return this.resilientDelete<string[]>(`/orders/${orderId}`);
  }

  /**
   * Get product candles with resilience
   * Used for gap filling
   */
  public async getProductCandlesResilient(
    productId: string,
    params: HistoricRatesParams
  ): Promise<Candle[]> {
    const response = await this.resilientGet<number[][]>(
      `/products/${productId}/candles`,
      { params },
      { isReconciliation: true, priority: 1 }
    );

    return response.map((candle: number[]) => ({
      time: candle[0],
      low: candle[1],
      high: candle[2],
      open: candle[3],
      close: candle[4],
      volume: candle[5]
    }));
  }
}
