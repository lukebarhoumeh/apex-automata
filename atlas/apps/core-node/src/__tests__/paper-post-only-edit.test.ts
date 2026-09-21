/**
 * Card SH-QMAKER-CFM-PAPER-v0 — blockers 1 + 2 on the canonical PAPER path.
 *
 * Blocker 1 (true post-only / no chase):
 *   - a post-only limit that would cross the spread is REJECTED
 *     (`POST_ONLY_WOULD_CROSS`), its price is never adjusted, nothing is retried;
 *   - a resting post-only limit later reached by the market fills as a MAKER at
 *     the limit price (fee_side = maker);
 *   - a NON post-only limit that crosses on placement fills as a TAKER at the
 *     touch (fee_side = taker) — never mislabelled maker;
 *   - `*-CDE` symbols: tick alignment (buy down / sell up), whole-contract lots,
 *     cost-plus fee legs stamped on the fill.
 *
 * Blocker 2 (edit > cancel+new):
 *   - `editOrder` re-quotes in place (same id), counts the edit, refuses a
 *     crossing edit on a post-only order and leaves it resting;
 *   - OrderManager: `noChase` makes a venue post-only rejection terminal, and
 *     `editOrder` uses the venue edit when present else an explicit cancel+new.
 *
 * Engine path: TradingEngine.createOrder() maps the simulator rejection to a
 * `paper_validation` rejection with the code, emits `order:rejected`, and
 * `editOrder()` works end-to-end in paper.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { PaperTradingSimulator, PaperTradingConfig, PaperOrderRejectedError } from '../trading/paper-trading-simulator';
import { OrderManager, OrderManagerConfig, ManagedOrder } from '../trading/order-manager';
import { TradingEngine, TradingEngineConfig } from '../trading/trading-engine';
import { FeeModel } from '../core/fee-model';
import type { FeesConfig } from '../config/loadGuardrails';
import type { CoinbaseExchange } from '../exchanges/coinbase';
import type { CoinbaseOrder, Fill, OrderRequest, Ticker } from '../exchanges/coinbase/types';
import type { Logger } from '../core/logger';

vi.mock('../config/secrets');
vi.mock('../exchanges/coinbase');

vi.mock('@supabase/supabase-js', () => {
  const FILTER_METHODS = ['eq', 'neq', 'is', 'in', 'gte', 'lte', 'gt', 'lt', 'order', 'limit'];
  const OP_METHODS = ['select', 'insert', 'upsert', 'update', 'delete'];
  function makeBuilder() {
    const builder: Record<string, unknown> = {};
    const resolve = () => ({ data: null, error: null });
    for (const name of FILTER_METHODS) builder[name] = () => builder;
    for (const op of OP_METHODS) builder[op] = () => builder;
    builder.maybeSingle = () => Promise.resolve(resolve());
    builder.single = () => Promise.resolve(resolve());
    builder.then = (onFulfilled?: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
      Promise.resolve(resolve()).then(onFulfilled, onRejected);
    return builder;
  }
  return { createClient: () => ({ from: () => makeBuilder() }) };
});

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;

const FEES: FeesConfig = {
  coinbase: {
    spot: { maker_bps: 25, taker_bps: 40 },
    perps_intx: { maker_bps: 0, taker_bps: 5 },
    cfm_nano: { maker_bps: 9.5, taker_bps: 10, exchange_fee_per_contract_usd: 0.1 },
  },
  hyperliquid: { perps: { maker_bps: -1.5, taker_bps: 4.5 } },
};

const BIP = 'BIP-20DEC30-CDE';

function buildSim(overrides: Partial<PaperTradingConfig> = {}): PaperTradingSimulator {
  const config: PaperTradingConfig = {
    initialBalances: new Map<string, number>([['USD', 100_000], ['BTC', 0], ['ETH', 0], ['BIP', 0]]),
    feeModel: new FeeModel(FEES),
    venue: 'coinbase',
    slippage: 0,
    latencyMs: 0,
    depthAware: false,
    contractSpecs: { [BIP]: { contractSize: 0.01, priceIncrementUsd: 5 } },
    ...overrides,
  };
  return new PaperTradingSimulator(config, logger);
}

function ticker(product_id: string, price: number, best_bid: number, best_ask: number): Ticker {
  return {
    type: 'ticker', sequence: 1, product_id, price: String(price), open_24h: '0', volume_24h: '0', low_24h: '0',
    high_24h: '0', volume_30d: '0', best_bid: String(best_bid), best_ask: String(best_ask), side: 'buy',
    time: new Date().toISOString(), trade_id: 1, last_size: '0.01',
  };
}

async function rejectionOf(promise: Promise<unknown>): Promise<PaperOrderRejectedError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(PaperOrderRejectedError);
    return error as PaperOrderRejectedError;
  }
  throw new Error('expected the promise to reject');
}

// ----------------------------------------------------------------------------
// Blocker 1 — simulator
// ----------------------------------------------------------------------------

describe('PaperTradingSimulator — true post-only (reject on cross, never chase)', () => {
  let sim: PaperTradingSimulator;
  const fills: Fill[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
    fills.length = 0;
    sim = buildSim();
    sim.on('fill', (f: Fill) => fills.push(f));
    sim.updateMarketQuote('ETH-USD', { bid: 2752.0, ask: 2752.5, last: 2752.3 });
  });

  it('post-only BUY at the ask (or through it) is rejected with POST_ONLY_WOULD_CROSS and never stored', async () => {
    for (const price of ['2752.50', '2760']) {
      const err = await rejectionOf(sim.placeOrder({ product_id: 'ETH-USD', side: 'buy', type: 'limit', size: '0.5', price, post_only: true }));
      expect(err.code).toBe('POST_ONLY_WOULD_CROSS');
      expect(err.details).toMatchObject({ side: 'buy', bid: 2752.0, ask: 2752.5 });
    }
    expect(sim.getOrders()).toHaveLength(0);
    expect(fills).toHaveLength(0);
    expect(sim.getOrderOpsStats().postOnlyRejected).toBe(2);
    expect(sim.getOrderOpsStats().placed).toBe(0);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('no chase'), expect.anything());
  });

  it('post-only SELL at the bid (or through it) is rejected symmetrically', async () => {
    const err = await rejectionOf(sim.placeOrder({ product_id: 'ETH-USD', side: 'sell', type: 'limit', size: '0.5', price: '2752.00', post_only: true }));
    expect(err.code).toBe('POST_ONLY_WOULD_CROSS');
    expect(sim.getOrders()).toHaveLength(0);
  });

  it('post-only BUY below the ask rests open, then fills as MAKER at the limit price when the ask comes down', async () => {
    const resp = await sim.placeOrder({ product_id: 'ETH-USD', side: 'buy', type: 'limit', size: '0.5', price: '2751.00', post_only: true });
    expect(resp.status).toBe('open');
    expect(resp.post_only).toBe(true);
    expect(fills).toHaveLength(0);

    sim.updateMarketQuote('ETH-USD', { bid: 2751.2, ask: 2751.4, last: 2751.3 }); // ask still above limit → no fill
    expect(fills).toHaveLength(0);

    sim.updateMarketQuote('ETH-USD', { bid: 2750.6, ask: 2751.0, last: 2750.8 }); // ask reaches the limit
    expect(fills).toHaveLength(1);
    const fill = fills[0];
    expect(fill.price).toBe('2751');
    expect(fill.liquidity).toBe('M');
    expect(fill.fee_side).toBe('maker');
    expect(fill.fee_side_source).toBe('simulated');
    expect(parseFloat(fill.fee)).toBeCloseTo(0.5 * 2751 * 0.0025, 6); // spot maker 25 bps
    expect(fill.exchange_fee).toBe('0');
    expect(sim.getOrder(resp.id)?.status).toBe('done');
    expect(sim.getOrderOpsStats()).toMatchObject({ placed: 1, filled: 1, makerFills: 1, takerFills: 0 });
  });

  it('NON post-only BUY that crosses on placement fills immediately as TAKER at the ask, not maker at the limit', async () => {
    const resp = await sim.placeOrder({ product_id: 'ETH-USD', side: 'buy', type: 'limit', size: '0.5', price: '2753.00', post_only: false });
    expect(resp.status).toBe('done');
    expect(fills).toHaveLength(1);
    const fill = fills[0];
    expect(fill.price).toBe('2752.5'); // the touch, better than the 2753 limit
    expect(fill.liquidity).toBe('T');
    expect(fill.fee_side).toBe('taker');
    expect(parseFloat(fill.fee)).toBeCloseTo(0.5 * 2752.5 * 0.004, 6); // spot taker 40 bps
    expect(sim.getOrderOpsStats().takerFills).toBe(1);
  });

  it('NON post-only SELL that crosses fills as TAKER at the bid; a passive sell rests and fills maker when the bid rises', async () => {
    const crossing = await sim.placeOrder({ product_id: 'ETH-USD', side: 'sell', type: 'limit', size: '0.1', price: '2751.00' });
    expect(crossing.status).toBe('done');
    expect(fills[0].price).toBe('2752');
    expect(fills[0].fee_side).toBe('taker');

    const passive = await sim.placeOrder({ product_id: 'ETH-USD', side: 'sell', type: 'limit', size: '0.1', price: '2755.00', post_only: true });
    expect(passive.status).toBe('open');
    sim.updateMarketQuote('ETH-USD', { bid: 2755.0, ask: 2755.5, last: 2755.2 });
    expect(fills).toHaveLength(2);
    expect(fills[1].price).toBe('2755');
    expect(fills[1].fee_side).toBe('maker');
  });

  it('market orders are always taker against the far side of the quote', async () => {
    await sim.placeOrder({ product_id: 'ETH-USD', side: 'buy', type: 'market', size: '0.1' });
    expect(fills[0].price).toBe('2752.5');
    expect(fills[0].fee_side).toBe('taker');
    await sim.placeOrder({ product_id: 'ETH-USD', side: 'sell', type: 'market', size: '0.1' });
    expect(fills[1].price).toBe('2752');
    expect(fills[1].fee_side).toBe('taker');
  });

  it('post-only with no quote yet is refused (fail closed) — a non post-only limit still rests', async () => {
    const err = await rejectionOf(sim.placeOrder({ product_id: 'SOL-USD', side: 'buy', type: 'limit', size: '1', price: '100', post_only: true }));
    expect(err.code).toBe('NO_MARKET_DATA');
    const resting = await sim.placeOrder({ product_id: 'SOL-USD', side: 'buy', type: 'limit', size: '1', price: '100' });
    expect(resting.status).toBe('open');
  });

  it('updateFromTicker uses best_bid/best_ask; updateMarketPrice collapses the spread to last', () => {
    sim.updateFromTicker(ticker('BTC-USD', 85901, 85900, 85902));
    expect(sim.getQuote('BTC-USD')).toEqual({ bid: 85900, ask: 85902, last: 85901 });
    sim.updateMarketPrice('BTC-USD', 85950);
    expect(sim.getQuote('BTC-USD')).toEqual({ bid: 85950, ask: 85950, last: 85950 });
    // crossed input falls back to last on both sides
    sim.updateMarketQuote('BTC-USD', { bid: 86000, ask: 85990, last: 85995 });
    expect(sim.getQuote('BTC-USD')).toEqual({ bid: 85995, ask: 85995, last: 85995 });
  });

  it('with a collapsed quote (legacy price-only feed) a post-only limit AT last is a cross; one tick below is passive', async () => {
    sim.updateMarketPrice('ETH-USD', 2752.0);
    const err = await rejectionOf(sim.placeOrder({ product_id: 'ETH-USD', side: 'buy', type: 'limit', size: '0.1', price: '2752.00', post_only: true }));
    expect(err.code).toBe('POST_ONLY_WOULD_CROSS');
    const ok = await sim.placeOrder({ product_id: 'ETH-USD', side: 'buy', type: 'limit', size: '0.1', price: '2751.99', post_only: true });
    expect(ok.status).toBe('open');
  });
});

describe('PaperTradingSimulator — *-CDE contract symbols (cost-plus fees, tick, lots)', () => {
  let sim: PaperTradingSimulator;
  const fills: Fill[] = [];

  beforeEach(() => {
    fills.length = 0;
    sim = buildSim();
    sim.on('fill', (f: Fill) => fills.push(f));
    sim.updateMarketQuote(BIP, { bid: 77715, ask: 77720, last: 77717 });
  });

  it('aligns a post-only buy DOWN to the $5 tick, rounds size down to whole contracts, and fills maker with stacked fee legs', async () => {
    // 0.105 BTC → 10 contracts (0.10 BTC); 77713 → 77710 (buy rounds down, stays passive)
    const resp = await sim.placeOrder({ product_id: BIP, side: 'buy', type: 'limit', size: '0.105', price: '77713', post_only: true });
    expect(resp.status).toBe('open');
    expect(resp.size).toBe('0.1');
    expect(resp.price).toBe('77710');

    sim.updateMarketQuote(BIP, { bid: 77705, ask: 77710, last: 77708 });
    expect(fills).toHaveLength(1);
    const fill = fills[0];
    expect(fill.fee_side).toBe('maker');
    expect(fill.contracts).toBe('10.00000000');
    // maker 9.5 bps × (0.1 × 77710 = 7771.0) = 7.38245 ; floor 10 × 0.10 = 1.00
    expect(fill.commission).toBe('7.38245000');
    expect(fill.exchange_fee).toBe('1.00000000');
    expect(parseFloat(fill.fee)).toBeCloseTo(8.38245, 8);
    expect(fill.usd_volume).toBe(String(0.1 * 77710));
  });

  it('aligns a sell UP to the tick; a crossing non post-only sell is a TAKER with the 10 bps leg + floor', async () => {
    // 77716 sell → 77720 tick-up; bid 77715 < 77720 so it rests (post-only would be fine too)
    const passive = await sim.placeOrder({ product_id: BIP, side: 'sell', type: 'limit', size: '0.02', price: '77716', post_only: true });
    expect(passive.price).toBe('77720');
    expect(passive.status).toBe('open');

    // crossing sell (no post-only) at 77700 → taker at the bid 77715
    const crossing = await sim.placeOrder({ product_id: BIP, side: 'sell', type: 'limit', size: '0.03', price: '77700' });
    expect(crossing.status).toBe('done');
    const fill = fills[0];
    expect(fill.fee_side).toBe('taker');
    expect(fill.price).toBe('77715');
    expect(fill.contracts).toBe('3.00000000');
    // taker 10 bps × (0.03 × 77715 = 2331.45) = 2.33145 ; floor 3 × 0.10 = 0.30
    expect(fill.commission).toBe('2.33145000');
    expect(fill.exchange_fee).toBe('0.30000000');
    expect(parseFloat(fill.fee)).toBeCloseTo(2.63145, 8);
  });

  it('post-only buy at the tick-aligned ask is a cross and is rejected (no chase down to the bid)', async () => {
    const err = await rejectionOf(sim.placeOrder({ product_id: BIP, side: 'buy', type: 'limit', size: '0.01', price: '77720', post_only: true }));
    expect(err.code).toBe('POST_ONLY_WOULD_CROSS');
    expect(sim.getOrders(BIP)).toHaveLength(0);
  });

  it('a size below one contract is refused with BELOW_MIN_CONTRACT', async () => {
    const err = await rejectionOf(sim.placeOrder({ product_id: BIP, side: 'buy', type: 'limit', size: '0.005', price: '77700', post_only: true }));
    expect(err.code).toBe('BELOW_MIN_CONTRACT');
  });

  it('the Luke 10-ct taker anchor: 0.10 BTC market buy @ ask 77715 → $7.7715 + $1.00 = $8.7715', async () => {
    sim.updateMarketQuote(BIP, { bid: 77710, ask: 77715, last: 77712 });
    await sim.placeOrder({ product_id: BIP, side: 'buy', type: 'market', size: '0.1' });
    expect(fills[0].commission).toBe('7.77150000');
    expect(fills[0].exchange_fee).toBe('1.00000000');
    expect(parseFloat(fills[0].fee)).toBeCloseTo(8.7715, 8);
  });

  it('spot symbols are unaffected by contract specs (no tick / lot rounding, no exchange leg)', async () => {
    sim.updateMarketQuote('BTC-USD', { bid: 85900, ask: 85902, last: 85901 });
    const resp = await sim.placeOrder({ product_id: 'BTC-USD', side: 'buy', type: 'limit', size: '0.00123', price: '85899.37', post_only: true });
    expect(resp.size).toBe('0.00123');
    expect(resp.price).toBe('85899.37');
  });
});

// ----------------------------------------------------------------------------
// Blocker 2 — in-place edit
// ----------------------------------------------------------------------------

describe('PaperTradingSimulator.editOrder — re-quote in place, refuse a crossing post-only edit', () => {
  let sim: PaperTradingSimulator;
  const fills: Fill[] = [];

  beforeEach(() => {
    fills.length = 0;
    sim = buildSim();
    sim.on('fill', (f: Fill) => fills.push(f));
    sim.updateMarketQuote('ETH-USD', { bid: 2752.0, ask: 2752.5, last: 2752.3 });
  });

  it('edits price and size on an open post-only order keeping the same id, and counts the edit', async () => {
    const placed = await sim.placeOrder({ product_id: 'ETH-USD', side: 'buy', type: 'limit', size: '0.5', price: '2750', post_only: true });
    const edited = await sim.editOrder(placed.id, { price: 2751.5, size: 0.4 });
    expect(edited.id).toBe(placed.id);
    expect(edited.price).toBe('2751.5');
    expect(edited.size).toBe('0.4');
    expect(edited.status).toBe('open');
    expect(sim.getOrder(placed.id)?.editCount).toBe(1);
    expect(sim.getOrderOpsStats()).toMatchObject({ placed: 1, edited: 1, cancelled: 0 });
    // still one order, no new id was minted
    expect(sim.getOrders('ETH-USD')).toHaveLength(1);
  });

  it('refuses an edit that would cross on a post-only order and leaves the order at its old price', async () => {
    const placed = await sim.placeOrder({ product_id: 'ETH-USD', side: 'buy', type: 'limit', size: '0.5', price: '2750', post_only: true });
    const err = await rejectionOf(sim.editOrder(placed.id, { price: 2752.5 }));
    expect(err.code).toBe('POST_ONLY_WOULD_CROSS');
    const order = sim.getOrder(placed.id)!;
    expect(order.price).toBe(2750);
    expect(order.status).toBe('open');
    expect(order.editCount).toBe(0);
    expect(sim.getOrderOpsStats().editRejected).toBe(1);
    expect(fills).toHaveLength(0);
  });

  it('an edit that makes a NON post-only order marketable executes as a taker at the touch', async () => {
    const placed = await sim.placeOrder({ product_id: 'ETH-USD', side: 'buy', type: 'limit', size: '0.5', price: '2750' });
    const edited = await sim.editOrder(placed.id, { price: 2753 });
    expect(edited.status).toBe('done');
    expect(fills[0].price).toBe('2752.5');
    expect(fills[0].fee_side).toBe('taker');
  });

  it('only open, unfilled limit orders are editable', async () => {
    const filled = await sim.placeOrder({ product_id: 'ETH-USD', side: 'buy', type: 'market', size: '0.1' });
    expect((await rejectionOf(sim.editOrder(filled.id, { price: 1 }))).code).toBe('ORDER_NOT_EDITABLE');
    expect((await rejectionOf(sim.editOrder('nope', { price: 1 }))).code).toBe('ORDER_NOT_EDITABLE');
    const open = await sim.placeOrder({ product_id: 'ETH-USD', side: 'buy', type: 'limit', size: '0.1', price: '2700' });
    expect((await rejectionOf(sim.editOrder(open.id, {}))).code).toBe('ORDER_NOT_EDITABLE');
    await sim.cancelOrder(open.id);
    expect((await rejectionOf(sim.editOrder(open.id, { price: 2701 }))).code).toBe('ORDER_NOT_EDITABLE');
    expect(sim.getOrderOpsStats().cancelled).toBe(1);
  });

  it('*-CDE edits obey tick and lot rules', async () => {
    sim.updateMarketQuote(BIP, { bid: 77715, ask: 77720, last: 77717 });
    const placed = await sim.placeOrder({ product_id: BIP, side: 'buy', type: 'limit', size: '0.05', price: '77700', post_only: true });
    const edited = await sim.editOrder(placed.id, { price: 77713, size: 0.087 });
    expect(edited.price).toBe('77710');
    expect(edited.size).toBe('0.08');
    expect((await rejectionOf(sim.editOrder(placed.id, { size: 0.004 }))).code).toBe('BELOW_MIN_CONTRACT');
  });
});

// ----------------------------------------------------------------------------
// OrderManager — no-chase + editOrder (live-shaped exchange doubles)
// ----------------------------------------------------------------------------

const omConfig: OrderManagerConfig = {
  supabaseUrl: 'http://localhost:54321',
  supabaseKey: 'test-key',
  defaultTimeInForce: 'GTC',
  maxOrderRetries: 1,
  postOnlyRetries: 3,
  twapConfig: { minSliceSize: 0.001, maxSliceSize: 0.01, sliceDuration: 1000, randomizeSize: false, randomizeTime: false },
};

class PostOnlyRejectingExchange extends EventEmitter {
  public calls: OrderRequest[] = [];
  public rejectFirstN: number;
  constructor(rejectFirstN: number) {
    super();
    this.rejectFirstN = rejectFirstN;
  }
  public async createOrder(request: OrderRequest): Promise<CoinbaseOrder> {
    this.calls.push({ ...request });
    if (this.calls.length <= this.rejectFirstN) {
      const err = new Error('post-only order would have been taker') as Error & { kind: string };
      err.kind = 'post_only';
      throw err;
    }
    return {
      id: `cb-${this.calls.length}`, product_id: request.product_id, side: request.side, type: request.type,
      created_at: new Date().toISOString(), fill_fees: '0', filled_size: '0', executed_value: '0', status: 'open',
      settled: false, size: request.size, price: request.price, post_only: request.post_only,
    } as CoinbaseOrder;
  }
  public async cancelOrder(): Promise<boolean> {
    return true;
  }
}

describe('OrderManager — noChase makes a venue post-only rejection terminal', () => {
  it('legacy: without noChase a post-only reject is re-priced 5 bps more passive and retried', async () => {
    const exchange = new PostOnlyRejectingExchange(1);
    const om = new OrderManager(omConfig, logger, exchange as unknown as CoinbaseExchange);
    const order = await om.createOrder({ product_id: 'ETH-USD', side: 'buy', type: 'limit', size: '0.1', price: '2752.50', post_only: true });
    expect(order.status).toBe('open');
    expect(exchange.calls).toHaveLength(2);
    expect(exchange.calls[0].price).toBe('2752.50');
    expect(parseFloat(exchange.calls[1].price!)).toBeCloseTo(2752.5 * 0.9995, 2); // legacy passive re-quote
    om.destroy();
  }, 10_000);

  it('noChase: the first post-only reject throws, the exchange is called exactly once, the price is untouched', async () => {
    const exchange = new PostOnlyRejectingExchange(1);
    const om = new OrderManager(omConfig, logger, exchange as unknown as CoinbaseExchange);
    const failed: ManagedOrder[] = [];
    om.on('order:failed', (o) => failed.push(o));

    await expect(
      om.createOrder(
        { product_id: BIP, side: 'buy', type: 'limit', size: '0.1', price: '77720', post_only: true },
        { noChase: true, strategy: 'system' },
      ),
    ).rejects.toThrow(/post-only/);

    expect(exchange.calls).toHaveLength(1);
    expect(exchange.calls[0].price).toBe('77720');
    expect(failed).toHaveLength(1);
    expect(failed[0].status).toBe('failed');
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('no chase'), expect.anything());
    om.destroy();
  });

  it('metadata.noChase === true is honoured the same way (router-friendly form)', async () => {
    const exchange = new PostOnlyRejectingExchange(1);
    const om = new OrderManager(omConfig, logger, exchange as unknown as CoinbaseExchange);
    await expect(
      om.createOrder({ product_id: BIP, side: 'buy', type: 'limit', size: '0.1', price: '77720', post_only: true }, { metadata: { noChase: true } }),
    ).rejects.toThrow(/post-only/);
    expect(exchange.calls).toHaveLength(1);
    om.destroy();
  });
});

describe('OrderManager.editOrder — venue edit when supported, explicit cancel+new otherwise', () => {
  it('uses exchange.editOrder and keeps the managed order id (viaEdit=true)', async () => {
    const exchange = new PostOnlyRejectingExchange(0) as PostOnlyRejectingExchange & {
      editOrder: (id: string, e: { price: string; size: string }) => Promise<boolean>;
    };
    const edits: Array<{ id: string; price: string; size: string }> = [];
    exchange.editOrder = async (id, e) => {
      edits.push({ id, ...e });
      return true;
    };
    const om = new OrderManager(omConfig, logger, exchange as unknown as CoinbaseExchange);
    const edited: ManagedOrder[] = [];
    om.on('order:edited', (o) => edited.push(o));

    const order = await om.createOrder({ product_id: BIP, side: 'buy', type: 'limit', size: '0.1', price: '77700', post_only: true });
    const result = await om.editOrder(order.id, { price: 77705 });

    expect(result.viaEdit).toBe(true);
    expect(result.order.id).toBe(order.id);
    expect(result.order.price).toBe(77705);
    expect(result.order.size).toBe(0.1);
    expect(edits).toEqual([{ id: 'cb-1', price: '77705', size: '0.1' }]); // both fields on the wire
    expect(edited).toHaveLength(1);
    expect(exchange.calls).toHaveLength(1); // no new order was placed
    om.destroy();
  });

  it('a refused venue edit throws and leaves the order unchanged', async () => {
    const exchange = new PostOnlyRejectingExchange(0) as PostOnlyRejectingExchange & { editOrder: () => Promise<boolean> };
    exchange.editOrder = async () => false;
    const om = new OrderManager(omConfig, logger, exchange as unknown as CoinbaseExchange);
    const order = await om.createOrder({ product_id: BIP, side: 'buy', type: 'limit', size: '0.1', price: '77700', post_only: true });
    await expect(om.editOrder(order.id, { price: 77705 })).rejects.toThrow(/refused edit/);
    expect(om.getOrder(order.id)?.price).toBe(77700);
    om.destroy();
  });

  it('falls back to an explicit cancel + new order when the exchange has no editOrder (viaEdit=false)', async () => {
    const exchange = new PostOnlyRejectingExchange(0);
    const om = new OrderManager(omConfig, logger, exchange as unknown as CoinbaseExchange);
    const cancelled: ManagedOrder[] = [];
    om.on('order:cancelled', (o) => cancelled.push(o));

    const order = await om.createOrder(
      { product_id: BIP, side: 'buy', type: 'limit', size: '0.1', price: '77700', post_only: true },
      { strategy: 'system', metadata: { tag: 'entry', postOnly: true, noChase: true } },
    );
    const result = await om.editOrder(order.id, { price: 77705, size: 0.2 });

    expect(result.viaEdit).toBe(false);
    expect(result.order.id).not.toBe(order.id);
    expect(result.order.price).toBe(77705);
    expect(result.order.size).toBe(0.2);
    expect(result.order.metadata).toMatchObject({ replacedOrderId: order.id, editFallback: 'cancel_replace', tag: 'entry' });
    expect(result.order.strategy).toBe('system');
    expect(cancelled.map((o) => o.id)).toEqual([order.id]);
    expect(om.getOrder(order.id)?.status).toBe('cancelled');
    expect(exchange.calls).toHaveLength(2);
    expect(exchange.calls[1].post_only).toBe(true); // replacement keeps post-only
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('edit_unsupported_fallback_cancel_replace'), expect.anything());
    om.destroy();
  });

  it('rejects edits of market orders, terminal orders and empty changes', async () => {
    const exchange = new PostOnlyRejectingExchange(0);
    const om = new OrderManager(omConfig, logger, exchange as unknown as CoinbaseExchange);
    const market = await om.createOrder({ product_id: 'ETH-USD', side: 'buy', type: 'market', size: '0.1' });
    await expect(om.editOrder(market.id, { price: 1 })).rejects.toThrow(/not a limit order/);
    const limit = await om.createOrder({ product_id: 'ETH-USD', side: 'buy', type: 'limit', size: '0.1', price: '2700' });
    await expect(om.editOrder(limit.id, {})).rejects.toThrow(/requires a new price/);
    await expect(om.editOrder('missing', { price: 1 })).rejects.toThrow(/not found/);
    om.destroy();
  });
});

// ----------------------------------------------------------------------------
// TradingEngine — paper path end to end
// ----------------------------------------------------------------------------

const guardrails = {
  disabled_strategies: ['vwap_mr', 'breakout', 'momentum'],
  account: { equity_usd: 10000, risk_per_trade: 0.005, max_open_positions: 4, max_account_leverage: 3.0, min_notional_buffer: 1.1 },
  fees: FEES,
  risk: { daily_loss_limit: -0.02, weekly_loss_limit: -0.05, max_drawdown_limit: -0.15, max_position_exposure_pct: 0.30, funding_cost_tolerance_bps: 20, slippage_estimate_bps: 3, min_ev_threshold: 0 },
  per_symbol: { 'ETH-USD': { max_notional_usd: 3000, max_daily_loss_usd: 200 }, 'BTC-USD': { max_notional_usd: 3000, max_daily_loss_usd: 200 } },
  cfm: { max_leverage: 2, execution: { order_type: 'post_only', no_chase: true, max_requotes_per_sec: 4 }, hours_gap: { entry_block_lead_min: 30, flatten_lead_min: 10 } },
  cfm_symbols: { [BIP]: { contract_size: 0.01, price_increment_usd: 5, spot_proxy: 'BTC-USD', max_notional_usd: 2000, max_daily_loss_usd: 100, disabled_strategies: ['trend_follow', 'momentum', 'vwap_mr', 'breakout'] } },
  strategy: { mode: 'momentum_futures', donchian_len: 20, ema_len_1h: 100, atr_len_15m: 20, atr_entry_band: [0.0005, 0.05], stop_init_atr: 1.5, stop_trail_atr: 1.0, time_stop_bars: 96, allow_short: true, trade_cooldown_min: 15 },
  execution: { order_type: 'marketable_limit', price_offset_ticks: 2, max_slippage_bps: 5, order_timeout_sec: 5, retry_backoff_ms: [100, 500, 1000, 5000, 30000] },
  circuit_breakers: { rapid_loss_trigger: -0.02, fill_rate_collapse: 0.1, adverse_selection_spike: 0.6, correlation_spike: 0.8, vol_spike_atr: 0.03, data_gap_sec: 30 },
  filters: { atr_volatility_min: 0.005, atr_volatility_max: 0.05, funding_bias_enabled: true, time_filter_enabled: false, allowed_hours_utc: [0] },
  compliance: { tax_method: 'FIFO', export_frequency_days: 7, log_level: 'INFO', audit_trail_enabled: true, flatten_on_shutdown: false },
  ui: { heartbeat_sec: 15, show_pnl_per_symbol: true, show_risk_status: true, kill_switch_button: true, alert_channels: ['telegram'] },
  go_live_criteria: { paper_parity_max_diff_bps: 20, min_profitable_days: 3, max_error_count_per_day: 0, manual_approval_required: true },
};

const engineConfig: TradingEngineConfig = {
  mode: 'paper',
  exchange: { name: 'coinbase', environment: 'production' },
  products: ['ETH-USD', 'BTC-USD'],
  supabase: { url: 'http://localhost:54321', serviceKey: 'test-key', anonKey: 'test-anon', userId: 'b7e8f9c2-4d6a-4c8b-9e2d-1a3b5c7d9e1f' },
  security: { encryptionKey: '00'.repeat(32) },
  guardrails: guardrails as unknown as TradingEngineConfig['guardrails'],
};

function wireEngine(): TradingEngine {
  const engine = new TradingEngine(engineConfig, logger);
  const e = engine as any;
  e.exchange = new EventEmitter();
  e.initializePaperSimulator();
  e.initializeOrderManager();
  e.initializePositionTracker();
  e.initializeRiskEngine();
  e.setupEventHandlers();
  e.isRunning = true;
  return engine;
}

function teardown(engine: TradingEngine): void {
  const e = engine as any;
  e.riskEngine?.stop?.();
  e.positionTracker?.stopUpdateLoop?.();
  e.orderManager?.destroy?.();
}

describe('TradingEngine paper path — post-only miss is attributable; edit works in place', () => {
  const previous = process.env.PAPER_DISABLE_SOFT_LAUNCH;
  let engine: TradingEngine;

  beforeEach(() => {
    process.env.PAPER_DISABLE_SOFT_LAUNCH = 'true';
    vi.clearAllMocks();
    engine = wireEngine();
    const e = engine as any;
    e.marketPrices.set(BIP, 77717);
    e.paperSimulator.updateMarketQuote(BIP, { bid: 77715, ask: 77720, last: 77717 });
    e.marketPrices.set('ETH-USD', 2752.3);
    e.paperSimulator.updateMarketQuote('ETH-USD', { bid: 2752.0, ask: 2752.5, last: 2752.3 });
  });

  afterEach(() => {
    teardown(engine);
    if (previous === undefined) delete process.env.PAPER_DISABLE_SOFT_LAUNCH;
    else process.env.PAPER_DISABLE_SOFT_LAUNCH = previous;
  });

  it('a post-only *-CDE entry that would cross returns null, records a coded paper_validation rejection and emits order:rejected', async () => {
    const rejected: Array<{ order: ManagedOrder; reason: string }> = [];
    engine.on('order:rejected', (order, reason) => rejected.push({ order, reason }));
    const created: ManagedOrder[] = [];
    engine.on('order:created', (o) => created.push(o));

    const order = await engine.createOrder(
      { product_id: BIP, side: 'buy', type: 'limit', size: '0.02', price: '77720', post_only: true },
      { strategy: 'system', metadata: { tag: 'entry', noChase: true } },
    );

    expect(order).toBeNull();
    const rejection = engine.getLastOrderRejection();
    expect(rejection).toMatchObject({ productId: BIP, side: 'buy', source: 'paper_validation', code: 'POST_ONLY_WOULD_CROSS' });
    expect(rejection!.reason).toMatch(/would cross/);
    // attempt was logged (created) and then surfaced as rejected — accept + miss both visible
    expect(created).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].order.id).toBe(created[0].id);
    expect(rejected[0].order.status).toBe('rejected');
    expect(rejected[0].order.metadata).toMatchObject({ rejectCode: 'POST_ONLY_WOULD_CROSS' });
    expect(engine.getActiveOrders()).toHaveLength(0);
    expect(engine.getOrderOpsStats().paper).toMatchObject({ postOnlyRejected: 1, placed: 0 });
  });

  it('a passive post-only *-CDE entry is accepted and rests; a later proxy tick fills it as MAKER with cost-plus legs', async () => {
    const fills: Fill[] = [];
    engine.on('order:filled', (_o, fill) => fills.push(fill));

    const order = await engine.createOrder(
      { product_id: BIP, side: 'buy', type: 'limit', size: '0.02', price: '77710', post_only: true },
      { strategy: 'system', metadata: { tag: 'entry', noChase: true } },
    );
    expect(order).not.toBeNull();
    expect(order!.status).toBe('open');
    expect(engine.getLastOrderRejection()).toBeNull();

    (engine as any).paperSimulator.updateMarketQuote(BIP, { bid: 77705, ask: 77710, last: 77708 });
    await new Promise((r) => setTimeout(r, 20));

    expect(fills).toHaveLength(1);
    expect(fills[0].fee_side).toBe('maker');
    expect(fills[0].fee_side_source).toBe('simulated');
    expect(fills[0].contracts).toBe('2.00000000');
    expect(fills[0].exchange_fee).toBe('0.20000000');
    expect(engine.getOrderOpsStats().paper).toMatchObject({ makerFills: 1, takerFills: 0 });
  });

  it('editOrder re-quotes a resting paper order in place and emits order:edited; a crossing edit is refused with a code', async () => {
    const edited: ManagedOrder[] = [];
    engine.on('order:edited', (o) => edited.push(o));

    const order = await engine.createOrder(
      { product_id: BIP, side: 'buy', type: 'limit', size: '0.02', price: '77700', post_only: true },
      { strategy: 'system', metadata: { tag: 'entry', noChase: true } },
    );
    expect(order).not.toBeNull();

    const result = await engine.editOrder(order!.id, { price: 77710 });
    expect(result).not.toBeNull();
    expect(result!.id).toBe(order!.id);
    expect(result!.price).toBe(77710);
    expect(result!.metadata?.editCount).toBe(1);
    expect(edited).toHaveLength(1);
    expect(engine.getOrderOpsStats()).toMatchObject({ edits: 1, editFallbackCancelReplace: 0 });
    expect(engine.getOrderOpsStats().paper).toMatchObject({ edited: 1 });

    const refused = await engine.editOrder(order!.id, { price: 77725 });
    expect(refused).toBeNull();
    expect(engine.getLastOrderRejection()).toMatchObject({ source: 'paper_validation', code: 'POST_ONLY_WOULD_CROSS', productId: BIP });
    expect(engine.getActiveOrders().find((o) => o.id === order!.id)?.price).toBe(77710);
  });

  it('spot marketable_limit entries (legacy profile) still go through and are now attributed TAKER, not maker', async () => {
    const fills: Fill[] = [];
    engine.on('order:filled', (_o, fill) => fills.push(fill));
    const order = await engine.createOrder(
      { product_id: 'ETH-USD', side: 'buy', type: 'limit', size: '0.1', price: (2752.3 * 1.0002).toFixed(2), post_only: false },
      { strategy: 'trend_follow', metadata: { tag: 'entry' } },
    );
    expect(order).not.toBeNull();
    await new Promise((r) => setTimeout(r, 20));
    expect(fills).toHaveLength(1);
    expect(fills[0].fee_side).toBe('taker');
    expect(fills[0].price).toBe('2752.5'); // the ask, not the +2 bps limit
  });
});
