/**
 * `orders.position_id` linkage (P3 verification §0 follow-up, 2026-09-29).
 *
 * Pins:
 *   - PositionTracker threads the engine-side client order id (`orders.id`)
 *     from FillContext onto Trade.clientOrderId (absent when unknown);
 *   - OrderPositionLinker links each order once, after a confirmed positions
 *     write: entry on open, only the new order on scale-in, the exit order on
 *     close (then forgets the position);
 *   - ids the UPDATE did not return (order row not persisted yet) and failed
 *     UPDATEs are retried on the next write; a missing column disables the
 *     linker after one warn; trades without clientOrderId are never sent.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  OrderPositionLinker,
  createSupabaseOrderLinkUpdate,
  linkOrdersAfterPositionWrite,
  pendingOrderLinks,
} from '../persistence/order-position-link';
import { PositionTracker, type PositionTrackerConfig } from '../trading/position-tracker';
import type { Fill } from '../exchanges/coinbase';
import type { Logger } from '../core/logger';
import type { PostgrestErrorLike } from '../core/postgrest-errors';

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: () => ({
      select: () => ({ eq: () => ({ is: () => Promise.resolve({ data: [], error: null }) }) }),
      insert: () => Promise.resolve({ error: null }),
      upsert: () => Promise.resolve({ error: null }),
    }),
  }),
}));

const logger = { warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

function makeLinker(
  handler?: (positionId: string, orderIds: string[]) => { data: Array<{ id: string }> | null; error: PostgrestErrorLike | null },
  extra: { now?: () => number; logger?: typeof logger } = {},
) {
  const calls: Array<{ positionId: string; orderIds: string[] }> = [];
  const linker = new OrderPositionLinker({
    update: async (positionId, orderIds) => {
      calls.push({ positionId, orderIds });
      return handler ? handler(positionId, orderIds) : { data: orderIds.map((id) => ({ id })), error: null };
    },
    logger: extra.logger ?? logger,
    now: extra.now,
  });
  return { linker, calls };
}

const POS = 'aaaaaaaa-0000-4000-8000-000000000001';

describe('pendingOrderLinks', () => {
  it('returns distinct clientOrderIds not yet linked and ignores trades without one', () => {
    const position = { id: POS, trades: [{ clientOrderId: 'o1' }, { clientOrderId: 'o1' }, { clientOrderId: 'o2' }, {}, { clientOrderId: '' }] };
    expect(pendingOrderLinks(position)).toEqual(['o1', 'o2']);
    expect(pendingOrderLinks(position, new Set(['o1']))).toEqual(['o2']);
  });
});

describe('OrderPositionLinker.link', () => {
  it('open → scale-in → close: each order is linked exactly once and the position is forgotten on close', async () => {
    const { linker, calls } = makeLinker();

    const open = await linker.link({ id: POS, symbol: 'ETH-USD', trades: [{ clientOrderId: 'o-entry' }] });
    expect(open.linked).toEqual(['o-entry']);

    // Debounced ticker update: same trades, nothing new to link, no UPDATE.
    const tick = await linker.link({ id: POS, symbol: 'ETH-USD', trades: [{ clientOrderId: 'o-entry' }] });
    expect(tick.attempted).toEqual([]);
    expect(calls).toHaveLength(1);

    const scaleIn = await linker.link({ id: POS, symbol: 'ETH-USD', trades: [{ clientOrderId: 'o-entry' }, { clientOrderId: 'o-scale' }] });
    expect(scaleIn.linked).toEqual(['o-scale']);
    expect(calls[1]).toEqual({ positionId: POS, orderIds: ['o-scale'] });

    const close = await linker.link({
      id: POS,
      symbol: 'ETH-USD',
      closedAt: new Date(),
      trades: [{ clientOrderId: 'o-entry' }, { clientOrderId: 'o-scale' }, { clientOrderId: 'o-exit' }],
    });
    expect(close.linked).toEqual(['o-exit']);
    expect(linker.snapshot()).toEqual({ positions: 0, disabled: false });
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('an id the UPDATE did not return (order row not persisted yet) is retried on the next write', async () => {
    let returnAll = false;
    const { linker, calls } = makeLinker((_p, ids) => ({ data: returnAll ? ids.map((id) => ({ id })) : [], error: null }));

    const first = await linker.link({ id: POS, trades: [{ clientOrderId: 'o-entry' }] });
    expect(first.missing).toEqual(['o-entry']);
    expect(first.linked).toEqual([]);

    returnAll = true;
    const second = await linker.link({ id: POS, trades: [{ clientOrderId: 'o-entry' }] });
    expect(second.linked).toEqual(['o-entry']);
    expect(calls).toHaveLength(2);
  });

  it('a failed UPDATE is logged (never thrown) and retried on the first write after its backoff', async () => {
    let fail = true;
    let now = 0;
    const { linker, calls } = makeLinker((_p, ids) => (fail ? { data: null, error: { code: '08006', message: 'connection failure' } } : { data: ids.map((id) => ({ id })), error: null }), { now: () => now });

    const first = await linker.link({ id: POS, symbol: 'ETH-USD', trades: [{ clientOrderId: 'o-entry' }] });
    expect(first.error).toMatchObject({ code: '08006' });
    expect(logger.error).toHaveBeenCalledWith(expect.stringMatching(/position_id link write failed/), expect.objectContaining({ orderIds: ['o-entry'] }));

    fail = false;
    now = 1_000;
    const second = await linker.link({ id: POS, symbol: 'ETH-USD', trades: [{ clientOrderId: 'o-entry' }] });
    expect(second.linked).toEqual(['o-entry']);
    expect(calls).toHaveLength(2);
  });

  it('a thrown UPDATE is contained like an error result', async () => {
    const linker = new OrderPositionLinker({ update: async () => { throw new Error('fetch failed'); }, logger });
    const result = await linker.link({ id: POS, trades: [{ clientOrderId: 'o-entry' }] });
    expect(result.error).toEqual({ message: 'fetch failed' });
  });

  it('a missing position_id column disables the linker after one warn (pre-20251216000002 schema)', async () => {
    const { linker, calls } = makeLinker(() => ({ data: null, error: { code: 'PGRST204', message: "Could not find the 'position_id' column of 'orders' in the schema cache" } }));

    const first = await linker.link({ id: POS, trades: [{ clientOrderId: 'o-entry' }] });
    expect(first.disabled).toBe(true);
    expect(linker.disabled).toBe(true);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][0]).toMatch(/20251216000002/);

    const second = await linker.link({ id: POS, trades: [{ clientOrderId: 'o-entry' }] });
    expect(second.attempted).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it('trades without a clientOrderId (live fill not matched to a managed order) are never sent', async () => {
    const { linker, calls } = makeLinker();
    const result = await linker.link({ id: POS, trades: [{}, { clientOrderId: undefined }] });
    expect(result.attempted).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

describe('OrderPositionLinker.linkCounts (round 3, task G: /api/status persistence block)', () => {
  const POS_2 = 'aaaaaaaa-0000-4000-8000-000000000002';

  it('starts at zero, counts confirmed links cumulatively, and tracks ids awaiting retry as pending', async () => {
    let returnAll = false;
    const { linker } = makeLinker((_p, ids) => ({ data: returnAll ? ids.map((id) => ({ id })) : [], error: null }));
    expect(linker.linkCounts()).toEqual({ linked: 0, pending: 0, failed: 0, disabled: false });

    // Order row not persisted yet → pending, retried on the next write.
    await linker.link({ id: POS, symbol: 'ETH-USD', trades: [{ clientOrderId: 'o-entry' }] });
    expect(linker.linkCounts()).toEqual({ linked: 0, pending: 1, failed: 0, disabled: false });

    returnAll = true;
    await linker.link({ id: POS, symbol: 'ETH-USD', trades: [{ clientOrderId: 'o-entry' }, { clientOrderId: 'o-scale' }] });
    expect(linker.linkCounts()).toEqual({ linked: 2, pending: 0, failed: 0, disabled: false });

    // A second position: its pending set is counted alongside the first.
    returnAll = false;
    await linker.link({ id: POS_2, symbol: 'SOL-USD', trades: [{ clientOrderId: 'o-2a' }, { clientOrderId: 'o-2b' }] });
    expect(linker.linkCounts()).toEqual({ linked: 2, pending: 2, failed: 0, disabled: false });
  });

  it('a failed UPDATE on an open position is pending (retried), and ids still unlinked when the position closes are failed', async () => {
    let fail = true;
    const { linker } = makeLinker((_p, ids) => (fail ? { data: null, error: { code: '08006', message: 'connection failure' } } : { data: [], error: null }));

    await linker.link({ id: POS, symbol: 'ETH-USD', trades: [{ clientOrderId: 'o-entry' }] });
    expect(linker.linkCounts()).toEqual({ linked: 0, pending: 1, failed: 0, disabled: false });

    // Close write: UPDATE answers but RETURNING confirms nothing — the position is
    // forgotten, so those ids will never be retried: they are failed, not pending.
    fail = false;
    await linker.link({ id: POS, symbol: 'ETH-USD', closedAt: new Date(), trades: [{ clientOrderId: 'o-entry' }, { clientOrderId: 'o-exit' }] });
    expect(linker.linkCounts()).toEqual({ linked: 0, pending: 0, failed: 2, disabled: false });

    // Close write whose link UPDATE errors: same — terminal for that position.
    fail = true;
    await linker.link({ id: POS_2, symbol: 'SOL-USD', closedAt: new Date(), trades: [{ clientOrderId: 'o-2a' }] });
    expect(linker.linkCounts()).toEqual({ linked: 0, pending: 0, failed: 3, disabled: false });
  });

  it('a missing position_id column reports disabled and clears pending (nothing will ever be retried)', async () => {
    const { linker } = makeLinker(() => ({ data: null, error: { code: 'PGRST204', message: "Could not find the 'position_id' column of 'orders' in the schema cache" } }));
    await linker.link({ id: POS, trades: [{ clientOrderId: 'o-entry' }] });
    expect(linker.linkCounts()).toEqual({ linked: 0, pending: 0, failed: 0, disabled: true });
  });
});

describe('OrderPositionLinker backoff on a failing UPDATE (review finding 5)', () => {
  const CONNECTION_FAILURE = { code: '08006', message: 'connection failure' };
  const mkLogger = () => ({ warn: vi.fn(), error: vi.fn(), debug: vi.fn() });
  const openPosition = { id: POS, symbol: 'ETH-USD', trades: [{ clientOrderId: 'o-entry' }] };
  const failureLogs = (fn: ReturnType<typeof vi.fn>) => fn.mock.calls.filter((c) => /position_id link write failed/.test(String(c[0])));

  it('a permanently failing UPDATE is retried on a per-position exponential schedule (1 s·2^n, capped at 5 min), not on every ~1 s write', async () => {
    let now = 0;
    const log = mkLogger();
    const { linker, calls } = makeLinker(() => ({ data: null, error: CONNECTION_FAILURE }), { now: () => now, logger: log });

    // The debounced positions write fires every ~1 s for 30 min while the position is open.
    const attemptTimes: number[] = [];
    for (now = 0; now <= 30 * 60_000; now += 1_000) {
      const result = await linker.link(openPosition);
      if (result.attempted.length > 0) {
        attemptTimes.push(now);
        expect(result.error).toMatchObject({ code: '08006' });
      } else {
        // Inside the backoff window: nothing sent, still pending.
        expect(result).toMatchObject({ attempted: [], error: null, backedOff: true });
      }
      expect(linker.linkCounts()).toEqual({ linked: 0, pending: 1, failed: 0, disabled: false });
    }

    const gaps = attemptTimes.slice(1).map((t, i) => t - attemptTimes[i]);
    expect(gaps).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 64_000, 128_000, 256_000, 300_000, 300_000, 300_000, 300_000]);
    expect(calls).toHaveLength(14); // not ~1800

    // First failure logs an error; repeats log at debug, with an error every 10th so it never goes silent.
    const errors = failureLogs(log.error);
    expect(errors).toHaveLength(2);
    expect(errors[0][1]).toMatchObject({ positionId: POS, symbol: 'ETH-USD', orderIds: ['o-entry'], code: '08006', failures: 1, nextRetryInMs: 1_000 });
    expect(errors[1][1]).toMatchObject({ failures: 10, nextRetryInMs: 300_000 });
    expect(failureLogs(log.debug)).toHaveLength(12);
  });

  it('a success resets the schedule and the log level', async () => {
    let now = 0;
    let fail = true;
    const log = mkLogger();
    const { linker, calls } = makeLinker((_p, ids) => (fail ? { data: null, error: CONNECTION_FAILURE } : { data: ids.map((id) => ({ id })), error: null }), { now: () => now, logger: log });

    await linker.link(openPosition); // t=0 fails → next at 1 s
    now = 1_000;
    await linker.link(openPosition); // fails → next at 3 s
    fail = false;
    now = 3_000;
    expect((await linker.link(openPosition)).linked).toEqual(['o-entry']);

    // A scale-in whose link fails right after: a fresh first failure (1 s, error log), not the 4 s step.
    fail = true;
    now = 3_001;
    const scaled = { ...openPosition, trades: [{ clientOrderId: 'o-entry' }, { clientOrderId: 'o-scale' }] };
    await linker.link(scaled);
    now = 4_000;
    expect((await linker.link(scaled)).backedOff).toBe(true);
    now = 4_001;
    expect((await linker.link(scaled)).attempted).toEqual(['o-scale']);
    expect(calls).toHaveLength(5);
    expect(failureLogs(log.error).map((c) => (c[1] as { failures: number }).failures)).toEqual([1, 1]);
  });

  it('the close write is always attempted, even inside the backoff window', async () => {
    let now = 0;
    let fail = true;
    const { linker, calls } = makeLinker((_p, ids) => (fail ? { data: null, error: CONNECTION_FAILURE } : { data: ids.map((id) => ({ id })), error: null }), { now: () => now, logger: mkLogger() });

    await linker.link(openPosition); // t=0 fails
    now = 1_000;
    await linker.link(openPosition); // fails → next at 3 s
    fail = false;
    now = 1_500;
    const close = await linker.link({ id: POS, symbol: 'ETH-USD', closedAt: new Date(), trades: [{ clientOrderId: 'o-entry' }, { clientOrderId: 'o-exit' }] });
    expect(close.backedOff).toBe(false);
    expect(close.linked).toEqual(['o-entry', 'o-exit']);
    expect(calls).toHaveLength(3);
    expect(linker.snapshot()).toEqual({ positions: 0, disabled: false });
    expect(linker.linkCounts()).toEqual({ linked: 2, pending: 0, failed: 0, disabled: false });
  });
});

describe('OrderPositionLinker close-time UPDATE failure (review finding 6)', () => {
  it('forgets the position, logs the still-unlinked exit order with the error, and counts it as failed', async () => {
    const log = { warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    let fail = false;
    const { linker } = makeLinker((_p, ids) => (fail ? { data: null, error: { code: '08006', message: 'connection failure' } } : { data: ids.map((id) => ({ id })), error: null }), { logger: log });

    await linker.link({ id: POS, symbol: 'ETH-USD', trades: [{ clientOrderId: 'o-entry' }] });
    expect(linker.snapshot()).toEqual({ positions: 1, disabled: false });

    fail = true;
    const close = await linker.link({ id: POS, symbol: 'ETH-USD', closedAt: new Date(), trades: [{ clientOrderId: 'o-entry' }, { clientOrderId: 'o-exit' }] });
    expect(close.error).toMatchObject({ code: '08006' });

    // The tracker has already forgotten the position: no entry may leak, nothing will retry.
    expect(linker.snapshot()).toEqual({ positions: 0, disabled: false });
    expect(linker.linkCounts()).toEqual({ linked: 1, pending: 0, failed: 1, disabled: false });
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.error).toHaveBeenCalledWith('orders: position closed with orders still unlinked (link write failed)', {
      positionId: POS,
      symbol: 'ETH-USD',
      orderIds: ['o-exit'],
      code: '08006',
      message: 'connection failure',
    });
    expect(log.error.mock.calls.some((c) => /will retry/.test(String(c[0])))).toBe(false);
  });
});

describe('createSupabaseOrderLinkUpdate (review finding 8a: the production UPDATE chain)', () => {
  const USER_ID = 'b7e8f9c2-4d6a-4c8b-9e2d-1a3b5c7d9e1f';

  function recordingClient(result: { data: Array<{ id: string }> | null; error: PostgrestErrorLike | null }) {
    const chain: unknown[][] = [];
    const builder = {
      update: (values: unknown) => { chain.push(['update', values]); return builder; },
      eq: (column: string, value: unknown) => { chain.push(['eq', column, value]); return builder; },
      in: (column: string, values: unknown) => { chain.push(['in', column, values]); return builder; },
      select: (columns: string) => { chain.push(['select', columns]); return Promise.resolve(result); },
    };
    const client = { from: (table: string) => { chain.push(['from', table]); return builder; } };
    return { client: client as unknown as Parameters<typeof createSupabaseOrderLinkUpdate>[0], chain };
  }

  it('issues UPDATE orders SET position_id WHERE user_id = … AND id IN (…) RETURNING id and passes the result through', async () => {
    const { client, chain } = recordingClient({ data: [{ id: 'o1' }], error: null });
    const update = createSupabaseOrderLinkUpdate(client, USER_ID);
    await expect(update(POS, ['o1', 'o2'])).resolves.toEqual({ data: [{ id: 'o1' }], error: null });
    expect(chain).toEqual([
      ['from', 'orders'],
      ['update', { position_id: POS }],
      ['eq', 'user_id', USER_ID],
      ['in', 'id', ['o1', 'o2']],
      ['select', 'id'],
    ]);
  });

  it('passes a PostgREST error through so the linker can classify it', async () => {
    const error = { code: '08006', message: 'connection failure' };
    const { client } = recordingClient({ data: null, error });
    await expect(createSupabaseOrderLinkUpdate(client, USER_ID)(POS, ['o1'])).resolves.toEqual({ data: null, error });

    // Wired into the linker: a missing column (42703) disables it, a transient error is a retryable failure.
    const missingColumn = recordingClient({ data: null, error: { code: '42703', message: 'column orders.position_id does not exist' } });
    const disabledLinker = new OrderPositionLinker({ update: createSupabaseOrderLinkUpdate(missingColumn.client, USER_ID), logger: { warn: vi.fn(), error: vi.fn(), debug: vi.fn() } });
    expect(await disabledLinker.link({ id: POS, trades: [{ clientOrderId: 'o1' }] })).toMatchObject({ attempted: ['o1'], disabled: true });
    expect(disabledLinker.disabled).toBe(true);

    const failingLinker = new OrderPositionLinker({ update: createSupabaseOrderLinkUpdate(client, USER_ID), logger: { warn: vi.fn(), error: vi.fn(), debug: vi.fn() } });
    expect(await failingLinker.link({ id: POS, trades: [{ clientOrderId: 'o1' }] })).toMatchObject({ attempted: ['o1'], error, disabled: false });
    expect(failingLinker.linkCounts()).toEqual({ linked: 0, pending: 1, failed: 0, disabled: false });
  });
});

describe('linkOrdersAfterPositionWrite (review finding 8: the FK-ordering gate api/server.ts uses)', () => {
  it('links only after a written positions write — never after dropped, failed or no write', async () => {
    const link = vi.fn(async () => ({ attempted: [], linked: [], missing: [], error: null, disabled: false, backedOff: false }));
    const position = { id: POS, trades: [{ clientOrderId: 'o1' }] };
    expect(await linkOrdersAfterPositionWrite({ status: 'dropped' }, position, { link })).toBeNull();
    expect(await linkOrdersAfterPositionWrite({ status: 'failed' }, position, { link })).toBeNull();
    expect(await linkOrdersAfterPositionWrite(null, position, { link })).toBeNull();
    expect(link).not.toHaveBeenCalled();
    await linkOrdersAfterPositionWrite({ status: 'written' }, position, { link });
    expect(link).toHaveBeenCalledTimes(1);
    expect(link).toHaveBeenCalledWith(position);
  });
});

describe('PositionTracker threads FillContext.clientOrderId onto Trade', () => {
  const config: PositionTrackerConfig = {
    supabaseUrl: 'http://localhost:54321',
    supabaseKey: 'test-key',
    updateInterval: 60_000,
    pnlCalculationMethod: 'fifo',
    maxPositionValueUsd: 500_000,
    maxUnrealizedLossUsd: 500_000,
    drawdownWarningPct: 50,
    drawdownCriticalPct: 75,
  };
  const fill = (overrides: Partial<Fill>): Fill => ({
    trade_id: 1, product_id: 'BTC-USD', order_id: 'exch-1', user_id: 'u', profile_id: 'p', liquidity: 'T',
    price: '50000', size: '0.01', fee: '0', created_at: '2026-09-29T12:00:00.000Z', side: 'buy', settled: true, usd_volume: '0',
    ...overrides,
  });

  it('records clientOrderId when the engine matched a managed order, and omits it otherwise', async () => {
    const tracker = new PositionTracker(config, { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger);
    try {
      await tracker.processFill(fill({}), { strategy: 'trend_follow', clientOrderId: 'client-uuid-1' });
      await tracker.processFill(fill({ trade_id: 2, order_id: 'exch-2' }), {});
      const trades = tracker.getPosition('BTC-USD')!.trades;
      expect(trades[0]).toMatchObject({ orderId: 'exch-1', clientOrderId: 'client-uuid-1' });
      expect(trades[1].orderId).toBe('exch-2');
      expect('clientOrderId' in trades[1]).toBe(false);
      expect(pendingOrderLinks(tracker.getPosition('BTC-USD')!)).toEqual(['client-uuid-1']);
    } finally {
      tracker.stopUpdateLoop();
    }
  });
});
