/**
 * Coinbase Advanced Trade REST client (CDP key + ES256 JWT).
 *
 * This is the ONLY Coinbase REST surface that can authenticate a CDP key
 * (`organizations/{org}/apiKeys/{id}` + EC P-256 PEM). The legacy
 * `CoinbaseRestClient` (HMAC + passphrase) cannot, so live execution must go
 * through this client (see `trading/execution/coinbase-advanced-adapter.ts`).
 *
 * Hardening (Sprint 9 / TASK_010):
 * - Spec-exact JWT: header {alg, kid, nonce, typ}; claims {sub, iss:"cdp", nbf, exp:+120, uri}.
 *   Signed with `dsaEncoding: 'ieee-p1363'` (raw R||S). No `aud` claim. `uri` excludes the query string.
 * - `createOrderRaw()` returns a discriminated union — `success:false` is a business
 *   rejection (`ok:false`), never a synthesized "pending" order and never a throw.
 * - Real product increments (`getProduct`), paginated accounts/orders/fills, batch cancel,
 *   order preview, key permissions, server time, live fee tier (`getTransactionSummary`).
 * - Central `request()`: 15s timeout, bounded 429 retries honouring `Retry-After`,
 *   idempotent GET retries on 5xx/network, and safe error mapping — request headers
 *   (the bearer JWT) are never attached to errors or logs.
 *
 * Reference: https://docs.cdp.coinbase.com/api-reference/advanced-trade-api
 */

import crypto from 'node:crypto';
import { Logger } from '../../core/logger';
import { decimalAdd, decimalMul } from '../../core/decimal';
import { CoinbaseApiError, CoinbaseErrorKind, CoinbaseNetworkError } from './http/errors';
import { Account, Candle, CoinbaseOrder, Fill, OrderRequest, Product } from './types';

// ============================================================================
// Constants
// ============================================================================

export const ADVANCED_TRADE_HOST = 'api.coinbase.com';
export const ADVANCED_TRADE_BASE_URL = `https://${ADVANCED_TRADE_HOST}`;
export const ADVANCED_TRADE_SANDBOX_BASE_URL = 'https://api-sandbox.coinbase.com';
const BROKERAGE = '/api/v3/brokerage';

/** JWT lifetime mandated by the CDP authentication spec. */
export const ADVANCED_TRADE_JWT_TTL_SECONDS = 120;

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_MAX_RETRY_DELAY_MS = 10_000;
const ACCOUNTS_PAGE_LIMIT = 250;
const MAX_PAGES = 20;

// ============================================================================
// Config / auth
// ============================================================================

/** Minimal fetch response surface used by the client (keeps tests free of real sockets). */
export interface FetchResponseLike {
  status: number;
  ok: boolean;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}

