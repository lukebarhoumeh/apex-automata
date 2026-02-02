/**
 * StrategyRegistry - Central registry for strategy plugins
 * 
 * Manages:
 * - Strategy plugin registration/discovery
 * - Plugin lifecycle (enable/disable/reload)
 * - Configuration management
 * - Signal orchestration
 */

import { EventEmitter } from 'events';
import { Logger } from '../../core/logger';
import {
  StrategyPlugin,
  StrategySignal,
  MarketContext,
  StrategyRegistration,
  StrategyRegistryEvents,
} from './types';
import { Counter, Gauge, Histogram } from 'prom-client';

// Prometheus metrics
const strategiesRegisteredGauge = new Gauge({
  name: 'atlas_strategies_registered_total',
  help: 'Total number of registered strategies',
});

const strategiesEnabledGauge = new Gauge({
  name: 'atlas_strategies_enabled_total',
  help: 'Total number of enabled strategies',
});

const strategySignalsCounter = new Counter({
  name: 'atlas_strategy_signals_generated_total',
  help: 'Total signals generated per strategy',
  labelNames: ['strategy', 'direction'],
});

const strategyExecutionHistogram = new Histogram({
  name: 'atlas_strategy_execution_duration_seconds',
  help: 'Strategy signal generation execution time',
  labelNames: ['strategy'],
  buckets: [0.0001, 0.0005, 0.001, 0.005, 0.01, 0.05, 0.1],
});

const strategyErrorCounter = new Counter({
  name: 'atlas_strategy_errors_total',
  help: 'Total errors per strategy',
  labelNames: ['strategy'],
});

export interface StrategyRegistryConfig {
  maxErrorsBeforeDisable: number;  // Auto-disable after N errors
  signalDedupeWindowMs: number;    // Dedupe window for same strategy/symbol
}

const DEFAULT_CONFIG: StrategyRegistryConfig = {
  maxErrorsBeforeDisable: 5,
  signalDedupeWindowMs: 300000, // 5 minutes
};

export class StrategyRegistry extends EventEmitter {
  private config: StrategyRegistryConfig;
  private logger: Logger;
  
  // Registered strategies
  private strategies: Map<string, StrategyRegistration> = new Map();
  
  // Signal deduplication
  private recentSignals: Map<string, { signal: StrategySignal; expiry: number }> = new Map();
  
