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
import { OrderPositionLinker, pendingOrderLinks } from '../persistence/order-position-link';
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

function makeLinker(handler?: (positionId: string, orderIds: string[]) => { data: Array<{ id: string }> | null; error: PostgrestErrorLike | null }) {
  const calls: Array<{ positionId: string; orderIds: string[] }> = [];
  const linker = new OrderPositionLinker({
    update: async (positionId, orderIds) => {
      calls.push({ positionId, orderIds });
      return handler ? handler(positionId, orderIds) : { data: orderIds.map((id) => ({ id })), error: null };
    },
    logger,
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

  it('a failed UPDATE is logged (never thrown) and retried on the next write', async () => {
    let fail = true;
    const { linker, calls } = makeLinker((_p, ids) => (fail ? { data: null, error: { code: '08006', message: 'connection failure' } } : { data: ids.map((id) => ({ id })), error: null }));

    const first = await linker.link({ id: POS, symbol: 'ETH-USD', trades: [{ clientOrderId: 'o-entry' }] });
    expect(first.error).toMatchObject({ code: '08006' });
    expect(logger.error).toHaveBeenCalledWith(expect.stringMatching(/position_id link write failed/), expect.objectContaining({ orderIds: ['o-entry'] }));

    fail = false;
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
