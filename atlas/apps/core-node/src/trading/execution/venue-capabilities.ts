/**
 * Venue capabilities — the single place that answers "can this venue
 * short?" so backtest, paper and live agree (TASK_012 step 3 / TASK_017 B2).
 *
 * Coinbase spot cannot short: a SELL with no inventory is rejected by the
 * exchange, and a SELL with inventory liquidates holdings. Only perpetual
 * venues (Coinbase INTX perps, Hyperliquid) support short entries. The
 * `guardrails.strategy.allow_short` flag is therefore necessary but NOT
 * sufficient — shorting requires `allow_short && capabilities.shorting`.
 *
 * Symbol convention: `XXX-PERP-INTX` is a perp; everything else is spot
 * (see `core/symbol-utils.marketForSymbol`).
 */

import { marketForSymbol } from '../../core/symbol-utils';

/** Market venue class. Mirrors `core/fee-model.Market`. */
export type MarketVenue = 'spot' | 'perps';

export interface VenueCapabilities {
  /** True when the venue supports opening short positions. */
  shorting: boolean;
}

/**
 * Infer the venue from a product symbol (`ETH-PERP-INTX` → perps,
 * `ETH-USD` → spot). Callers with an explicit venue override should apply
 * it before consulting this.
 */
export function venueForSymbol(symbol: string): MarketVenue {
  return marketForSymbol(symbol);
}

/**
 * Static capability table per venue class.
 *
 *   spot  → { shorting: false }
 *   perps → { shorting: true }
 */
export function capabilitiesForVenue(venue: MarketVenue): VenueCapabilities {
  return { shorting: venue === 'perps' };
}

/**
 * Effective shorting permission: config flag AND venue capability.
 * A spot venue never shorts, regardless of `allow_short`.
 */
export function isShortingAllowed(allowShortConfig: boolean, venue: MarketVenue): boolean {
  return Boolean(allowShortConfig) && capabilitiesForVenue(venue).shorting;
}
