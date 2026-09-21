/**
 * Tier-A P0 (DESK GO 2026-09-21) — persisting the routing verdict onto the
 * `signals` row (persistence/signal-route-verdict.ts).
 *
 * Pins:
 *   - the UPDATE is keyed on the signal UUID and skipped (with a warn) when the
 *     id is not the row UUID;
 *   - a placed signal patches allowed=true + routed_exchange and leaves the
 *     strategy's `reason` alone; a rejection patches allowed=false + reason and
 *     routed_exchange NULL (router gate) / venue (engine);
 *   - a missing `routed_exchange` column retries ONCE without it so
 *     allowed / reason still land; unrelated errors surface, no retry;
 *   - row lifecycle: the pre-routing INSERT shape (allowed=true, no route)
 *     plus the verdict patch yields the final blotter row.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  ROUTED_EXCHANGE_COLUMN,
  buildSignalRouteVerdictPatch,
  isAddressableSignalId,
  writeSignalRouteVerdict,
} from '../persistence/signal-route-verdict';
import {
  resolveRoutedExchange,
  routeEngineRejected,
  routeOrderPlaced,
  routeRejected,
} from '../exchanges/signal-route';

const SIGNAL_ID = '6f1c2a3e-9b4d-4c8e-8f21-0a1b2c3d4e5f';
const MISSING_ROUTED_EXCHANGE = {
  code: 'PGRST204',
  message: "Could not find the 'routed_exchange' column of 'signals' in the schema cache",
};
const UNRELATED_MISSING = {
  code: 'PGRST204',
  message: "Could not find the 'allowed' column of 'signals' in the schema cache",
};
const RLS_DENIED = { code: '42501', message: 'new row violates row-level security policy' };

function makeLogger() {
  return { warn: vi.fn() };
}

describe('isAddressableSignalId()', () => {
  it('accepts the v4 UUID the canonical insert used as signals.id', () => {
    expect(isAddressableSignalId(SIGNAL_ID)).toBe(true);
  });
  it('rejects non-UUID ids (the row would have a DB-generated id we cannot address)', () => {
    expect(isAddressableSignalId('test-signal-1')).toBe(false);
    expect(isAddressableSignalId(undefined)).toBe(false);
    expect(isAddressableSignalId(42)).toBe(false);
  });
});

describe('buildSignalRouteVerdictPatch()', () => {
  it('placed → allowed + routed_exchange, no reason key (strategy reason preserved)', () => {
    const patch = buildSignalRouteVerdictPatch(routeOrderPlaced('coinbase-perps', 'o1'));
    expect(patch).toEqual({ allowed: true, routed_exchange: 'coinbase-perps' });
    expect('reason' in patch).toBe(false);
  });

  it('router rejection → allowed=false, reason, routed_exchange null', () => {
    const patch = buildSignalRouteVerdictPatch(routeRejected('coinbase', 'ev_gate', 'EV $-16.41 < threshold $0.00'));
    expect(patch).toEqual({
      allowed: false,
      reason: 'ev_gate: EV $-16.41 < threshold $0.00',
      routed_exchange: null,
    });
  });

  it('engine rejection → allowed=false with the venue stamped', () => {
    const patch = buildSignalRouteVerdictPatch(routeEngineRejected('coinbase', 'order_not_created'));
    expect(patch).toEqual({ allowed: false, reason: 'risk_engine: order_not_created', routed_exchange: 'coinbase' });
  });

  it('legacy shape omits routed_exchange entirely', () => {
    const patch = buildSignalRouteVerdictPatch(routeOrderPlaced('coinbase', 'o1'), false);
    expect(patch).toEqual({ allowed: true });
    expect(ROUTED_EXCHANGE_COLUMN in patch).toBe(false);
  });
});

describe('writeSignalRouteVerdict()', () => {
  it('updates once with the full patch on the happy path', async () => {
    const update = vi.fn(async () => ({ error: null }));
    const result = await writeSignalRouteVerdict({
      signalId: SIGNAL_ID,
      verdict: routeOrderPlaced('coinbase', 'ord-1'),
      update,
      logger: makeLogger(),
    });
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith({ allowed: true, routed_exchange: 'coinbase' });
    expect(result).toEqual({
      error: null,
      attempted: true,
      fellBack: false,
      patch: { allowed: true, routed_exchange: 'coinbase' },
    });
  });

  it('does not write when the signal id is not the row UUID, and says so', async () => {
    const update = vi.fn(async () => ({ error: null }));
    const logger = makeLogger();
    const result = await writeSignalRouteVerdict({
      signalId: 'not-a-uuid',
      verdict: routeOrderPlaced('coinbase', 'ord-1'),
      update,
      logger,
    });
    expect(update).not.toHaveBeenCalled();
    expect(result.attempted).toBe(false);
    expect(result.patch).toBeNull();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('retries once without routed_exchange when that column is missing', async () => {
    const update = vi
      .fn()
      .mockResolvedValueOnce({ error: MISSING_ROUTED_EXCHANGE })
      .mockResolvedValueOnce({ error: null });
    const logger = makeLogger();
    const result = await writeSignalRouteVerdict({
      signalId: SIGNAL_ID,
      verdict: routeRejected('coinbase', 'ev_gate', 'EV $-16.41 < threshold $0.00'),
      update,
      logger,
    });
    expect(update).toHaveBeenCalledTimes(2);
    expect(update.mock.calls[0][0]).toEqual({
      allowed: false,
      reason: 'ev_gate: EV $-16.41 < threshold $0.00',
      routed_exchange: null,
    });
    expect(update.mock.calls[1][0]).toEqual({ allowed: false, reason: 'ev_gate: EV $-16.41 < threshold $0.00' });
    expect(result.error).toBeNull();
    expect(result.fellBack).toBe(true);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('surfaces an unrelated missing-column error without retrying', async () => {
    const update = vi.fn(async () => ({ error: UNRELATED_MISSING }));
    const result = await writeSignalRouteVerdict({
      signalId: SIGNAL_ID,
      verdict: routeOrderPlaced('coinbase', 'ord-1'),
      update,
      logger: makeLogger(),
    });
    expect(update).toHaveBeenCalledTimes(1);
    expect(result.error).toBe(UNRELATED_MISSING);
    expect(result.fellBack).toBe(false);
  });

  it('surfaces a non-schema error (RLS) without retrying', async () => {
    const update = vi.fn(async () => ({ error: RLS_DENIED }));
    const result = await writeSignalRouteVerdict({
      signalId: SIGNAL_ID,
      verdict: routeOrderPlaced('coinbase', 'ord-1'),
      update,
      logger: makeLogger(),
    });
    expect(update).toHaveBeenCalledTimes(1);
    expect(result.error).toBe(RLS_DENIED);
  });

  it('propagates the fallback write error when the legacy shape also fails', async () => {
    const update = vi
      .fn()
      .mockResolvedValueOnce({ error: MISSING_ROUTED_EXCHANGE })
      .mockResolvedValueOnce({ error: RLS_DENIED });
    const result = await writeSignalRouteVerdict({
      signalId: SIGNAL_ID,
      verdict: routeOrderPlaced('coinbase', 'ord-1'),
      update,
      logger: makeLogger(),
    });
    expect(result.error).toBe(RLS_DENIED);
    expect(result.fellBack).toBe(true);
  });
});

/**
 * The row the desk reads: the pre-routing INSERT shape that
 * `syncSignalToSupabase` writes (allowed=true, strategy reason, no route),
 * then the verdict patch applied by `persistSignalRouteVerdict`.
 */