export interface FetchRequestInit {
  method: string;
  headers: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

export type FetchLike = (url: string, init: FetchRequestInit) => Promise<FetchResponseLike>;

export interface AdvancedTradeConfig {
  /** CDP key name: organizations/{org_id}/apiKeys/{key_id} */
  apiKey: string;
  /** EC P-256 private key in PEM format (literal `\n` sequences are tolerated) */
  apiSecret: string;
  environment: 'production' | 'sandbox';
  /** Injectable fetch (tests). Defaults to the global fetch. */
  fetchImpl?: FetchLike;
  /** Per-request timeout (default 15 000 ms) */
  timeoutMs?: number;
  /** Retries after the first attempt for 429 / idempotent failures (default 2) */
  maxRetries?: number;
  /** Upper bound for a single retry delay (default 10 000 ms) */
  maxRetryDelayMs?: number;
  userAgent?: string;
}

/** Parsed credential pair used for JWT signing. Never log this object. */
export interface AdvancedTradeAuth {
  keyName: string;
  privateKey: crypto.KeyObject;
}

const KEY_NAME_RE = /^organizations\/[^/\s]+\/apiKeys\/[^/\s]+$/i;

/**
 * Validate + parse CDP credentials once. Throws a safe (secret-free) error when the
 * key name is not a CDP resource name or the PEM is not an ECDSA P-256 key.
 */
export function loadAdvancedTradeAuth(apiKey: string, apiSecret: string): AdvancedTradeAuth {
  const keyName = (apiKey ?? '').trim();
  if (!KEY_NAME_RE.test(keyName)) {
    throw new Error(
      'COINBASE_API_KEY is not a CDP key name (expected organizations/{org_id}/apiKeys/{key_id}). ' +
        'Legacy Coinbase Exchange keys cannot authenticate against Advanced Trade.',
    );
  }

  const pem = (apiSecret ?? '').replace(/\\n/g, '\n').trim();
  let privateKey: crypto.KeyObject;
  try {
    privateKey = crypto.createPrivateKey({ key: pem, format: 'pem' });
  } catch {
    throw new Error('COINBASE_API_SECRET is not a parseable PEM private key');
  }
  const curve = privateKey.asymmetricKeyDetails?.namedCurve;
  if (privateKey.asymmetricKeyType !== 'ec' || curve !== 'prime256v1') {
    throw new Error(
      `COINBASE_API_SECRET must be an ECDSA P-256 (prime256v1) private key; got ${privateKey.asymmetricKeyType ?? '?'}/${curve ?? '?'}`,
    );
  }
  return { keyName, privateKey };
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

export interface JwtRequestTarget {
  method: string;
  /** Request path; any query string is stripped before it enters the `uri` claim. */
  path: string;
  host?: string;
}

/**
 * Spec-exact Advanced Trade JWT.
 *
 * REST tokens carry `uri: "METHOD host/path"` (no query string). WebSocket tokens
 * omit `uri` entirely (pass no target). A fresh token must be minted per request /
 * per subscribe message — they expire after 120 seconds.
 */
export function signAdvancedTradeJwt(auth: AdvancedTradeAuth, target?: JwtRequestTarget): string {
  const now = Math.floor(Date.now() / 1000);
  const header = {
    alg: 'ES256',
    kid: auth.keyName,
    nonce: crypto.randomBytes(16).toString('hex'),
    typ: 'JWT',
  };
  const claims: Record<string, string | number> = {
    sub: auth.keyName,
    iss: 'cdp',
    nbf: now,
    exp: now + ADVANCED_TRADE_JWT_TTL_SECONDS,
  };
  if (target) {
    const pathOnly = target.path.split('?')[0];
    claims.uri = `${target.method.toUpperCase()} ${target.host ?? ADVANCED_TRADE_HOST}${pathOnly}`;
  }
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const signature = crypto.sign('sha256', Buffer.from(signingInput), {
    key: auth.privateKey,
    dsaEncoding: 'ieee-p1363', // raw R||S, as JWS ES256 requires
  });
  return `${signingInput}.${b64url(signature)}`;
}

// ============================================================================
// Advanced Trade wire types (subset actually consumed by the runtime)
// ============================================================================

export interface AtMoney {
  value: string;
  currency: string;
}

export interface AtAccount {
  uuid: string;
  name: string;
  currency: string;
  available_balance: AtMoney;
  hold: AtMoney;
  default?: boolean;
  active?: boolean;
  type?: string;
  ready?: boolean;
  platform?: string;
}

export interface AtAccountsPage {
  accounts: AtAccount[];
  has_next: boolean;
  cursor: string;
  size?: number;
}

export interface AtProduct {
  product_id: string;
  price: string;
  base_currency_id: string;
  quote_currency_id: string;
  base_increment: string;
  quote_increment: string;
  base_min_size: string;
  base_max_size: string;
  quote_min_size: string;
  quote_max_size: string;
  status: string;
  trading_disabled: boolean;
  cancel_only: boolean;
  limit_only: boolean;
  post_only: boolean;
  view_only?: boolean;
  is_disabled?: boolean;
  auction_mode?: boolean;
  product_type?: string;
  display_name?: string;
}

export type AtOrderSide = 'BUY' | 'SELL';

export type AtStopDirection = 'STOP_DIRECTION_STOP_UP' | 'STOP_DIRECTION_STOP_DOWN';

export interface AtOrderConfiguration {
  market_market_ioc?: { base_size?: string; quote_size?: string; rfq_disabled?: boolean };
  limit_limit_gtc?: { base_size: string; limit_price: string; post_only?: boolean };
  limit_limit_gtd?: { base_size: string; limit_price: string; end_time: string; post_only?: boolean };
  limit_limit_fok?: { base_size: string; limit_price: string };
  sor_limit_ioc?: { base_size: string; limit_price: string };
  stop_limit_stop_limit_gtc?: {
    base_size: string;
    limit_price: string;
    stop_price: string;
    stop_direction: AtStopDirection;
  };
  stop_limit_stop_limit_gtd?: {
    base_size: string;
    limit_price: string;
    stop_price: string;
    end_time: string;
    stop_direction: AtStopDirection;
  };
  /** For attached (bracket) configurations `base_size` MUST be omitted. */
  trigger_bracket_gtc?: { base_size?: string; limit_price: string; stop_trigger_price: string };
  trigger_bracket_gtd?: { base_size?: string; limit_price: string; stop_trigger_price: string; end_time: string };
}

export interface AtCreateOrderBody {
  client_order_id: string;
  product_id: string;
  side: AtOrderSide;
  order_configuration: AtOrderConfiguration;
  /** Only `trigger_bracket_gtc` (without base_size) is eligible. */
  attached_order_configuration?: AtOrderConfiguration;
  preview_id?: string;
}

export type AtCreateOrderResult =
  | { ok: true; orderId: string; clientOrderId: string; attachedOrderId?: string; raw: unknown }
  | {
      ok: false;
      code: string;
      message: string;
      previewFailureReason?: string;
      newOrderFailureReason?: string;
      raw: unknown;
    };

export interface AtPreviewOrderBody {
  product_id: string;
  side: AtOrderSide;
  order_configuration: AtOrderConfiguration;
  attached_order_configuration?: AtOrderConfiguration;
}

export interface AtPreviewResult {
  order_total: string;
  commission_total: string;
  errs: string[];
  warning: string[];
  quote_size: string;
  base_size: string;
  best_bid: string;
  best_ask: string;
  is_max?: boolean;
  slippage?: string;
  preview_id?: string;
  raw: unknown;
}

export type AtOrderStatus =
  | 'PENDING'
  | 'OPEN'
  | 'FILLED'
  | 'CANCELLED'
  | 'EXPIRED'
  | 'FAILED'
  | 'UNKNOWN_ORDER_STATUS'
  | 'QUEUED'
  | 'CANCEL_QUEUED'
  | 'EDIT_QUEUED';

export interface AtOrder {
  order_id: string;
  product_id: string;
  user_id?: string;
  order_configuration: AtOrderConfiguration;
  side: AtOrderSide;
  client_order_id: string;
  status: AtOrderStatus | string;
  time_in_force?: string;
  created_time: string;
  completion_percentage?: string;
  filled_size?: string;
  average_filled_price?: string;
  number_of_fills?: string;
  filled_value?: string;
  pending_cancel?: boolean;
  size_in_quote?: boolean;
  total_fees?: string;
  size_inclusive_of_fees?: boolean;
  total_value_after_fees?: string;
  trigger_status?: string;
  order_type?: string;
  reject_reason?: string;
  settled?: boolean;
  product_type?: string;
  reject_message?: string;
  cancel_message?: string;
  last_fill_time?: string;
  originating_order_id?: string;
  attached_order_id?: string;
  attached_order_configuration?: AtOrderConfiguration;
}

export interface AtListOrdersParams {
  order_ids?: string[];
  product_ids?: string[];
  /** Also accepted for convenience; folded into `product_ids`. */
  product_id?: string;
  order_status?: string[];
  start_date?: string;
  end_date?: string;
  limit?: number;
  cursor?: string;
}

export interface AtListOrdersPage {
  orders: AtOrder[];
  has_next: boolean;
  cursor: string;
}

export type AtLiquidityIndicator = 'MAKER' | 'TAKER' | 'UNKNOWN_LIQUIDITY_INDICATOR';

export interface AtFill {
  entry_id: string;
  trade_id: string;
  order_id: string;
  trade_time: string;
  trade_type: string;
  price: string;
  size: string;
  commission: string;
  product_id: string;
  sequence_timestamp: string;
  liquidity_indicator: AtLiquidityIndicator | string;
  size_in_quote: boolean;
  user_id?: string;
  side: AtOrderSide;
  retail_portfolio_id?: string;
}

export interface AtListFillsParams {
  order_ids?: string[];
  product_ids?: string[];
  start_sequence_timestamp?: string;
  end_sequence_timestamp?: string;
  limit?: number;
  cursor?: string;
}

export interface AtListFillsPage {
  fills: AtFill[];
  /** Empty string when there are no more pages. */
  cursor: string;
}

export interface AtCancelResult {
  order_id: string;
  success: boolean;
  failure_reason?: string;
}

export interface AtKeyPermissions {
  can_view: boolean;
  can_trade: boolean;
  can_transfer: boolean;
  portfolio_uuid: string;
  portfolio_type: string;
}

export interface AtServerTime {
  iso: string;
  epochSeconds: string;
  epochMillis: string;
}

/** `fee_tier` block of GET /transaction_summary. Rates are decimal strings (0.012 = 120 bps). */
export interface AtFeeTier {
  pricing_tier: string;
  usd_from?: string;
  usd_to?: string;
  taker_fee_rate: string;
  maker_fee_rate: string;
  aop_from?: string;
  aop_to?: string;
}

/** GET /transaction_summary — the account's live fee tier and 30-day volume. */
export interface AtTransactionSummary {
  /** 30-day trailing volume in USD (Coinbase returns a JSON number). */
  total_volume: number;
  total_fees: number;
  fee_tier: AtFeeTier;
  advanced_trade_only_volume?: number;
  advanced_trade_only_fees?: number;
  raw: unknown;
}

// ============================================================================
// Internal helpers
// ============================================================================

type HttpMethod = 'GET' | 'POST';
type QueryValue = string | number | boolean | undefined | null | Array<string | number>;
type QueryParams = Record<string, QueryValue>;

function buildQuery(params?: QueryParams): string {
  if (!params) return '';
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) search.append(key, String(item));
    } else {
      search.append(key, String(value));
    }
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

function classifyStatus(status: number, message: string): { kind: CoinbaseErrorKind; retryable: boolean } {
  if (status === 429) return { kind: 'rate_limit', retryable: true };
  if (status >= 500) return { kind: 'server', retryable: true };
  if (status === 408) return { kind: 'timeout', retryable: true };
  if (status === 401 || status === 403) return { kind: 'auth', retryable: false };
  if (status === 404) return { kind: 'not_found', retryable: false };
  const lower = message.toLowerCase();
  if (lower.includes('post-only') || lower.includes('post only')) return { kind: 'post_only', retryable: false };
  if (lower.includes('insufficient')) return { kind: 'insufficient_funds', retryable: false };
  if (lower.includes('rejected') || lower.includes('invalid')) return { kind: 'order_rejected', retryable: false };
  return { kind: 'bad_request', retryable: false };
}

function parseRetryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number.parseInt(header, 10);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(header);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function toLegacyType(orderType: string | undefined): 'limit' | 'market' | 'stop' {
  const upper = (orderType ?? '').toUpperCase();
  if (upper === 'MARKET') return 'market';
  if (upper === 'STOP' || upper === 'STOP_LIMIT' || upper === 'BRACKET') return 'stop';
  return 'limit';
}

function toLegacyStatus(status: string | undefined): CoinbaseOrder['status'] {
  switch ((status ?? '').toUpperCase()) {
    case 'OPEN':
    case 'QUEUED':
    case 'CANCEL_QUEUED':
    case 'EDIT_QUEUED':
      return 'open';
    case 'FILLED':
    case 'EXPIRED':
      return 'done';
    case 'CANCELLED':
      return 'canceled';
    case 'FAILED':
      return 'rejected';
    default:
      return 'pending';
  }
}

const GRANULARITY_MAP: Record<number, string> = {
  60: 'ONE_MINUTE',
  300: 'FIVE_MINUTE',
  900: 'FIFTEEN_MINUTE',
  1800: 'THIRTY_MINUTE',
  3600: 'ONE_HOUR',
  7200: 'TWO_HOUR',
  21600: 'SIX_HOUR',
  86400: 'ONE_DAY',
};

// ============================================================================
// Client
// ============================================================================

/**
 * Coinbase Advanced Trade REST client (`/api/v3/brokerage`).
 *
 * Construct with empty credentials for public endpoints only; any credential
 * supplied is validated immediately (fail closed).
 */
export class AdvancedTradeRestClient {
  private readonly logger: Logger;
  private readonly baseUrl: string;
  /** Host used in the JWT `uri` claim — must match the host the request is sent to. */
  private readonly host: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly maxRetryDelayMs: number;
  private readonly userAgent: string;
  private readonly auth: AdvancedTradeAuth | null;

