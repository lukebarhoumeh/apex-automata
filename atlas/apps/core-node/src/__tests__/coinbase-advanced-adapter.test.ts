/**
 * Coinbase Advanced Trade live execution path — TASK_010.
 *
 * Everything is mocked (fetch + WebSocket). No network, no real orders, no money.
 *
 * Covers the task's minimum cases:
 *  1. JWT header/claims shape, `uri` excludes query string, ES256 signature verifies (ieee-p1363)
 *  2. `success:false` (INSUFFICIENT_FUND) ⇒ `order_rejected` with code, no `order_accepted`
 *  3. Limit sizing rounds DOWN to base_increment, price to quote_increment, strings in body
 *  4. Below base_min_size ⇒ local reject, zero HTTP calls
 *  5. Retry with the same clientOrderId sends an identical client_order_id
 *  6. User-stream cumulative fills 0 → 0.4 → 1.0 emit two deltas; duplicate ignored
 *  7. Factory: live + COINBASE_API_VERSION=exchange throws LIVE_REQUIRES_ADVANCED_TRADE
 *  8. Error logging never contains `Bearer `
 * plus pagination, cancel-confirmed-only, 429 retry, stop/bracket mapping, REST fill merge,
 * user-stream staleness/reconnect and product-spec fail-closed start.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'node:crypto';
import { EventEmitter } from 'events';
import { Logger } from '../core/logger';
import { FeeModel } from '../core/fee-model';
import type { FeesConfig } from '../config/loadGuardrails';
import {
  AdvancedTradeRestClient,
  FetchLike,
  FetchRequestInit,
  loadAdvancedTradeAuth,
  signAdvancedTradeJwt,
  AtProduct,
  AtOrder,
  AtFill,
} from '../exchanges/coinbase/advanced-trade-client';
import { CoinbaseApiError, CoinbaseNetworkError } from '../exchanges/coinbase/http/errors';
import {
  AdvancedTradeUserStream,
  USER_STREAM_STALE,
  WsLike,
} from '../exchanges/coinbase/advanced-trade-user-stream';
import {
  CoinbaseAdvancedExecutionAdapter,
  LIVE_PRODUCT_UNAVAILABLE,
  LiveProductSpec,
  toLiveProductSpec,
} from '../trading/execution/coinbase-advanced-adapter';
import {
  createAdapters,
  LIVE_REQUIRES_ADVANCED_TRADE,
  LIVE_CREDENTIALS_MISSING,
  parseEnvConfig,
} from '../trading/execution/adapter-factory';
import { PaperExecutionAdapter } from '../trading/execution/paper-adapter';
import { BrokerOrderEvent, FillEvent, OrderRejectedEvent, PlaceOrderRequest } from '../trading/execution/execution-adapter';

// ============================================================================
// Fixtures
// ============================================================================

const KEY_NAME = 'organizations/11111111-1111-1111-1111-111111111111/apiKeys/22222222-2222-2222-2222-222222222222';
const { privateKey: PRIVATE_KEY, publicKey: PUBLIC_KEY } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const PRIVATE_PEM = PRIVATE_KEY.export({ type: 'sec1', format: 'pem' }) as string;
/** Same PEM but with literal `\n` sequences, as it arrives from .env files. */
const PRIVATE_PEM_ESCAPED = PRIVATE_PEM.replace(/\n/g, '\\n');

const TEST_FEES: FeesConfig = {
  coinbase: {
    spot: { maker_bps: 25, taker_bps: 40 },
    perps_intx: { maker_bps: 0, taker_bps: 5 },
  },
  hyperliquid: { perps: { maker_bps: -1.5, taker_bps: 4.5 } },
};
const testFeeModel = new FeeModel(TEST_FEES);

function createLogger(): Logger & { calls: () => unknown[][] } {
  const info = vi.fn();
  const warn = vi.fn();
  const error = vi.fn();
  const debug = vi.fn();
  return {
    info,
    warn,
    error,
    debug,
    calls: () => [...info.mock.calls, ...warn.mock.calls, ...error.mock.calls, ...debug.mock.calls],
  };
}

const ETH_PRODUCT: AtProduct = {
  product_id: 'ETH-USD',
  price: '2469.55',
  base_currency_id: 'ETH',
  quote_currency_id: 'USD',
  base_increment: '0.00000001',
  quote_increment: '0.01',
  base_min_size: '0.00022',
  base_max_size: '2600',
  quote_min_size: '1',
  quote_max_size: '10000000',
  status: 'online',
  trading_disabled: false,
  cancel_only: false,
  limit_only: false,
  post_only: false,
  view_only: false,
  is_disabled: false,
  auction_mode: false,
  product_type: 'SPOT',
};

const ETH_SPEC: LiveProductSpec = toLiveProductSpec(ETH_PRODUCT);

interface RecordedCall {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string>;
  body: any;
  url: string;
}

