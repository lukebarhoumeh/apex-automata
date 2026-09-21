/**
 * Tier-A P0 (DESK GO 2026-09-21) — signal → venue routing verdict
 * (exchanges/signal-route.ts).
 *
 * Pins:
 *   - resolveRoutedExchange(): spot → 'coinbase', XXX-PERP-INTX → 'coinbase-perps',
 *     and those ids are the ExchangeRegistry adapter ids (CoinbaseAdapter /
 *     CoinbasePerpsAdapter) so signals.routed_exchange and orders.exchange_id
 *     speak the same vocabulary.
 *   - signalRouteColumns(): allowed ⇔ an order was placed; routed_exchange is
 *     stamped when the venue path was reached (placed or engine-rejected) and
 *     NULL for router-gate rejections; reason = '<stage>: <why>' when not placed.
 *   - Null-route regression guard: no verdict can ever produce
 *     allowed=true with routed_exchange=NULL (the state the desk saw).
 */

import { describe, it, expect, vi } from 'vitest';
import {
  ROUTED_EXCHANGE_COINBASE_PERPS,
  ROUTED_EXCHANGE_COINBASE_SPOT,
  isOrderPlaced,
  reachedVenue,
  resolveRoutedExchange,
  routeEngineRejected,
  routeError,
  routeExitPlaced,
  routeOrderPlaced,
  routeRejected,
  signalRouteColumns,
  type SignalRouteVerdict,
} from '../exchanges/signal-route';
import { CoinbaseAdapter } from '../exchanges/coinbase-adapter';
import { CoinbasePerpsAdapter } from '../exchanges/coinbase-perps-adapter';
import { FeeModel } from '../core/fee-model';
import type { Logger } from '../core/logger';

const logger = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
const feeModel = new FeeModel({
  coinbase: { spot: { maker_bps: 25, taker_bps: 40 }, perps_intx: { maker_bps: 0, taker_bps: 5 } },
  hyperliquid: { perps: { maker_bps: -1.5, taker_bps: 4.5 } },
});

describe('resolveRoutedExchange()', () => {
  it('routes spot symbols to coinbase', () => {
    for (const symbol of ['BTC-USD', 'ETH-USD', 'SOL-USD']) {
      expect(resolveRoutedExchange(symbol)).toBe('coinbase');
    }
  });

  it('routes XXX-PERP-INTX symbols to coinbase-perps', () => {
    for (const symbol of ['ETH-PERP-INTX', 'BTC-PERP-INTX']) {
      expect(resolveRoutedExchange(symbol)).toBe('coinbase-perps');
    }
  });

  it('venue ids are the ExchangeRegistry adapter ids', () => {
    expect(ROUTED_EXCHANGE_COINBASE_SPOT).toBe(new CoinbaseAdapter(logger, feeModel).id);
    expect(ROUTED_EXCHANGE_COINBASE_PERPS).toBe(new CoinbasePerpsAdapter(logger, feeModel).id);
    expect(resolveRoutedExchange('ETH-USD')).toBe(new CoinbaseAdapter(logger, feeModel).id);
    expect(resolveRoutedExchange('ETH-PERP-INTX')).toBe(new CoinbasePerpsAdapter(logger, feeModel).id);
  });

  it("spot id equals the orders.exchange_id column default ('coinbase')", () => {
    // supabase/migrations/20260305015203_add_exchange_id.sql
    expect(resolveRoutedExchange('BTC-USD')).toBe('coinbase');
  });
});

describe('verdict constructors', () => {
  const venue = resolveRoutedExchange('ETH-USD');

  it('order_placed / exit_placed carry the order id and count as placed + venue reached', () => {
    const entry = routeOrderPlaced(venue, 'ord-1');
    const exit = routeExitPlaced(venue, 'ord-2');
    expect(entry).toEqual({ outcome: 'order_placed', routedExchange: 'coinbase', orderId: 'ord-1' });
    expect(exit).toEqual({ outcome: 'exit_placed', routedExchange: 'coinbase', orderId: 'ord-2' });
    for (const v of [entry, exit]) {
      expect(isOrderPlaced(v)).toBe(true);
      expect(reachedVenue(v)).toBe(true);
    }
  });

  it('rejected carries stage + reason and never reached a venue', () => {
    const v = routeRejected(venue, 'ev_gate', 'EV $-16.41 < threshold $0.00');
    expect(v).toEqual({ outcome: 'rejected', routedExchange: 'coinbase', stage: 'ev_gate', reason: 'EV $-16.41 < threshold $0.00' });
    expect(isOrderPlaced(v)).toBe(false);
    expect(reachedVenue(v)).toBe(false);
  });

  it('engine_rejected reached the venue but placed nothing', () => {
    const v = routeEngineRejected(venue, 'order_not_created');
    expect(v.stage).toBe('risk_engine');
    expect(isOrderPlaced(v)).toBe(false);
    expect(reachedVenue(v)).toBe(true);
  });

  it('engine_rejected can name the paper simulator as the declining layer', () => {
    const v = routeEngineRejected(venue, 'Insufficient USD balance. Required: 1332.28, Available: 100.00', 'paper_validation');
    expect(v.stage).toBe('paper_validation');
    expect(signalRouteColumns(v).reason).toBe('paper_validation: Insufficient USD balance. Required: 1332.28, Available: 100.00');
    expect(signalRouteColumns(v).routed_exchange).toBe('coinbase');
  });

  it('error is neither placed nor venue-reached', () => {
    const v = routeError(venue, 'boom');
    expect(v.stage).toBe('router');
    expect(isOrderPlaced(v)).toBe(false);
    expect(reachedVenue(v)).toBe(false);
  });
});