  constructor(config: AdvancedTradeConfig, logger: Logger) {
    this.logger = logger;
    this.baseUrl = config.environment === 'production' ? ADVANCED_TRADE_BASE_URL : ADVANCED_TRADE_SANDBOX_BASE_URL;
    this.host = new URL(this.baseUrl).host;
    this.fetchImpl = config.fetchImpl ?? ((url, init) => globalThis.fetch(url, init) as Promise<FetchResponseLike>);
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = Math.max(0, config.maxRetries ?? DEFAULT_MAX_RETRIES);
    this.maxRetryDelayMs = config.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;
    this.userAgent = config.userAgent ?? 'AtlasBot/1.0 (advanced-trade)';
    this.auth = config.apiKey || config.apiSecret ? loadAdvancedTradeAuth(config.apiKey, config.apiSecret) : null;
  }

  /** True when credentials were supplied (authenticated endpoints available). */
  public get isAuthenticated(): boolean {
    return this.auth !== null;
  }

  /** Parsed credentials for components that need their own JWTs (user WebSocket). */
  public getAuth(): AdvancedTradeAuth {
    if (!this.auth) {
      throw new Error('AdvancedTradeRestClient has no credentials configured');
    }
    return this.auth;
  }

  // ---------------------------------------------------------------- public