interface MockResponse {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

type Route = (call: RecordedCall) => MockResponse | Promise<MockResponse>;

/** Records every outbound request and lets tests route by method + path. */
function createMockFetch() {
  const calls: RecordedCall[] = [];
  const routes: Array<{ match: (c: RecordedCall) => boolean; handler: Route }> = [];

  const fetchImpl: FetchLike = async (url: string, init: FetchRequestInit) => {
    const parsed = new URL(url);
    const call: RecordedCall = {
      method: init.method,
      path: parsed.pathname,
      query: parsed.searchParams,
      headers: init.headers,
      body: init.body ? JSON.parse(init.body) : undefined,
      url,
    };
    calls.push(call);
    const route = routes.find((r) => r.match(call));
    if (!route) {
      return toResponse({ status: 404, body: { error: 'NOT_FOUND', message: `no route for ${call.method} ${call.path}` } });
    }
    return toResponse(await route.handler(call));
  };

  return {
    fetchImpl,
    calls,
    on(method: string, pathOrPrefix: string, handler: Route) {
      routes.unshift({
        match: (c) => c.method === method && (c.path === pathOrPrefix || c.path.startsWith(`${pathOrPrefix}/`)),
        handler,
      });
    },
    reset() {
      calls.length = 0;
      routes.length = 0;
    },
  };
}

function toResponse(mock: MockResponse) {
  const headers = new Map(Object.entries(mock.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    status: mock.status,
    ok: mock.status >= 200 && mock.status < 300,
    headers: { get: (name: string) => headers.get(name.toLowerCase()) ?? null },
    text: async () => (mock.body === undefined ? '' : JSON.stringify(mock.body)),
  };
}

function decodeJwt(token: string) {
  const [h, c, s] = token.split('.');
  return {
    header: JSON.parse(Buffer.from(h, 'base64url').toString('utf8')),
    claims: JSON.parse(Buffer.from(c, 'base64url').toString('utf8')),
    signature: Buffer.from(s, 'base64url'),
    signingInput: `${h}.${c}`,
  };
}

function makeClient(mock: ReturnType<typeof createMockFetch>, logger: Logger, overrides: Partial<ConstructorParameters<typeof AdvancedTradeRestClient>[0]> = {}) {
  return new AdvancedTradeRestClient(
    { apiKey: KEY_NAME, apiSecret: PRIVATE_PEM_ESCAPED, environment: 'production', fetchImpl: mock.fetchImpl, ...overrides },
    logger,
  );
}

function atOrder(overrides: Partial<AtOrder>): AtOrder {
  return {
    order_id: 'ex-1',
    product_id: 'ETH-USD',
    order_configuration: { limit_limit_gtc: { base_size: '1', limit_price: '2000.00', post_only: false } },
    side: 'BUY',
    client_order_id: 'c-1',
    status: 'OPEN',
    created_time: '2026-09-10T18:00:00Z',
    filled_size: '0',
    average_filled_price: '0',
    total_fees: '0',
    order_type: 'LIMIT',
    ...overrides,
  };
}

function atFill(overrides: Partial<AtFill>): AtFill {
  return {
    entry_id: `e-${overrides.trade_id ?? 't'}`,
    trade_id: 't-1',
    order_id: 'ex-1',
    trade_time: '2026-09-10T18:00:01Z',
    trade_type: 'FILL',
    price: '2000.00',
    size: '0.4',
    commission: '1.00',
    product_id: 'ETH-USD',
    sequence_timestamp: '2026-09-10T18:00:01Z',
    liquidity_indicator: 'TAKER',
    size_in_quote: false,
    side: 'BUY',
    ...overrides,
  };
}

const LIMIT_REQUEST: PlaceOrderRequest = {
  clientOrderId: 'c-1',
  symbol: 'ETH-USD',
  side: 'buy',
  type: 'limit',
  price: 2000,
  quantity: 1,
};

/** Fake `ws` socket controlled by the test. */
class FakeWs extends EventEmitter implements WsLike {
  public readyState = 0;
  public sent: string[] = [];
  public closed: Array<{ code?: number; reason?: string }> = [];
  send(data: string, cb?: (err?: Error) => void) {
    this.sent.push(data);
    cb?.();
  }
  close(code?: number, reason?: string) {
    this.closed.push({ code, reason });
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.emit('open');
  }
  message(payload: unknown) {
    this.emit('message', typeof payload === 'string' ? payload : JSON.stringify(payload));
  }
}

function userMessage(orders: Array<Record<string, unknown>>, seq = 1, type: 'snapshot' | 'update' = 'update') {
  return {
    channel: 'user',
    client_id: '',
    timestamp: '2026-09-10T18:00:05Z',
    sequence_num: seq,
    events: [{ type, orders }],
  };
}

// ============================================================================
// Step 1 — hardened client
// ============================================================================

describe('AdvancedTradeRestClient — JWT (spec-exact)', () => {
  it('signs REST requests with header {alg,kid,nonce,typ}, claims {sub,iss,nbf,exp,uri}, no aud, uri without query', async () => {
    const mock = createMockFetch();
    mock.on('GET', '/api/v3/brokerage/orders/historical/batch', () => ({ status: 200, body: { orders: [], has_next: false, cursor: '' } }));
    const client = makeClient(mock, createLogger());

    const before = Math.floor(Date.now() / 1000);
    await client.listOrders({ order_status: ['OPEN'], cursor: 'abc', product_id: 'ETH-USD' });
    const after = Math.floor(Date.now() / 1000);

    expect(mock.calls).toHaveLength(1);
    const call = mock.calls[0];
    expect(call.query.getAll('order_status')).toEqual(['OPEN']);
    expect(call.query.get('cursor')).toBe('abc');
    expect(call.query.getAll('product_ids')).toEqual(['ETH-USD']);

    const authorization = call.headers.Authorization;
    expect(authorization).toMatch(/^Bearer /);
    const token = authorization.slice('Bearer '.length);
    const { header, claims, signature, signingInput } = decodeJwt(token);

    expect(header).toEqual({ alg: 'ES256', kid: KEY_NAME, nonce: expect.stringMatching(/^[0-9a-f]{32}$/), typ: 'JWT' });
    expect(Object.keys(claims).sort()).toEqual(['exp', 'iss', 'nbf', 'sub', 'uri']);
    expect(claims.sub).toBe(KEY_NAME);
    expect(claims.iss).toBe('cdp');
    expect(claims.nbf).toBeGreaterThanOrEqual(before);
    expect(claims.nbf).toBeLessThanOrEqual(after);
    expect(claims.exp).toBe(claims.nbf + 120);
    expect(claims.uri).toBe('GET api.coinbase.com/api/v3/brokerage/orders/historical/batch');
    expect(claims.aud).toBeUndefined();

    const valid = crypto.verify('sha256', Buffer.from(signingInput), { key: PUBLIC_KEY, dsaEncoding: 'ieee-p1363' }, signature);
    expect(valid).toBe(true);
    expect(signature).toHaveLength(64);
  });

  it('WebSocket JWTs omit the uri claim and each mint is unique (fresh nonce)', () => {
    const auth = loadAdvancedTradeAuth(KEY_NAME, PRIVATE_PEM);
    const a = decodeJwt(signAdvancedTradeJwt(auth));
    const b = decodeJwt(signAdvancedTradeJwt(auth));
    expect(a.claims.uri).toBeUndefined();
    expect(Object.keys(a.claims).sort()).toEqual(['exp', 'iss', 'nbf', 'sub']);
    expect(a.header.nonce).not.toBe(b.header.nonce);
    expect(crypto.verify('sha256', Buffer.from(a.signingInput), { key: PUBLIC_KEY, dsaEncoding: 'ieee-p1363' }, a.signature)).toBe(true);
  });

  it('fails closed on non-CDP key names and non-P-256 keys', () => {
    expect(() => loadAdvancedTradeAuth('legacy-hmac-key-id', PRIVATE_PEM)).toThrow(/not a CDP key name/);
    const ed = crypto.generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
    expect(() => loadAdvancedTradeAuth(KEY_NAME, ed)).toThrow(/P-256/);
    expect(() => loadAdvancedTradeAuth(KEY_NAME, 'not a pem')).toThrow(/PEM/);
    expect(() => new AdvancedTradeRestClient({ apiKey: 'bad', apiSecret: PRIVATE_PEM, environment: 'production' }, createLogger())).toThrow();
  });

  it('does not attach Authorization to public endpoints', async () => {
    const mock = createMockFetch();
    mock.on('GET', '/api/v3/brokerage/time', () => ({ status: 200, body: { iso: 'x', epochSeconds: '1', epochMillis: String(Date.now()) } }));
    const client = makeClient(mock, createLogger());
    await client.getServerTime();
    expect(mock.calls[0].headers.Authorization).toBeUndefined();
  });
});

describe('AdvancedTradeRestClient — orders', () => {
  it('createOrderRaw maps success:false to ok:false with the failure code (no throw)', async () => {
    const mock = createMockFetch();
    mock.on('POST', '/api/v3/brokerage/orders', () => ({
      status: 200,
      body: {
        success: false,
        error_response: {
          error: 'INSUFFICIENT_FUND',
          message: 'Insufficient balance in source account',
          error_details: '',
          preview_failure_reason: 'PREVIEW_INSUFFICIENT_FUND',
          new_order_failure_reason: 'INSUFFICIENT_FUND',
        },
        order_configuration: {},
      },
    }));
    const logger = createLogger();
    const client = makeClient(mock, logger);

    const result = await client.createOrderRaw({
      client_order_id: 'c-1',
      product_id: 'ETH-USD',
      side: 'BUY',
      order_configuration: { limit_limit_gtc: { base_size: '1', limit_price: '2000.00', post_only: false } },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('INSUFFICIENT_FUND');
      expect(result.message).toBe('Insufficient balance in source account');
      expect(result.previewFailureReason).toBe('PREVIEW_INSUFFICIENT_FUND');
      expect(result.newOrderFailureReason).toBe('INSUFFICIENT_FUND');
    }
  });

  it('createOrderRaw returns ok:true with exchange + client ids on success', async () => {
    const mock = createMockFetch();
    mock.on('POST', '/api/v3/brokerage/orders', (call) => ({
      status: 200,
      body: {
        success: true,
        success_response: { order_id: 'ex-42', product_id: 'ETH-USD', side: 'BUY', client_order_id: call.body.client_order_id },
      },
    }));
    const client = makeClient(mock, createLogger());
    const result = await client.createOrderRaw({
      client_order_id: 'c-42',
      product_id: 'ETH-USD',
      side: 'BUY',
      order_configuration: { market_market_ioc: { base_size: '0.01' } },
    });
    expect(result).toMatchObject({ ok: true, orderId: 'ex-42', clientOrderId: 'c-42' });
  });

  it('createOrderRaw treats HTTP 400 validation errors as business rejects, but throws on auth failures', async () => {
    const mock = createMockFetch();
    mock.on('POST', '/api/v3/brokerage/orders', () => ({ status: 400, body: { error: 'INVALID_ARGUMENT', code: 3, message: 'base_size is invalid' } }));
    const client = makeClient(mock, createLogger());
    const body = { client_order_id: 'c', product_id: 'ETH-USD', side: 'BUY' as const, order_configuration: {} };
    const rejected = await client.createOrderRaw(body);
    expect(rejected).toMatchObject({ ok: false, code: 'INVALID_ARGUMENT', message: 'base_size is invalid' });

    mock.reset();
    mock.on('POST', '/api/v3/brokerage/orders', () => ({ status: 401, body: { error: 'UNAUTHENTICATED', message: 'Unauthorized' } }));
    await expect(client.createOrderRaw(body)).rejects.toBeInstanceOf(CoinbaseApiError);
  });

  it('legacy createOrder throws instead of returning a synthesized pending order', async () => {
    const mock = createMockFetch();
    mock.on('POST', '/api/v3/brokerage/orders', () => ({
      status: 200,
      body: { success: false, error_response: { error: 'INSUFFICIENT_FUND', message: 'nope', new_order_failure_reason: 'INSUFFICIENT_FUND' } },
    }));
    const client = makeClient(mock, createLogger());
    await expect(
      client.createOrder({ product_id: 'ETH-USD', side: 'buy', type: 'limit', size: '1', price: '2000', client_oid: 'c-1' }),
    ).rejects.toMatchObject({ kind: 'order_rejected', coinbaseCode: 'INSUFFICIENT_FUND' });
  });

  it('previewOrder posts to /orders/preview without executing', async () => {
    const mock = createMockFetch();
    mock.on('POST', '/api/v3/brokerage/orders/preview', () => ({
      status: 200,
      body: { order_total: '2001.20', commission_total: '1.20', errs: [], warning: [], quote_size: '2000', base_size: '1', best_bid: '1999', best_ask: '2001' },
    }));
    const client = makeClient(mock, createLogger());
    const preview = await client.previewOrder({
      product_id: 'ETH-USD',
      side: 'BUY',
      order_configuration: { limit_limit_gtc: { base_size: '1', limit_price: '2000.00', post_only: false } },
    });
    expect(preview.commission_total).toBe('1.20');
    expect(preview.errs).toEqual([]);
    expect(mock.calls[0].path).toBe('/api/v3/brokerage/orders/preview');
    expect(mock.calls.some((c) => c.path === '/api/v3/brokerage/orders')).toBe(false);
  });

  it('cancelOrders returns a per-id outcome and never assumes success', async () => {
    const mock = createMockFetch();
    mock.on('POST', '/api/v3/brokerage/orders/batch_cancel', () => ({
      status: 200,
      body: { results: [{ success: true, failure_reason: 'UNKNOWN_CANCEL_FAILURE_REASON', order_id: 'a' }, { success: false, failure_reason: 'UNKNOWN_CANCEL_ORDER', order_id: 'b' }] },
    }));
    const client = makeClient(mock, createLogger());
    const results = await client.cancelOrders(['a', 'b', 'c']);
    expect(results).toEqual([
      { order_id: 'a', success: true, failure_reason: 'UNKNOWN_CANCEL_FAILURE_REASON' },
      { order_id: 'b', success: false, failure_reason: 'UNKNOWN_CANCEL_ORDER' },
      { order_id: 'c', success: false, failure_reason: 'NO_RESULT_RETURNED' },
    ]);
    expect(mock.calls[0].body).toEqual({ order_ids: ['a', 'b', 'c'] });
  });
});

describe('AdvancedTradeRestClient — pagination, products, retries, error hygiene', () => {
  it('getAccountsAll follows cursor while has_next (limit=250) and getAccounts sums available+hold exactly', async () => {
    const mock = createMockFetch();
    mock.on('GET', '/api/v3/brokerage/accounts', (call) => {
      if (!call.query.get('cursor')) {
        return { status: 200, body: { accounts: [{ uuid: 'u1', name: 'USD', currency: 'USD', available_balance: { value: '2.90', currency: 'USD' }, hold: { value: '0.10', currency: 'USD' } }], has_next: true, cursor: 'p2' } };
      }
      return { status: 200, body: { accounts: [{ uuid: 'u2', name: 'ETH', currency: 'ETH', available_balance: { value: '0.5', currency: 'ETH' }, hold: { value: '0', currency: 'ETH' } }], has_next: false, cursor: '' } };
    });
    const client = makeClient(mock, createLogger());
    const all = await client.getAccountsAll();
    expect(all.map((a) => a.currency)).toEqual(['USD', 'ETH']);
    expect(mock.calls).toHaveLength(2);
    expect(mock.calls[0].query.get('limit')).toBe('250');
    expect(mock.calls[1].query.get('cursor')).toBe('p2');

    const legacy = await client.getAccounts();
    expect(legacy[0]).toMatchObject({ currency: 'USD', available: '2.90', hold: '0.10', balance: '3.00' });
  });

  it('listFillsAll follows cursor until it is empty', async () => {
    const mock = createMockFetch();
    mock.on('GET', '/api/v3/brokerage/orders/historical/fills', (call) => {
      if (!call.query.get('cursor')) return { status: 200, body: { fills: [atFill({ trade_id: 't1' })], cursor: 'next' } };
      return { status: 200, body: { fills: [atFill({ trade_id: 't2' })], cursor: '' } };
    });
    const client = makeClient(mock, createLogger());
    const fills = await client.listFillsAll({ order_ids: ['ex-1'] });
    expect(fills.map((f) => f.trade_id)).toEqual(['t1', 't2']);
    expect(mock.calls[0].query.getAll('order_ids')).toEqual(['ex-1']);
    expect(mock.calls[1].query.get('cursor')).toBe('next');
  });

  it('getProduct returns real increments (no hard-coded specs)', async () => {
    const mock = createMockFetch();
    mock.on('GET', '/api/v3/brokerage/products', () => ({ status: 200, body: { ...ETH_PRODUCT, base_min_size: '0.00022', quote_increment: '0.01' } }));
    const client = makeClient(mock, createLogger());
    const product = await client.getProduct('ETH-USD');
    expect(product.base_min_size).toBe('0.00022');
    expect(product.base_increment).toBe('0.00000001');
    expect(mock.calls[0].path).toBe('/api/v3/brokerage/products/ETH-USD');
    const spec = toLiveProductSpec(product);
    expect(spec).toMatchObject({ symbol: 'ETH-USD', baseCurrency: 'ETH', quoteCurrency: 'USD', tradable: true, quoteMinSize: '1' });
  });

  it('retries 429 honouring Retry-After, then succeeds', async () => {
    const mock = createMockFetch();
    let attempts = 0;
    mock.on('GET', '/api/v3/brokerage/key_permissions', () => {
      attempts += 1;
      if (attempts === 1) return { status: 429, body: { error: 'RATE_LIMITED', message: 'slow down' }, headers: { 'Retry-After': '0' } };
      return { status: 200, body: { can_view: true, can_trade: true, can_transfer: false, portfolio_uuid: 'p', portfolio_type: 'DEFAULT' } };
    });
    const client = makeClient(mock, createLogger(), { maxRetries: 2 });
    const permissions = await client.getKeyPermissions();
    expect(permissions.can_trade).toBe(true);
    expect(mock.calls).toHaveLength(2);
    // Each attempt mints a fresh JWT.
    expect(mock.calls[0].headers.Authorization).not.toBe(mock.calls[1].headers.Authorization);
  });

  it('gives up after bounded 429 retries with a rate_limit error', async () => {
    const mock = createMockFetch();
    mock.on('GET', '/api/v3/brokerage/key_permissions', () => ({ status: 429, body: { message: 'slow down' }, headers: { 'Retry-After': '0' } }));
    const client = makeClient(mock, createLogger(), { maxRetries: 1 });
    await expect(client.getKeyPermissions()).rejects.toMatchObject({ kind: 'rate_limit', httpStatus: 429 });
    expect(mock.calls).toHaveLength(2);
  });

  it('maps network failures to CoinbaseNetworkError and retries idempotent GETs once', async () => {
    const mock = createMockFetch();
    let attempts = 0;
    mock.on('GET', '/api/v3/brokerage/accounts', async () => {
      attempts += 1;
      if (attempts === 1) throw Object.assign(new Error('fetch failed'), { code: 'ECONNRESET' });
      return { status: 200, body: { accounts: [], has_next: false, cursor: '' } };
    });
    const client = makeClient(mock, createLogger(), { maxRetries: 1 });
    await expect(client.getAccountsAll()).resolves.toEqual([]);

    mock.reset();
    mock.on('POST', '/api/v3/brokerage/orders', async () => {
      throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    });
    // POST is not retried by the client (idempotency is handled by the adapter via client_order_id).
    await expect(
      client.createOrderRaw({ client_order_id: 'c', product_id: 'ETH-USD', side: 'BUY', order_configuration: {} }),
    ).rejects.toBeInstanceOf(CoinbaseNetworkError);
    expect(mock.calls).toHaveLength(1);
  });

  it('never logs Authorization headers / JWTs on auth, network or business failures', async () => {
    const logger = createLogger();
    const mock = createMockFetch();
    mock.on('GET', '/api/v3/brokerage/key_permissions', () => ({ status: 401, body: { error: 'UNAUTHENTICATED', message: 'invalid signature' } }));
    mock.on('GET', '/api/v3/brokerage/accounts', async () => {
      throw new Error('getaddrinfo ENOTFOUND api.coinbase.com');
    });
    mock.on('POST', '/api/v3/brokerage/orders', () => ({ status: 200, body: { success: false, error_response: { error: 'INSUFFICIENT_FUND', message: 'nope' } } }));
    const client = makeClient(mock, logger, { maxRetries: 0 });

    const authError = await client.getKeyPermissions().catch((e) => e);
    await client.getAccountsAll().catch(() => undefined);
    await client.createOrderRaw({ client_order_id: 'c', product_id: 'ETH-USD', side: 'BUY', order_configuration: {} });

    expect(authError).toBeInstanceOf(CoinbaseApiError);
    expect(authError.kind).toBe('auth');
    expect(logger.error).toHaveBeenCalled();
    const serialised = JSON.stringify([logger.calls(), authError.toJSON(), authError.message]);
    expect(serialised).not.toContain('Bearer ');
    expect(serialised).not.toContain('eyJ'); // base64url JWT prefix
    expect(serialised).not.toContain('PRIVATE KEY');
    expect(serialised).toContain('UNAUTHENTICATED');
  });
});

// ============================================================================
// Step 2 — execution adapter
// ============================================================================

describe('CoinbaseAdvancedExecutionAdapter — order placement', () => {
  let mock: ReturnType<typeof createMockFetch>;
  let logger: ReturnType<typeof createLogger>;
  let adapter: CoinbaseAdvancedExecutionAdapter;
  let events: BrokerOrderEvent[];

  beforeEach(async () => {
    mock = createMockFetch();
    logger = createLogger();
    events = [];
    adapter = new CoinbaseAdvancedExecutionAdapter({
      logger,
      client: makeClient(mock, logger, { maxRetries: 0 }),
      symbols: ['ETH-USD'],
      productSpecs: { 'ETH-USD': ETH_SPEC },
      userStream: null,
      fillPollIntervalMs: 60_000,
    });
    adapter.onEvent((e) => events.push(e));
    await adapter.start();
  });

  afterEach(async () => {
    await adapter.stop();
  });

  it('rounds size DOWN to base_increment and price to quote_increment, sending strings', async () => {
    mock.on('POST', '/api/v3/brokerage/orders', (call) => ({
      status: 200,
      body: { success: true, success_response: { order_id: 'ex-1', client_order_id: call.body.client_order_id } },
    }));

    await adapter.placeOrder({
      clientOrderId: 'c-1',
      symbol: 'ETH-USD',
      side: 'buy',
      type: 'limit',
      price: 2469.554,
      quantity: 0.123456789,
      postOnly: true,
    });

    expect(mock.calls).toHaveLength(1);
    const body = mock.calls[0].body;
    expect(body).toEqual({
      client_order_id: 'c-1',
      product_id: 'ETH-USD',
      side: 'BUY',
      order_configuration: { limit_limit_gtc: { base_size: '0.12345678', limit_price: '2469.55', post_only: true } },
    });
    expect(typeof body.order_configuration.limit_limit_gtc.base_size).toBe('string');
    expect(typeof body.order_configuration.limit_limit_gtc.limit_price).toBe('string');
    expect(events.map((e) => e.type)).toEqual(['order_accepted']);
    expect(events[0]).toMatchObject({ clientOrderId: 'c-1', exchangeOrderId: 'ex-1' });
  });

  it('rejects below base_min_size locally with ZERO HTTP calls', async () => {
    await adapter.placeOrder({ ...LIMIT_REQUEST, quantity: 0.0001 });
    expect(mock.calls).toHaveLength(0);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'order_rejected', clientOrderId: 'c-1', code: 'BELOW_MIN_SIZE' });
  });

  it('rejects below quote_min_size notional and unknown / non-tradable products locally', async () => {
    await adapter.placeOrder({ ...LIMIT_REQUEST, clientOrderId: 'n', price: 1, quantity: 0.0005 });
    await adapter.placeOrder({ ...LIMIT_REQUEST, clientOrderId: 'u', symbol: 'DOGE-USD' });
    expect(mock.calls).toHaveLength(0);
    expect(events.map((e) => (e as OrderRejectedEvent).code)).toEqual(['BELOW_MIN_NOTIONAL', 'UNKNOWN_PRODUCT']);
  });

  it('success:false (INSUFFICIENT_FUND) ⇒ order_rejected with code and NO order_accepted', async () => {
    mock.on('POST', '/api/v3/brokerage/orders', () => ({
      status: 200,
      body: { success: false, error_response: { error: 'INSUFFICIENT_FUND', message: 'Insufficient balance', new_order_failure_reason: 'INSUFFICIENT_FUND' } },
    }));
    await adapter.placeOrder(LIMIT_REQUEST);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'order_rejected', clientOrderId: 'c-1', code: 'INSUFFICIENT_FUND', reason: 'Insufficient balance' });
    expect(events.some((e) => e.type === 'order_accepted')).toBe(false);
    expect(adapter.getHealth().pendingOrderCount).toBe(0);
  });

