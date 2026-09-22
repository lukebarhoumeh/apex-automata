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
  resolveFillTradeId,
  FILLS_UPSERT_ON_CONFLICT,
  FILL_ORDER_ID_MISSING,
  PAPER_TRADE_ID_PREFIX,
  FillRow,
  FillRowOrderRef,
} from '../persistence/fill-row';
import type { SessionStamp } from '../persistence/session-stamp';
import { PaperTradingSimulator } from '../trading/paper-trading-simulator';
import { FeeModel } from '../core/fee-model';
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

  it('carries every other column over unchanged from the previous inline writer (+ the fee_side pair, 2026-09-21)', () => {
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
      // Card SH-QMAKER-CFM-PAPER-v0 blocker 3: explicit attribution columns
      // (migration 20260921180000, written schema-tolerantly by server.ts).
      fee_side: 'maker',
      fee_side_source: 'exchange',
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

  it('keeps legacy edge-case semantics: undefined trade_id -> null, taker liquidity -> maker=false', () => {
    const order = { id: randomUUID(), exchangeOrderId: 'x' };
    const { trade_id: _omitted, ...fillWithoutTradeId } = legacyFill({ liquidity: 'T' });
    const row = buildFillRow({ userId: USER_ID, order, fill: fillWithoutTradeId });

    expect(row.trade_id).toBeNull();
    expect(row.maker).toBe(false);
    expect(row.fee_side).toBe('taker');
  });

  it('2026-09-21: an UNKNOWN liquidity is persisted as maker=null / fee_side=null, never coerced to taker', () => {
    const order = { id: randomUUID(), exchangeOrderId: 'x' };
    const { liquidity: _omitted, ...fillWithoutLiquidity } = legacyFill({});
    const row = buildFillRow({ userId: USER_ID, order, fill: fillWithoutLiquidity });

    expect(row.maker).toBeNull();
    expect(row.fee_side).toBeNull();
    expect(row.fee_side_source).toBeNull();
  });

  it('upsert conflict target is unchanged', () => {
    expect(FILLS_UPSERT_ON_CONFLICT).toBe('user_id,trade_id');
  });
});

/**
 * TASK_014 P3 — paper trade_id namespacing (soak audit 2026-09-22).
 *
 * `fills_user_trade_key UNIQUE (user_id, trade_id)` + upsert on that pair, while the
 * paper simulator's trade_id is `++fillSequence` (restarts at 1 every engine start).
 * Observed: session 9q7egp's fills 1–11 upserted OVER hkub8j's fills 1–11 → hkub8j
 * showed 18 filled orders / 5 fill rows, 3z950m 3 / 0. Paper ids must be unique
 * across sessions; live exchange ids must be untouched.
 */