describe('signalRouteColumns()', () => {
  it('placed entry → allowed=true, routed_exchange stamped, reason left to the strategy (null)', () => {
    expect(signalRouteColumns(routeOrderPlaced('coinbase', 'o1'))).toEqual({
      allowed: true,
      routed_exchange: 'coinbase',
      reason: null,
    });
    expect(signalRouteColumns(routeOrderPlaced('coinbase-perps', 'o2'))).toEqual({
      allowed: true,
      routed_exchange: 'coinbase-perps',
      reason: null,
    });
  });

  it('placed exit → allowed=true with venue', () => {
    expect(signalRouteColumns(routeExitPlaced('coinbase', 'o3'))).toEqual({
      allowed: true,
      routed_exchange: 'coinbase',
      reason: null,
    });
  });

  it('router-gate rejection → allowed=false, routed_exchange NULL, reason "<stage>: <why>"', () => {
    expect(signalRouteColumns(routeRejected('coinbase', 'ev_gate', 'EV $-16.41 < threshold $0.00'))).toEqual({
      allowed: false,
      routed_exchange: null,
      reason: 'ev_gate: EV $-16.41 < threshold $0.00',
    });
    expect(signalRouteColumns(routeRejected('coinbase-perps', 'cross_venue', 'intra_window_dedup'))).toEqual({
      allowed: false,
      routed_exchange: null,
      reason: 'cross_venue: intra_window_dedup',
    });
  });

  it('engine rejection → allowed=false but routed_exchange stamped (the venue was reached)', () => {
    expect(signalRouteColumns(routeEngineRejected('coinbase-perps', 'order_not_created'))).toEqual({
      allowed: false,
      routed_exchange: 'coinbase-perps',
      reason: 'risk_engine: order_not_created',
    });
  });

  it('router error → allowed=false, NULL venue, "router: <message>"', () => {
    expect(signalRouteColumns(routeError('coinbase', 'Trading engine not running'))).toEqual({
      allowed: false,
      routed_exchange: null,
      reason: 'router: Trading engine not running',
    });
  });

  it('falls back to the outcome when stage/reason are absent', () => {
    const bare: SignalRouteVerdict = { outcome: 'rejected', routedExchange: 'coinbase' };
    expect(signalRouteColumns(bare).reason).toBe('rejected: rejected');
    const empty: SignalRouteVerdict = { outcome: 'error', routedExchange: 'coinbase', stage: 'router', reason: '' };
    expect(signalRouteColumns(empty).reason).toBe('router: error');
  });
});

describe('null-route regression guard', () => {
  const venues = ['coinbase', 'coinbase-perps'] as const;
  const everyVerdict = (venue: (typeof venues)[number]): SignalRouteVerdict[] => [
    routeOrderPlaced(venue, 'o'),
    routeExitPlaced(venue, 'o'),
    routeRejected(venue, 'runtime_state', 'paused'),
    routeRejected(venue, 'routing', 'exit_no_open_position'),
    routeRejected(venue, 'cross_venue', 'intra_window_dedup'),
    routeRejected(venue, 'time', 'hour_not_allowed'),
    routeRejected(venue, 'atr_vol', 'atr_below_min'),
    routeRejected(venue, 'funding_bias', 'excessive_funding_rate'),
    routeRejected(venue, 'sizing', 'guardrail_size_zero_or_invalid'),
    routeRejected(venue, 'ev_gate', 'ev_below_threshold'),
    routeEngineRejected(venue, 'order_not_created'),
    routeError(venue, 'boom'),
  ];

  it('no verdict yields allowed=true with routed_exchange=NULL', () => {
    for (const venue of venues) {
      for (const verdict of everyVerdict(venue)) {
        const cols = signalRouteColumns(verdict);
        if (cols.allowed) {
          expect(cols.routed_exchange).not.toBeNull();
          expect(cols.routed_exchange).toBe(venue);
        }
      }
    }
  });

  it('every non-placed verdict carries a non-empty reason', () => {
    for (const venue of venues) {
      for (const verdict of everyVerdict(venue)) {
        const cols = signalRouteColumns(verdict);
        if (!cols.allowed) {
          expect(cols.reason).toEqual(expect.stringMatching(/^\S+: .+/));
        }
      }
    }
  });

  it('the incident shape (allowed=true, routed_exchange=null) is unreachable for spot AND INTX symbols', () => {
    for (const symbol of ['ETH-USD', 'ETH-PERP-INTX', 'BTC-USD', 'BTC-PERP-INTX']) {
      const venue = resolveRoutedExchange(symbol);
      const placed = signalRouteColumns(routeOrderPlaced(venue, 'ord'));
      expect(placed).toEqual({ allowed: true, routed_exchange: venue, reason: null });
    }
  });
});