describe('signals row lifecycle (insert → verdict)', () => {
  const insertedRow = (symbol: string) => ({
    id: SIGNAL_ID,
    symbol,
    strategy: 'trend_follow',
    side: 'long',
    allowed: true,
    reason: 'Bullish EMA crossover (12/15) with price confirmation',
    routed_exchange: null as string | null,
  });

  async function applyVerdict(row: Record<string, unknown>, verdict: Parameters<typeof buildSignalRouteVerdictPatch>[0]) {
    const store = { ...row };
    await writeSignalRouteVerdict({
      signalId: row.id,
      verdict,
      update: async (patch) => {
        Object.assign(store, patch);
        return { error: null };
      },
    });
    return store;
  }

  it('ETH-USD entry placed → allowed=true, routed_exchange=coinbase, strategy reason kept', async () => {
    const venue = resolveRoutedExchange('ETH-USD');
    const row = await applyVerdict(insertedRow('ETH-USD'), routeOrderPlaced(venue, 'ord-eth'));
    expect(row).toMatchObject({
      allowed: true,
      routed_exchange: 'coinbase',
      reason: 'Bullish EMA crossover (12/15) with price confirmation',
    });
  });

  it('ETH-PERP-INTX entry placed → routed_exchange=coinbase-perps (INTX is paper-routable, not null)', async () => {
    const venue = resolveRoutedExchange('ETH-PERP-INTX');
    const row = await applyVerdict(insertedRow('ETH-PERP-INTX'), routeOrderPlaced(venue, 'ord-eth-perp'));
    expect(row).toMatchObject({ allowed: true, routed_exchange: 'coinbase-perps' });
  });

  it('EV-gate rejection → allowed=false, routed_exchange NULL, reason names the gate', async () => {
    const venue = resolveRoutedExchange('BTC-USD');
    const row = await applyVerdict(
      insertedRow('BTC-USD'),
      routeRejected(venue, 'ev_gate', 'EV $-15.38 < threshold $0.00 (p=0.000[observed], …)'),
    );
    expect(row).toMatchObject({
      allowed: false,
      routed_exchange: null,
      reason: 'ev_gate: EV $-15.38 < threshold $0.00 (p=0.000[observed], …)',
    });
  });

  it('risk-engine rejection → allowed=false but the venue it reached is stamped', async () => {
    const venue = resolveRoutedExchange('BTC-PERP-INTX');
    const row = await applyVerdict(insertedRow('BTC-PERP-INTX'), routeEngineRejected(venue, 'order_not_created'));
    expect(row).toMatchObject({
      allowed: false,
      routed_exchange: 'coinbase-perps',
      reason: 'risk_engine: order_not_created',
    });
  });
});