  it('retries a transport failure and a caller retry with the SAME clientOrderId — client_order_id is identical every time', async () => {
    let attempt = 0;
    mock.on('POST', '/api/v3/brokerage/orders', async (call) => {
      attempt += 1;
      if (attempt === 1) throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
      if (attempt === 2) return { status: 200, body: { success: false, error_response: { error: 'INSUFFICIENT_FUND', message: 'nope' } } };
      return { status: 200, body: { success: true, success_response: { order_id: 'ex-9', client_order_id: call.body.client_order_id } } };
    });

    await adapter.placeOrder(LIMIT_REQUEST); // transport retry → business reject
    await adapter.placeOrder(LIMIT_REQUEST); // caller retry → accepted

    const ids = mock.calls.map((c) => c.body.client_order_id);
    expect(ids).toEqual(['c-1', 'c-1', 'c-1']);
    expect(events.map((e) => e.type)).toEqual(['order_rejected', 'order_accepted']);
  });

  it('maps market buys (base_size or quoteSize metadata), stop orders and attached brackets to Advanced Trade shapes', async () => {
    mock.on('POST', '/api/v3/brokerage/orders', (call) => ({
      status: 200,
      body: { success: true, success_response: { order_id: `ex-${call.body.client_order_id}`, client_order_id: call.body.client_order_id } },
    }));
    adapter.updateMarketPrice('ETH-USD', 2469.55);

    await adapter.placeOrder({ clientOrderId: 'm1', symbol: 'ETH-USD', side: 'buy', type: 'market', quantity: 0.01 });
    await adapter.placeOrder({ clientOrderId: 'm2', symbol: 'ETH-USD', side: 'buy', type: 'market', quantity: 0.01, metadata: { quoteSize: '25.999' } });
    await adapter.placeOrder({ clientOrderId: 's1', symbol: 'ETH-USD', side: 'sell', type: 'stop', quantity: 0.5, price: 1900.004, stopPrice: 1910.006 });
    await adapter.placeOrder({
      clientOrderId: 'b1',
      symbol: 'ETH-USD',
      side: 'buy',
      type: 'limit',
      quantity: 0.5,
      price: 2000,
      metadata: { protection: { takeProfit: 2200.004, stopTrigger: 1900.006 } },
    });

    const [m1, m2, s1, b1] = mock.calls.map((c) => c.body);
    expect(m1.order_configuration).toEqual({ market_market_ioc: { base_size: '0.01000000' } });
    expect(m2.order_configuration).toEqual({ market_market_ioc: { quote_size: '25.99' } });
    expect(s1.side).toBe('SELL');
    expect(s1.order_configuration).toEqual({
      stop_limit_stop_limit_gtc: { base_size: '0.50000000', limit_price: '1900.00', stop_price: '1910.01', stop_direction: 'STOP_DIRECTION_STOP_DOWN' },
    });
    expect(b1.order_configuration).toEqual({ limit_limit_gtc: { base_size: '0.50000000', limit_price: '2000.00', post_only: false } });
    expect(b1.attached_order_configuration).toEqual({ trigger_bracket_gtc: { limit_price: '2200.00', stop_trigger_price: '1900.01' } });
    expect(b1.attached_order_configuration.trigger_bracket_gtc.base_size).toBeUndefined();
    expect(events.filter((e) => e.type === 'order_accepted')).toHaveLength(4);
  });