  constructor(config: Partial<StrategyRegistryConfig>, logger: Logger) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.logger = logger;
  }

  /**
   * Register a strategy plugin.
   */
  public register(plugin: StrategyPlugin): boolean {
    if (this.strategies.has(plugin.id)) {
      this.logger.warn(`Strategy ${plugin.id} already registered, skipping`);
      return false;
    }

    // Initialize if needed
    if (plugin.initialize) {
      plugin.initialize().catch(err => {
        this.logger.error(`Failed to initialize strategy ${plugin.id}:`, err);
        this.emit('strategy:error', plugin.id, err);
      });
    }

    const registration: StrategyRegistration = {
      plugin,
      loadTime: new Date(),
      enabled: plugin.enabled,
      errorCount: 0,
    };

    this.strategies.set(plugin.id, registration);
    strategiesRegisteredGauge.set(this.strategies.size);
    this.updateEnabledCount();

    this.logger.info(`Strategy registered: ${plugin.id}`, {
      name: plugin.name,
      version: plugin.version,
      category: plugin.category,
      enabled: plugin.enabled,
    });

    this.emit('strategy:registered', plugin);
    return true;
  }

  /**
   * Unregister a strategy plugin.
   */
  public async unregister(strategyId: string): Promise<boolean> {
    const registration = this.strategies.get(strategyId);
    if (!registration) {
      return false;
    }

    // Shutdown if needed
    if (registration.plugin.shutdown) {
      try {
        await registration.plugin.shutdown();
      } catch (err) {
        this.logger.error(`Error shutting down strategy ${strategyId}:`, err);
      }
    }

    this.strategies.delete(strategyId);
    strategiesRegisteredGauge.set(this.strategies.size);
    this.updateEnabledCount();

    this.logger.info(`Strategy unregistered: ${strategyId}`);
    this.emit('strategy:unregistered', strategyId);
    return true;
  }

  /**
   * Enable a strategy.
   */
  public enable(strategyId: string): boolean {
    const registration = this.strategies.get(strategyId);
    if (!registration) {
      return false;
    }

    registration.enabled = true;
    registration.plugin.enabled = true;
    registration.errorCount = 0; // Reset error count
    this.updateEnabledCount();

    this.logger.info(`Strategy enabled: ${strategyId}`);
    this.emit('strategy:enabled', strategyId);
    return true;
  }

  /**
   * Disable a strategy.
   */
  public disable(strategyId: string): boolean {
    const registration = this.strategies.get(strategyId);
    if (!registration) {
      return false;
    }

    registration.enabled = false;
    registration.plugin.enabled = false;
    this.updateEnabledCount();

    this.logger.info(`Strategy disabled: ${strategyId}`);
    this.emit('strategy:disabled', strategyId);
    return true;
  }

  /**
   * Update strategy configuration.
   */
  public updateConfig(strategyId: string, config: Record<string, unknown>): boolean {
    const registration = this.strategies.get(strategyId);
    if (!registration) {
      return false;
    }

    // Merge with existing config
    const plugin = registration.plugin;
    const newConfig = { ...plugin.config, ...config };
    
    // Apply to plugin
    plugin.config = newConfig;
    if (plugin.onConfigUpdate) {
      plugin.onConfigUpdate(newConfig);
    }

    this.logger.info(`Strategy config updated: ${strategyId}`, { config });
    this.emit('strategy:config_updated', strategyId, newConfig);
    return true;
  }

  /**
   * Get a strategy by ID.
   */
  public get(strategyId: string): StrategyPlugin | undefined {
    return this.strategies.get(strategyId)?.plugin;
  }

  /**
   * Get all registered strategies.
   */
  public getAll(): StrategyPlugin[] {
    return Array.from(this.strategies.values()).map(r => r.plugin);
  }

  /**
   * Get all enabled strategies.
   */
  public getEnabled(): StrategyPlugin[] {
    return Array.from(this.strategies.values())
      .filter(r => r.enabled)
      .map(r => r.plugin);
  }

  /**
   * Get strategies by category.
   */
  public getByCategory(category: string): StrategyPlugin[] {
    return this.getAll().filter(s => s.category === category);
  }

  /**
   * Generate signals from all enabled strategies.
   * 
   * @param context - Market context to pass to strategies
   * @param parallelExecution - Whether to run strategies in parallel
   * @returns Array of generated signals
   */
  public generateSignals(context: MarketContext, parallelExecution = false): StrategySignal[] {
    const enabledStrategies = this.getEnabled();
    const allSignals: StrategySignal[] = [];

    // Clean up expired signals from dedupe cache
    this.cleanupExpiredSignals();

    if (parallelExecution) {
      // Parallel execution (careful with shared state)
      const results = enabledStrategies.map(strategy => {
        return this.executeStrategy(strategy, context);
      });
      
      for (const signals of results) {
        allSignals.push(...signals);
      }
    } else {
      // Sequential execution (safer, deterministic)
      for (const strategy of enabledStrategies) {
        const signals = this.executeStrategy(strategy, context);
        allSignals.push(...signals);
      }
    }

    // Deduplicate signals
    const uniqueSignals = this.deduplicateSignals(allSignals, context.symbol);

    return uniqueSignals;
  }

  /**
   * Execute a single strategy and handle errors.
   */
  private executeStrategy(strategy: StrategyPlugin, context: MarketContext): StrategySignal[] {
    const registration = this.strategies.get(strategy.id);
    if (!registration) return [];

    const startTime = process.hrtime.bigint();

    try {
      // Validate context if strategy supports it
      if (strategy.validateContext) {
        const validation = strategy.validateContext(context);
        if (!validation.valid) {
          this.logger.debug(`Strategy ${strategy.id} context invalid: ${validation.reason}`);
          return [];
        }
      }

      // Check regime compatibility
      const regimeCompat = strategy.regimeCompatibility.find(
        rc => rc.regime === context.regime.regime
      );
      
      if (regimeCompat?.compatibility === 'incompatible') {
        this.logger.debug(`Strategy ${strategy.id} incompatible with ${context.regime.regime} regime`);
        return [];
      }

      // Generate signals
      const signals = strategy.generateSignals(context);
      
      // AGGRESSIVE DEBUG: Log every strategy execution
      if (signals.length > 0) {
        this.logger.info(`Strategy ${strategy.id} generated ${signals.length} signal(s)`, { symbol: context.symbol, regime: context.regime.regime });
      } else {
        this.logger.debug(`Strategy ${strategy.id} returned 0 signals`, { symbol: context.symbol, regime: context.regime.regime });
      }

      // Record execution time
      const duration = Number(process.hrtime.bigint() - startTime) / 1e9;
      strategyExecutionHistogram.observe({ strategy: strategy.id }, duration);

      // Record signal metrics
      for (const signal of signals) {
        strategySignalsCounter.inc({ strategy: strategy.id, direction: signal.direction });
      }

      // Reset error count on success
      registration.errorCount = 0;

      return signals;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      
      // Record error
      registration.errorCount++;
      registration.lastError = { message: err.message, timestamp: new Date() };
      strategyErrorCounter.inc({ strategy: strategy.id });

      this.logger.error(`Strategy ${strategy.id} error:`, err);
      this.emit('strategy:error', strategy.id, err);

      // Auto-disable if too many errors
      if (registration.errorCount >= this.config.maxErrorsBeforeDisable) {
        this.logger.warn(`Auto-disabling strategy ${strategy.id} after ${registration.errorCount} errors`);
        this.disable(strategy.id);
      }

      return [];
    }
  }

  /**
   * Deduplicate signals within the dedupe window.
   */
  private deduplicateSignals(signals: StrategySignal[], symbol: string): StrategySignal[] {
    const unique: StrategySignal[] = [];
    const now = Date.now();

    for (const signal of signals) {
      const key = `${signal.strategy}:${signal.symbol}:${signal.direction}`;
      const existing = this.recentSignals.get(key);

      if (!existing || existing.expiry < now) {
        // No recent signal, this one is unique
        unique.push(signal);
        this.recentSignals.set(key, {
          signal,
          expiry: now + this.config.signalDedupeWindowMs,
        });
      }
      // Else: duplicate within window, skip
    }

    return unique;
  }

  /**
   * Clean up expired signals from dedupe cache.
   */
  private cleanupExpiredSignals(): void {
    const now = Date.now();
    for (const [key, entry] of this.recentSignals) {
      if (entry.expiry < now) {
        this.recentSignals.delete(key);
      }
    }
  }

  /**
   * Update enabled strategy count metric.
   */
  private updateEnabledCount(): void {
    const count = Array.from(this.strategies.values()).filter(r => r.enabled).length;
    strategiesEnabledGauge.set(count);
  }

  // ============ Introspection ============

  /**
   * Get registry statistics.
   */
  public getStats(): {
    total: number;
    enabled: number;
    byCategory: Record<string, number>;
    strategies: {
      id: string;
      name: string;
      enabled: boolean;
      category: string;
      errorCount: number;
      signalsGenerated: number;
    }[];
  } {
    const strategies = Array.from(this.strategies.entries()).map(([id, reg]) => ({
      id,
      name: reg.plugin.name,
      enabled: reg.enabled,
      category: reg.plugin.category,
      errorCount: reg.errorCount,
      signalsGenerated: reg.plugin.getStats?.()?.signalsGenerated ?? 0,
    }));

    const byCategory: Record<string, number> = {};
    for (const s of strategies) {
      byCategory[s.category] = (byCategory[s.category] || 0) + 1;
    }

    return {
      total: this.strategies.size,
      enabled: strategies.filter(s => s.enabled).length,
      byCategory,
      strategies,
    };
  }

  /**
   * Get detailed info for a strategy.
   */
  public getStrategyInfo(strategyId: string): {
    plugin: StrategyPlugin;
    registration: Omit<StrategyRegistration, 'plugin'>;
    stats: ReturnType<NonNullable<StrategyPlugin['getStats']>>;
    state: ReturnType<NonNullable<StrategyPlugin['getState']>>;
  } | undefined {
    const reg = this.strategies.get(strategyId);
    if (!reg) return undefined;

    return {
      plugin: reg.plugin,
      registration: {
        loadTime: reg.loadTime,
        enabled: reg.enabled,
        errorCount: reg.errorCount,
        lastError: reg.lastError,
      },
      stats: reg.plugin.getStats?.() ?? { signalsGenerated: 0 },
      state: reg.plugin.getState?.() ?? {},
    };
  }

  /**
   * Export all strategy configurations.
   */
  public exportConfigs(): Record<string, Record<string, unknown>> {
    const configs: Record<string, Record<string, unknown>> = {};
    for (const [id, reg] of this.strategies) {
      configs[id] = {
        enabled: reg.enabled,
        ...reg.plugin.config,
      };
    }
    return configs;
  }

  /**
   * Import strategy configurations.
   */
  public importConfigs(configs: Record<string, Record<string, unknown>>): void {
    for (const [id, config] of Object.entries(configs)) {
      const reg = this.strategies.get(id);
      if (reg) {
        const { enabled, ...strategyConfig } = config;
        
        if (typeof enabled === 'boolean') {
          if (enabled) {
            this.enable(id);
          } else {
            this.disable(id);
          }
        }
        
        this.updateConfig(id, strategyConfig);
      }
    }
  }

  /**
   * Shutdown all strategies.
   */
  public async shutdown(): Promise<void> {
    for (const [id, reg] of this.strategies) {
      if (reg.plugin.shutdown) {
        try {
          await reg.plugin.shutdown();
        } catch (err) {
          this.logger.error(`Error shutting down strategy ${id}:`, err);
        }
      }
    }
  }
}

