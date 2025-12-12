/**
 * Coinbase Advanced Trade API Client
 * 
 * This is the new API replacing the deprecated GDAX/Exchange API.
 * Use COINBASE_API_VERSION=advanced to enable.
 * 
 * Key differences:
 * - Different authentication method (JWT for v3)
 * - Different endpoint paths (/api/v3/brokerage/...)
 * - Different order/account structure
 */

import axios, { AxiosInstance, InternalAxiosRequestConfig } from 'axios';
import crypto from 'crypto';
import { Logger } from '../../core/logger';
import {
  Account,
  Product,
  Candle,
  Fill,
  CoinbaseOrder,
  OrderRequest,
} from './types';

export interface AdvancedTradeConfig {
  apiKey: string;
  apiSecret: string;
  environment: 'production' | 'sandbox';
}

// Advanced Trade API response types
interface ATAccount {
  uuid: string;
  name: string;
  currency: string;
  available_balance: {
    value: string;
    currency: string;
  };
  hold: {
    value: string;
    currency: string;
  };
}

interface ATProduct {
  product_id: string;
  price: string;
  base_currency_id: string;
  quote_currency_id: string;
  status: string;
  trading_disabled: boolean;
}

interface ATOrder {
  order_id: string;
  product_id: string;
  side: 'BUY' | 'SELL';
  order_type: string;
  status: string;
  created_time: string;
  filled_size: string;
  filled_value: string;
  average_filled_price: string;
  fee: string;
}

/**
 * Coinbase Advanced Trade REST API Client
 */
export class AdvancedTradeRestClient {
  private client: AxiosInstance;
  private config: AdvancedTradeConfig;
  private logger: Logger;

  constructor(config: AdvancedTradeConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;

    const baseURL = config.environment === 'production'
      ? 'https://api.coinbase.com'
      : 'https://api-sandbox.coinbase.com';

    this.client = axios.create({
      baseURL,
      timeout: 15000,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'AtlasBot/1.0',
      },
    });

