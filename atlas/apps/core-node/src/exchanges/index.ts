// Universal exchange adapter types
export * from './types';

// Exchange registry
export { ExchangeRegistry } from './exchange-registry';

// Adapters
export { CoinbaseAdapter } from './coinbase-adapter';
export { CoinbasePerpsAdapter } from './coinbase-perps-adapter';
export { HyperliquidAdapter } from './hyperliquid';
export type { HyperliquidConfig } from './hyperliquid/types';

// Re-export coinbase internals for backward compatibility
export { CoinbaseExchange } from './coinbase';
