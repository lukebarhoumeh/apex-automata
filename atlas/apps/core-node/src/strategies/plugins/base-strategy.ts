/**
 * BaseStrategy - Abstract base class for strategy plugins
 * 
 * Provides common functionality for all strategies:
 * - Configuration management
 * - Signal generation helpers
 * - Statistics tracking
 * - Regime compatibility checking
 */

import { v4 as uuidv4 } from 'uuid';
import {
  StrategyPlugin,
  StrategySignal,
  MarketContext,
  StrategyConfigSchema,
  ConfigParameter,
  RegimeCompatibility,
  IndicatorRequirement,
} from './types';
import { MarketRegime } from '../regime-detector';

export abstract class BaseStrategy implements StrategyPlugin {
  // ============ Metadata (must be overridden) ============
  abstract readonly id: string;
  abstract readonly name: string;
  abstract readonly description: string;
  abstract readonly version: string;
  abstract readonly author: string;
  abstract readonly category: 'trend' | 'mean-reversion' | 'momentum' | 'volatility' | 'hybrid';
  abstract readonly tags: string[];
  abstract readonly configSchema: StrategyConfigSchema;
  abstract readonly requiredIndicators: IndicatorRequirement[];
  abstract readonly regimeCompatibility: RegimeCompatibility[];

  // ============ State ============
  enabled: boolean = true;
  config: Record<string, unknown> = {};
  
  // Statistics
  protected stats = {
    signalsGenerated: 0,
    lastSignalTime: undefined as Date | undefined,
    signalsByDirection: { buy: 0, sell: 0 },
    avgSignalStrength: 0,
  };

  constructor(config?: Record<string, unknown>) {
    // Note: configSchema is defined in subclass, so we can't call initializeDefaults here
    // Instead, subclasses should call super() then call initializeWithConfig()
    // Store config for later initialization
    this._pendingConfig = config;
  }

  private _pendingConfig?: Record<string, unknown>;
  private _initialized = false;

  /**
   * Initialize the strategy with its config schema.
   * Must be called after subclass constructor sets configSchema.
   */
  protected initializeWithConfig(): void {
    if (this._initialized) return;
    this._initialized = true;

    // Initialize with defaults from schema
    if (this.configSchema?.parameters) {
      for (const param of this.configSchema.parameters) {
        this.config[param.key] = param.default;
      }
    }
    
    // Apply provided config
    if (this._pendingConfig) {
      this.updateConfig(this._pendingConfig);
      this._pendingConfig = undefined;
    }
  }

  /**
   * Ensure strategy is initialized before accessing config.
   */
  private ensureInitialized(): void {
    if (!this._initialized) {
      this.initializeWithConfig();
    }
  }

  /**
   * Update configuration with validation.
   */
  public updateConfig(newConfig: Record<string, unknown>): void {
    for (const [key, value] of Object.entries(newConfig)) {
      const param = this.configSchema.parameters.find(p => p.key === key);
      if (param) {
        // Validate value
        if (this.validateParam(param, value)) {
          this.config[key] = value;
        }
      }
    }
    
    this.onConfigUpdate?.(this.config);
  }

  /**
   * Validate a configuration parameter value.
   */
  protected validateParam(param: ConfigParameter, value: unknown): boolean {
    // Type check
    switch (param.type) {
      case 'number':
      case 'range':
        if (typeof value !== 'number') return false;
        if (param.min !== undefined && value < param.min) return false;
        if (param.max !== undefined && value > param.max) return false;
        break;
      case 'boolean':
        if (typeof value !== 'boolean') return false;
        break;
      case 'string':
        if (typeof value !== 'string') return false;
        break;
      case 'select':
        if (!param.options?.some(o => o.value === value)) return false;
        break;
    }

    // Custom validation
    if (param.validate) {
      const result = param.validate(value);
      if (result !== true) return false;
    }

    return true;
  }

  /**
   * Get a typed config value.
   */
  protected getConfig<T>(key: string, defaultValue: T): T {
    this.ensureInitialized();
    const value = this.config[key];
    return value !== undefined ? (value as T) : defaultValue;
  }

  // ============ Abstract method ============
  
