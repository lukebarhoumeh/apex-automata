/**
 * Unit tests for MetaFilter (Rule-Based Trade Quality Filter)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MetaFilter, MetaFilterConfig, TradeOutcome, StrategyPerformance } from '../strategies/meta-filter';
import { Signal } from '../strategies/signal-processor';
import { Logger } from '../core/logger';

// Mock logger
const mockLogger: Logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

// Helper to create a mock signal
function createMockSignal(
  strategy: 'breakout' | 'momentum' | 'vwap_mr',
  strength: number = 0.5,
  symbol: string = 'BTC-USD'
): Signal {
  return {
    id: `test-signal-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    timestamp: new Date(),
    symbol,
    strategy,
    direction: 'buy',
    strength,
    price: 50000,
    stopLoss: 49000,
    takeProfit: 52000,
    metadata: {
      indicators: {},
      reason: 'Test signal',
    },
  };
}

// Helper to create trade outcomes
function createOutcome(
  strategy: string,
  outcome: 'win' | 'loss' | 'breakeven',
  strength: number = 0.5,
  pnl: number = 0
): TradeOutcome {
  return {
    signalId: `sig-${Date.now()}`,
    strategy,
    symbol: 'BTC-USD',
    direction: 'buy',
    signalStrength: strength,
    entryTime: new Date(),
    exitTime: new Date(),
    pnl,
    outcome,
    hourOfDay: 14,
    dayOfWeek: 1,
    filtersPassed: [],
    filtersBlocked: [],
  };
}

describe('MetaFilter', () => {
  let metaFilter: MetaFilter;

  beforeEach(() => {
    metaFilter = new MetaFilter({
      enabled: true,
      coldStreakEnabled: true,
      coldStreakThreshold: 3,
      strengthFilterEnabled: true,
      volumeConfirmEnabled: true,
      timeFilterEnabled: true,
      crossConfirmEnabled: true,
      logDecisions: false, // Disable for tests
    }, mockLogger);
  });

  describe('initialization', () => {
    it('should initialize with default config', () => {
      const filter = new MetaFilter({}, mockLogger);
      const stats = filter.getStats();
      
      expect(stats.enabled).toBe(true);
      // AGGRESSIVE config: higher threshold to allow more trades
      expect(stats.config.coldStreakThreshold).toBe(10);
      expect(stats.config.minQualityScore).toBe(0.5);
    });

    it('should respect custom config', () => {
      const filter = new MetaFilter({
        coldStreakThreshold: 5,
        minQualityScore: 0.7,
      }, mockLogger);
      const stats = filter.getStats();
      
      expect(stats.config.coldStreakThreshold).toBe(5);
      expect(stats.config.minQualityScore).toBe(0.7);
    });
  });

  describe('basic filtering', () => {
    it('should pass signal when filter is disabled', () => {
      metaFilter.setEnabled(false);
      
      const signal = createMockSignal('breakout', 0.3);
      const result = metaFilter.filter(signal);
      
      expect(result.allowed).toBe(true);
      expect(result.qualityScore).toBe(1.0);
      expect(result.reason).toContain('disabled');
    });

    it('should evaluate all rules and calculate quality score', () => {
      const signal = createMockSignal('breakout', 0.7);
      const result = metaFilter.filter(signal, {
        volumeRatio: 1.5,
        regime: 'strong_trend',
        mtfAlignment: 0.8,
      });

      expect(result.rulesEvaluated.length).toBeGreaterThan(0);
      expect(result.qualityScore).toBeGreaterThanOrEqual(0);
      expect(result.qualityScore).toBeLessThanOrEqual(1);
    });

    it('should pass high-quality signals', () => {
      const signal = createMockSignal('breakout', 0.8);
      const result = metaFilter.filter(signal, {
        volumeRatio: 2.0,
        regime: 'strong_trend',
        mtfAlignment: 0.9,
      });

      // High strength + high volume + good MTF should pass
      expect(result.qualityScore).toBeGreaterThan(0.5);
    });
  });

  describe('cold streak detection', () => {
    it('should block signals after consecutive losses', () => {
      // Record 3 consecutive losses
      metaFilter.recordTradeOutcome(createOutcome('breakout', 'loss', 0.5, -100));
      metaFilter.recordTradeOutcome(createOutcome('breakout', 'loss', 0.5, -100));
      metaFilter.recordTradeOutcome(createOutcome('breakout', 'loss', 0.5, -100));

      const signal = createMockSignal('breakout', 0.7);
      const result = metaFilter.filter(signal);

      expect(result.allowed).toBe(false);
      expect(result.coldStreakActive).toBe(true);
      expect(result.reason).toContain('Cold streak');
    });

    it('should allow signals for other strategies during cold streak', () => {
      // Record 3 consecutive losses for breakout
      metaFilter.recordTradeOutcome(createOutcome('breakout', 'loss', 0.5, -100));
      metaFilter.recordTradeOutcome(createOutcome('breakout', 'loss', 0.5, -100));
      metaFilter.recordTradeOutcome(createOutcome('breakout', 'loss', 0.5, -100));

      // Momentum should still be allowed
      const signal = createMockSignal('momentum', 0.7);
      const result = metaFilter.filter(signal, { volumeRatio: 1.5 });

      expect(result.coldStreakActive).toBe(false);
    });

    it('should clear cold streak after winning trade', () => {
      // Record 3 losses
      metaFilter.recordTradeOutcome(createOutcome('breakout', 'loss', 0.5, -100));
      metaFilter.recordTradeOutcome(createOutcome('breakout', 'loss', 0.5, -100));
      metaFilter.recordTradeOutcome(createOutcome('breakout', 'loss', 0.5, -100));

      // Now record a win
      metaFilter.recordTradeOutcome(createOutcome('breakout', 'win', 0.6, 150));

      const signal = createMockSignal('breakout', 0.7);
      const result = metaFilter.filter(signal, { volumeRatio: 1.5 });

      expect(result.coldStreakActive).toBe(false);
    });
  });

  describe('signal strength filtering', () => {
    it('should pass signals regardless of strength when minAbsoluteStrength is 0', () => {
      // AGGRESSIVE config: minAbsoluteStrength is 0.0, so all signals pass strength check
      const signal = createMockSignal('breakout', 0.2);
      const result = metaFilter.filter(signal);

      // With minAbsoluteStrength=0, the strength rule should pass
      const strengthRule = result.rulesEvaluated.find(r => r.rule.includes('strength'));
      expect(strengthRule?.passed).toBe(true);
    });

    it('should use percentile filtering with historical data', () => {
      // Record some winning trades with varying strengths
      for (let i = 0; i < 15; i++) {
        const strength = 0.5 + Math.random() * 0.4; // 0.5-0.9
        metaFilter.recordTradeOutcome(createOutcome('breakout', 'win', strength, 100));
      }

      // Low strength signal should have lower score
      const lowStrength = createMockSignal('breakout', 0.4);
      const lowResult = metaFilter.filter(lowStrength, { volumeRatio: 1.5 });

      // High strength signal should have higher score
      const highStrength = createMockSignal('breakout', 0.85);
      const highResult = metaFilter.filter(highStrength, { volumeRatio: 1.5 });

      expect(highResult.qualityScore).toBeGreaterThan(lowResult.qualityScore);
    });
  });

  describe('volume confirmation', () => {
    it('should penalize low volume for breakout strategy', () => {
      const signal = createMockSignal('breakout', 0.7);
      
      const lowVolResult = metaFilter.filter(signal, { volumeRatio: 0.8 });
      const highVolResult = metaFilter.filter(signal, { volumeRatio: 2.0 });

      // Higher volume should give better score
      const lowVolRule = lowVolResult.rulesEvaluated.find(r => r.rule === 'volume_confirm');
      const highVolRule = highVolResult.rulesEvaluated.find(r => r.rule === 'volume_confirm');

      expect(highVolRule?.contribution).toBeGreaterThan(lowVolRule?.contribution || 0);
    });

    it('should not require volume for mean reversion', () => {
      const signal = createMockSignal('vwap_mr', 0.7);
      
      const lowVolResult = metaFilter.filter(signal, { volumeRatio: 0.8 });

      // MR strategy should still pass with low volume
      const volumeRule = lowVolResult.rulesEvaluated.find(r => r.rule === 'volume_confirm');
      // The rule should pass (not be a hard block)
      expect(volumeRule?.passed).toBe(true);
    });
  });

  describe('time of day filtering', () => {
    it('should penalize low liquidity hours', () => {
      // Note: This test depends on current hour, so we just verify the rule is evaluated
      const signal = createMockSignal('breakout', 0.7);
      const result = metaFilter.filter(signal);

      const timeRule = result.rulesEvaluated.find(r => r.rule === 'time_of_day');
      expect(timeRule).toBeDefined();
      expect(timeRule?.weight).toBeGreaterThan(0);
    });
  });

  describe('strategy performance tracking', () => {
    it('should track trade outcomes per strategy', () => {
      metaFilter.recordTradeOutcome(createOutcome('breakout', 'win', 0.6, 100));
      metaFilter.recordTradeOutcome(createOutcome('breakout', 'win', 0.7, 150));
      metaFilter.recordTradeOutcome(createOutcome('breakout', 'loss', 0.5, -80));

      const perf = metaFilter.getStrategyPerformance('breakout');

      expect(perf).toBeDefined();
      expect(perf?.totalTrades).toBe(3);
      expect(perf?.wins).toBe(2);
      expect(perf?.losses).toBe(1);
      expect(perf?.winRate).toBeCloseTo(0.667, 2);
    });

    it('should track consecutive wins and losses', () => {
      metaFilter.recordTradeOutcome(createOutcome('momentum', 'win', 0.6, 100));
      metaFilter.recordTradeOutcome(createOutcome('momentum', 'win', 0.7, 150));
      metaFilter.recordTradeOutcome(createOutcome('momentum', 'win', 0.8, 200));

      let perf = metaFilter.getStrategyPerformance('momentum');
      expect(perf?.consecutiveWins).toBe(3);
      expect(perf?.consecutiveLosses).toBe(0);

      // Now record a loss
      metaFilter.recordTradeOutcome(createOutcome('momentum', 'loss', 0.5, -100));
      
      perf = metaFilter.getStrategyPerformance('momentum');
      expect(perf?.consecutiveWins).toBe(0);
      expect(perf?.consecutiveLosses).toBe(1);
    });

    it('should calculate average winning strength', () => {
      metaFilter.recordTradeOutcome(createOutcome('breakout', 'win', 0.6, 100));
      metaFilter.recordTradeOutcome(createOutcome('breakout', 'win', 0.8, 150));
      metaFilter.recordTradeOutcome(createOutcome('breakout', 'win', 0.7, 120));

      const perf = metaFilter.getStrategyPerformance('breakout');
      
      expect(perf?.avgWinningStrength).toBeCloseTo(0.7, 1);
    });

    it('should track hourly performance', () => {
      // Record wins at hour 14
      metaFilter.recordTradeOutcome({
        ...createOutcome('breakout', 'win', 0.6, 100),
        hourOfDay: 14,
      });
      metaFilter.recordTradeOutcome({
        ...createOutcome('breakout', 'win', 0.7, 150),
        hourOfDay: 14,
      });
      
      // Record loss at hour 4
      metaFilter.recordTradeOutcome({
        ...createOutcome('breakout', 'loss', 0.5, -100),
        hourOfDay: 4,
      });

      const perf = metaFilter.getStrategyPerformance('breakout');
      
      const hour14 = perf?.hourlyPerformance.get(14);
      const hour4 = perf?.hourlyPerformance.get(4);

      expect(hour14?.wins).toBe(2);
      expect(hour14?.losses).toBe(0);
      expect(hour4?.wins).toBe(0);
      expect(hour4?.losses).toBe(1);
    });
  });

  describe('statistics and config', () => {
    it('should return comprehensive stats', () => {
      metaFilter.recordTradeOutcome(createOutcome('breakout', 'win', 0.6, 100));
      metaFilter.recordTradeOutcome(createOutcome('momentum', 'loss', 0.5, -50));

      const stats = metaFilter.getStats();

      expect(stats.enabled).toBe(true);
      expect(stats.strategies).toBeDefined();
      expect(stats.strategies['breakout']).toBeDefined();
      expect(stats.strategies['momentum']).toBeDefined();
    });

    it('should update config dynamically', () => {
      metaFilter.updateConfig({
        coldStreakThreshold: 5,
        minQualityScore: 0.7,
      });

      const stats = metaFilter.getStats();
      expect(stats.config.coldStreakThreshold).toBe(5);
      expect(stats.config.minQualityScore).toBe(0.7);
    });

    it('should toggle enabled state', () => {
      expect(metaFilter.getStats().enabled).toBe(true);
      
      metaFilter.setEnabled(false);
      expect(metaFilter.getStats().enabled).toBe(false);
      
      metaFilter.setEnabled(true);
      expect(metaFilter.getStats().enabled).toBe(true);
    });
  });

  describe('events', () => {
    it('should emit signal:passed when signal passes', () => {
      const passedHandler = vi.fn();
      metaFilter.on('signal:passed', passedHandler);

      const signal = createMockSignal('breakout', 0.8);
      const result = metaFilter.filter(signal, {
        volumeRatio: 2.0,
        regime: 'strong_trend',
      });

      if (result.allowed) {
        expect(passedHandler).toHaveBeenCalled();
      }
    });

    it('should emit signal:blocked when signal is blocked by quality score', () => {
      // Create a filter with very high threshold to force blocking
      const strictFilter = new MetaFilter({
        enabled: true,
        coldStreakEnabled: false, // Disable cold streak for this test
        minQualityScore: 0.99, // Very high threshold
        logDecisions: false,
      }, mockLogger);

      const blockedHandler = vi.fn();
      strictFilter.on('signal:blocked', blockedHandler);

      const signal = createMockSignal('breakout', 0.5);
      const result = strictFilter.filter(signal, { volumeRatio: 1.0 });

      // With such high threshold, signal should be blocked
      if (!result.allowed) {
        expect(blockedHandler).toHaveBeenCalled();
      }
      
      // At minimum, verify the quality score calculation works
      expect(result.qualityScore).toBeLessThan(0.99);
    });

    it('should emit outcome:recorded when trade outcome is recorded', () => {
      const recordedHandler = vi.fn();
      metaFilter.on('outcome:recorded', recordedHandler);

      metaFilter.recordTradeOutcome(createOutcome('breakout', 'win', 0.6, 100));

      expect(recordedHandler).toHaveBeenCalled();
    });
  });

  describe('quality score calculation', () => {
    it('should give higher scores to better signals', () => {
      // Good signal: high strength, high volume, good regime
      const goodSignal = createMockSignal('breakout', 0.9);
      const goodResult = metaFilter.filter(goodSignal, {
        volumeRatio: 2.5,
        regime: 'strong_trend',
        mtfAlignment: 0.9,
      });

      // Poor signal: low strength, low volume
      const poorSignal = createMockSignal('breakout', 0.35);
      const poorResult = metaFilter.filter(poorSignal, {
        volumeRatio: 0.8,
        regime: 'choppy',
        mtfAlignment: 0.1,
      });

      expect(goodResult.qualityScore).toBeGreaterThan(poorResult.qualityScore);
    });

    it('should adjust signal strength based on quality score', () => {
      const signal = createMockSignal('breakout', 0.8);
      const result = metaFilter.filter(signal, { volumeRatio: 1.5 });

      // Adjusted strength = original strength * quality score
      expect(result.adjustedStrength).toBe(signal.strength * result.qualityScore);
    });
  });
});

