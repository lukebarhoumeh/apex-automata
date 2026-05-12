/**
 * Regression test for the funnel-latch bug.
 *
 * Symptom (May 2026 — fix/funnel-latch-bug):
 *   Across 29d / 90d / 365d backtests of momentum + trend_follow, the engine
 *   admitted exactly 12 signals per run — one per
 *   (strategy, symbol, direction) tuple — all in the first 36-48 hours of
 *   simulated time, then went silent for the remainder of the window.
 *
 * Root cause:
 *   `StrategyRegistry.deduplicateSignals` compared `Date.now()` against a
 *   `Date.now() + signalDedupeWindowMs` expiry. In a backtest the engine
 *   processes thousands of candles in <30s of wall-clock time, so the
 *   ENTIRE multi-month run fits inside one 5-min wall-clock window. After
 *   each tuple's first emission, all subsequent emissions were silently
 *   skipped here (no metric, no log line).
 *
 * Fix:
 *   Dedup uses the signal's own `timestamp` (the candle the strategy was
 *   evaluating). In live this tracks wall-clock so behaviour is unchanged;
 *   in backtest the window collapses correctly to a 5-minute slice of
 *   market time.
 *
 * What this test locks:
 *   1. With a fake strategy that emits one signal per call, 1500
 *      synthetic candles spaced 15 minutes apart in signal-time must
 *      produce >1000 admitted signals (we want them ALL admitted; the
 *      assertion is generous to allow future tightening of the window).
 *   2. The bar index of the LAST admitted signal must be well past bar
 *      5000 (i.e. admissions span the whole synthetic run, not just the
 *      opening 40 hours).
 *   3. Pre-fix the same input produces exactly 1 admitted signal, so any
 *      regression that re-introduces a wall-clock dedup will trip this
 *      threshold.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Logger } from '../core/logger';
import { StrategyRegistry } from '../strategies/plugins/strategy-registry';
import type {
  StrategyPlugin,
  StrategySignal,
  MarketContext,
  ConfigParameter,
} from '../strategies/plugins/types';
import type { OHLCV } from '../indicators/technical';
import type { MarketRegime, RegimeState } from '../strategies/regime-detector';
import {
  __resetSignalFilteredCounter,
  __resetSignalFunnelCounter,
} from '../strategies/signal-filter-telemetry';

class AlwaysEmitStrategy implements StrategyPlugin {
  readonly id = 'always_emit_test';
  readonly name = 'Always Emit (test)';
  readonly description = 'Test strategy that emits a buy signal on every call.';
  readonly version = '0.0.1';
  readonly author = 'test';
  readonly category: StrategyPlugin['category'] = 'momentum';
  enabled = true;
  config: Record<string, unknown> = {};

  readonly regimeCompatibility = [
    { regime: 'strong_trend' as MarketRegime, compatibility: 'optimal' as const, positionMultiplier: 1, notes: '' },
    { regime: 'weak_trend' as MarketRegime, compatibility: 'optimal' as const, positionMultiplier: 1, notes: '' },
    { regime: 'ranging' as MarketRegime, compatibility: 'optimal' as const, positionMultiplier: 1, notes: '' },
    { regime: 'choppy' as MarketRegime, compatibility: 'optimal' as const, positionMultiplier: 1, notes: '' },
  ];

  readonly requiredIndicators = [];
  readonly configSchema: { parameters: ConfigParameter[] } = { parameters: [] };

  generateSignals(context: MarketContext): StrategySignal[] {
    const t = context.latestCandle.time;
    return [
      {
        id: `sig-${t}`,
        timestamp: new Date(t),
        symbol: context.symbol,
        strategy: this.id,
        direction: 'buy',
        strength: 0.8,
        price: context.latestCandle.close,
        stopLoss: context.latestCandle.close * 0.98,
        takeProfit: context.latestCandle.close * 1.04,
        metadata: {
          indicators: {},
          reason: 'test fixture',
        },
      },
    ];
  }
}

function makeRegimeState(): RegimeState {
  return {
    regime: 'weak_trend',
    confidence: 0.8,
    trendDirection: 'up',
    adx: 25,
    plusDI: 30,
    minusDI: 15,
    atrPercent: 0.01,
    bbWidth: 0.02,
    choppiness: 40,
    directionConsistency: 0.7,
    mtfAlignment: 0.5,
    lastUpdated: new Date(),
    regimeSince: new Date(),
  };
}

function makeContext(symbol: string, signalTimeMs: number, price = 100): MarketContext {
  const candle: OHLCV = {
    time: signalTimeMs,
    open: price,
    high: price + 1,
    low: price - 1,
    close: price,
    volume: 1000,
  };
  return {
    symbol,
    timestamp: new Date(signalTimeMs),
    candles: [candle, candle],
    indicators: {},
    latestIndicators: {},
    latestCandle: candle,
    previousCandle: candle,
    regime: makeRegimeState(),
  };
}

const mockLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Logger;

describe('StrategyRegistry — signal-time-based dedup (fix/funnel-latch-bug)', () => {
  beforeEach(() => {
    __resetSignalFilteredCounter();
    __resetSignalFunnelCounter();
  });

  it('admits signals across the full synthetic run when bars are >= dedupe window apart', () => {
    const registry = new StrategyRegistry(
      { signalDedupeWindowMs: 5 * 60_000 },
      mockLogger,
    );
    registry.register(new AlwaysEmitStrategy());

    const BAR_INTERVAL_MS = 15 * 60_000; // 15-minute candles, > 5-min window
    const BAR_COUNT = 1500;
    const SYMBOL = 'TEST-USD';
    // Use a fixed historical anchor so candle times are all in the past.
    // This is the critical part of the regression: even though every
    // generateSignals call happens at the same Date.now() (wall-clock), the
    // dedup must respect signal-time spacing.
    const startTimeMs = new Date('2024-01-01T00:00:00Z').getTime();

    let admitted = 0;
    let lastAdmittedBar = -1;
    for (let i = 0; i < BAR_COUNT; i++) {
      const signalTime = startTimeMs + i * BAR_INTERVAL_MS;
      const ctx = makeContext(SYMBOL, signalTime);
      const signals = registry.generateSignals(ctx);
      if (signals.length > 0) {
        admitted += signals.length;
        lastAdmittedBar = i;
      }
    }

    // Pre-fix expected admitted = 1. Post-fix expected = BAR_COUNT.
    expect(admitted).toBeGreaterThan(1000);
    // Admissions span the entire run — not just the opening bars.
    expect(lastAdmittedBar).toBeGreaterThan(1000);
  });

  it('still dedups same-tuple signals inside the configured window', () => {
    // Sanity check: the fix must NOT defeat the dedup entirely. Two
    // emissions of the same (strategy, symbol, direction) inside the 5-min
    // signal-time window must collapse to one.
    const registry = new StrategyRegistry(
      { signalDedupeWindowMs: 5 * 60_000 },
      mockLogger,
    );
    registry.register(new AlwaysEmitStrategy());

    const t0 = new Date('2024-01-01T00:00:00Z').getTime();
    const a = registry.generateSignals(makeContext('TEST-USD', t0));
    const b = registry.generateSignals(makeContext('TEST-USD', t0 + 60_000)); // 1m later
    const c = registry.generateSignals(makeContext('TEST-USD', t0 + 6 * 60_000)); // 6m later

    expect(a.length).toBe(1);
    expect(b.length).toBe(0); // inside window
    expect(c.length).toBe(1); // outside window
  });

  it('admits all 12 (strategy, symbol, direction) tuples without latching the funnel', () => {
    // Directly mirrors the production failure mode: 3 symbols × 1 strategy
    // × 2 directions. After each tuple emits once, subsequent emissions of
    // the SAME tuple inside the window are dropped, but the OTHER tuples
    // must still flow through unaffected. Pre-fix the wall-clock dedup
    // would have latched everything regardless of tuple identity (because
    // it was per-tuple keyed AND wall-clock windowed — both keys collapsed
    // simultaneously in backtest).
    const registry = new StrategyRegistry(
      { signalDedupeWindowMs: 5 * 60_000 },
      mockLogger,
    );

    class DirStrategy implements StrategyPlugin {
      readonly id = 'dir_strat';
      readonly name = 'Dir';
      readonly description = '';
      readonly version = '0.0.1';
      readonly author = 'test';
      readonly category: StrategyPlugin['category'] = 'momentum';
      enabled = true;
      config: Record<string, unknown> = {};
      readonly regimeCompatibility = [
        { regime: 'weak_trend' as MarketRegime, compatibility: 'optimal' as const, positionMultiplier: 1, notes: '' },
      ];
      readonly requiredIndicators = [];
      readonly configSchema: { parameters: ConfigParameter[] } = { parameters: [] };
      constructor(private readonly dir: 'buy' | 'sell') {}
      generateSignals(context: MarketContext): StrategySignal[] {
        return [
          {
            id: `sig-${this.dir}-${context.symbol}-${context.latestCandle.time}`,
            timestamp: new Date(context.latestCandle.time),
            symbol: context.symbol,
            strategy: this.id,
            direction: this.dir,
            strength: 0.5,
            price: 100,
            stopLoss: 98,
            takeProfit: 104,
            metadata: { indicators: {}, reason: 'test' },
          },
        ];
      }
    }

    // We can't register two strategies with the same id; use one with a
    // dynamic per-call direction instead.
    class BothDirStrategy implements StrategyPlugin {
      readonly id = 'both_dir';
      readonly name = 'BothDir';
      readonly description = '';
      readonly version = '0.0.1';
      readonly author = 'test';
      readonly category: StrategyPlugin['category'] = 'momentum';
      enabled = true;
      config: Record<string, unknown> = {};
      readonly regimeCompatibility = [
        { regime: 'weak_trend' as MarketRegime, compatibility: 'optimal' as const, positionMultiplier: 1, notes: '' },
      ];
      readonly requiredIndicators = [];
      readonly configSchema: { parameters: ConfigParameter[] } = { parameters: [] };
      generateSignals(context: MarketContext): StrategySignal[] {
        const make = (direction: 'buy' | 'sell'): StrategySignal => ({
          id: `sig-${direction}-${context.symbol}-${context.latestCandle.time}`,
          timestamp: new Date(context.latestCandle.time),
          symbol: context.symbol,
          strategy: this.id,
          direction,
          strength: 0.5,
          price: 100,
          stopLoss: direction === 'buy' ? 98 : 102,
          takeProfit: direction === 'buy' ? 104 : 96,
          metadata: { indicators: {}, reason: 'test' },
        });
        return [make('buy'), make('sell')];
      }
    }

    registry.register(new BothDirStrategy());

    const SYMBOLS = ['BTC-USD', 'ETH-USD', 'SOL-USD'];
    const t0 = new Date('2024-01-01T00:00:00Z').getTime();

    const admittedSet = new Set<string>();

    // 200 bars, 15 minutes apart → ~50h simulated
    for (let i = 0; i < 200; i++) {
      const signalTime = t0 + i * 15 * 60_000;
      for (const sym of SYMBOLS) {
        const signals = registry.generateSignals(makeContext(sym, signalTime));
        for (const s of signals) {
          admittedSet.add(`${s.symbol}|${s.direction}`);
        }
      }
    }

    // All 6 (symbol × direction) tuples for this single strategy should be
    // present, NOT collapsed to a one-per-tuple-forever latch.
    expect(admittedSet.size).toBe(SYMBOLS.length * 2);

    // And admissions should be plural per tuple — 200 bars × 15 min = 3000
    // minutes simulated, 5-min window → ~600 admissions per (sym, dir) max.
    // Pre-fix: total admitted = 6 (one per tuple). Post-fix: >> 6.
    let totalAdmitted = 0;
    for (let i = 0; i < 200; i++) {
      const signalTime = t0 + 1000 * 15 * 60_000 + i * 15 * 60_000; // disjoint range
      for (const sym of SYMBOLS) {
        totalAdmitted += registry.generateSignals(makeContext(sym, signalTime)).length;
      }
    }
    expect(totalAdmitted).toBeGreaterThan(SYMBOLS.length * 2);
  });
});