  /**
   * Core signal generation logic - must be implemented by each strategy.
   */
  abstract generateSignals(context: MarketContext): StrategySignal[];

  // ============ Helpers ============

  /**
   * Create a signal with proper structure.
   */
  protected createSignal(params: {
    context: MarketContext;
    direction: 'buy' | 'sell';
    strength: number;
    stopLoss: number;
    takeProfit: number;
    reason: string;
    indicators?: Record<string, number>;
    metadata?: Record<string, unknown>;
  }): StrategySignal {
    const signal: StrategySignal = {
      id: uuidv4(),
      timestamp: new Date(),
      symbol: params.context.symbol,
      strategy: this.id,
      direction: params.direction,
      strength: Math.max(0, Math.min(1, params.strength)), // Clamp 0-1
      price: params.context.latestCandle.close,
      stopLoss: params.stopLoss,
      takeProfit: params.takeProfit,
      metadata: {
        indicators: params.indicators || {},
        reason: params.reason,
        ...params.metadata,
      },
    };

    // Update stats
    this.stats.signalsGenerated++;
    this.stats.lastSignalTime = signal.timestamp;
    this.stats.signalsByDirection[params.direction]++;
    this.stats.avgSignalStrength = 
      (this.stats.avgSignalStrength * (this.stats.signalsGenerated - 1) + params.strength) / 
      this.stats.signalsGenerated;

    return signal;
  }

  /**
   * Check if strategy is compatible with current regime.
   */
  protected checkRegimeCompatibility(regime: MarketRegime): {
    compatible: boolean;
    multiplier: number;
    compatibility: RegimeCompatibility | undefined;
  } {
    const compat = this.regimeCompatibility.find(rc => rc.regime === regime);
    
    if (!compat) {
      return { compatible: true, multiplier: 0.5, compatibility: undefined };
    }

    return {
      compatible: compat.compatibility !== 'incompatible',
      multiplier: compat.positionMultiplier,
      compatibility: compat,
    };
  }

  /**
   * Validate that context has required indicators.
   */
  public validateContext(context: MarketContext): { valid: boolean; reason?: string } {
    for (const req of this.requiredIndicators) {
      if (req.required) {
        const indicator = context.indicators[req.name];
        if (!indicator || indicator.length === 0) {
          return { 
            valid: false, 
            reason: `Missing required indicator: ${req.name}` 
          };
        }
      }
    }

    if (context.candles.length < 50) {
      return { valid: false, reason: 'Insufficient candle data (need 50+)' };
    }

    return { valid: true };
  }

  /**
   * Get latest indicator value safely.
   */
  protected getLatestIndicator(indicators: Record<string, number[]>, key: string): number | undefined {
    const values = indicators[key];
    if (!values || values.length === 0) return undefined;
    return values[values.length - 1];
  }

  /**
   * Get previous indicator value safely.
   */
  protected getPrevIndicator(indicators: Record<string, number[]>, key: string, offset = 1): number | undefined {
    const values = indicators[key];
    if (!values || values.length <= offset) return undefined;
    return values[values.length - 1 - offset];
  }

  /**
   * Calculate ATR-based stop loss distance.
   */
  protected calculateATRStop(atr: number, multiplier: number, direction: 'buy' | 'sell', price: number): number {
    const distance = atr * multiplier;
    return direction === 'buy' ? price - distance : price + distance;
  }

  /**
   * Calculate ATR-based take profit distance.
   */
  protected calculateATRTarget(atr: number, multiplier: number, direction: 'buy' | 'sell', price: number): number {
    const distance = atr * multiplier;
    return direction === 'buy' ? price + distance : price - distance;
  }

  // ============ Lifecycle ============

  async initialize(): Promise<void> {
    // Default: no-op, override if needed
  }

  async shutdown(): Promise<void> {
    // Default: no-op, override if needed
  }

  onConfigUpdate?(newConfig: Record<string, unknown>): void;

  // ============ Introspection ============

  getState(): Record<string, unknown> {
    return {
      id: this.id,
      enabled: this.enabled,
      config: { ...this.config },
    };
  }

  getStats() {
    return { ...this.stats };
  }
}

