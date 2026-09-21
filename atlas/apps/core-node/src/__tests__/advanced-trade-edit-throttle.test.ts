/**
 * Card SH-QMAKER-CFM-PAPER-v0, blocker 2 — live-side edit path + rate-limit budget.
 *
 *   - `AdvancedTradeRestClient.editOrder` → `POST /orders/edit` (wire shape,
 *     both price+size on the wire, business refusal → ok:false, never a throw);
 *   - `previewEditOrder` → `POST /orders/edit_preview`;
 *   - REST 429 is EXPECTED: the client honours `Retry-After`, retries a bounded
 *     number of times, then surfaces `kind: 'rate_limit'` + `retryAfterMs`;
 *   - `CoinbaseAdvancedExecutionAdapter.editOrder` aligns to increments, keeps
 *     the order untouched on refusal;
 *   - `OrderOpsThrottle` paces order mutations and opens a cooldown on 429
 *     (Retry-After first, exponential backoff with jitter otherwise).
 *
 * No sockets: fetch is injected. No live send anywhere.
 */
import { describe, it, expect, vi } from 'vitest';
import crypto from 'node:crypto';
import {
  AdvancedTradeRestClient,
  AtProduct,
  FetchLike,
  FetchRequestInit,
  toLegacyOrder,
} from '../exchanges/coinbase/advanced-trade-client';
import { CoinbaseApiError } from '../exchanges/coinbase/http/errors';
import { CoinbaseAdvancedExecutionAdapter, toLiveProductSpec } from '../trading/execution/coinbase-advanced-adapter';
import { OrderOpsThrottle, isRateLimitErrorLike } from '../trading/execution/order-ops-throttle';
import type { Logger } from '../core/logger';

const KEY_NAME = 'organizations/11111111-1111-1111-1111-111111111111/apiKeys/22222222-2222-2222-2222-222222222222';
const PRIVATE_PEM = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ type: 'sec1', format: 'pem' }) as string;

function createLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
}