    // Add authentication interceptor
    this.client.interceptors.request.use(
      this.addAuthHeaders.bind(this),
      error => Promise.reject(error)
    );
  }

  /**
   * Generate authentication headers for Advanced Trade API
   * Uses HMAC-SHA256 signature
   */
  private addAuthHeaders(config: InternalAxiosRequestConfig): InternalAxiosRequestConfig {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const method = config.method?.toUpperCase() || 'GET';
    const path = config.url || '';
    const body = config.data ? JSON.stringify(config.data) : '';

    // Create signature
    const message = timestamp + method + path + body;
    const signature = crypto
      .createHmac('sha256', this.config.apiSecret)
      .update(message)
      .digest('hex');

    const headers = config.headers as any;
    headers['CB-ACCESS-KEY'] = this.config.apiKey;
    headers['CB-ACCESS-SIGN'] = signature;
    headers['CB-ACCESS-TIMESTAMP'] = timestamp;

    return config;
  }

  /**
   * Get all accounts
   */
  async getAccounts(): Promise<Account[]> {
    try {
      const response = await this.client.get('/api/v3/brokerage/accounts');
      const atAccounts: ATAccount[] = response.data.accounts || [];

      return atAccounts.map(acc => ({
        id: acc.uuid,
        currency: acc.currency,
        balance: (parseFloat(acc.available_balance.value) + parseFloat(acc.hold.value)).toString(),
        available: acc.available_balance.value,
        hold: acc.hold.value,
        profile_id: '',
        trading_enabled: true,
      }));
    } catch (error) {
      this.logger.error('Failed to get accounts:', error);
      throw error;
    }
  }

  /**
   * Get all products
   */
  async getProducts(): Promise<Product[]> {
    try {
      const response = await this.client.get('/api/v3/brokerage/products');
      const atProducts: ATProduct[] = response.data.products || [];

      return atProducts
        .filter(p => !p.trading_disabled)
        .map(p => ({
          id: p.product_id,
          base_currency: p.base_currency_id,
          quote_currency: p.quote_currency_id,
          base_min_size: '0.001',
          base_max_size: '10000',
          quote_increment: '0.01',
          base_increment: '0.00000001',
          display_name: p.product_id,
          status: p.status.toLowerCase(),
          status_message: '',
          min_market_funds: '1',
          max_market_funds: '1000000',
          post_only: false,
          limit_only: false,
          cancel_only: false,
          type: 'spot',
          fx_stablecoin: false,
        }));
    } catch (error) {
      this.logger.error('Failed to get products:', error);
      throw error;
    }
  }

  /**
   * Create an order
   */
  async createOrder(order: OrderRequest): Promise<CoinbaseOrder> {
    try {
      // Convert to Advanced Trade format
      const atOrder: any = {
        product_id: order.product_id,
        side: order.side.toUpperCase(),
        client_order_id: order.client_oid || crypto.randomUUID(),
      };

      if (order.type === 'market') {
        atOrder.order_configuration = {
          market_market_ioc: {
            quote_size: order.funds,
            base_size: order.size,
          },
        };
      } else if (order.type === 'limit') {
        atOrder.order_configuration = {
          limit_limit_gtc: {
            base_size: order.size,
            limit_price: order.price,
            post_only: order.post_only || false,
          },
        };
      }

      const response = await this.client.post('/api/v3/brokerage/orders', atOrder);
      const atResponse = response.data;

      // Convert response to legacy format
      return {
        id: atResponse.order_id || atResponse.success_response?.order_id,
        product_id: order.product_id,
        side: order.side,
        type: order.type,
        size: order.size || '',
        price: order.price || '',
        status: 'pending',
        created_at: new Date().toISOString(),
        done_at: '',
        fill_fees: '0',
        filled_size: '0',
        executed_value: '0',
        settled: false,
        post_only: order.post_only || false,
        time_in_force: order.time_in_force || 'GTC',
      };
    } catch (error) {
      this.logger.error('Failed to create order:', error);
      throw error;
    }
  }

  /**
   * Cancel an order
   */
  async cancelOrder(orderId: string): Promise<string[]> {
    try {
      const response = await this.client.post('/api/v3/brokerage/orders/batch_cancel', {
        order_ids: [orderId],
      });
      return response.data.results?.map((r: any) => r.order_id) || [orderId];
    } catch (error) {
      this.logger.error('Failed to cancel order:', error);
      throw error;
    }
  }

  /**
   * Get order status
   */
  async getOrder(orderId: string): Promise<CoinbaseOrder> {
    try {
      const response = await this.client.get(`/api/v3/brokerage/orders/historical/${orderId}`);
      const atOrder: ATOrder = response.data.order;

      return {
        id: atOrder.order_id,
        product_id: atOrder.product_id,
        side: atOrder.side.toLowerCase() as 'buy' | 'sell',
        type: atOrder.order_type.toLowerCase() as 'limit' | 'market',
        size: atOrder.filled_size,
        price: atOrder.average_filled_price,
        status: this.mapOrderStatus(atOrder.status),
        created_at: atOrder.created_time,
        done_at: '',
        fill_fees: atOrder.fee,
        filled_size: atOrder.filled_size,
        executed_value: atOrder.filled_value,
        settled: atOrder.status === 'FILLED',
        post_only: false,
        time_in_force: 'GTC',
      };
    } catch (error) {
      this.logger.error('Failed to get order:', error);
      throw error;
    }
  }

  /**
   * Get fills
   */
  async getFills(orderId?: string, productId?: string): Promise<Fill[]> {
    try {
      const params: any = {};
      if (orderId) params.order_id = orderId;
      if (productId) params.product_id = productId;

      const response = await this.client.get('/api/v3/brokerage/orders/historical/fills', {
        params,
      });

      return (response.data.fills || []).map((f: any) => ({
        trade_id: f.entry_id,
        product_id: f.product_id,
        order_id: f.order_id,
        user_id: '',
        profile_id: '',
        liquidity: f.liquidity_indicator === 'MAKER' ? 'M' : 'T',
        price: f.price,
        size: f.size,
        fee: f.commission,
        created_at: f.trade_time,
        side: f.side.toLowerCase(),
        settled: true,
        usd_volume: (parseFloat(f.price) * parseFloat(f.size)).toString(),
      }));
    } catch (error) {
      this.logger.error('Failed to get fills:', error);
      throw error;
    }
  }

  /**
   * Get product candles (OHLCV)
   */
  async getCandles(productId: string, granularity: number, start?: string, end?: string): Promise<Candle[]> {
    try {
      const params: any = {
        granularity: this.mapGranularity(granularity),
      };
      if (start) params.start = start;
      if (end) params.end = end;

      const response = await this.client.get(`/api/v3/brokerage/products/${productId}/candles`, {
        params,
      });

      return (response.data.candles || []).map((c: any) => ({
        time: parseInt(c.start),
        open: parseFloat(c.open),
        high: parseFloat(c.high),
        low: parseFloat(c.low),
        close: parseFloat(c.close),
        volume: parseFloat(c.volume),
      }));
    } catch (error) {
      this.logger.error('Failed to get candles:', error);
      throw error;
    }
  }

  private mapOrderStatus(status: string): 'pending' | 'open' | 'done' | 'rejected' {
    switch (status.toUpperCase()) {
      case 'PENDING':
      case 'OPEN':
        return 'open';
      case 'FILLED':
      case 'CANCELLED':
      case 'EXPIRED':
        return 'done';
      case 'FAILED':
        return 'rejected';
      default:
        return 'pending';
    }
  }

  private mapGranularity(seconds: number): string {
    const map: Record<number, string> = {
      60: 'ONE_MINUTE',
      300: 'FIVE_MINUTE',
      900: 'FIFTEEN_MINUTE',
      3600: 'ONE_HOUR',
      21600: 'SIX_HOUR',
      86400: 'ONE_DAY',
    };
    return map[seconds] || 'ONE_MINUTE';
  }
}
