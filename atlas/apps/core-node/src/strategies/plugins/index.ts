/**
 * Strategy Plugin System - Main Export
 * 
 * Provides the complete plugin architecture for modular strategies.
 */

// Types
export * from './types';

// Base class
export { BaseStrategy } from './base-strategy';

// Registry
export { StrategyRegistry } from './strategy-registry';
export type { StrategyRegistryConfig } from './strategy-registry';

// Built-in strategies
export * from './builtin';