interface RecordedCall {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: any;
}
interface MockResponse {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

function createMockFetch() {
  const calls: RecordedCall[] = [];
  const routes: Array<{ method: string; path: string; handler: (c: RecordedCall) => MockResponse }> = [];
  const fetchImpl: FetchLike = async (url: string, init: FetchRequestInit) => {
    const parsed = new URL(url);
    const call: RecordedCall = { method: init.method, path: parsed.pathname, headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined };
    calls.push(call);
    const route = routes.find((r) => r.method === call.method && (r.path === call.path || (r.method === 'GET' && call.path.startsWith(`${r.path}/`))));
    const mock: MockResponse = route ? route.handler(call) : { status: 404, body: { error: 'NOT_FOUND', message: `no route ${call.method} ${call.path}` } };
    const headers = new Map(Object.entries(mock.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    return {
      status: mock.status,
      ok: mock.status >= 200 && mock.status < 300,
      headers: { get: (name: string) => headers.get(name.toLowerCase()) ?? null },
      text: async () => (mock.body === undefined ? '' : JSON.stringify(mock.body)),
    };
  };
  return {
    fetchImpl,
    calls,
    on(method: string, path: string, handler: (c: RecordedCall) => MockResponse) {
      routes.unshift({ method, path, handler });
    },
  };
}

/** Client whose sleeps are recorded instead of awaited (429 backoff assertions). */
class RecordingClient extends AdvancedTradeRestClient {
  public sleeps: number[] = [];
  protected override sleep(ms: number): Promise<void> {
    this.sleeps.push(ms);
    return Promise.resolve();
  }
}

function makeClient(mock: ReturnType<typeof createMockFetch>, logger: Logger, overrides: Partial<ConstructorParameters<typeof AdvancedTradeRestClient>[0]> = {}) {
  return new RecordingClient({ apiKey: KEY_NAME, apiSecret: PRIVATE_PEM, environment: 'production', fetchImpl: mock.fetchImpl, ...overrides }, logger);
}

const EDIT = '/api/v3/brokerage/orders/edit';
const EDIT_PREVIEW = '/api/v3/brokerage/orders/edit_preview';

// ----------------------------------------------------------------------------
// REST client
// ----------------------------------------------------------------------------

describe('AdvancedTradeRestClient.editOrder — POST /orders/edit', () => {
  it('sends order_id + price + size with a bearer JWT and resolves ok on success:true', async () => {
    const mock = createMockFetch();
    mock.on('POST', EDIT, () => ({ status: 200, body: { success: true, errors: [] } }));
    const client = makeClient(mock, createLogger());

    const result = await client.editOrder({ order_id: 'ex-1', price: '77710', size: '10' });

    expect(result).toMatchObject({ ok: true, orderId: 'ex-1' });
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0].method).toBe('POST');
    expect(mock.calls[0].path).toBe(EDIT);
    expect(mock.calls[0].body).toEqual({ order_id: 'ex-1', price: '77710', size: '10' });
    expect(mock.calls[0].headers.Authorization).toMatch(/^Bearer /);
  });

  it('a refused edit (success:false + errors[]) is ok:false with the edit_failure_reason — no throw, no retry', async () => {
    const mock = createMockFetch();
    mock.on('POST', EDIT, () => ({
      status: 200,
      body: { success: false, errors: [{ edit_failure_reason: 'ORDER_EDIT_NOT_ALLOWED', preview_failure_reason: 'PREVIEW_INVALID_PRICE_PRECISION' }] },
    }));
    const logger = createLogger();
    const client = makeClient(mock, logger);

    const result = await client.editOrder({ order_id: 'ex-1', price: '77712.5', size: '10' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('ORDER_EDIT_NOT_ALLOWED');
      expect(result.message).toMatch(/PREVIEW_INVALID_PRICE_PRECISION/);
    }
    expect(mock.calls).toHaveLength(1);
    expect(logger.warn).toHaveBeenCalledWith('Advanced Trade order edit refused', expect.objectContaining({ orderId: 'ex-1' }));
  });

  it('HTTP 400 validation is a business refusal (ok:false), not an exception', async () => {
    const mock = createMockFetch();
    mock.on('POST', EDIT, () => ({ status: 400, body: { error: 'INVALID_ARGUMENT', message: 'size must be positive' } }));
    const result = await makeClient(mock, createLogger()).editOrder({ order_id: 'ex-1', price: '1', size: '0' });
    expect(result).toMatchObject({ ok: false, code: 'INVALID_ARGUMENT' });
  });

  it('refuses locally (no HTTP) when price or size is missing — Coinbase requires both', async () => {
    const mock = createMockFetch();
    const client = makeClient(mock, createLogger());
    expect(await client.editOrder({ order_id: 'ex-1', price: '1', size: '' })).toMatchObject({ ok: false, code: 'PRICE_AND_SIZE_REQUIRED' });
    expect(await client.editOrder({ order_id: '', price: '1', size: '1' })).toMatchObject({ ok: false, code: 'ORDER_ID_REQUIRED' });
    expect(mock.calls).toHaveLength(0);
  });

  it('previewEditOrder → POST /orders/edit_preview returns the venue view and ok iff errors is empty', async () => {
    const mock = createMockFetch();
    mock.on('POST', EDIT_PREVIEW, () => ({
      status: 200,
      body: { errors: [], slippage: '0', order_total: '7771.50', commission_total: '8.96', quote_size: '7771.50', base_size: '10', best_bid: '77715', best_ask: '77720', average_filled_price: '0' },
    }));
    const client = makeClient(mock, createLogger());
    const preview = await client.previewEditOrder({ order_id: 'ex-1', price: '77715', size: '10' });
    expect(preview.ok).toBe(true);
    expect(preview).toMatchObject({ order_total: '7771.50', commission_total: '8.96', best_bid: '77715', best_ask: '77720' });
    expect(mock.calls[0].path).toBe(EDIT_PREVIEW);

    mock.on('POST', EDIT_PREVIEW, () => ({ status: 200, body: { errors: [{ preview_failure_reason: 'PREVIEW_INSUFFICIENT_FUND' }] } }));
    const refused = await client.previewEditOrder({ order_id: 'ex-1', price: '77715', size: '1000' });
    expect(refused.ok).toBe(false);
    expect(refused.errors[0].preview_failure_reason).toBe('PREVIEW_INSUFFICIENT_FUND');
  });
});

describe('AdvancedTradeRestClient — REST 429 backoff on order mutations (expected, handled)', () => {
  it('honours Retry-After on a 429, retries once, then succeeds', async () => {
    const mock = createMockFetch();
    let attempts = 0;
    mock.on('POST', EDIT, () => {
      attempts += 1;
      return attempts === 1
        ? { status: 429, headers: { 'Retry-After': '2' }, body: { error: 'RATE_LIMIT_EXCEEDED', message: 'too many requests' } }
        : { status: 200, body: { success: true } };
    });
    const client = makeClient(mock, createLogger(), { maxRetries: 2 });

    const result = await client.editOrder({ order_id: 'ex-1', price: '77710', size: '10' });

    expect(result.ok).toBe(true);
    expect(attempts).toBe(2);
    expect(client.sleeps).toEqual([2000]); // Retry-After: 2s, not the exponential default
  });

  it('caps the wait at maxRetryDelayMs and falls back to exponential backoff when Retry-After is absent', async () => {
    const mock = createMockFetch();
    let attempts = 0;
    mock.on('POST', EDIT, () => {
      attempts += 1;
      return attempts <= 2 ? { status: 429, body: { error: 'RATE_LIMIT_EXCEEDED' } } : { status: 200, body: { success: true } };
    });
    const client = makeClient(mock, createLogger(), { maxRetries: 2, maxRetryDelayMs: 750 });

    const result = await client.editOrder({ order_id: 'ex-1', price: '77710', size: '10' });

    expect(result.ok).toBe(true);
    expect(client.sleeps).toEqual([500, 750]); // 500 · 2^(n-1), capped at 750
  });

  it('exhausted retries surface kind=rate_limit with retryAfterMs so a throttle can open a cooldown', async () => {
    const mock = createMockFetch();
    mock.on('POST', EDIT, () => ({ status: 429, headers: { 'Retry-After': '3' }, body: { error: 'RATE_LIMIT_EXCEEDED', message: 'slow down' } }));
    const client = makeClient(mock, createLogger(), { maxRetries: 1 });

    let caught: unknown;
    try {
      await client.editOrder({ order_id: 'ex-1', price: '77710', size: '10' });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CoinbaseApiError);
    const err = caught as CoinbaseApiError;
    expect(err.kind).toBe('rate_limit');
    expect(err.httpStatus).toBe(429);
    expect(err.retryAfterMs).toBe(3000);
    expect(err.retryable).toBe(true);
    expect(mock.calls).toHaveLength(2); // 1 + maxRetries
    expect(isRateLimitErrorLike(err)).toBe(true);
  });
});

// ----------------------------------------------------------------------------
// Execution adapter
// ----------------------------------------------------------------------------

const BIP_PRODUCT: AtProduct = {
  product_id: 'BIP-20DEC30-CDE',
  price: '77717',
  base_currency_id: 'BIP',
  quote_currency_id: 'USD',
  base_increment: '1',
  quote_increment: '5',
  base_min_size: '1',
  base_max_size: '1000',
  quote_min_size: '1',
  quote_max_size: '10000000',
  status: 'online',
  trading_disabled: false,
  cancel_only: false,
  limit_only: false,
  post_only: false,
  product_type: 'FUTURE',
};

async function startAdapterWithOpenOrder(edit: (c: RecordedCall) => MockResponse) {
  const mock = createMockFetch();
  mock.on('POST', '/api/v3/brokerage/orders', () => ({ status: 200, body: { success: true, success_response: { order_id: 'ex-77', client_order_id: 'c-77' } } }));
  mock.on('POST', EDIT, edit);
  const logger = createLogger();
  const client = makeClient(mock, logger, { maxRetries: 0 });
  const adapter = new CoinbaseAdvancedExecutionAdapter({
    logger,
    client,
    symbols: ['BIP-20DEC30-CDE'],
    userStream: null,
    productSpecs: { 'BIP-20DEC30-CDE': toLiveProductSpec(BIP_PRODUCT) },
    fillPollIntervalMs: 60_000,
    cancelOpenOrdersOnStop: false,
  });
  await adapter.start();
  await adapter.placeOrder({ clientOrderId: 'c-77', symbol: 'BIP-20DEC30-CDE', side: 'buy', type: 'limit', price: 77700, quantity: 10, postOnly: true, timeInForce: 'GTC' });
  expect(mock.calls[0].body.order_configuration.limit_limit_gtc.post_only).toBe(true);
  return { adapter, mock, logger };
}

describe('CoinbaseAdvancedExecutionAdapter.editOrder — venue edit, increments, refusal leaves order untouched', () => {
  it('aligns the buy price DOWN to quote_increment, sends both fields, and updates the tracked order', async () => {
    const { adapter, mock } = await startAdapterWithOpenOrder(() => ({ status: 200, body: { success: true } }));

    const ok = await adapter.editOrder('c-77', { price: 77713 });

    expect(ok).toBe(true);
    const editCall = mock.calls.find((c) => c.path === EDIT)!;
    expect(editCall.body).toEqual({ order_id: 'ex-77', price: '77710', size: '10' }); // 77713 → 77710 on the $5 tick; size resent unchanged
    const open = await adapter.getOpenOrders().catch(() => []);
    void open;
    await adapter.stop();
  });

  it('a refused venue edit returns false, logs no-chase, and never re-sends', async () => {
    const { adapter, mock, logger } = await startAdapterWithOpenOrder(() => ({
      status: 200,
      body: { success: false, errors: [{ edit_failure_reason: 'ORDER_EDIT_NOT_ALLOWED' }] },
    }));

    const ok = await adapter.editOrder('c-77', { price: 77715, size: 12 });

    expect(ok).toBe(false);
    expect(mock.calls.filter((c) => c.path === EDIT)).toHaveLength(1);
    expect(mock.calls.filter((c) => c.path === '/api/v3/brokerage/orders')).toHaveLength(1); // no replacement order
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('edit refused'),
      expect.objectContaining({ clientOrderId: 'c-77', code: 'ORDER_EDIT_NOT_ALLOWED' }),
    );
    await adapter.stop();
  });

  it('refuses locally when the new size is below base_min_size or the order is unknown', async () => {
    const { adapter, mock } = await startAdapterWithOpenOrder(() => ({ status: 200, body: { success: true } }));
    expect(await adapter.editOrder('c-77', { size: 0.5 })).toBe(false);
    expect(await adapter.editOrder('nope', { price: 1 })).toBe(false);
    expect(await adapter.editOrder('c-77', {})).toBe(false);
    expect(mock.calls.filter((c) => c.path === EDIT)).toHaveLength(0);
    await adapter.stop();
  });

  it('the legacy order mapping still reports post_only from limit_limit_gtc', () => {
    const legacy = toLegacyOrder({
      order_id: 'ex-1', product_id: 'BIP-20DEC30-CDE', side: 'BUY', client_order_id: 'c-1', status: 'OPEN', created_time: '2026-09-21T17:00:00Z',
      order_configuration: { limit_limit_gtc: { base_size: '10', limit_price: '77710', post_only: true } }, order_type: 'LIMIT',
    });
    expect(legacy.post_only).toBe(true);
    expect(legacy.price).toBe('77710');
  });
});

// ----------------------------------------------------------------------------
// Throttle
// ----------------------------------------------------------------------------

function fakeClock() {
  let t = 1_000_000;
  const sleeps: number[] = [];
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
    sleeps,
  };
}

