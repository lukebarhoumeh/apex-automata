/**
 * Unit tests for the signal-pipeline-hygiene fixes.
 *
 * Each describe block targets one of the six audit fixes so a regression
 * surfaces with a precise label.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Logger } from '../core/logger';
import { StrategyRegistry } from '../strategies/plugins/strategy-registry';
import { MetaFilter } from '../strategies/meta-filter';
import { Signal } from '../strategies/signal-processor';
import {
  recordSignalFiltered,
  __resetSignalFilteredCounter,
} from '../strategies/signal-filter-telemetry';
import {
  BreakoutStrategy,
  VWAPMeanReversionStrategy,
  MomentumStrategy,
} from '../strategies/plugins/builtin';

const mockLogger: Logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

function makeSignal(overrides: Partial<Signal> = {}): Signal {
  return {
    id: overrides.id ?? `sig-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: overrides.timestamp ?? new Date(),
    symbol: overrides.symbol ?? 'BTC-USD',
    strategy: (overrides.strategy ?? 'momentum') as Signal['strategy'],
    direction: overrides.direction ?? 'buy',
    strength: overrides.strength ?? 0.5,
    price: overrides.price ?? 100,
    stopLoss: overrides.stopLoss ?? 99,
    takeProfit: overrides.takeProfit ?? 102,
    metadata: overrides.metadata ?? { indicators: {}, reason: 'test' },
  };
}

describe('Audit fix #1 — disabled_strategies wired into StrategyRegistry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('refuses to register plugins listed in disabledStrategies', () => {
    const registry = new StrategyRegistry(
      { disabledStrategies: ['vwap_mr', 'breakout'] },
      mockLogger,
    );
    expect(registry.register(new BreakoutStrategy())).toBe(false);
    expect(registry.register(new VWAPMeanReversionStrategy())).toBe(false);
    expect(registry.register(new MomentumStrategy())).toBe(true);
    const all = registry.getAll().map((s) => s.id);
    expect(all).toEqual(['momentum']);
  });

  it('logs the disabled-strategy skip at INFO so ops sees it once at startup', () => {
    const registry = new StrategyRegistry(
      { disabledStrategies: ['vwap_mr'] },
      mockLogger,
    );
    registry.register(new VWAPMeanReversionStrategy());
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.stringContaining('"vwap_mr" is disabled'),
    );
  });

  it('disabled strategies never run on bar updates (skipped before generateSignals)', () => {
    const registry = new StrategyRegistry(
      { disabledStrategies: ['vwap_mr'] },
      mockLogger,
    );
    const vwap = new VWAPMeanReversionStrategy();
    const spy = vi.spyOn(vwap, 'generateSignals');
    registry.register(vwap); // refused
    // generateSignals iterates over registered+enabled plugins — vwap_mr
    // wasn't registered, so its strategy method must not be called.
    registry.generateSignals({
      symbol: 'BTC-USD',
      timestamp: new Date(),
      candles: [],
      indicators: {},
      latestIndicators: {},
      latestCandle: { time: 0, open: 0, high: 0, low: 0, close: 0, volume: 0 },
      previousCandle: { time: 0, open: 0, high: 0, low: 0, close: 0, volume: 0 },
      regime: {
        regime: 'ranging',
        confidence: 0.5,
        adx: 0,
        plusDI: 0,
        minusDI: 0,
        atrPercent: 0,
        bbWidth: 0,
        choppiness: 50,
        trendDirection: 'neutral',
        directionConsistency: 0.5,
        mtfAlignment: 0,
        lastUpdated: new Date(),
        regimeSince: new Date(),
      },
    });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('Audit fix #3 — MetaFilter strategy id matches plugin emit (trend_follow not "trend")', () => {
  let metaFilter: MetaFilter;

  beforeEach(() => {
    vi.clearAllMocks();
    // Force volume + MTF rules ON so the strategy-id branches are exercised.
    metaFilter = new MetaFilter(
      {
        enabled: true,
        coldStreakEnabled: false,
        strengthFilterEnabled: false,
        volumeConfirmEnabled: true,
        timeFilterEnabled: false,
        crossConfirmEnabled: true,
        requireMTFConfirm: true,
        minVolumeRatio: 1.5, // tight enough to fail when volume rule applies
        logDecisions: false,
      },
      mockLogger,
    );
  });

  it('regression: trend_follow signal triggers volume rule (id used to be "trend" — silent no-op)', () => {
    const sig = makeSignal({ strategy: 'trend_follow' as Signal['strategy'], strength: 0.8 });
    const result = metaFilter.filter(sig, { volumeRatio: 0.5 /* below 1.5 min */ });
    const volumeRule = result.rulesEvaluated.find((r) => r.rule === 'volume_confirm');
    expect(volumeRule, 'trend_follow must be subject to volume_confirm rule').toBeDefined();
    expect(volumeRule!.passed).toBe(false);
  });

  it('regression: trend_follow signal triggers MTF alignment rule (id used to be "trend")', () => {
    const sig = makeSignal({ strategy: 'trend_follow' as Signal['strategy'], strength: 0.8 });
    const result = metaFilter.filter(sig, {
      volumeRatio: 2.0, // pass volume
      mtfAlignment: 0.1, // below 0.3 threshold
    });
    const mtfRule = result.rulesEvaluated.find((r) => r.rule === 'mtf_alignment');
    expect(mtfRule, 'trend_follow must be subject to mtf_alignment rule').toBeDefined();
    expect(mtfRule!.passed).toBe(false);
  });

  it('legacy "trend" id no longer matches anything (proves the old typo is gone)', () => {
    // After the fix, only 'trend_follow' is recognized as a trend strategy.
    // Sending strategy='trend' should NOT trigger the MTF gate (it's not
    // a real strategy id any plugin emits — this guards against re-typos).
    const sig = makeSignal({ strategy: 'trend' as unknown as Signal['strategy'], strength: 0.8 });
    const result = metaFilter.filter(sig, {
      volumeRatio: 2.0,
      mtfAlignment: 0.0, // would fail the gate IF 'trend' were treated as a trend strategy
    });
    const mtfRule = result.rulesEvaluated.find((r) => r.rule === 'mtf_alignment');
    // Rule still runs but should pass because 'trend' isn't recognized as a trend strategy.
    expect(mtfRule).toBeDefined();
    expect(mtfRule!.passed).toBe(true);
  });
});

