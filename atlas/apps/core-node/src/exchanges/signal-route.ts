/**
 * Signal route — the venue a canonical signal is routed to and the router's
 * final verdict on it, in the shape the `signals` blotter row persists.
 *
 * Background (Tier-A P0, DESK GO 2026-09-21): `signals.routed_exchange` was
 * added by migration `20260305015203_add_exchange_id.sql` but no writer ever
 * set it, and the row was inserted BEFORE the router ran, so every canonical
 * signal landed as `allowed = true, routed_exchange = NULL` whether or not it
 * became an order. This module gives the router one vocabulary for
 * "where did this go and did it become an order":
 *
 *   - {@link resolveRoutedExchange} — symbol → execution venue id. Venue ids
 *     are the `ExchangeRegistry` adapter ids (`CoinbaseAdapter.id`,
 *     `CoinbasePerpsAdapter.id`) and match the `orders.exchange_id` default.
 *     Symbol convention follows `core/symbol-utils.marketForSymbol`.
 *   - {@link SignalRouteVerdict} — the outcome of the router's gate chain.
 *   - {@link signalRouteColumns} — verdict → `signals` column patch.
 *
 * Pure and I/O-free so it is unit-testable without Supabase or an engine.
 */

import { marketForSymbol } from '../core/symbol-utils';

/** Coinbase Advanced Trade spot (`XXX-USD`). Same id as `CoinbaseAdapter`. */
export const ROUTED_EXCHANGE_COINBASE_SPOT = 'coinbase' as const;
/** Coinbase International Exchange perps (`XXX-PERP-INTX`). Same id as `CoinbasePerpsAdapter`. */
export const ROUTED_EXCHANGE_COINBASE_PERPS = 'coinbase-perps' as const;
/**
 * Coinbase Financial Markets / CDE nano futures (`XXX-<expiry>-CDE`). Paper
 * harness venue only (card SH-QMAKER-CFM-PAPER-v0); no live adapter carries
 * this id. Any future live path is Advanced Trade `/cfm/*` — not INTX/drb.
 */
export const ROUTED_EXCHANGE_COINBASE_CFM = 'coinbase-cfm' as const;

/** Execution venue ids the router can stamp today. */
export type RoutedExchangeId =
  | typeof ROUTED_EXCHANGE_COINBASE_SPOT
  | typeof ROUTED_EXCHANGE_COINBASE_PERPS
  | typeof ROUTED_EXCHANGE_COINBASE_CFM;

/**
 * Resolve the execution venue for a product symbol.
 *
 * Paper and live both execute every symbol through the engine's single
 * Coinbase path (paper: `PaperTradingSimulator`, which prices `*-PERP-INTX`
 * at the `coinbase.perps_intx` fee tier, `*-CDE` at the `coinbase.cfm_nano`
 * cost-plus book, and settles both in USD collateral), so the venue is a
 * pure function of the symbol:
 *
 *   resolveRoutedExchange('ETH-USD')          === 'coinbase'
 *   resolveRoutedExchange('ETH-PERP-INTX')    === 'coinbase-perps'
 *   resolveRoutedExchange('BIP-20DEC30-CDE')  === 'coinbase-cfm'
 *
 * Hyperliquid is deliberately absent: `guardrails.hyperliquid.enabled` only
 * governs whether the HL adapter connects; signal routing to HL is not wired.
 */
export function resolveRoutedExchange(symbol: string): RoutedExchangeId {
  switch (marketForSymbol(symbol)) {
    case 'perps':
      return ROUTED_EXCHANGE_COINBASE_PERPS;
    case 'cfm':
      return ROUTED_EXCHANGE_COINBASE_CFM;
    default:
      return ROUTED_EXCHANGE_COINBASE_SPOT;
  }
}

/**
 * What happened to a canonical signal in the router.
 *
 *   - `order_placed`    — entry order accepted by the trading engine.
 *   - `exit_placed`     — SELL-as-exit (spot, `allow_short` off) order accepted.
 *   - `rejected`        — a router gate (runtime_state, routing, cross_venue,
 *                          time, atr_vol, funding_bias, sizing, ev_gate …) dropped
 *                          it before any venue was reached.
 *   - `engine_rejected` — handed to the venue path but the engine returned no
 *                          order (pre-trade risk check or paper validation).
 *   - `error`           — the router threw; nothing was placed.
 */