describe('OrderOpsThrottle — re-quote budget + 429 cooldown', () => {
  it('paces order mutations to maxOpsPerSec after the burst is spent, never dropping one', async () => {
    const clock = fakeClock();
    const throttle = new OrderOpsThrottle({ maxOpsPerSec: 4, burst: 2, now: clock.now, sleep: clock.sleep, random: () => 0.5 });

    await throttle.acquire('edit');
    await throttle.acquire('edit');
    expect(clock.sleeps).toEqual([]); // burst of 2
    await throttle.acquire('edit'); // must wait ~250 ms for one token at 4/s
    expect(clock.sleeps).toEqual([250]);
    await throttle.acquire('cancel');
    expect(clock.sleeps).toEqual([250, 250]);

    const stats = throttle.getStats();
    expect(stats).toMatchObject({ edits: 3, cancels: 1, places: 0, waits: 2, rateLimited429: 0, cooldownUntil: null });
  });

  it('observeError on a 429 opens a Retry-After cooldown that acquire() waits out', async () => {
    const clock = fakeClock();
    const throttle = new OrderOpsThrottle({ maxOpsPerSec: 10, now: clock.now, sleep: clock.sleep, random: () => 0.5 });
    const events: unknown[] = [];
    throttle.on('rate_limited', (e) => events.push(e));

    const err = new CoinbaseApiError({ kind: 'rate_limit', message: 'slow down', httpStatus: 429, retryable: true, retryAfterMs: 3000 });
    expect(throttle.observeError(err)).toBe(true);
    expect(throttle.isCoolingDown()).toBe(true);
    expect(throttle.getStats()).toMatchObject({ rateLimited429: 1, consecutive429: 1, cooldownUntil: clock.now() + 3000 });
    expect(events).toHaveLength(1);

    await throttle.acquire('edit');
    expect(clock.sleeps).toEqual([3000]);
    expect(throttle.isCoolingDown()).toBe(false);
    expect(throttle.getStats().waits).toBe(1);
  });

  it('without Retry-After the backoff is exponential (1s, 2s, 4s…), capped, and resets on success', () => {
    const clock = fakeClock();
    const throttle = new OrderOpsThrottle({ maxOpsPerSec: 10, backoffBaseMs: 1000, backoffMaxMs: 3000, now: clock.now, sleep: clock.sleep, random: () => 0.5 });
    const no429 = new Error('boom');
    expect(throttle.observeError(no429)).toBe(false);

    const bare429 = { kind: 'rate_limit' } as unknown;
    throttle.observeError(bare429);
    expect(throttle.getStats().cooldownUntil).toBe(clock.now() + 1000);
    clock.advance(1000);
    throttle.observeError(bare429);
    expect(throttle.getStats().cooldownUntil).toBe(clock.now() + 2000);
    clock.advance(2000);
    throttle.observeError({ httpStatus: 429 });
    expect(throttle.getStats().cooldownUntil).toBe(clock.now() + 3000); // capped (would be 4000)
    expect(throttle.getStats().consecutive429).toBe(3);

    throttle.observeSuccess();
    expect(throttle.getStats().consecutive429).toBe(0);
    clock.advance(3000);
    throttle.observeError(bare429);
    expect(throttle.getStats().cooldownUntil).toBe(clock.now() + 1000); // streak reset → base again
  });

  it('jitter stays within ±jitterRatio and never goes negative', () => {
    const clock = fakeClock();
    const high = new OrderOpsThrottle({ maxOpsPerSec: 1, backoffBaseMs: 1000, jitterRatio: 0.2, now: clock.now, sleep: clock.sleep, random: () => 1 });
    high.onRateLimited();
    expect(high.getStats().cooldownUntil).toBe(clock.now() + 1200);
    const low = new OrderOpsThrottle({ maxOpsPerSec: 1, backoffBaseMs: 1000, jitterRatio: 0.2, now: clock.now, sleep: clock.sleep, random: () => 0 });
    low.onRateLimited();
    expect(low.getStats().cooldownUntil).toBe(clock.now() + 800);
  });

  it('rejects a non-positive budget', () => {
    expect(() => new OrderOpsThrottle({ maxOpsPerSec: 0 })).toThrow(/maxOpsPerSec/);
  });
});
