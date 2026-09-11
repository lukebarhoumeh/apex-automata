/**
 * TASK_014 defect P2 — `fills.order_id` FK mapping.
 *
 * `fills.order_id` references `orders.id` (the engine's client UUID). Live fills used
 * to be written with the exchange order id there, violating the FK and dropping every
 * live fill; `external_order_id` was never populated. These tests pin the writer to:
 *   order_id          = order.id            (client UUID)
 *   external_order_id = exchange order id   (fill.exchangeOrderId | fill.order_id | order.exchangeOrderId)
 *
 * No Supabase, no network: the mapping is pure. One case drives the real OrderManager
 * so the row is built from the exact `order:filled` shapes the engine emits.
 */

import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'events';
import { randomUUID } from 'node:crypto';
import {
  buildFillRow,
  resolveFillExternalOrderId,
  FILLS_UPSERT_ON_CONFLICT,
  FILL_ORDER_ID_MISSING,
  FillRow,
  FillRowOrderRef,
} from '../persistence/fill-row';
import { OrderManager, OrderManagerConfig, ManagedOrder } from '../trading/order-manager';
import type { CoinbaseExchange } from '../exchanges/coinbase';
import type { CoinbaseOrder, Fill, OrderRequest } from '../exchanges/coinbase/types';
import type { Logger } from '../core/logger';

const USER_ID = '00000000-0000-4000-8000-000000000001';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function legacyFill(overrides: Partial<Fill>): Fill {
  return {
    trade_id: 987654,
    product_id: 'ETH-USD',
    order_id: 'cb-exchange-order-1',
    user_id: 'u',
    profile_id: 'p',
    liquidity: 'T',
    price: '2000.50',
    size: '0.25',
    fee: '1.25',
    created_at: '2026-09-10T15:00:00.000Z',
    side: 'buy',
    settled: true,
    usd_volume: '500.125',
    ...overrides,
  };
}

