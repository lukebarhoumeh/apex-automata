/**
 * Coinbase Advanced Trade API Client
 * 
 * This is the new API replacing the deprecated GDAX/Exchange API.
 * Use COINBASE_API_VERSION=advanced to enable.
 * 
 * Authentication: ES256 JWT signed with EC private key
 * Endpoints: /api/v3/brokerage/...
 * 
 * JWT claims format (per Coinbase CDP docs):
 * - sub: Full API key resource name (organizations/{org_id}/apiKeys/{key_id})
 * - iss: "cdp" (issuer)
 * - aud: ["cdp_service"]
 * - nbf: Current timestamp
 * - exp: Current timestamp + 120 seconds
 * - Header kid: API key ID (the full resource name)
 * - Header nonce: Random hex string
 * 
 * Reference: https://docs.cdp.coinbase.com/get-started/authentication/jwt-authentication
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
  apiKey: string;    // Full key: organizations/{org_id}/apiKeys/{key_id}
  apiSecret: string; // EC private key in PEM format
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
 * Base64url encode (no padding, URL-safe)
 */
function base64url(buffer: Buffer): string {
  return buffer
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Convert DER-encoded ECDSA signature to raw R||S format (64 bytes for P-256).
 * Node.js crypto.sign() returns DER by default; JWT ES256 requires raw format.
 */
function derToRaw(derSig: Buffer): Buffer {
  // DER format: 0x30 [total-len] 0x02 [r-len] [r] 0x02 [s-len] [s]
  let offset = 2; // skip 0x30 and total length

  // Read R
  if (derSig[offset] !== 0x02) throw new Error('Invalid DER signature: expected 0x02 for R');
  offset++;
  const rLen = derSig[offset];
  offset++;
  let r = derSig.subarray(offset, offset + rLen);
  offset += rLen;

  // Read S
  if (derSig[offset] !== 0x02) throw new Error('Invalid DER signature: expected 0x02 for S');
  offset++;
  const sLen = derSig[offset];
  offset++;
  let s = derSig.subarray(offset, offset + sLen);

  // Remove leading zeros (DER uses signed integers, may have leading 0x00)
  if (r.length > 32) r = r.subarray(r.length - 32);
  if (s.length > 32) s = s.subarray(s.length - 32);

  // Pad to 32 bytes each
  const raw = Buffer.alloc(64);
  r.copy(raw, 32 - r.length);
  s.copy(raw, 64 - s.length);

  return raw;
}

/**
 * Generate a JWT for Coinbase Advanced Trade API.
 * Uses ES256 (ECDSA with P-256 curve and SHA-256).
 */
function generateCoinbaseJwt(
  apiKey: string,
  privateKeyPem: string,
  requestMethod: string,
  requestPath: string,
): string {
  const now = Math.floor(Date.now() / 1000);
  const nonce = crypto.randomBytes(16).toString('hex');

  // Construct the URI for the request
  const uri = `${requestMethod} ${requestPath}`;

  // JWT Header
  const header = {
    alg: 'ES256',
    typ: 'JWT',
    kid: apiKey,
    nonce,
  };

  // JWT Payload per Coinbase CDP docs
  const payload = {
    sub: apiKey,
    iss: 'cdp',
    aud: ['cdp_service'],
    nbf: now,
    exp: now + 120,
    uri,
  };

  // Encode header and payload
  const headerB64 = base64url(Buffer.from(JSON.stringify(header)));
  const payloadB64 = base64url(Buffer.from(JSON.stringify(payload)));
  const signingInput = `${headerB64}.${payloadB64}`;

  // Parse the EC private key — handle \n escape sequences in env vars
  const cleanPem = privateKeyPem.replace(/\\n/g, '\n').trim();

  // Sign with ES256
  const privateKey = crypto.createPrivateKey({
    key: cleanPem,
    format: 'pem',
    type: 'sec1', // EC private key format
  });

  const derSignature = crypto.sign('sha256', Buffer.from(signingInput), {
    key: privateKey,
    dsaEncoding: 'der',
  });

  // Convert DER to raw R||S format for JWT
  const rawSignature = derToRaw(derSignature);
  const signatureB64 = base64url(rawSignature);

  return `${signingInput}.${signatureB64}`;
}

/**
 * Coinbase Advanced Trade REST API Client
 * 
 * Uses ES256 JWT authentication with EC private key.
 * Compatible with Coinbase CDP API keys (organizations/... format).
 */
export class AdvancedTradeRestClient {
  private client: AxiosInstance;
  private config: AdvancedTradeConfig;
  private logger: Logger;
  private baseURL: string;

  constructor(config: AdvancedTradeConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;

    this.baseURL = config.environment === 'production'
      ? 'https://api.coinbase.com'
      : 'https://api-sandbox.coinbase.com';

    this.client = axios.create({
      baseURL: this.baseURL,
      timeout: 15000,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'AtlasBot/1.0',
      },
    });

    // Add JWT authentication interceptor
    this.client.interceptors.request.use(
      this.addAuthHeaders.bind(this),
      error => Promise.reject(error)
    );
  }

  /**
   * Generate JWT authentication headers for Advanced Trade API.
   * Creates a fresh ES256 JWT for each request (120s expiry).
   */
  private addAuthHeaders(config: InternalAxiosRequestConfig): InternalAxiosRequestConfig {
    // Skip auth if no credentials (allows public endpoint access)
    if (!this.config.apiKey || !this.config.apiSecret) {
      return config;
    }

    try {
      const method = (config.method?.toUpperCase() || 'GET');
      const path = config.url || '';

      const jwt = generateCoinbaseJwt(
        this.config.apiKey,
        this.config.apiSecret,
        method,
        `api.coinbase.com${path}`,
      );

      const headers = config.headers as any;
      headers['Authorization'] = `Bearer ${jwt}`;

      return config;
    } catch (error) {
      this.logger.error('Failed to generate JWT for Coinbase API:', error);
      throw error;
    }
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
   * Get all products (public endpoint — works without auth)
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
   * Create an order (requires auth)
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
            ...(order.size ? { base_size: order.size } : {}),
            ...(order.funds ? { quote_size: order.funds } : {}),
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

      // Convert response to legacy format for compatibility
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
   * Get product candles (OHLCV) — public endpoint, works without auth
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

  /**
   * Get open orders
   */
  async getOrders(status?: string[], productId?: string, limit?: number): Promise<CoinbaseOrder[]> {
    try {
      const params: any = {};
      if (productId) params.product_id = productId;
      if (limit) params.limit = limit;
      if (status && status.length > 0) {
        // Advanced Trade uses order_status filter
        params.order_status = status.map(s => s.toUpperCase());
      }

      const response = await this.client.get('/api/v3/brokerage/orders/historical', { params });
      const orders: ATOrder[] = response.data.orders || [];

      return orders.map(o => ({
        id: o.order_id,
        product_id: o.product_id,
        side: o.side.toLowerCase() as 'buy' | 'sell',
        type: o.order_type.toLowerCase() as 'limit' | 'market',
        size: o.filled_size,
        price: o.average_filled_price,
        status: this.mapOrderStatus(o.status),
        created_at: o.created_time,
        done_at: '',
        fill_fees: o.fee,
        filled_size: o.filled_size,
        executed_value: o.filled_value,
        settled: o.status === 'FILLED',
        post_only: false,
        time_in_force: 'GTC',
      }));
    } catch (error) {
      this.logger.error('Failed to get orders:', error);
      throw error;
    }
  }

  /**
   * Cancel all orders for a product
   */
  async cancelAllOrders(productId?: string): Promise<string[]> {
    try {
      // Get open orders first, then batch cancel
      const openOrders = await this.getOrders(['OPEN', 'PENDING'], productId);
      if (openOrders.length === 0) return [];

      const orderIds = openOrders.map(o => o.id);
      const response = await this.client.post('/api/v3/brokerage/orders/batch_cancel', {
        order_ids: orderIds,
      });
      return response.data.results?.map((r: any) => r.order_id) || orderIds;
    } catch (error) {
      this.logger.error('Failed to cancel all orders:', error);
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