  /** GET /time — server clock (public). Used for JWT skew checks. */
  public async getServerTime(): Promise<AtServerTime> {
    return this.request<AtServerTime>('GET', `${BROKERAGE}/time`, { auth: false });
  }

  /** Clock skew between this host and Coinbase, in seconds (absolute). Throws if the server time is unusable. */
  public async getClockSkewSeconds(): Promise<number> {
    const time = await this.getServerTime();
    const serverMs = time?.epochMillis ? Number(time.epochMillis) : Number(time?.epochSeconds) * 1000;
    if (!Number.isFinite(serverMs) || serverMs <= 0) {
      throw new Error('Coinbase server time response was unparseable');
    }
    return Math.abs(Date.now() - serverMs) / 1000;
  }

  /** GET /key_permissions — what this CDP key may do. */
  public async getKeyPermissions(): Promise<AtKeyPermissions> {
    return this.request<AtKeyPermissions>('GET', `${BROKERAGE}/key_permissions`);
  }

  /**
   * GET /transaction_summary — the account's CURRENT fee tier (maker/taker rates) and
   * 30-day volume. Throws when the response carries no parseable `fee_tier`, so callers
   * can never mistake an unknown tier for a known one (fail closed).
   */
  public async getTransactionSummary(): Promise<AtTransactionSummary> {
    const raw = await this.request<Record<string, unknown>>('GET', `${BROKERAGE}/transaction_summary`);
    const tier = asRecord(raw.fee_tier);
    const makerRate = Number.parseFloat(String(tier.maker_fee_rate ?? ''));
    const takerRate = Number.parseFloat(String(tier.taker_fee_rate ?? ''));
    if (!Number.isFinite(makerRate) || !Number.isFinite(takerRate) || makerRate < 0 || takerRate < 0) {
      throw new Error(
        'Coinbase transaction_summary response carried no parseable fee_tier (maker_fee_rate/taker_fee_rate)',
      );
    }
    const toNumber = (value: unknown): number => {
      const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''));
      return Number.isFinite(parsed) ? parsed : 0;
    };
    return {
      total_volume: toNumber(raw.total_volume),
      total_fees: toNumber(raw.total_fees),
      fee_tier: {
        pricing_tier: str(tier.pricing_tier) ?? 'unknown',
        usd_from: str(tier.usd_from),
        usd_to: str(tier.usd_to),
        taker_fee_rate: String(tier.taker_fee_rate),
        maker_fee_rate: String(tier.maker_fee_rate),
        aop_from: str(tier.aop_from),
        aop_to: str(tier.aop_to),
      },
      advanced_trade_only_volume: raw.advanced_trade_only_volume !== undefined ? toNumber(raw.advanced_trade_only_volume) : undefined,
      advanced_trade_only_fees: raw.advanced_trade_only_fees !== undefined ? toNumber(raw.advanced_trade_only_fees) : undefined,
      raw,
    };
  }

  /** GET /accounts — all pages (limit 250, follows `cursor` while `has_next`). */
  public async getAccountsAll(): Promise<AtAccount[]> {
    const accounts: AtAccount[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const data = await this.request<AtAccountsPage>('GET', `${BROKERAGE}/accounts`, {
        query: { limit: ACCOUNTS_PAGE_LIMIT, cursor },
      });
      accounts.push(...(data.accounts ?? []));
      if (!data.has_next || !data.cursor) break;
      cursor = data.cursor;
    }
    return accounts;
  }

  /**
   * Accounts in the legacy `Account` shape (balance = available + hold), paginated.
   * Kept so `LiveAccountProvider` and the preflight CLI can consume this client.
   */
  public async getAccounts(): Promise<Account[]> {
    const accounts = await this.getAccountsAll();
    return accounts.map((acc) => ({
      id: acc.uuid,
      currency: acc.currency,
      balance: decimalAdd(acc.available_balance?.value ?? '0', acc.hold?.value ?? '0'),
      available: acc.available_balance?.value ?? '0',
      hold: acc.hold?.value ?? '0',
      profile_id: '',
      trading_enabled: acc.active ?? true,
    }));
  }

  /** GET /products/{id} — real increments, minimums and trading flags. */
  public async getProduct(productId: string): Promise<AtProduct> {
    return this.request<AtProduct>('GET', `${BROKERAGE}/products/${encodeURIComponent(productId)}`);
  }

  /** GET /products — raw Advanced Trade products (spot by default). */
  public async listProducts(productType: 'SPOT' | 'FUTURE' = 'SPOT'): Promise<AtProduct[]> {
    const data = await this.request<{ products?: AtProduct[] }>('GET', `${BROKERAGE}/products`, {
      query: { product_type: productType },
    });
    return data.products ?? [];
  }

  /** Products in the legacy `Product` shape, populated with REAL increments (no hard-coded specs). */
  public async getProducts(): Promise<Product[]> {
    const products = await this.listProducts();
    return products
      .filter((p) => !p.trading_disabled && !p.is_disabled)
      .map((p) => ({
        id: p.product_id,
        base_currency: p.base_currency_id,
        quote_currency: p.quote_currency_id,
        base_min_size: p.base_min_size,
        base_max_size: p.base_max_size,
        quote_increment: p.quote_increment,
        base_increment: p.base_increment,
        display_name: p.display_name ?? p.product_id,
        min_market_funds: p.quote_min_size,
        max_market_funds: p.quote_max_size,
        margin_enabled: false,
        post_only: p.post_only,
        limit_only: p.limit_only,
        cancel_only: p.cancel_only,
        status: (p.status ?? '').toLowerCase(),
        status_message: '',
        trading_disabled: p.trading_disabled,
      }));
  }

  /** POST /orders/preview — validates an order shape and returns totals without executing. */
  public async previewOrder(body: AtPreviewOrderBody): Promise<AtPreviewResult> {
    const raw = await this.request<Record<string, unknown>>('POST', `${BROKERAGE}/orders/preview`, { body });
    return {
      order_total: str(raw.order_total) ?? '0',
      commission_total: str(raw.commission_total) ?? '0',
      errs: Array.isArray(raw.errs) ? raw.errs.map(String) : [],
      warning: Array.isArray(raw.warning) ? raw.warning.map(String) : [],
      quote_size: str(raw.quote_size) ?? '0',
      base_size: str(raw.base_size) ?? '0',
      best_bid: str(raw.best_bid) ?? '0',
      best_ask: str(raw.best_ask) ?? '0',
      is_max: typeof raw.is_max === 'boolean' ? raw.is_max : undefined,
      slippage: str(raw.slippage),
      preview_id: str(raw.preview_id),
      raw,
    };
  }

  /**
   * POST /orders — place an order.
   *
   * Business rejections (`success:false`, or HTTP 4xx validation errors) resolve to
   * `{ ok:false, code, message }`. Only transport/auth/rate-limit/server failures throw.
   */
  public async createOrderRaw(body: AtCreateOrderBody): Promise<AtCreateOrderResult> {
    if (!body.client_order_id) {
      return { ok: false, code: 'CLIENT_ORDER_ID_REQUIRED', message: 'client_order_id is required', raw: null };
    }

    let raw: Record<string, unknown>;
    try {
      raw = await this.request<Record<string, unknown>>('POST', `${BROKERAGE}/orders`, { body });
    } catch (error) {
      if (error instanceof CoinbaseApiError && isBusinessRejectStatus(error.httpStatus)) {
        return {
          ok: false,
          code: error.coinbaseCode ?? `HTTP_${error.httpStatus}`,
          message: error.coinbaseMessage ?? error.message,
          raw: { status: error.httpStatus, code: error.coinbaseCode, message: error.coinbaseMessage },
        };
      }
      throw error;
    }

    const successResponse = asRecord(raw.success_response);
    const errorResponse = asRecord(raw.error_response);
    const orderId = str(successResponse.order_id) ?? str(raw.order_id);

    if (raw.success === true && orderId) {
      return {
        ok: true,
        orderId,
        clientOrderId: str(successResponse.client_order_id) ?? body.client_order_id,
        attachedOrderId: str(successResponse.attached_order_id),
        raw,
      };
    }

    const newOrderFailureReason = str(errorResponse.new_order_failure_reason) ?? str(errorResponse.error);
    const previewFailureReason = str(errorResponse.preview_failure_reason);
    const code =
      newOrderFailureReason ??
      previewFailureReason ??
      str(raw.failure_reason) ??
      (raw.success === true ? 'MISSING_ORDER_ID' : 'UNKNOWN_FAILURE_REASON');
    const message =
      str(errorResponse.message) ??
      str(errorResponse.error_details) ??
      (raw.success === true ? 'Coinbase reported success without an order_id' : code);

    this.logger.warn('Advanced Trade order rejected', {
      productId: body.product_id,
      clientOrderId: body.client_order_id,
      code,
      message,
    });

    return { ok: false, code, message, previewFailureReason, newOrderFailureReason, raw };
  }

  /**
   * Legacy-shape order placement. Rejections THROW a `CoinbaseApiError` (kind
   * `order_rejected`) instead of returning a synthesized pending order, and the
   * returned order is fetched from Coinbase (truth, not a guess).
   *
   * @deprecated Prefer `createOrderRaw` + `getOrder`.
   */
  public async createOrder(order: OrderRequest): Promise<CoinbaseOrder> {
    const body = legacyRequestToBody(order);
    const result = await this.createOrderRaw(body);
    if (!result.ok) {
      throw new CoinbaseApiError({
        kind: 'order_rejected',
        message: `${result.code}: ${result.message}`,
        httpStatus: 200,
        coinbaseCode: result.code,
        coinbaseMessage: result.message,
        route: `${BROKERAGE}/orders`,
        method: 'POST',
        retryable: false,
      });
    }
    const truth = await this.getOrder(result.orderId);
    return toLegacyOrder(truth);
  }

  /** GET /orders/historical/{order_id} */
  public async getOrder(orderId: string): Promise<AtOrder> {
    const data = await this.request<{ order: AtOrder }>(
      'GET',
      `${BROKERAGE}/orders/historical/${encodeURIComponent(orderId)}`,
    );
    return data.order;
  }

  /** GET /orders/historical/batch — one page. */
  public async listOrders(params: AtListOrdersParams = {}): Promise<AtListOrdersPage> {
    const productIds = [...(params.product_ids ?? []), ...(params.product_id ? [params.product_id] : [])];
    const data = await this.request<Partial<AtListOrdersPage>>('GET', `${BROKERAGE}/orders/historical/batch`, {
      query: {
        order_ids: params.order_ids,
        product_ids: productIds.length ? productIds : undefined,
        order_status: params.order_status,
        start_date: params.start_date,
        end_date: params.end_date,
        limit: params.limit,
        cursor: params.cursor,
      },
    });
    return {
      orders: data.orders ?? [],
      has_next: Boolean(data.has_next),
      cursor: data.cursor ?? '',
    };
  }

  /** All pages of `listOrders` (bounded by `maxPages`). */
  public async listOrdersAll(params: AtListOrdersParams = {}, maxPages = MAX_PAGES): Promise<AtOrder[]> {
    const orders: AtOrder[] = [];
    let cursor = params.cursor;
    for (let page = 0; page < maxPages; page++) {
      const data = await this.listOrders({ ...params, cursor });
      orders.push(...data.orders);
      if (!data.has_next || !data.cursor) break;
      cursor = data.cursor;
    }
    return orders;
  }

  /** GET /orders/historical/fills — one page (`cursor` is empty when exhausted). */
  public async listFills(params: AtListFillsParams = {}): Promise<AtListFillsPage> {
    const data = await this.request<Partial<AtListFillsPage>>('GET', `${BROKERAGE}/orders/historical/fills`, {
      query: {
        order_ids: params.order_ids,
        product_ids: params.product_ids,
        start_sequence_timestamp: params.start_sequence_timestamp,
        end_sequence_timestamp: params.end_sequence_timestamp,
        limit: params.limit,
        cursor: params.cursor,
      },
    });
    return { fills: data.fills ?? [], cursor: data.cursor ?? '' };
  }

  /** All pages of `listFills` (bounded by `maxPages`). */
  public async listFillsAll(params: AtListFillsParams = {}, maxPages = MAX_PAGES): Promise<AtFill[]> {
    const fills: AtFill[] = [];
    let cursor = params.cursor;
    for (let page = 0; page < maxPages; page++) {
      const data = await this.listFills({ ...params, cursor });
      fills.push(...data.fills);
      if (!data.cursor || data.fills.length === 0) break;
      cursor = data.cursor;
    }
    return fills;
  }

  /** POST /orders/batch_cancel — per-id outcome; never assume success. */
  public async cancelOrders(orderIds: string[]): Promise<AtCancelResult[]> {
    if (orderIds.length === 0) return [];
    const data = await this.request<{ results?: Array<Partial<AtCancelResult>> }>(
      'POST',
      `${BROKERAGE}/orders/batch_cancel`,
      { body: { order_ids: orderIds } },
    );
    const results = data.results ?? [];
    return orderIds.map((orderId) => {
      const match = results.find((r) => r.order_id === orderId);
      return {
        order_id: orderId,
        success: match?.success === true,
        failure_reason: match ? match.failure_reason : 'NO_RESULT_RETURNED',
      };
    });
  }

  /** Legacy: cancel one order, returning the ids Coinbase confirmed as cancelled. */
  public async cancelOrder(orderId: string): Promise<string[]> {
    const results = await this.cancelOrders([orderId]);
    return results.filter((r) => r.success).map((r) => r.order_id);
  }

  /** Legacy: cancel every OPEN order (optionally for one product); returns confirmed ids. */
  public async cancelAllOrders(productId?: string): Promise<string[]> {
    const open = await this.listOrdersAll({
      order_status: ['OPEN'],
      product_ids: productId ? [productId] : undefined,
    });
    if (open.length === 0) return [];
    const results = await this.cancelOrders(open.map((o) => o.order_id));
    return results.filter((r) => r.success).map((r) => r.order_id);
  }

  /** Legacy: orders in the `CoinbaseOrder` shape (first page). */
  public async getOrders(status?: string[], productId?: string, limit?: number): Promise<CoinbaseOrder[]> {
    const page = await this.listOrders({
      order_status: status?.map((s) => s.toUpperCase()),
      product_ids: productId ? [productId] : undefined,
      limit,
    });
    return page.orders.map(toLegacyOrder);
  }

  /** Legacy: fills in the `Fill` shape (first page). */
  public async getFills(orderId?: string, productId?: string): Promise<Fill[]> {
    const page = await this.listFills({
      order_ids: orderId ? [orderId] : undefined,
      product_ids: productId ? [productId] : undefined,
    });
    return page.fills.map((f) => ({
      trade_id: Number.parseInt(f.trade_id, 10) || 0,
      product_id: f.product_id,
      order_id: f.order_id,
      user_id: f.user_id ?? '',
      profile_id: '',
      liquidity: f.liquidity_indicator === 'MAKER' ? 'M' : 'T',
      price: f.price,
      size: f.size,
      fee: f.commission,
      created_at: f.trade_time,
      side: f.side.toLowerCase() as 'buy' | 'sell',
      settled: true,
      usd_volume: decimalMul(f.price, f.size),
    }));
  }

  /** GET /products/{id}/candles (public). Throws on granularities Coinbase does not offer. */
  public async getCandles(productId: string, granularity: number, start?: string, end?: string): Promise<Candle[]> {
    const mapped = GRANULARITY_MAP[granularity];
    if (!mapped) {
      throw new Error(
        `Unsupported Coinbase candle granularity ${granularity}s (supported: ${Object.keys(GRANULARITY_MAP).join(', ')})`,
      );
    }
    const data = await this.request<{ candles?: Array<Record<string, string>> }>(
      'GET',
      `${BROKERAGE}/products/${encodeURIComponent(productId)}/candles`,
      { query: { granularity: mapped, start, end }, auth: this.isAuthenticated },
    );
    return (data.candles ?? []).map((c) => ({
      time: Number.parseInt(c.start, 10),
      open: Number.parseFloat(c.open),
      high: Number.parseFloat(c.high),
      low: Number.parseFloat(c.low),
      close: Number.parseFloat(c.close),
      volume: Number.parseFloat(c.volume),
    }));
  }

  // --------------------------------------------------------------- request

  /**
   * Central HTTP entry point. Every outbound call goes through here so timeout,
   * retry and error hygiene are applied uniformly.
   */
  private async request<T>(
    method: HttpMethod,
    path: string,
    options: { query?: QueryParams; body?: unknown; auth?: boolean } = {},
  ): Promise<T> {
    const url = `${this.baseUrl}${path}${buildQuery(options.query)}`;
    const maxAttempts = 1 + this.maxRetries;
    const idempotent = method === 'GET';

    for (let attempt = 1; ; attempt++) {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': this.userAgent,
      };
      if (options.auth !== false && this.auth) {
        headers.Authorization = `Bearer ${signAdvancedTradeJwt(this.auth, { method, path, host: this.host })}`;
      }

      let response: FetchResponseLike;
      let text: string;
      try {
        response = await this.fetchImpl(url, {
          method,
          headers,
          body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        // Reading the body can fail after the server has already processed the request
        // (stream reset, abort). Surface that as a NETWORK error so callers treat the
        // outcome as unknown rather than as a definitive rejection.
        text = await response.text();
      } catch (error) {
        const netError = toNetworkError(error, path, method);
        if (idempotent && attempt < maxAttempts) {
          await this.sleep(this.backoffMs(attempt));
          continue;
        }
        this.logger.error('Advanced Trade request failed', {
          method,
          path,
          kind: netError.kind,
          code: netError.code,
          message: netError.message,
          attempt,
        });
        throw netError;
      }

      let body: unknown = null;
      if (text) {
        try {
          body = JSON.parse(text);
        } catch {
          body = null;
        }
      }

      if (response.ok) {
        return (body ?? {}) as T;
      }

      const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'));
      if (response.status === 429 && attempt < maxAttempts) {
        await this.sleep(Math.min(retryAfterMs ?? this.backoffMs(attempt), this.maxRetryDelayMs));
        continue;
      }
      if (response.status >= 500 && idempotent && attempt < maxAttempts) {
        await this.sleep(this.backoffMs(attempt));
        continue;
      }

      const apiError = toApiError(response.status, body, path, method, retryAfterMs);
      this.logger.error('Advanced Trade request rejected', {
        method,
        path,
        status: apiError.httpStatus,
        kind: apiError.kind,
        code: apiError.coinbaseCode,
        message: apiError.coinbaseMessage ?? apiError.message,
        attempt,
      });
      throw apiError;
    }
  }

  private backoffMs(attempt: number): number {
    return Math.min(500 * 2 ** (attempt - 1), this.maxRetryDelayMs);
  }

  /** Overridable for tests. */
  protected sleep(ms: number): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// ============================================================================
// Error mapping (never carries request headers)
// ============================================================================

function isBusinessRejectStatus(status: number): boolean {
  return status >= 400 && status < 500 && ![401, 403, 404, 408, 429].includes(status);
}

function toApiError(
  status: number,
  body: unknown,
  path: string,
  method: HttpMethod,
  retryAfterMs?: number,
): CoinbaseApiError {
  const record = asRecord(body);
  const errorResponse = asRecord(record.error_response);
  const code =
    str(record.error) ??
    str(errorResponse.error) ??
    str(errorResponse.new_order_failure_reason) ??
    (record.code !== undefined ? String(record.code) : undefined);
  const message =
    str(record.message) ??
    str(errorResponse.message) ??
    str(record.error_details) ??
    str(errorResponse.error_details) ??
    `HTTP ${status}`;
  const { kind, retryable } = classifyStatus(status, `${code ?? ''} ${message}`);
  return new CoinbaseApiError({
    kind,
    message: code ? `${code}: ${message}` : message,
    httpStatus: status,
    coinbaseCode: code,
    coinbaseMessage: message,
    route: path,
    method,
    retryable,
    retryAfterMs,
  });
}

function toNetworkError(error: unknown, path: string, method: HttpMethod): CoinbaseNetworkError {
  const err = error instanceof Error ? error : new Error(String(error));
  const code = (err as { code?: string }).code ?? (err as { cause?: { code?: string } }).cause?.code;
  const isTimeout = err.name === 'TimeoutError' || err.name === 'AbortError' || code === 'ETIMEDOUT' || code === 'ECONNABORTED';
  return new CoinbaseNetworkError({
    kind: isTimeout ? 'timeout' : 'network',
    message: err.message || (isTimeout ? 'Request timed out' : 'Network error'),
    code,
    route: path,
    method,
  });
}

// ============================================================================
// Legacy shape mapping
// ============================================================================

function legacyRequestToBody(order: OrderRequest): AtCreateOrderBody {
  const configuration: AtOrderConfiguration = {};
  if (order.type === 'market') {
    configuration.market_market_ioc = {
      ...(order.size ? { base_size: order.size } : {}),
      ...(order.funds ? { quote_size: order.funds } : {}),
    };
  } else if (order.type === 'limit') {
    configuration.limit_limit_gtc = {
      base_size: order.size ?? '0',
      limit_price: order.price ?? '0',
      post_only: order.post_only ?? false,
    };
  } else {
    configuration.stop_limit_stop_limit_gtc = {
      base_size: order.size ?? '0',
      limit_price: order.price ?? '0',
      stop_price: order.stop_price ?? '0',
      stop_direction: order.side === 'sell' ? 'STOP_DIRECTION_STOP_DOWN' : 'STOP_DIRECTION_STOP_UP',
    };
  }
  return {
    client_order_id: order.client_oid || crypto.randomUUID(),
    product_id: order.product_id,
    side: order.side.toUpperCase() as AtOrderSide,
    order_configuration: configuration,
  };
}

function extractLimitPrice(config: AtOrderConfiguration | undefined): string | undefined {
  if (!config) return undefined;
  return (
    config.limit_limit_gtc?.limit_price ??
    config.limit_limit_gtd?.limit_price ??
    config.limit_limit_fok?.limit_price ??
    config.sor_limit_ioc?.limit_price ??
    config.stop_limit_stop_limit_gtc?.limit_price ??
    config.stop_limit_stop_limit_gtd?.limit_price ??
    config.trigger_bracket_gtc?.limit_price ??
    config.trigger_bracket_gtd?.limit_price
  );
}

function extractBaseSize(config: AtOrderConfiguration | undefined): string | undefined {
  if (!config) return undefined;
  return (
    config.limit_limit_gtc?.base_size ??
    config.limit_limit_gtd?.base_size ??
    config.limit_limit_fok?.base_size ??
    config.sor_limit_ioc?.base_size ??
    config.stop_limit_stop_limit_gtc?.base_size ??
    config.stop_limit_stop_limit_gtd?.base_size ??
    config.trigger_bracket_gtc?.base_size ??
    config.trigger_bracket_gtd?.base_size ??
    config.market_market_ioc?.base_size
  );
}

function extractStopPrice(config: AtOrderConfiguration | undefined): string | undefined {
  if (!config) return undefined;
  return (
    config.stop_limit_stop_limit_gtc?.stop_price ??
    config.stop_limit_stop_limit_gtd?.stop_price ??
    config.trigger_bracket_gtc?.stop_trigger_price ??
    config.trigger_bracket_gtd?.stop_trigger_price
  );
}

/** Map an Advanced Trade order onto the legacy `CoinbaseOrder` shape. */
export function toLegacyOrder(order: AtOrder): CoinbaseOrder {
  const status = toLegacyStatus(order.status);
  return {
    id: order.order_id,
    product_id: order.product_id,
    side: order.side.toLowerCase() as 'buy' | 'sell',
    type: toLegacyType(order.order_type),
    size: extractBaseSize(order.order_configuration) ?? order.filled_size ?? '0',
    price: extractLimitPrice(order.order_configuration) ?? order.average_filled_price,
    stop_price: extractStopPrice(order.order_configuration),
    status,
    created_at: order.created_time,
    fill_fees: order.total_fees ?? '0',
    filled_size: order.filled_size ?? '0',
    executed_value: order.filled_value ?? '0',
    settled: order.settled ?? status === 'done',
    post_only: order.order_configuration?.limit_limit_gtc?.post_only ?? false,
    time_in_force: 'GTC',
  };
}
