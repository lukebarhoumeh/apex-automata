/**
 * Symbol utilities — shared classifier for routing per-symbol decisions
 * (today: fee tier; future: venue inference, contract metadata, etc.).
 *
 * Single source of truth so paper-trading-simulator, backtest-engine,
 * and any future fee-aware consumer agree on what counts as a perp.
 *
 * Coinbase perp products use the `XXX-PERP-INTX` pattern (cross-margin
 * INTX perpetual futures). Hyperliquid uses bare `XXX-USD`-style symbols
 * routed via a separate adapter, so they never enter this classifier
 * today; callers that need HL-vs-CB venue routing should resolve venue
 * upstream of this function.
 */

import type { Market } from './fee-model';

/**
 * Classify a product symbol to its market bucket (spot vs perps).
 *
 * Examples:
 *   marketForSymbol('BTC-USD')         === 'spot'
 *   marketForSymbol('ETH-PERP-INTX')   === 'perps'
 *   marketForSymbol('BTC-PERP-INTX')   === 'perps'
 */
export function marketForSymbol(symbol: string): Market {
  return symbol.includes('-PERP-') ? 'perps' : 'spot';
}
