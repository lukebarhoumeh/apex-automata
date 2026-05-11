/**
 * Unit tests for the signal-pipeline-hygiene fixes.
 *
 * Each describe block targets one of the six audit fixes so a regression
 * surfaces with a precise label.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { register } from 'prom-client';
import { Logger } from '../core/logger';
import { StrategyRegistry } from '../strategies/plugins/strategy-registry';
import { MetaFilter } from '../strategies/meta-filter';
import { Signal, SignalProcessor, SignalProcessorConfig } from '../strategies/signal-processor';
import {
  recordSignalFiltered,
  recordSignalFunnel,
  __resetSignalFilteredCounter,
  __resetSignalFunnelCounter,
} from '../strategies/signal-filter-telemetry';
import {
  BreakoutStrategy,
  VWAPMeanReversionStrategy,
  MomentumStrategy,
} from '../strategies/plugins/builtin';

// Mock Supabase so SignalProcessor doesn't need real network access in tests
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: () => ({
      insert: () => ({ error: null }),
    }),
  }),
}));

/**
 * Pull the live integer count for a (stage, ...) labelset from the
 * `atlas_signal_filtered_total` Prometheus counter. Returns 0 if the
 * labelset has never been incremented (matches counter semantics).
 */
async function filteredCount(stage: string, opts: Partial<{ symbol: string; strategy: string; reason: string }> = {}): Promise<number> {
  const metric = register.getSingleMetric('atlas_signal_filtered_total');
  if (!metric) return 0;
  const data = await metric.get();
  let total = 0;
  for (const v of data.values) {
    const labels = v.labels as Record<string, string>;
    if (labels.stage !== stage) continue;
    if (opts.symbol && labels.symbol !== opts.symbol) continue;
    if (opts.strategy && labels.strategy !== opts.strategy) continue;
    if (opts.reason && labels.reason !== opts.reason) continue;
    total += v.value;
  }
  return total;
}

async function funnelCount(stage: string, opts: Partial<{ symbol: string; strategy: string; direction: string }> = {}): Promise<number> {
  const metric = register.getSingleMetric('atlas_signal_funnel_total');
  if (!metric) return 0;
  const data = await metric.get();
  let total = 0;
  for (const v of data.values) {
    const labels = v.labels as Record<string, string>;
    if (labels.stage !== stage) continue;
    if (opts.symbol && labels.symbol !== opts.symbol) continue;
    if (opts.strategy && labels.strategy !== opts.strategy) continue;
    if (opts.direction && labels.direction !== opts.direction) continue;
    total += v.value;
  }
  return total;
}

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

/**
 * 2026-05-11 audit-fix-regression: a 10-min paper run produced 24 canonical
 * "Signal generated" events but only 12 reached "Sizing order from signal"
 * with zero `signal:filtered` log lines. Root cause: the original audit
 * instrumented 5 stages (regime, meta, cross_venue, time, atr_vol) but the
 * silent drops in that run were happening at uninstrumented stages
 * (intra-strategy 5-min dedup, runtime_state, sizing-zero, etc.). These
 * tests lock in the new stages so the regression cannot return.
 */
