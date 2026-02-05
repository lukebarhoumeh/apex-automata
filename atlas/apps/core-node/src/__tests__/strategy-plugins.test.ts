/**
 * Unit tests for Strategy Plugin System
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Logger } from '../core/logger';
import {
  StrategyRegistry,
  StrategyPlugin,
  MarketContext,
  StrategySignal,
  BaseStrategy,
  BreakoutStrategy,
  VWAPMeanReversionStrategy,
  MomentumStrategy,
  createBuiltinStrategies,
} from '../strategies/plugins';
import { OHLCV } from '../indicators/technical';
import { RegimeState, MarketRegime } from '../strategies/regime-detector';

// Mock logger
const mockLogger: Logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

// Helper to create mock OHLCV data
function generateCandles(count: number, basePrice: number): OHLCV[] {
  const candles: OHLCV[] = [];
  let price = basePrice;
  
  for (let i = 0; i < count; i++) {
    const change = (Math.random() - 0.5) * 100;
    price += change;
    
    candles.push({
      time: Date.now() - (count - i) * 60000,
      open: price - 10,
      high: price + 20,
      low: price - 25,
      close: price,
      volume: 100 + Math.random() * 200,
    });
  }
  
  return candles;
}

// Helper to create mock regime state
function createMockRegimeState(regime: MarketRegime = 'strong_trend'): RegimeState {
  return {
    regime,
    confidence: 0.8,
    adx: 35,
    chopIndex: 40,
    volatility: 0.02,
    trend: 0.5,
    mtfAlignment: 0.7,
    timestamp: new Date(),
    history: [],
  };
}

// Helper to create mock market context
function createMockContext(
  symbol: string = 'BTC-USD',
  regime: MarketRegime = 'strong_trend'
): MarketContext {
  const candles = generateCandles(100, 50000);
  const latestCandle = candles[candles.length - 1];
  const previousCandle = candles[candles.length - 2];

  // Create mock indicators
  const indicators: Record<string, number[]> = {
    donchianUpper: candles.map(c => c.high + 100),
    donchianLower: candles.map(c => c.low - 100),
    donchianMiddle: candles.map(c => (c.high + c.low) / 2),
    atr: candles.map(() => 150),
    volumeSMA: candles.map(() => 100),
    vwap: candles.map(c => c.close),
    rsi: candles.map(() => 50),
    macd: candles.map(() => 0),
    macdSignal: candles.map(() => 0),
    macdHistogram: candles.map(() => 0),
    bbUpper: candles.map(c => c.close + 200),
    bbMiddle: candles.map(c => c.close),
    bbLower: candles.map(c => c.close - 200),
  };

  const latestIndicators: Record<string, number> = {};
  for (const [key, values] of Object.entries(indicators)) {
    latestIndicators[key] = values[values.length - 1];
  }

  return {
    symbol,
    timestamp: new Date(),
    candles,
    indicators,
    latestIndicators,
    latestCandle,
    previousCandle,
    regime: createMockRegimeState(regime),
  };
}

describe('StrategyPlugin System', () => {
  describe('BreakoutStrategy', () => {
    let strategy: BreakoutStrategy;

    beforeEach(() => {
      strategy = new BreakoutStrategy();
    });

    it('should have correct metadata', () => {
      expect(strategy.id).toBe('breakout');
      expect(strategy.name).toBe('Donchian Breakout');
      expect(strategy.category).toBe('trend');
      expect(strategy.version).toBe('1.0.0');
    });

    it('should have config schema with parameters', () => {
      expect(strategy.configSchema.parameters.length).toBeGreaterThan(0);
      expect(strategy.configSchema.parameters.find(p => p.key === 'period')).toBeDefined();
      expect(strategy.configSchema.parameters.find(p => p.key === 'volumeThreshold')).toBeDefined();
    });

    it('should have regime compatibility defined', () => {
      expect(strategy.regimeCompatibility.length).toBe(4);
      
      const trendCompat = strategy.regimeCompatibility.find(r => r.regime === 'strong_trend');
      expect(trendCompat?.compatibility).toBe('optimal');
      
      // AGGRESSIVE config: choppy is now 'neutral' to allow signals with reduced size
      const choppyCompat = strategy.regimeCompatibility.find(r => r.regime === 'choppy');
      expect(choppyCompat?.compatibility).toBe('neutral');
    });

    it('should validate context correctly', () => {
      const validContext = createMockContext();
      const result = strategy.validateContext(validContext);
      expect(result.valid).toBe(true);

      // Test with insufficient candles
      const invalidContext = { ...validContext, candles: validContext.candles.slice(0, 10) };
      const invalidResult = strategy.validateContext(invalidContext);
      expect(invalidResult.valid).toBe(false);
    });

    it('should initialize with default config', () => {
      // AGGRESSIVE defaults: shorter period, lower volume threshold
      expect(strategy.config.period).toBe(10);
      expect(strategy.config.volumeThreshold).toBe(0.5);
      expect(strategy.config.atrMultiplier).toBe(2.0);
    });

    it('should accept custom config', () => {
      const customStrategy = new BreakoutStrategy({
        period: 30,
        volumeThreshold: 1.5,
      });
      
      expect(customStrategy.config.period).toBe(30);
      expect(customStrategy.config.volumeThreshold).toBe(1.5);
    });

    it('should generate signals array (may be empty)', () => {
      const context = createMockContext();
      const signals = strategy.generateSignals(context);
      
      expect(Array.isArray(signals)).toBe(true);
    });

    it('should track signal statistics', () => {
      const context = createMockContext();
      strategy.generateSignals(context);
      
      const stats = strategy.getStats();
      expect(stats).toBeDefined();
      expect(typeof stats.signalsGenerated).toBe('number');
    });
  });

  describe('VWAPMeanReversionStrategy', () => {
    let strategy: VWAPMeanReversionStrategy;

    beforeEach(() => {
      strategy = new VWAPMeanReversionStrategy();
    });

    it('should have correct metadata', () => {
      expect(strategy.id).toBe('vwap_mr');
      expect(strategy.category).toBe('mean-reversion');
    });

    it('should favor ranging markets', () => {
      const rangingCompat = strategy.regimeCompatibility.find(r => r.regime === 'ranging');
      expect(rangingCompat?.compatibility).toBe('optimal');
      
      const trendCompat = strategy.regimeCompatibility.find(r => r.regime === 'strong_trend');
      expect(trendCompat?.compatibility).toBe('incompatible');
    });
  });

  describe('MomentumStrategy', () => {
    let strategy: MomentumStrategy;

    beforeEach(() => {
      strategy = new MomentumStrategy();
    });

    it('should have correct metadata', () => {
      expect(strategy.id).toBe('momentum');
      expect(strategy.category).toBe('momentum');
    });

    it('should have RSI/MACD config parameters', () => {
      expect(strategy.config.rsiPeriod).toBe(14);
      // AGGRESSIVE defaults: wider trigger zones
      expect(strategy.config.rsiOversold).toBe(40);
      expect(strategy.config.rsiOverbought).toBe(60);
      expect(strategy.config.macdFast).toBe(12);
    });
  });

  describe('StrategyRegistry', () => {
    let registry: StrategyRegistry;

    beforeEach(() => {
      registry = new StrategyRegistry({}, mockLogger);
    });

    it('should register strategies', () => {
      const strategy = new BreakoutStrategy();
      const result = registry.register(strategy);
      
      expect(result).toBe(true);
      expect(registry.getAll().length).toBe(1);
    });

    it('should prevent duplicate registration', () => {
      const strategy1 = new BreakoutStrategy();
      const strategy2 = new BreakoutStrategy();
      
      registry.register(strategy1);
      const result = registry.register(strategy2);
      
      expect(result).toBe(false);
      expect(registry.getAll().length).toBe(1);
    });

    it('should enable and disable strategies', () => {
      const strategy = new BreakoutStrategy();
      registry.register(strategy);
      
      expect(registry.getEnabled().length).toBe(1);
      
      registry.disable('breakout');
      expect(registry.getEnabled().length).toBe(0);
      
      registry.enable('breakout');
      expect(registry.getEnabled().length).toBe(1);
    });

    it('should update strategy config', () => {
      const strategy = new BreakoutStrategy();
      registry.register(strategy);
      
      registry.updateConfig('breakout', { period: 30 });
      
      const updated = registry.get('breakout');
      expect(updated?.config.period).toBe(30);
    });

    it('should unregister strategies', async () => {
      const strategy = new BreakoutStrategy();
      registry.register(strategy);
      
      const result = await registry.unregister('breakout');
      
      expect(result).toBe(true);
      expect(registry.getAll().length).toBe(0);
    });

    it('should generate signals from all enabled strategies', () => {
      const breakout = new BreakoutStrategy();
      const momentum = new MomentumStrategy();
      
      registry.register(breakout);
      registry.register(momentum);
      
      const context = createMockContext();
      const signals = registry.generateSignals(context);
      
      expect(Array.isArray(signals)).toBe(true);
    });

    it('should filter incompatible strategies based on regime', () => {
      const vwapMr = new VWAPMeanReversionStrategy();
      registry.register(vwapMr);
      
      // Strong trend - VWAP MR is incompatible
      const trendContext = createMockContext('BTC-USD', 'strong_trend');
      const signals = registry.generateSignals(trendContext);
      
      // Should not generate signals (regime incompatible)
      expect(signals.length).toBe(0);
    });

    it('should export and import configs', () => {
      const strategies = createBuiltinStrategies();
      for (const s of strategies) {
        registry.register(s);
      }
      
      // Modify config
      registry.updateConfig('breakout', { period: 25 });
      registry.disable('momentum');
      
      // Export
      const exported = registry.exportConfigs();
      expect(exported.breakout.period).toBe(25);
      expect(exported.momentum.enabled).toBe(false);
      
      // Create new registry and import
      const newRegistry = new StrategyRegistry({}, mockLogger);
      const newStrategies = createBuiltinStrategies();
      for (const s of newStrategies) {
        newRegistry.register(s);
      }
      newRegistry.importConfigs(exported);
      
      expect(newRegistry.get('breakout')?.config.period).toBe(25);
      expect(newRegistry.getEnabled().find(s => s.id === 'momentum')).toBeUndefined();
    });

    it('should get registry statistics', () => {
      const strategies = createBuiltinStrategies();
      for (const s of strategies) {
        registry.register(s);
      }
      
      registry.disable('momentum');
      
      const stats = registry.getStats();
      
      // 4 built-in strategies: breakout, vwap_mr, momentum, trend_follow
      expect(stats.total).toBe(4);
      expect(stats.enabled).toBe(3);
      expect(stats.strategies.length).toBe(4);
      expect(stats.byCategory['trend']).toBe(2); // breakout + trend_follow
      expect(stats.byCategory['mean-reversion']).toBe(1);
      expect(stats.byCategory['momentum']).toBe(1);
    });
  });

  describe('createBuiltinStrategies', () => {
    it('should create all built-in strategies', () => {
      const strategies = createBuiltinStrategies();
      
      // 4 built-in strategies: breakout, vwap_mr, momentum, trend_follow
      expect(strategies.length).toBe(4);
      expect(strategies.find(s => s.id === 'breakout')).toBeDefined();
      expect(strategies.find(s => s.id === 'vwap_mr')).toBeDefined();
      expect(strategies.find(s => s.id === 'momentum')).toBeDefined();
      expect(strategies.find(s => s.id === 'trend_follow')).toBeDefined();
    });

    it('should apply custom configs', () => {
      const strategies = createBuiltinStrategies({
        breakout: { period: 30 },
        momentum: { rsiPeriod: 21 },
      });
      
      const breakout = strategies.find(s => s.id === 'breakout');
      const momentum = strategies.find(s => s.id === 'momentum');
      
      expect(breakout?.config.period).toBe(30);
      expect(momentum?.config.rsiPeriod).toBe(21);
    });
  });
});

