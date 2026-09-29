import { describe, test, expect, beforeEach, vi } from 'vitest';
import { SignalProcessor, SignalProcessorConfig } from '../strategies/signal-processor';
import { OHLCV } from '../indicators/technical';
import type { MarketContext, StrategyPlugin } from '../strategies/plugins/types';

// Mock logger
const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

// Mock Supabase client
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: () => ({
      insert: () => ({ error: null }),
    }),
  }),
}));

describe('SignalProcessor', () => {
  let signalProcessor: SignalProcessor;
  const config: SignalProcessorConfig = {
    supabaseUrl: 'http://localhost:54321',
    supabaseKey: 'test-key',
    strategies: {
      breakout: {
        enabled: true,
        period: 20,
        atrPeriod: 14,
        atrMultiplier: 1.5,
        volumeThreshold: 1.5,
      },
      vwapMeanReversion: {
        enabled: true,
        deviationEntry: 2,
        deviationExit: 0.5,
        minVolume: 1000,
      },
      momentum: {
        enabled: true,
        rsiPeriod: 14,
        rsiOverbought: 70,
        rsiOversold: 30,
        macdFast: 12,
        macdSlow: 26,
        macdSignal: 9,
      },
    },
    metaLabeling: {
      enabled: false,
      threshold: 0.5,
    },
  };

  beforeEach(() => {
    signalProcessor = new SignalProcessor(config, mockLogger as any);
  });

  describe('Candle Management', () => {
    test('should add candles correctly', () => {
      const candle: OHLCV = {
        time: Date.now(),
        open: 100,
        high: 105,
        low: 99,
        close: 103,
        volume: 1000,
      };

      signalProcessor.addCandle('BTC-USD', candle);
      expect(signalProcessor.getCandleCount('BTC-USD')).toBe(1);
    });

    test('should maintain max candle buffer size', () => {
      for (let i = 0; i < 600; i++) {
        signalProcessor.addCandle('BTC-USD', {
          time: Date.now() + i * 60000,
          open: 100 + i,
          high: 105 + i,
          low: 99 + i,
          close: 103 + i,
          volume: 1000,
        });
      }
      // Should keep only 500 candles
      expect(signalProcessor.getCandleCount('BTC-USD')).toBe(500);
    });
  });

  describe('Warmup', () => {
    test('should not be warmed up with insufficient candles', () => {
      for (let i = 0; i < 10; i++) {
        signalProcessor.addCandle('BTC-USD', {
          time: Date.now() + i * 60000,
          open: 100,
          high: 105,
          low: 99,
          close: 103,
          volume: 1000,
        });
      }
      expect(signalProcessor.isWarmupComplete('BTC-USD')).toBe(false);
    });

    test('should be warmed up with sufficient candles', () => {
      for (let i = 0; i < 60; i++) {
        signalProcessor.addCandle('BTC-USD', {
          time: Date.now() + i * 60000,
          open: 100,
          high: 105,
          low: 99,
          close: 103,
          volume: 1000,
        });
      }
      expect(signalProcessor.isWarmupComplete('BTC-USD')).toBe(true);
    });
  });

  describe('Donchian Breakout Strategy', () => {
    test('should generate buy signal on upper channel breakout', async () => {
      const signals: any[] = [];
      signalProcessor.on('signal:generated', (signal) => signals.push(signal));

      // Feed candles to build Donchian channel
      const basePrice = 100;
      for (let i = 0; i < 25; i++) {
        signalProcessor.addCandle('BTC-USD', {
          time: Date.now() + i * 60000,
          open: basePrice,
          high: basePrice + 2,
          low: basePrice - 2,
          close: basePrice,
          volume: 1000,
        });
      }

      // Add breakout candle - price above upper channel
      signalProcessor.addCandle('BTC-USD', {
        time: Date.now() + 25 * 60000,
        open: basePrice,
        high: basePrice + 10,
        low: basePrice,
        close: basePrice + 8,
        volume: 2000, // High volume
      });

      // Check for breakout signal
      expect(signalProcessor.getCandleCount('BTC-USD')).toBe(26);
    });
  });

  describe('openPosition book hint (setOpenPositionProvider)', () => {
    /** Probe plugin: records the `openPosition` hint it is handed on every bar. */
    function probePlugin(seen: Array<MarketContext['openPosition']>): StrategyPlugin {
      return {
        id: 'probe_open_position',
        name: 'probe',
        description: 'records context.openPosition',
        version: '0.0.1',
        author: 'test',
        category: 'trend',
        tags: [],
        enabled: true,
        configSchema: { parameters: [] },
        config: {},
        requiredIndicators: [],
        regimeCompatibility: [],
        generateSignals(context: MarketContext) {
          seen.push(context.openPosition);
          return [];
        },
      };
    }

    function feed(sp: SignalProcessor, symbol: string, from: number, count: number): void {
      for (let i = from; i < from + count; i++) {
        sp.addCandle(symbol, {
          time: 1_700_000_000_000 + i * 60_000,
          open: 100,
          high: 101 + (i % 3),
          low: 99 - (i % 2),
          close: 100 + (i % 5) * 0.1,
          volume: 1000,
        }, 1_700_000_000_000 + i * 60_000);
      }
    }

    test('without a provider plugins see openPosition === undefined (unknown book)', () => {
      const sp = new SignalProcessor({ ...config, disabledStrategies: [] }, mockLogger as any);
      const seen: Array<MarketContext['openPosition']> = [];
      expect(sp.registerStrategy(probePlugin(seen))).toBe(true);
      feed(sp, 'BTC-USD', 0, 60);
      expect(seen.length).toBeGreaterThan(0);
      expect(seen.every((h) => h === undefined)).toBe(true);
    });

    test('with a provider the per-symbol hint is passed through verbatim; clearing the provider restores undefined', () => {
      const sp = new SignalProcessor({ ...config, disabledStrategies: [] }, mockLogger as any);
      const seen: Array<MarketContext['openPosition']> = [];
      sp.registerStrategy(probePlugin(seen));
      const asked: string[] = [];
      sp.setOpenPositionProvider((symbol) => {
        asked.push(symbol);
        return symbol === 'BTC-USD'
          ? { side: 'long', size: 0.5, entryPrice: 100 }
          : { side: 'flat', size: 0 };
      });
      feed(sp, 'BTC-USD', 0, 60);
      feed(sp, 'ETH-USD', 0, 60);
      expect(asked).toContain('BTC-USD');
      expect(asked).toContain('ETH-USD');
      expect(seen).toContainEqual({ side: 'long', size: 0.5, entryPrice: 100 });
      expect(seen).toContainEqual({ side: 'flat', size: 0 });
      expect(seen.some((h) => h === undefined)).toBe(false);

      seen.length = 0;
      sp.setOpenPositionProvider(null);
      feed(sp, 'BTC-USD', 60, 1);
      expect(seen).toEqual([undefined]);
    });
  });
});
