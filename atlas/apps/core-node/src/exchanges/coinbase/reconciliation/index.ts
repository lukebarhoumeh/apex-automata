/**
 * Coinbase Reconciliation Module
 * 
 * Provides:
 * - Order/fill reconciliation (keeps local state in sync via REST)
 * - Market data gap filling (fetches missing candles when WS drops)
 */

export * from './reconciler';
export * from './gap-filler';