describe('buildFillRow — P2: order_id is the client UUID, exchange id goes to external_order_id', () => {
  it('live-shaped legacy Coinbase fill: FK column gets order.id, never fill.order_id', () => {
    const clientOrderId = randomUUID();
    const order = { id: clientOrderId, exchangeOrderId: 'cb-exchange-order-1' };
    const fill = legacyFill({ order_id: 'cb-exchange-order-1' });

    const row = buildFillRow({ userId: USER_ID, order, fill });

    expect(row.order_id).toBe(clientOrderId);
    expect(row.order_id).toMatch(UUID_RE);
    expect(row.order_id).not.toBe(fill.order_id); // the exact P2 defect
    expect(row.external_order_id).toBe('cb-exchange-order-1');
  });

  it('carries every other column over unchanged from the previous inline writer', () => {
    const order = { id: randomUUID(), exchangeOrderId: 'cb-exchange-order-1' };
    const row = buildFillRow({ userId: USER_ID, order, fill: legacyFill({ liquidity: 'M' }) });

    const expected: FillRow = {
      user_id: USER_ID,
      order_id: order.id,
      external_order_id: 'cb-exchange-order-1',
      trade_id: '987654',
      price: 2000.5,
      quantity: 0.25,
      fee_currency: 'USD',
      fee_amount: 1.25,
      maker: true,
      filled_at: '2026-09-10T15:00:00.000Z',
    };
    expect(row).toEqual(expected);
    expect(Object.keys(row).sort()).toEqual(Object.keys(expected).sort()); // no extra columns sneak into the upsert
  });

  it('adapter FillEvent shape (TASK_010): external_order_id = fill.exchangeOrderId', () => {
    const order = { id: randomUUID(), exchangeOrderId: 'cb-exchange-order-2' };
    const fillEvent = {
      clientOrderId: order.id,
      exchangeOrderId: 'cb-exchange-order-2',
      trade_id: 'trade-abc',
      price: 2001,
      size: 1,
      fee: 0.5,
      liquidity: 'M',
      created_at: '2026-09-10T15:01:00.000Z',
    };

    const row = buildFillRow({ userId: USER_ID, order, fill: fillEvent });

    expect(row.order_id).toBe(order.id);
    expect(row.external_order_id).toBe('cb-exchange-order-2');
    expect(row.trade_id).toBe('trade-abc');
    expect(row.price).toBe(2001);
    expect(row.quantity).toBe(1);
  });

  it('falls back to the id OrderManager bound to the order when the fill carries none', () => {
    const order = { id: randomUUID(), exchangeOrderId: 'cb-exchange-order-3' };
    const row = buildFillRow({ userId: USER_ID, order, fill: legacyFill({ order_id: '' }) });

    expect(row.order_id).toBe(order.id);
    expect(row.external_order_id).toBe('cb-exchange-order-3');
  });

  it('paper-shaped fill (simulator echoes the client UUID as its order id): FK behaviour unchanged', () => {
    const clientOrderId = randomUUID();
    // trading-engine.ts sets managedOrder.exchangeOrderId = paperOrder.id, which the
    // simulator derives from client_oid — so both ids are the client UUID in paper.
    const order = { id: clientOrderId, exchangeOrderId: clientOrderId };
    const fill = legacyFill({ order_id: clientOrderId, trade_id: 7 });

    const row = buildFillRow({ userId: USER_ID, order, fill });

    expect(row.order_id).toBe(clientOrderId); // identical to the pre-P2 value in paper
    expect(row.external_order_id).toBe(clientOrderId);
    expect(row.trade_id).toBe('7');
  });

  it('external_order_id is null when no exchange id is known anywhere', () => {
    const order = { id: randomUUID() };
    const { order_id: _omitted, ...fillWithoutOrderId } = legacyFill({});
    const row = buildFillRow({ userId: USER_ID, order, fill: fillWithoutOrderId });

    expect(row.order_id).toBe(order.id);
    expect(row.external_order_id).toBeNull();
  });

  it('refuses to write a fill without a client order id instead of substituting the exchange id', () => {
    const fill = legacyFill({ order_id: 'cb-exchange-order-9' });
    const attempt = () => buildFillRow({ userId: USER_ID, order: { id: '' }, fill });

    expect(attempt).toThrow(new RegExp(`^${FILL_ORDER_ID_MISSING}:`));
    expect(attempt).toThrow(/cb-exchange-order-9/);
    // Runtime callers pass untyped objects; a missing order must still be refused.
    const noOrder = undefined as unknown as FillRowOrderRef;
    expect(() => buildFillRow({ userId: USER_ID, order: noOrder, fill })).toThrow(FILL_ORDER_ID_MISSING);
  });

  it('keeps legacy edge-case semantics: undefined trade_id -> null, non-maker liquidity -> maker=false', () => {
    const order = { id: randomUUID(), exchangeOrderId: 'x' };
    const { trade_id: _omitted, ...fillWithoutTradeId } = legacyFill({ liquidity: 'T' });
    const row = buildFillRow({ userId: USER_ID, order, fill: fillWithoutTradeId });

    expect(row.trade_id).toBeNull();
    expect(row.maker).toBe(false);
  });

  it('upsert conflict target is unchanged', () => {
    expect(FILLS_UPSERT_ON_CONFLICT).toBe('user_id,trade_id');
  });
});

describe('resolveFillExternalOrderId — priority order', () => {
  it('prefers fill.exchangeOrderId, then fill.order_id, then order.exchangeOrderId', () => {
    const fill = { price: '1', size: '1', exchangeOrderId: 'from-event', order_id: 'from-legacy' };
    expect(resolveFillExternalOrderId({ exchangeOrderId: 'from-order' }, fill)).toBe('from-event');
    expect(resolveFillExternalOrderId({ exchangeOrderId: 'from-order' }, { ...fill, exchangeOrderId: undefined })).toBe('from-legacy');
    expect(resolveFillExternalOrderId({ exchangeOrderId: 'from-order' }, { price: '1', size: '1' })).toBe('from-order');
    expect(resolveFillExternalOrderId({}, { price: '1', size: '1' })).toBeNull();
  });

  it('ignores empty strings and nulls', () => {
    expect(resolveFillExternalOrderId({ exchangeOrderId: null }, { price: '1', size: '1', exchangeOrderId: '', order_id: null })).toBeNull();
  });
});

