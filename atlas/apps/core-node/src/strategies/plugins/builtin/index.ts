/**
 * Built-in Strategy Plugins Index
 * 
 * Export all built-in strategy plugins and provide a factory function
 * for creating instances with configuration.
 */

import { StrategyPlugin } from '../types';
import { BreakoutStrategy } from './breakout-strategy';
import { VWAPMeanReversionStrategy } from './vwap-mr-strategy';
import { MomentumStrategy } from './momentum-strategy';

// Export individual strategies
export { BreakoutStrategy } from './breakout-strategy';
export { VWAPMeanReversionStrategy } from './vwap-mr-strategy';
export { MomentumStrategy } from './momentum-strategy';

/**
 * Registry of all built-in strategies.
 */
export const BUILTIN_STRATEGIES = {
  breakout: BreakoutStrategy,
  vwap_mr: VWAPMeanReversionStrategy,
  momentum: MomentumStrategy,
} as const;

/**
 * Get all built-in strategy IDs.
 */
export function getBuiltinStrategyIds(): string[] {
  return Object.keys(BUILTIN_STRATEGIES);
}

/**
 * Create all built-in strategy instances.
 */
export function createBuiltinStrategies(
  configs?: Record<string, Record<string, unknown>>
): StrategyPlugin[] {
  return Object.entries(BUILTIN_STRATEGIES).map(([id, StrategyClass]) => {
    const config = configs?.[id];
    return new StrategyClass(config);
  });
}

/**
 * Create a specific built-in strategy instance.
 */
export function createBuiltinStrategy(
  strategyId: keyof typeof BUILTIN_STRATEGIES,
  config?: Record<string, unknown>
): StrategyPlugin {
  const StrategyClass = BUILTIN_STRATEGIES[strategyId];
  if (!StrategyClass) {
    throw new Error(`Unknown built-in strategy: ${strategyId}`);
  }
  return new StrategyClass(config);
}

/**
 * Get metadata for all built-in strategies (without instantiating).
 */
export function getBuiltinStrategyMetadata(): {
  id: string;
  name: string;
  description: string;
  category: string;
  version: string;
}[] {
  return Object.entries(BUILTIN_STRATEGIES).map(([id, StrategyClass]) => {
    const instance = new StrategyClass();
    return {
      id: instance.id,
      name: instance.name,
      description: instance.description,
      category: instance.category,
      version: instance.version,
    };
  });
}

