/**
 * Symbol utilities — shared classifier for routing per-symbol decisions
 * (today: fee tier; future: venue inference, contract metadata, etc.).
 *
 * Single source of truth so paper-trading-simulator, backtest-engine,
 * and any future fee-aware consumer agree on what counts as a perp or a
 * CFM future.
 *
 * Coinbase perp products use the `XXX-PERP-INTX` pattern (cross-margin
 * INTX perpetual futures). Coinbase Financial Markets / Coinbase
 * Derivatives Exchange (CDE) nano futures use the `XXX-<expiry>-CDE`
 * pattern (e.g. `BIP-20DEC30-CDE`, `ETP-20DEC30-CDE`) — a different
 * venue, a different fee book (`fees.coinbase.cfm_nano`, cite
 * `CFM-NANO-COSTPLUS-ADV1`) and a different API surface (`/cfm/*` on
 * `api.coinbase.com`, NOT INTX/drb). Hyperliquid uses bare `XXX-USD`-style
 * symbols routed via a separate adapter, so they never enter this
 * classifier today; callers that need HL-vs-CB venue routing should
 * resolve venue upstream of this function.
 */

import type { Market } from './fee-model';

/** Product-id suffix of Coinbase Derivatives Exchange (CFM) futures. */
export const CDE_PRODUCT_SUFFIX = '-CDE';

/**
 * True for Coinbase Financial Markets / CDE futures products
 * (`BIP-20DEC30-CDE`, `BIT-25SEP26-CDE`, `ETP-20DEC30-CDE`, ...).
 *
 * Examples:
 *   isCfmSymbol('BIP-20DEC30-CDE')  === true
 *   isCfmSymbol('BTC-PERP-INTX')    === false
 *   isCfmSymbol('BTC-USD')          === false
 */
export function isCfmSymbol(symbol: string): boolean {
  return symbol.toUpperCase().endsWith(CDE_PRODUCT_SUFFIX);
}

/**
 * Classify a product symbol to its market bucket (spot vs perps vs cfm).
 *
 * Examples:
 *   marketForSymbol('BTC-USD')         === 'spot'
 *   marketForSymbol('ETH-PERP-INTX')   === 'perps'
 *   marketForSymbol('BTC-PERP-INTX')   === 'perps'
 *   marketForSymbol('BIP-20DEC30-CDE') === 'cfm'
 */
export function marketForSymbol(symbol: string): Market {
  if (isCfmSymbol(symbol)) return 'cfm';
  return symbol.includes('-PERP-') ? 'perps' : 'spot';
}