// ----------------------------------------------------------------------------
// End-to-end through the real OrderManager: the exact (order, fill) pair the
// engine emits on `order:filled` for a live-style exchange (exchange id != client UUID).
// ----------------------------------------------------------------------------

class LiveLikeExchange extends EventEmitter {
  public async createOrder(request: OrderRequest): Promise<CoinbaseOrder> {
    const exchangeOrder = {
      id: 'cb-live-order-42',
      product_id: request.product_id,
      side: request.side,
      type: request.type,
      created_at: new Date().toISOString(),
      fill_fees: '0',
      filled_size: '0',
      executed_value: '0',
      status: 'open',
      settled: false,
      size: request.size,
      price: request.price,
      client_oid: request.client_oid,
    } as unknown as CoinbaseOrder;
    this.emit('order', exchangeOrder);
    return exchangeOrder;
  }

  public async cancelOrder(): Promise<boolean> {
    return true;
  }
}

const omConfig: OrderManagerConfig = {
  supabaseUrl: 'http://localhost:54321',
  supabaseKey: 'test-key',
  defaultTimeInForce: 'GTC',
  maxOrderRetries: 1,
  postOnlyRetries: 1,
  twapConfig: { minSliceSize: 0.001, maxSliceSize: 0.01, sliceDuration: 1000, randomizeSize: false, randomizeTime: false },
};

describe('order:filled → fills row (live-style exchange through the real OrderManager)', () => {
  it('builds a row whose order_id is the managed order UUID and external_order_id is the exchange id', async () => {
    const logger: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const exchange = new LiveLikeExchange();
    const orderManager = new OrderManager(omConfig, logger, exchange as unknown as CoinbaseExchange);

    const emitted: Array<{ order: ManagedOrder; fill: Fill }> = [];
    orderManager.on('order:filled', (order, fill) => emitted.push({ order, fill }));

    const managed = await orderManager.createOrder({ product_id: 'ETH-USD', side: 'buy', type: 'limit', size: '0.25', price: '2000' });
    expect(managed.id).toMatch(UUID_RE);
    expect(managed.exchangeOrderId).toBe('cb-live-order-42');

    exchange.emit('fill', legacyFill({ order_id: 'cb-live-order-42', size: '0.25' }));
    await new Promise((r) => setTimeout(r, 10));

    expect(emitted).toHaveLength(1);
    const { order, fill } = emitted[0];
    expect(fill.order_id).toBe('cb-live-order-42'); // what the old writer put in fills.order_id

    const row = buildFillRow({ userId: USER_ID, order, fill });
    expect(row.order_id).toBe(managed.id);
    expect(row.external_order_id).toBe('cb-live-order-42');
    expect(row.trade_id).toBe('987654');
    expect(row.quantity).toBe(0.25);

    orderManager.destroy();
  });
});

/**
 * TASK_014 P5 — optional session stamp on the fills row. The P2 invariant is
 * untouched: stamping only ADDS `session_id` / `execution_mode`.
 */
describe('buildFillRow — P5: optional session stamp', () => {
  const order = { id: randomUUID(), exchangeOrderId: 'cb-exchange-order-9' };
  const session = { sessionId: 'sess_1757606400000_ab12cd', executionMode: 'paper' as const };

  it('adds session_id + execution_mode when a session is supplied', () => {
    const row = buildFillRow({ userId: USER_ID, order, fill: legacyFill({ order_id: 'cb-exchange-order-9' }), session });

    expect(row.session_id).toBe(session.sessionId);
    expect(row.execution_mode).toBe('paper');
    expect(row.order_id).toBe(order.id);
    expect(row.external_order_id).toBe('cb-exchange-order-9');
  });

  it('builds the legacy shape (no stamp columns) when the session is omitted or null', () => {
    const plain = buildFillRow({ userId: USER_ID, order, fill: legacyFill({}) });
    const nulled = buildFillRow({ userId: USER_ID, order, fill: legacyFill({}), session: null });

    for (const row of [plain, nulled]) {
      expect(row).not.toHaveProperty('session_id');
      expect(row).not.toHaveProperty('execution_mode');
      expect(row.order_id).toBe(order.id);
    }
  });
});