  it('guards spot sells against the available base balance when a lookup is wired', async () => {
    const guarded = new CoinbaseAdvancedExecutionAdapter({
      logger,
      client: makeClient(mock, logger, { maxRetries: 0 }),
      symbols: ['ETH-USD'],
      productSpecs: { 'ETH-USD': ETH_SPEC },
      userStream: null,
      baseBalanceLookup: async (currency) => (currency === 'ETH' ? '0.25' : null),
    });
    const guardedEvents: BrokerOrderEvent[] = [];
    guarded.onEvent((e) => guardedEvents.push(e));
    await guarded.start();
    await guarded.placeOrder({ ...LIMIT_REQUEST, clientOrderId: 'sell-1', side: 'sell', quantity: 0.5 });
    await guarded.stop();
    expect(mock.calls).toHaveLength(0);
    expect(guardedEvents[0]).toMatchObject({ type: 'order_rejected', code: 'INSUFFICIENT_BASE_BALANCE' });
  });
});

describe('CoinbaseAdvancedExecutionAdapter — fills, cancels, reconciliation', () => {
  let mock: ReturnType<typeof createMockFetch>;
  let logger: ReturnType<typeof createLogger>;
  let adapter: CoinbaseAdvancedExecutionAdapter;
  let events: BrokerOrderEvent[];

  const fills = () => events.filter((e): e is FillEvent => e.type === 'fill');

  beforeEach(async () => {
    mock = createMockFetch();
    logger = createLogger();
    events = [];
    mock.on('POST', '/api/v3/brokerage/orders', (call) => ({
      status: 200,
      body: { success: true, success_response: { order_id: 'ex-1', client_order_id: call.body.client_order_id } },
    }));
    adapter = new CoinbaseAdvancedExecutionAdapter({
      logger,
      client: makeClient(mock, logger, { maxRetries: 0 }),
      symbols: ['ETH-USD'],
      productSpecs: { 'ETH-USD': ETH_SPEC },
      userStream: null,
      fillPollIntervalMs: 60_000,
    });
    adapter.onEvent((e) => events.push(e));
    await adapter.start();
    await adapter.placeOrder(LIMIT_REQUEST);
    expect(events.map((e) => e.type)).toEqual(['order_accepted']);
  });

  afterEach(async () => {
    await adapter.stop();
  });

  const update = (cumulative: string, avg: string, fees: string, status = 'OPEN', seq = 1) => ({
    orderId: 'ex-1',
    clientOrderId: 'c-1',
    productId: 'ETH-USD',
    status,
    side: 'buy' as const,
    orderType: 'Limit',
    cumulativeQuantity: cumulative,
    leavesQuantity: '0',
    avgPrice: avg,
    totalFees: fees,
    postOnly: false,
    creationTime: '2026-09-10T18:00:00Z',
    eventType: 'update',
    sequenceNum: seq,
    timestamp: '2026-09-10T18:00:05Z',
    raw: {},
  });

  it('emits cumulative fill deltas 0 → 0.4 → 1.0 as two fills and ignores duplicates', () => {
    adapter.handleUserOrderUpdate(update('0', '0', '0'));
    adapter.handleUserOrderUpdate(update('0.4', '2000', '1'));
    adapter.handleUserOrderUpdate(update('0.4', '2000', '1')); // duplicate
    adapter.handleUserOrderUpdate(update('1.0', '2100', '2.5', 'FILLED'));
    adapter.handleUserOrderUpdate(update('1.0', '2100', '2.5', 'FILLED')); // duplicate terminal

    const emitted = fills();
    expect(emitted).toHaveLength(2);
    expect(emitted[0]).toMatchObject({ clientOrderId: 'c-1', exchangeOrderId: 'ex-1', size: 0.4, price: 2000, fee: 1, feeCurrency: 'USD', tradeId: 'ex-1:0.4' });
    expect(emitted[1].size).toBeCloseTo(0.6, 12);
    expect(emitted[1].fee).toBeCloseTo(1.5, 12);
    // (1.0 × 2100 − 0.4 × 2000) / 0.6 = 2166.67
    expect(emitted[1].price).toBeCloseTo(2166.6667, 3);
    expect(emitted[1].tradeId).toBe('ex-1:1.0');
    expect(events.filter((e) => e.type !== 'fill').map((e) => e.type)).toEqual(['order_accepted']);
    expect(adapter.getHealth().pendingOrderCount).toBe(0);
  });

  it('maps CANCELLED / FAILED stream statuses to order_canceled / order_rejected exactly once', () => {
    adapter.handleUserOrderUpdate(update('0', '0', '0', 'CANCELLED'));
    adapter.handleUserOrderUpdate(update('0', '0', '0', 'CANCELLED'));
    expect(events.map((e) => e.type)).toEqual(['order_accepted', 'order_canceled']);
  });

  it('merges REST fills without double counting quantity already surfaced by the stream', async () => {
    adapter.handleUserOrderUpdate(update('0.4', '2000', '1'));
    mock.on('GET', '/api/v3/brokerage/orders/historical/fills', () => ({
      status: 200,
      body: { fills: [atFill({ trade_id: 't1', size: '0.4', commission: '1.00' }), atFill({ trade_id: 't2', size: '0.6', price: '2100.00', commission: '1.50', liquidity_indicator: 'MAKER' })], cursor: '' },
    }));
    mock.on('GET', '/api/v3/brokerage/orders/historical/batch', () => ({
      status: 200,
      body: { orders: [atOrder({ status: 'FILLED', filled_size: '1.0', average_filled_price: '2060', total_fees: '2.50' })], has_next: false, cursor: '' },
    }));

    // Cancel attempt that the exchange refuses (already filled) → reconcile instead of emitting order_canceled.
    mock.on('POST', '/api/v3/brokerage/orders/batch_cancel', () => ({ status: 200, body: { results: [{ success: false, failure_reason: 'UNKNOWN_CANCEL_ORDER', order_id: 'ex-1' }] } }));
    mock.on('GET', '/api/v3/brokerage/orders/historical/ex-1', () => ({
      status: 200,
      body: { order: atOrder({ status: 'FILLED', filled_size: '1.0', average_filled_price: '2060', total_fees: '2.50' }) },
    }));
    await adapter.cancelOrder('c-1');

    const emitted = fills();
    expect(emitted).toHaveLength(2);
    expect(emitted[1]).toMatchObject({ tradeId: 't2', size: 0.6, price: 2100, fee: 1.5, liquidity: 'maker' });
    expect(events.some((e) => e.type === 'order_canceled')).toBe(false);
    expect(adapter.getHealth().pendingOrderCount).toBe(0);
  });

  it('emits order_canceled only when batch_cancel confirms success', async () => {
    mock.on('POST', '/api/v3/brokerage/orders/batch_cancel', () => ({ status: 200, body: { results: [{ success: true, failure_reason: 'UNKNOWN_CANCEL_FAILURE_REASON', order_id: 'ex-1' }] } }));
    await adapter.cancelOrder('c-1');
    expect(events.map((e) => e.type)).toEqual(['order_accepted', 'order_canceled']);
    expect(events[1]).toMatchObject({ clientOrderId: 'c-1', exchangeOrderId: 'ex-1' });
    expect(mock.calls.at(-1)?.body).toEqual({ order_ids: ['ex-1'] });

    // Second cancel is a no-op (terminal) and does not emit again.
    await adapter.cancelOrder('c-1');
    expect(events).toHaveLength(2);
  });

  it('cancelAllOrders cancels exchange-listed + tracked orders and emits for confirmed ids only', async () => {
    mock.on('GET', '/api/v3/brokerage/orders/historical/batch', () => ({
      status: 200,
      body: { orders: [atOrder({ order_id: 'ex-other', client_order_id: 'c-other' })], has_next: false, cursor: '' },
    }));
    mock.on('POST', '/api/v3/brokerage/orders/batch_cancel', (call) => ({
      status: 200,
      body: { results: call.body.order_ids.map((id: string) => ({ order_id: id, success: id !== 'ex-other', failure_reason: id === 'ex-other' ? 'UNKNOWN_CANCEL_ORDER' : '' })) },
    }));
    await adapter.cancelAllOrders('ETH-USD');
    const cancelCall = mock.calls.find((c) => c.path.endsWith('/batch_cancel'));
    expect(cancelCall?.body.order_ids.sort()).toEqual(['ex-1', 'ex-other']);
    expect(events.filter((e) => e.type === 'order_canceled').map((e) => e.clientOrderId)).toEqual(['c-1']);
  });

  it('poll fallback fetches fills + statuses for open orders on the configured cadence', async () => {
    vi.useFakeTimers();
    try {
      const polled = new CoinbaseAdvancedExecutionAdapter({
        logger,
        client: makeClient(mock, logger, { maxRetries: 0 }),
        symbols: ['ETH-USD'],
        productSpecs: { 'ETH-USD': ETH_SPEC },
        userStream: null,
        fillPollIntervalMs: 5_000,
      });
      const polledEvents: BrokerOrderEvent[] = [];
      polled.onEvent((e) => polledEvents.push(e));
      await polled.start();
      mock.calls.length = 0;
      await polled.placeOrder({ ...LIMIT_REQUEST, clientOrderId: 'p-1' });

      mock.on('GET', '/api/v3/brokerage/orders/historical/fills', () => ({
        status: 200,
        body: { fills: [atFill({ trade_id: 't-p', size: '1', price: '2000', commission: '2', order_id: 'ex-1' })], cursor: '' },
      }));
      mock.on('GET', '/api/v3/brokerage/orders/historical/batch', () => ({
        status: 200,
        body: { orders: [atOrder({ order_id: 'ex-1', client_order_id: 'p-1', status: 'FILLED', filled_size: '1' })], has_next: false, cursor: '' },
      }));

      await vi.advanceTimersByTimeAsync(5_000);

      const paths = mock.calls.map((c) => c.path);
      expect(paths).toContain('/api/v3/brokerage/orders/historical/fills');
      expect(paths).toContain('/api/v3/brokerage/orders/historical/batch');
      expect(mock.calls.find((c) => c.path.endsWith('/fills'))?.query.getAll('order_ids')).toEqual(['ex-1']);
      expect(polledEvents.map((e) => e.type)).toEqual(['order_accepted', 'fill']);
      expect(polledEvents[1]).toMatchObject({ tradeId: 't-p', size: 1, fee: 2 });

      // Nothing open any more → no further polling traffic.
      const before = mock.calls.length;
      await vi.advanceTimersByTimeAsync(5_000);
      expect(mock.calls.length).toBe(before);
      await polled.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('getOpenOrders / getFillsSince map exchange truth (commission→fee, liquidity, trade_id)', async () => {
    mock.on('GET', '/api/v3/brokerage/orders/historical/batch', (call) => {
      if (call.query.getAll('order_status').includes('OPEN')) {
        return { status: 200, body: { orders: [atOrder({ filled_size: '0.25' })], has_next: false, cursor: '' } };
      }
      return { status: 200, body: { orders: [], has_next: false, cursor: '' } };
    });
    mock.on('GET', '/api/v3/brokerage/orders/historical/fills', () => ({
      status: 200,
      body: { fills: [atFill({ trade_id: 'tr-7', commission: '0.42', liquidity_indicator: 'MAKER', side: 'SELL' })], cursor: '' },
    }));

    const open = await adapter.getOpenOrders();
    expect(open).toEqual([
      expect.objectContaining({ clientOrderId: 'c-1', exchangeOrderId: 'ex-1', symbol: 'ETH-USD', side: 'buy', type: 'limit', price: 2000, quantity: 1, filledQuantity: 0.25, status: 'open' }),
    ]);
    const statuses = mock.calls.filter((c) => c.path.endsWith('/historical/batch')).map((c) => c.query.getAll('order_status'));
    expect(statuses).toEqual([['OPEN'], ['PENDING', 'QUEUED', 'CANCEL_QUEUED']]);

    const since = Date.UTC(2026, 8, 10, 17, 0, 0);
    const records = await adapter.getFillsSince(since);
    expect(records).toEqual([
      expect.objectContaining({ tradeId: 'tr-7', orderId: 'ex-1', clientOrderId: 'c-1', symbol: 'ETH-USD', side: 'sell', fee: 0.42, feeCurrency: 'USD', liquidity: 'maker', price: 2000, size: 0.4 }),
    ]);
    expect(mock.calls.at(-1)?.query.get('start_sequence_timestamp')).toBe(new Date(since).toISOString());
  });
});

describe('CoinbaseAdvancedExecutionAdapter — stream racing the HTTP response', () => {
  it('emits exactly one order_accepted and keeps FILLED when the user stream beats POST /orders', async () => {
    const mock = createMockFetch();
    const logger = createLogger();
    let resolvePost!: (value: MockResponse) => void;
    mock.on('POST', '/api/v3/brokerage/orders', () => new Promise<MockResponse>((resolve) => { resolvePost = resolve; }));
    const adapter = new CoinbaseAdvancedExecutionAdapter({
      logger,
      client: makeClient(mock, logger, { maxRetries: 0 }),
      symbols: ['ETH-USD'],
      productSpecs: { 'ETH-USD': ETH_SPEC },
      userStream: null,
      fillPollIntervalMs: 60_000,
    });
    const events: BrokerOrderEvent[] = [];
    adapter.onEvent((e) => events.push(e));
    await adapter.start();

    const placing = adapter.placeOrder({ clientOrderId: 'c-race', symbol: 'ETH-USD', side: 'buy', type: 'market', quantity: 0.01 });
    await vi.waitFor(() => expect(mock.calls).toHaveLength(1));

    // Fast IOC fill arrives on the user stream before the HTTP response.
    adapter.handleUserOrderUpdate({
      orderId: 'ex-race',
      clientOrderId: 'c-race',
      productId: 'ETH-USD',
      status: 'FILLED',
      side: 'buy',
      orderType: 'Market',
      cumulativeQuantity: '0.01',
      leavesQuantity: '0',
      avgPrice: '2469.55',
      totalFees: '0.30',
      postOnly: false,
      creationTime: '2026-09-10T18:00:00Z',
      eventType: 'update',
      sequenceNum: 1,
      timestamp: '2026-09-10T18:00:00.050Z',
      raw: {},
    });
    expect(events.map((e) => e.type)).toEqual(['order_accepted', 'fill']);

    resolvePost({ status: 200, body: { success: true, success_response: { order_id: 'ex-race', client_order_id: 'c-race' } } });
    await placing;

    expect(events.map((e) => e.type)).toEqual(['order_accepted', 'fill']); // no duplicate accepted
    expect(events[0]).toMatchObject({ clientOrderId: 'c-race', exchangeOrderId: 'ex-race' });
    expect(adapter.getHealth().pendingOrderCount).toBe(0); // FILLED not regressed to pending
    await adapter.stop();
  });

  it('does not announce acceptance for an order whose first exchange status is FAILED', async () => {
    const mock = createMockFetch();
    const logger = createLogger();
    let resolvePost!: (value: MockResponse) => void;
    mock.on('POST', '/api/v3/brokerage/orders', () => new Promise<MockResponse>((resolve) => { resolvePost = resolve; }));
    const adapter = new CoinbaseAdvancedExecutionAdapter({
      logger,
      client: makeClient(mock, logger, { maxRetries: 0 }),
      symbols: ['ETH-USD'],
      productSpecs: { 'ETH-USD': ETH_SPEC },
      userStream: null,
      fillPollIntervalMs: 60_000,
    });
    const events: BrokerOrderEvent[] = [];
    adapter.onEvent((e) => events.push(e));
    await adapter.start();

    const placing = adapter.placeOrder({ ...LIMIT_REQUEST, clientOrderId: 'c-fail' });
    await vi.waitFor(() => expect(mock.calls).toHaveLength(1));
    adapter.handleUserOrderUpdate({
      orderId: 'ex-fail', clientOrderId: 'c-fail', productId: 'ETH-USD', status: 'FAILED', side: 'buy', orderType: 'Limit',
      cumulativeQuantity: '0', leavesQuantity: '0', avgPrice: '0', totalFees: '0', postOnly: false, rejectReason: 'INSUFFICIENT_FUNDS',
      creationTime: '', eventType: 'update', sequenceNum: 1, timestamp: '', raw: {},
    });
    resolvePost({ status: 200, body: { success: false, error_response: { error: 'INSUFFICIENT_FUND', message: 'nope' } } });
    await placing;

    expect(events.map((e) => e.type)).toEqual(['order_rejected']); // once, never accepted
    expect((events[0] as OrderRejectedEvent).code).toBe('INSUFFICIENT_FUNDS');
    await adapter.stop();
  });
});

describe('CoinbaseAdvancedExecutionAdapter — start() fail-closed on product specs', () => {
  it('refuses to start when a live symbol is missing or not tradable', async () => {
    const mock = createMockFetch();
    const logger = createLogger();
    mock.on('GET', '/api/v3/brokerage/products/ETH-USD', () => ({ status: 200, body: { ...ETH_PRODUCT, cancel_only: true } }));
    mock.on('GET', '/api/v3/brokerage/products/BTC-USD', () => ({ status: 200, body: { ...ETH_PRODUCT, product_id: 'BTC-USD', base_currency_id: 'BTC' } }));
    const adapter = new CoinbaseAdvancedExecutionAdapter({
      logger,
      client: makeClient(mock, logger, { maxRetries: 0 }),
      symbols: ['ETH-USD', 'BTC-USD', 'SOL-USD'],
      userStream: null,
    });
    await expect(adapter.start()).rejects.toThrow(new RegExp(`${LIVE_PRODUCT_UNAVAILABLE}.*missing: SOL-USD.*not tradable: ETH-USD`));
    expect(adapter.getHealth().ok).toBe(false);
    // Loaded specs are exchange truth, cached for order validation.
    expect(adapter.getProductSpec('BTC-USD')).toMatchObject({ symbol: 'BTC-USD', baseCurrency: 'BTC', tradable: true });
  });
});

// ============================================================================
// Step 3 — user stream
// ============================================================================

describe('AdvancedTradeUserStream', () => {
  let sockets: FakeWs[];
  let clock: number;
  let logger: ReturnType<typeof createLogger>;

  function makeStream(overrides: Partial<ConstructorParameters<typeof AdvancedTradeUserStream>[0]> = {}) {
    return new AdvancedTradeUserStream({
      logger,
      auth: loadAdvancedTradeAuth(KEY_NAME, PRIVATE_PEM),
      productIds: ['ETH-USD'],
      wsFactory: () => {
        const ws = new FakeWs();
        sockets.push(ws);
        return ws;
      },
      now: () => clock,
      random: () => 0.5, // jitter factor exactly 1.0
      reconnect: { baseDelayMs: 1_000, maxDelayMs: 8_000 },
      ...overrides,
    });
  }

  beforeEach(() => {
    vi.useFakeTimers();
    sockets = [];
    clock = 1_000_000;
    logger = createLogger();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('subscribes to user + heartbeats with fresh WebSocket JWTs (no uri claim) on open', async () => {
    const stream = makeStream();
    await stream.start();
    expect(sockets).toHaveLength(1);
    sockets[0].open();

    expect(sockets[0].sent).toHaveLength(2);
    const [user, heartbeats] = sockets[0].sent.map((s) => JSON.parse(s));
    expect(user).toMatchObject({ type: 'subscribe', channel: 'user', product_ids: ['ETH-USD'] });
    expect(heartbeats).toMatchObject({ type: 'subscribe', channel: 'heartbeats' });
    expect(user.jwt).not.toBe(heartbeats.jwt);
    for (const token of [user.jwt, heartbeats.jwt]) {
      const { header, claims, signature, signingInput } = decodeJwt(token);
      expect(header).toMatchObject({ alg: 'ES256', kid: KEY_NAME, typ: 'JWT' });
      expect(claims.uri).toBeUndefined();
      expect(claims.aud).toBeUndefined();
      expect(crypto.verify('sha256', Buffer.from(signingInput), { key: PUBLIC_KEY, dsaEncoding: 'ieee-p1363' }, signature)).toBe(true);
    }
    expect(stream.getHealth()).toMatchObject({ connected: true, degraded: false, reasonCodes: [] });
    await stream.stop();
  });

  it('normalises user channel orders and relays heartbeats', async () => {
    const stream = makeStream();
    const orders: any[] = [];
    stream.on('order', (u) => orders.push(u));
    await stream.start();
    sockets[0].open();
    sockets[0].message(
      userMessage(
        [{ order_id: 'ex-1', client_order_id: 'c-1', product_id: 'ETH-USD', status: 'OPEN', order_side: 'BUY', order_type: 'Limit', cumulative_quantity: '0.4', leaves_quantity: '0.6', avg_price: '2000', total_fees: '1', post_only: 'true' }],
        7,
        'snapshot',
      ),
    );
    sockets[0].message({ channel: 'heartbeats', client_id: '', timestamp: 'x', sequence_num: 8, events: [{ current_time: 'x', heartbeat_counter: '3049' }] });

    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({ orderId: 'ex-1', clientOrderId: 'c-1', status: 'OPEN', side: 'buy', cumulativeQuantity: '0.4', avgPrice: '2000', totalFees: '1', postOnly: true, eventType: 'snapshot', sequenceNum: 7 });
    expect(stream.getHealth().lastHeartbeatAt).toBe(clock);
    await stream.stop();
  });

  it('flags USER_STREAM_STALE after 15s without messages, and the adapter reports it as degraded', async () => {
    const stream = makeStream();
    const mock = createMockFetch();
    const adapter = new CoinbaseAdvancedExecutionAdapter({
      logger,
      client: makeClient(mock, logger, { maxRetries: 0 }),
      symbols: ['ETH-USD'],
      productSpecs: { 'ETH-USD': ETH_SPEC },
      userStream: stream,
      fillPollIntervalMs: 60_000,
    });
    await adapter.start();
    sockets[0].open();
    expect(adapter.getHealth()).toMatchObject({ ok: true, degraded: false });

    clock += 16_000;
    await vi.advanceTimersByTimeAsync(2_500);
    expect(stream.getHealth()).toMatchObject({ stale: true, degraded: true, reasonCodes: [USER_STREAM_STALE] });
    expect(adapter.getHealth()).toMatchObject({ ok: false, degraded: true, reasonCodes: [USER_STREAM_STALE] });

    // Any message clears staleness.
    sockets[0].message({ channel: 'heartbeats', sequence_num: 1, events: [{ heartbeat_counter: '1' }] });
    expect(adapter.getHealth()).toMatchObject({ ok: true, degraded: false });
    await adapter.stop();
  });

  it('reconnects with backoff after close and triggers REST reconciliation on reconnect', async () => {
    const stream = makeStream();
    const mock = createMockFetch();
    mock.on('POST', '/api/v3/brokerage/orders', (call) => ({
      status: 200,
      body: { success: true, success_response: { order_id: 'ex-1', client_order_id: call.body.client_order_id } },
    }));
    mock.on('GET', '/api/v3/brokerage/orders/historical/fills', () => ({ status: 200, body: { fills: [], cursor: '' } }));
    mock.on('GET', '/api/v3/brokerage/orders/historical/batch', () => ({ status: 200, body: { orders: [atOrder({})], has_next: false, cursor: '' } }));
    const adapter = new CoinbaseAdvancedExecutionAdapter({
      logger,
      client: makeClient(mock, logger, { maxRetries: 0 }),
      symbols: ['ETH-USD'],
      productSpecs: { 'ETH-USD': ETH_SPEC },
      userStream: stream,
      fillPollIntervalMs: 60_000,
    });
    const lifecycle: string[] = [];
    for (const name of ['connected', 'disconnected', 'reconnecting', 'reconnected']) {
      stream.on(name, () => lifecycle.push(name));
    }
    await adapter.start();
    sockets[0].open();
    await adapter.placeOrder(LIMIT_REQUEST);
    mock.calls.length = 0;

    sockets[0].emit('close', 1006);
    expect(stream.getHealth()).toMatchObject({ connected: false, reconnecting: true, reconnectAttempts: 1 });
    expect(sockets).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1_000); // base delay × jitter(1.0)
    expect(sockets).toHaveLength(2);
    sockets[1].open();
    await vi.advanceTimersByTimeAsync(0);

    expect(lifecycle).toEqual(['connected', 'disconnected', 'reconnecting', 'connected', 'reconnected']);
    expect(sockets[1].sent).toHaveLength(2); // re-subscribed with fresh JWTs
    expect(mock.calls.map((c) => c.path)).toEqual(['/api/v3/brokerage/orders/historical/fills', '/api/v3/brokerage/orders/historical/batch']);
    expect(stream.getHealth()).toMatchObject({ connected: true, totalReconnects: 1, reconnectAttempts: 0 });
    await adapter.stop();
  });

  it('never leaks JWTs into logs even when the server rejects authentication', async () => {
    const stream = makeStream();
    await stream.start();
    sockets[0].open();
    sockets[0].message({ type: 'error', message: 'authentication failure' });
    const serialised = JSON.stringify(logger.calls());
    expect(serialised).toContain('authentication failure');
    expect(serialised).not.toContain('eyJ');
    expect(serialised).not.toContain('Bearer ');
    expect(stream.getHealth().reconnecting).toBe(true);
    await stream.stop();
  });
});

// ============================================================================
// Step 4 — factory fail-closed
// ============================================================================

describe('createAdapters — live fails closed without Advanced Trade', () => {
  const logger = createLogger();
  const fakeExchange = {} as any;

  it('throws LIVE_REQUIRES_ADVANCED_TRADE for live + COINBASE_API_VERSION=exchange (and when unset)', () => {
    expect(() =>
      createAdapters({ executionMode: 'live', marketDataEnv: 'production', executionEnv: 'production', paperInitialEquityUsd: 0, feeModel: testFeeModel, coinbaseApiVersion: 'exchange' }, fakeExchange, logger),
    ).toThrow(new RegExp(LIVE_REQUIRES_ADVANCED_TRADE));
    expect(() =>
      createAdapters({ executionMode: 'live', marketDataEnv: 'production', executionEnv: 'production', paperInitialEquityUsd: 0, feeModel: testFeeModel }, fakeExchange, logger),
    ).toThrow(new RegExp(LIVE_REQUIRES_ADVANCED_TRADE));
  });

  it('throws LIVE_CREDENTIALS_MISSING for live + advanced without credentials', () => {
    expect(() =>
      createAdapters({ executionMode: 'live', marketDataEnv: 'production', executionEnv: 'production', paperInitialEquityUsd: 0, feeModel: testFeeModel, coinbaseApiVersion: 'advanced' }, fakeExchange, logger),
    ).toThrow(new RegExp(LIVE_CREDENTIALS_MISSING));
  });

  it('builds CoinbaseAdvancedExecutionAdapter for live + advanced + CDP credentials', () => {
    const mock = createMockFetch();
    const { executionAdapter, accountProvider } = createAdapters(
      {
        executionMode: 'live',
        marketDataEnv: 'production',
        executionEnv: 'production',
        paperInitialEquityUsd: 0,
        feeModel: testFeeModel,
        coinbaseApiVersion: 'advanced',
        liveCredentials: { apiKey: KEY_NAME, apiSecret: PRIVATE_PEM_ESCAPED },
        liveSymbols: ['ETH-USD'],
      },
      fakeExchange,
      logger,
      { advancedTradeClient: makeClient(mock, logger), userStream: null },
    );
    expect(executionAdapter).toBeInstanceOf(CoinbaseAdvancedExecutionAdapter);
    expect(executionAdapter.mode).toBe('live');
    expect(accountProvider).toBeDefined();
    expect(mock.calls).toHaveLength(0); // constructing never touches the network
  });

  it('leaves paper mode untouched', () => {
    const { executionAdapter } = createAdapters(
      { executionMode: 'paper', marketDataEnv: 'production', executionEnv: 'production', paperInitialEquityUsd: 50_000, feeModel: testFeeModel },
      fakeExchange,
      logger,
    );
    expect(executionAdapter).toBeInstanceOf(PaperExecutionAdapter);
  });

  it('parseEnvConfig picks up COINBASE_API_VERSION', () => {
    const previous = process.env.COINBASE_API_VERSION;
    try {
      process.env.COINBASE_API_VERSION = 'advanced';
      expect(parseEnvConfig().coinbaseApiVersion).toBe('advanced');
      process.env.COINBASE_API_VERSION = 'exchange';
      expect(parseEnvConfig().coinbaseApiVersion).toBe('exchange');
      delete process.env.COINBASE_API_VERSION;
      expect(parseEnvConfig().coinbaseApiVersion).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.COINBASE_API_VERSION;
      else process.env.COINBASE_API_VERSION = previous;
    }
  });
});