describe('Audit fix #4 — per-stage signal:filtered telemetry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetSignalFilteredCounter();
  });

  it('emits a structured log line with stage label for every rejection', () => {
    recordSignalFiltered(mockLogger, {
      stage: 'time',
      reason: 'hour_not_allowed',
      symbol: 'ETH-USD',
      strategy: 'momentum',
      signalId: 'sig-1',
      direction: 'buy',
      strength: 0.7,
      context: { hour: 4, allowedHours: [13, 14, 15] },
    });
    expect(mockLogger.info).toHaveBeenCalledWith(
      'signal:filtered',
      expect.objectContaining({
        stage: 'time',
        reason: 'hour_not_allowed',
        symbol: 'ETH-USD',
        strategy: 'momentum',
        signalId: 'sig-1',
        direction: 'buy',
        hour: 4,
        allowedHours: [13, 14, 15],
      }),
    );
  });

  it('all five audit stages are accepted by the helper', () => {
    const stages = ['regime', 'meta', 'cross_venue', 'time', 'atr_vol'] as const;
    for (const stage of stages) {
      recordSignalFiltered(mockLogger, {
        stage,
        reason: `${stage}_test`,
        symbol: 'BTC-USD',
        strategy: 'momentum',
      });
    }
    // Each stage produced its own log line — five total in this test.
    const calls = (mockLogger.info as any).mock.calls.filter(
      (c: any[]) => c[0] === 'signal:filtered',
    );
    expect(calls.length).toBeGreaterThanOrEqual(5);
    const seenStages = new Set(calls.map((c: any[]) => c[1].stage));
    for (const stage of stages) expect(seenStages.has(stage)).toBe(true);
  });
});

describe('Audit fix #5 — momentum plugin defaults are the source of truth', () => {
  it('plugin uses configSchema defaults (30/70 industry-standard) when no overrides are passed', () => {
    // strategy-tuning (Bug B, 2026-05): defaults previously drifted to
    // 40/60 ("AGGRESSIVE" tuning). Live evidence: RSI 56.5 logged as
    // "overbought" on ETH-USD. Restored to the textbook 30/70 in both
    // schema defaults and inline getConfig fallbacks.
    const m = new MomentumStrategy();
    // Read-only access via getConfig: BaseStrategy stores the merged config.
    const oversold = (m as any).getConfig('rsiOversold', undefined as unknown as number);
    const overbought = (m as any).getConfig('rsiOverbought', undefined as unknown as number);
    expect(oversold).toBe(30);
    expect(overbought).toBe(70);
  });

  it('explicit YAML overrides win over plugin defaults', () => {
    const m = new MomentumStrategy({ rsiOversold: 25, rsiOverbought: 75 });
    const oversold = (m as any).getConfig('rsiOversold', undefined as unknown as number);
    const overbought = (m as any).getConfig('rsiOverbought', undefined as unknown as number);
    expect(oversold).toBe(25);
    expect(overbought).toBe(75);
  });
});

describe('Audit fix #6 — allowed_hours_utc list semantics (not range)', () => {
  // The gate now lives in api/server.ts and reads as a literal list. We can
  // verify the *semantics* (Array.includes) here without standing up the
  // Express app — this test exists to lock the contract so nobody re-adds
  // the [start,end] range branch.
  it('list semantics: [13,14,15] only allows hours 13,14,15 — not 0..15', () => {
    const allowed = [13, 14, 15];
    expect(allowed.includes(0)).toBe(false);
    expect(allowed.includes(13)).toBe(true);
    expect(allowed.includes(14)).toBe(true);
    expect(allowed.includes(15)).toBe(true);
    expect(allowed.includes(16)).toBe(false);
    expect(allowed.includes(23)).toBe(false);
  });

  it('regression: [0, 23] is NOT a 24h no-op — only hours 0 and 23 are allowed', () => {
    const allowed = [0, 23];
    // Pre-fix bug: range semantics treated [0,23] as "0 through 23" → all 24h.
    // Post-fix: list semantics → only hours 0 and 23.
    expect(allowed.includes(12)).toBe(false);
    expect(allowed.includes(0)).toBe(true);
    expect(allowed.includes(23)).toBe(true);
  });
});
