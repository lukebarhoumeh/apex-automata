/**
 * Execution Adapter Module
 * 
 * Provides unified execution interface for both paper and live trading.
 * The key abstraction that makes paper behave like live.
 */

export * from './execution-adapter';
export * from './coinbase-live-adapter';
export * from './coinbase-advanced-adapter';
export * from './paper-adapter';
export * from './adapter-factory';
