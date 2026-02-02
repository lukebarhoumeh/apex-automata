/**
 * Built-in Strategy Plugins Index
 * 
 * Export all built-in strategy plugins and provide a factory function
 * for creating instances with configuration.
 */

import { StrategyPlugin, PerSymbolOverrides } from '../types';
import { BaseStrategy } from '../base-strategy';
import { BreakoutStrategy } from './breakout-strategy';
import { VWAPMeanReversionStrategy } from './vwap-mr-strategy';
import { MomentumStrategy } from './momentum-strategy';
import { TrendFollowStrategy } from './trend-follow-strategy';

// Export individual strategies
export { BreakoutStrategy } from './breakout-strategy';
export { VWAPMeanReversionStrategy } from './vwap-mr-strategy';
export { MomentumStrategy } from './momentum-strategy';
export { TrendFollowStrategy } from './trend-follow-strategy';

/**
 * Registry of all built-in strategies.
 */
export const BUILTIN_STRATEGIES = {
  breakout: BreakoutStrategy,
  vwap_mr: VWAPMeanReversionStrategy,
  momentum: MomentumStrategy,
  trend_follow: TrendFollowStrategy,
} as const;

/**
 * Get all built-in strategy IDs.
 */
export function getBuiltinStrategyIds(): string[] {
  return Object.keys(BUILTIN_STRATEGIES);
}

/**
 * Per-symbol strategy overrides configuration.
 * Keyed by symbol, then by strategy ID, then by parameter.
 * 
 * Example:
 * {
 *   'BTC-USD': { breakout: { atrMultiplier: 1.8 }, momentum: { atrMultiplier: 1.8 } },
 *   'SOL-USD': { breakout: { atrMultiplier: 2.5 } }
 * }
 */
export type PerSymbolStrategyOverrides = Record<string, Record<string, Record<string, unknown>>>;

/**
 * Create all built-in strategy instances.
 * 
 * @param configs - Optional global configs per strategy
 * @param perSymbolOverrides - Optional per-symbol parameter overrides
 */
export function createBuiltinStrategies(
  configs?: Record<string, Record<string, unknown>>,
  perSymbolOverrides?: PerSymbolStrategyOverrides
): StrategyPlugin[] {
  return Object.entries(BUILTIN_STRATEGIES).map(([id, StrategyClass]) => {
    const config = configs?.[id];
    const strategy = new StrategyClass(config);
    
    // Load per-symbol overrides if provided
    if (perSymbolOverrides && strategy instanceof BaseStrategy) {
      const strategyOverrides: PerSymbolOverrides = {};
      
      // Transform from { symbol: { strategy: { params } } } to { symbol: { params } }
      for (const [symbol, strategyConfigs] of Object.entries(perSymbolOverrides)) {
        if (strategyConfigs[id]) {
          strategyOverrides[symbol] = strategyConfigs[id];
        }
      }
      
      if (Object.keys(strategyOverrides).length > 0) {
        strategy.loadSymbolOverrides(strategyOverrides);
      }
    }
    
    return strategy;
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