describe('resolveFillTradeId / buildFillRow — P3: paper trade_id is namespaced per session', () => {
  const paperSession: SessionStamp = { sessionId: 'sess_1790091200890_9q7egp', executionMode: 'paper' };
  const priorPaperSession: SessionStamp = { sessionId: 'sess_1790017457369_hkub8j', executionMode: 'paper' };
  const liveSession: SessionStamp = { sessionId: 'sess_1790100000000_live01', executionMode: 'live' };

  /** Exact shape PaperTradingSimulator.recordFill emits (fee_side_source: 'simulated'). */
  function simulatorFill(seq: number, orderId: string): Fill {
    return legacyFill({
      trade_id: seq,
      order_id: orderId,
      liquidity: 'M',
      fee_side: 'maker',
      fee_side_source: 'simulated',
    } as Partial<Fill>);
  }

  it('paper session: trade_id becomes paper-<sessionId>-<seq>', () => {
    const order = { id: randomUUID() };
    const row = buildFillRow({ userId: USER_ID, order, fill: simulatorFill(7, order.id), session: paperSession });
    expect(row.trade_id).toBe(`${PAPER_TRADE_ID_PREFIX}-sess_1790091200890_9q7egp-7`);
  });

  it('the exact production collision: same seq in two paper sessions yields two distinct (user_id, trade_id) keys', () => {
    const orderA = { id: randomUUID() };
    const orderB = { id: randomUUID() };
    const rowA = buildFillRow({ userId: USER_ID, order: orderA, fill: simulatorFill(1, orderA.id), session: priorPaperSession });
    const rowB = buildFillRow({ userId: USER_ID, order: orderB, fill: simulatorFill(1, orderB.id), session: paperSession });

    expect(rowA.user_id).toBe(rowB.user_id);
    expect(rowA.trade_id).not.toBe(rowB.trade_id); // pre-fix both were '1' → rowB upserted over rowA
    expect(rowA.trade_id).toBe('paper-sess_1790017457369_hkub8j-1');
    expect(rowB.trade_id).toBe('paper-sess_1790091200890_9q7egp-1');
  });

  it('live session: exchange trade_id is written unchanged', () => {
    const order = { id: randomUUID(), exchangeOrderId: 'cb-exchange-order-9' };
    const row = buildFillRow({ userId: USER_ID, order, fill: legacyFill({ trade_id: 987654 }), session: liveSession });
    expect(row.trade_id).toBe('987654');
  });

  it('no session stamp but simulator marker present: falls back to the client order UUID namespace (never a bare seq)', () => {
    const order = { id: randomUUID() };
    const row = buildFillRow({ userId: USER_ID, order, fill: simulatorFill(17, order.id), session: null });
    expect(row.trade_id).toBe(`paper-${order.id}-17`);
  });

  it('no session stamp and no simulator marker (live-shaped): unchanged legacy behaviour', () => {
    const order = { id: randomUUID(), exchangeOrderId: 'cb-exchange-order-1' };
    const row = buildFillRow({ userId: USER_ID, order, fill: legacyFill({ trade_id: 42 }) });
    expect(row.trade_id).toBe('42');
  });

  it('an already-namespaced paper id passes through untouched (idempotent on replay)', () => {
    const order = { id: randomUUID() };
    const fill = { ...simulatorFill(3, order.id), trade_id: 'paper-sess_1790091200890_9q7egp-3' } as unknown as Fill;
    const row = buildFillRow({ userId: USER_ID, order, fill, session: paperSession });
    expect(row.trade_id).toBe('paper-sess_1790091200890_9q7egp-3');
  });

  it('null / undefined trade_id stays null in every mode', () => {
    const order = { id: randomUUID() };
    expect(resolveFillTradeId({ order, fill: { trade_id: null, fee_side_source: 'simulated' }, session: paperSession })).toBeNull();
    expect(resolveFillTradeId({ order, fill: {}, session: liveSession })).toBeNull();
  });

  it('paper session stamp also lands on the row (P5) alongside the namespaced id', () => {
    const order = { id: randomUUID() };
    const row = buildFillRow({ userId: USER_ID, order, fill: simulatorFill(2, order.id), session: paperSession });
    expect(row.session_id).toBe(paperSession.sessionId);
    expect(row.execution_mode).toBe('paper');
    expect(row.trade_id).toBe('paper-sess_1790091200890_9q7egp-2');
  });

  it('end-to-end: two real PaperTradingSimulator instances (two engine starts) emit the SAME raw trade_id; rows no longer collide', async () => {
    const logger: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const fees = new FeeModel({
      coinbase: { spot: { maker_bps: 25, taker_bps: 40 }, perps_intx: { maker_bps: 0, taker_bps: 5 } },
      hyperliquid: { perps: { maker_bps: -1.5, taker_bps: 4.5 } },
    });
    const buildSim = () =>
      new PaperTradingSimulator(
        {
          initialBalances: new Map([['USD', 100_000], ['ETH', 0]]),
          feeModel: fees,
          venue: 'coinbase',
          slippage: 0,
          latencyMs: 0,
          depthAware: false,
        },
        logger,
      );

    const firstFillOf = async (sim: PaperTradingSimulator, session: SessionStamp) => {
      const fills: Fill[] = [];
      sim.on('fill', (f: Fill) => fills.push(f));
      sim.updateMarketQuote('ETH-USD', { bid: 1999, ask: 2001, last: 2000 });
      const clientOrderId = randomUUID();
      await sim.placeOrder({ product_id: 'ETH-USD', side: 'buy', type: 'market', size: '0.1', client_oid: clientOrderId } as OrderRequest);
      expect(fills).toHaveLength(1);
      return { fill: fills[0], row: buildFillRow({ userId: USER_ID, order: { id: clientOrderId }, fill: fills[0], session }) };
    };

    const a = await firstFillOf(buildSim(), priorPaperSession);
    const b = await firstFillOf(buildSim(), paperSession);

    // The producer-side defect, pinned: both processes hand out trade_id 1.
    expect(a.fill.trade_id).toBe(1);
    expect(b.fill.trade_id).toBe(1);
    expect(a.fill.fee_side_source).toBe('simulated');

    // The persistence-side fix: distinct upsert keys, so session B cannot overwrite session A.
    expect(a.row.trade_id).toBe(`paper-${priorPaperSession.sessionId}-1`);
    expect(b.row.trade_id).toBe(`paper-${paperSession.sessionId}-1`);
    expect(`${a.row.user_id}|${a.row.trade_id}`).not.toBe(`${b.row.user_id}|${b.row.trade_id}`);
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