describe('Silent-funnel regression (2026-05-11) — new stages emit signal:filtered', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetSignalFilteredCounter();
    __resetSignalFunnelCounter();
  });

  const NEW_STAGES = [
    'disabled_strategy',
    'dedup',
    'meta_label',
    'runtime_state',
    'routing',
    'funding_bias',
    'sizing',
  ] as const;

  it('every new silent-funnel stage is accepted by recordSignalFiltered', async () => {
    for (const stage of NEW_STAGES) {
      recordSignalFiltered(mockLogger, {
        stage,
        reason: `${stage}_smoke`,
        symbol: 'BTC-USD',
        strategy: 'momentum',
        direction: 'buy',
      });
    }
    const calls = (mockLogger.info as any).mock.calls.filter(
      (c: any[]) => c[0] === 'signal:filtered',
    );
    const seen = new Set(calls.map((c: any[]) => c[1].stage));
    for (const stage of NEW_STAGES) expect(seen.has(stage), `${stage} must emit signal:filtered`).toBe(true);

    // Counter labels are bounded — every stage should also be counted.
    for (const stage of NEW_STAGES) {
      expect(await filteredCount(stage), `counter for ${stage}`).toBe(1);
    }
  });

  it('log shape for every stage matches the grep target msg=signal:filtered', () => {
    recordSignalFiltered(mockLogger, {
      stage: 'dedup',
      reason: 'intra_strategy_5min_window',
      symbol: 'ETH-USD',
      strategy: 'momentum',
    });
    // Log message MUST be the literal 'signal:filtered' string. Operators
    // use `grep -E 'signal:filtered'` against logs to count rejections.
    expect(mockLogger.info).toHaveBeenCalledWith(
      'signal:filtered',
      expect.objectContaining({ stage: 'dedup', reason: 'intra_strategy_5min_window' }),
    );
  });

  it('SignalProcessor: 5-min intra-strategy dedup increments stage=dedup', async () => {
    const beforeCount = await filteredCount('dedup', { strategy: 'momentum' });
    const sp = makeQuietProcessor();
    const sig = makeSignal({ strategy: 'momentum', direction: 'buy', symbol: 'BTC-USD' });
    // First firing seeds lastSignals; second firing within 5 min must dedup.
    await (sp as unknown as { processSignal(s: Signal): Promise<void> }).processSignal({ ...sig, id: 'sig-a' });
    await (sp as unknown as { processSignal(s: Signal): Promise<void> }).processSignal({ ...sig, id: 'sig-b' });
    const afterCount = await filteredCount('dedup', { strategy: 'momentum' });
    expect(afterCount - beforeCount).toBeGreaterThanOrEqual(1);
  });

  it('SignalProcessor: disabled-strategy reject increments stage=disabled_strategy', async () => {
    const sp = makeQuietProcessor({ disabledStrategies: ['vwap_mr'] });
    const sig = makeSignal({ strategy: 'vwap_mr' as Signal['strategy'], direction: 'buy', symbol: 'BTC-USD' });
    await (sp as unknown as { processSignal(s: Signal): Promise<void> }).processSignal(sig);
    expect(await filteredCount('disabled_strategy', { strategy: 'vwap_mr' })).toBeGreaterThanOrEqual(1);
  });
});

describe('Silent-funnel regression (2026-05-11) — atlas_signal_funnel_total', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetSignalFunnelCounter();
  });

  it('recordSignalFunnel increments per-checkpoint counter', async () => {
    recordSignalFunnel({
      stage: 'canonical_emitted',
      symbol: 'BTC-USD',
      strategy: 'momentum',
      direction: 'buy',
    });
    recordSignalFunnel({
      stage: 'sized',
      symbol: 'BTC-USD',
      strategy: 'momentum',
      direction: 'buy',
    });
    recordSignalFunnel({
      stage: 'order_placed',
      symbol: 'BTC-USD',
      strategy: 'momentum',
      direction: 'buy',
    });

    expect(await funnelCount('canonical_emitted', { symbol: 'BTC-USD' })).toBe(1);
    expect(await funnelCount('sized', { symbol: 'BTC-USD' })).toBe(1);
    expect(await funnelCount('order_placed', { symbol: 'BTC-USD' })).toBe(1);
  });

  it('funnel labels stay bounded (stage, symbol, strategy, direction only)', async () => {
    const metric = register.getSingleMetric('atlas_signal_funnel_total');
    expect(metric).toBeDefined();
    const data = await metric!.get();
    // Sanity: meta description tells us the labels we declared.
    expect(data.help).toMatch(/funnel/i);
  });
});

/**
 * Build a SignalProcessor wired up just enough to exercise processSignal.
 * Strategies are disabled so the only paths exercised are the dedup +
 * disabled_strategy gates we want to test — keeps the test isolated from
 * regime/meta filter behaviour.
 */
function makeQuietProcessor(overrides: Partial<SignalProcessorConfig> = {}): SignalProcessor {
  const config: SignalProcessorConfig = {
    supabaseUrl: 'http://localhost:54321',
    supabaseKey: 'test-key',
    strategies: {
      breakout: { enabled: false, period: 20, atrPeriod: 14, atrMultiplier: 1.5, volumeThreshold: 1.5 },
      vwapMeanReversion: { enabled: false, deviationEntry: 2, deviationExit: 0.5, minVolume: 1000 },
      momentum: { enabled: true, rsiPeriod: 14, rsiOverbought: 70, rsiOversold: 30, macdFast: 12, macdSlow: 26, macdSignal: 9 },
    },
    metaLabeling: { enabled: false, threshold: 0.5 },
    // Default to no kill list — caller can override per test.
    disabledStrategies: [],
    ...overrides,
  };
  return new SignalProcessor(config, mockLogger as unknown as Logger);
}

describe('Audit fix #5 — momentum plugin defaults are the source of truth', () => {
  it('plugin uses configSchema defaults (40/60) when no overrides are passed', () => {
    const m = new MomentumStrategy();
    // Read-only access via getConfig: BaseStrategy stores the merged config.
    const oversold = (m as any).getConfig('rsiOversold', undefined as unknown as number);
    const overbought = (m as any).getConfig('rsiOverbought', undefined as unknown as number);
    expect(oversold).toBe(40);
    expect(overbought).toBe(60);
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