export type SignalRouteOutcome =
  | 'order_placed'
  | 'exit_placed'
  | 'rejected'
  | 'engine_rejected'
  | 'error';

export interface SignalRouteVerdict {
  outcome: SignalRouteOutcome;
  /** Venue the signal resolves to (always known; whether it was reached is `outcome`). */
  routedExchange: RoutedExchangeId;
  /** Router stage that produced the verdict (`SignalFilterStage` slug or `risk_engine` / `router`). */
  stage?: string;
  /** Human-readable reason (rejections / errors). */
  reason?: string;
  /** Engine order id when an order was placed. */
  orderId?: string;
}

/** Verdict for an accepted entry order. */
export function routeOrderPlaced(routedExchange: RoutedExchangeId, orderId: string): SignalRouteVerdict {
  return { outcome: 'order_placed', routedExchange, orderId };
}

/** Verdict for an accepted exit (SELL closing a long on a no-short venue). */
export function routeExitPlaced(routedExchange: RoutedExchangeId, orderId: string): SignalRouteVerdict {
  return { outcome: 'exit_placed', routedExchange, orderId };
}

/** Verdict for a router-gate rejection; `stage` is the funnel stage slug. */
export function routeRejected(routedExchange: RoutedExchangeId, stage: string, reason: string): SignalRouteVerdict {
  return { outcome: 'rejected', routedExchange, stage, reason };
}

/**
 * Verdict when the engine was reached but declined to create an order.
 * @param stage Which engine layer declined: `risk_engine` (pre-trade check, default)
 *   or `paper_validation` (simulator refused the order).
 */
export function routeEngineRejected(
  routedExchange: RoutedExchangeId,
  reason: string,
  stage: 'risk_engine' | 'paper_validation' = 'risk_engine',
): SignalRouteVerdict {
  return { outcome: 'engine_rejected', routedExchange, stage, reason };
}

/** Verdict when routing threw before a decision was reached. */
export function routeError(routedExchange: RoutedExchangeId, reason: string): SignalRouteVerdict {
  return { outcome: 'error', routedExchange, stage: 'router', reason };
}

/** True when the verdict means an order reached the engine's order path. */
export function isOrderPlaced(verdict: SignalRouteVerdict): boolean {
  return verdict.outcome === 'order_placed' || verdict.outcome === 'exit_placed';
}

/** True when the signal was handed to a venue's execution path (placed or engine-rejected). */
export function reachedVenue(verdict: SignalRouteVerdict): boolean {
  return isOrderPlaced(verdict) || verdict.outcome === 'engine_rejected';
}

/** Column patch a verdict applies to a `signals` row. */
export interface SignalRouteColumns {
  /** True iff an order was placed from this signal. */
  allowed: boolean;
  /** Venue id when the signal reached a venue's execution path, else `null`. */
  routed_exchange: RoutedExchangeId | null;
  /** `"<stage>: <reason>"` for rejections/errors; `null` when placed (keeps the strategy's reason). */
  reason: string | null;
}

/**
 * Translate a verdict into the `signals` columns it owns.
 *
 * Contract:
 *   - `allowed` is true only when an order was placed (entry or exit).
 *   - `routed_exchange` is set when the signal reached a venue's execution
 *     path — placed, or rejected by that venue's pre-trade risk engine. A
 *     router-gate rejection never reached a venue and stays `NULL`.
 *   - `reason` carries `"<stage>: <reason>"` for anything not placed so the
 *     blotter shows WHY; placed signals return `null` so the caller keeps the
 *     strategy's own reason text.
 */
export function signalRouteColumns(verdict: SignalRouteVerdict): SignalRouteColumns {
  const allowed = isOrderPlaced(verdict);
  const routed_exchange = reachedVenue(verdict) ? verdict.routedExchange : null;
  if (allowed) {
    return { allowed, routed_exchange, reason: null };
  }
  const stage = verdict.stage ?? verdict.outcome;
  const detail = verdict.reason && verdict.reason.length > 0 ? verdict.reason : verdict.outcome;
  return { allowed, routed_exchange, reason: `${stage}: ${detail}` };
}
