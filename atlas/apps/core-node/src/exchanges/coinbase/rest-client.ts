import axios, { AxiosInstance, AxiosResponse, InternalAxiosRequestConfig } from 'axios';
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
  RateLimitInfo
} from './types';

export class CoinbaseRestClient {
  private client: AxiosInstance;
  private config: CoinbaseConfig;
  private logger: Logger;
  private credentials: CoinbaseCredentials;
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
    const response = await this.client.get<CoinbaseOrder>(`/orders/${orderId}`);
    return response.data;
  }

  public async getOrders(
    status?: string[],
    productId?: string,
    limit?: number
  ): Promise<CoinbaseOrder[]> {
    const params: any = {};
    if (status) params.status = status;
    if (productId) params.product_id = productId;
    if (limit) params.limit = limit;

    const response = await this.client.get<CoinbaseOrder[]>('/orders', { params });
    return response.data;
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
}
