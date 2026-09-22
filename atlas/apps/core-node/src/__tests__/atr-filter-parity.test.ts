/**
 * TF-ATR-FILTER-PARITY (2026-09-22) — the `atr_vol` floor must see the ATR
 * trend_follow writes.
 *
 * Bug: the live router (api/server.ts, stage `atr_vol`) and the backtest
 * mirror read ONLY `signal.metadata.indicators.atr`, but `trend_follow`
 * stamped its ATR at `signal.metadata.atr` (it passed `metadata: { atr }` to
 * `BaseStrategy.createSignal`, never `indicators: { atr }`). Every trend_follow
 * entry therefore looked ATR-less, the filter was skipped, and sub-floor
 * (< 0.5% ATR) entries passed the paper soak.
 *
 * Pins:
 *   1. Stamp — `TrendFollowStrategy` now writes the ATR on BOTH paths
 *      (`metadata.indicators.atr` canonical, `metadata.atr` legacy), for buy
 *      and sell signals, with the same value it sized its stop / TP from.
 *   2. One SoT reader — `resolveSignalAtr` honours `indicators.atr` first and
 *      `metadata.atr` second; anything non-positive / non-finite is `null`.
 *   3. Decision — `evaluateAtrVolatilityFilter` with the real
 *      `guardrails.filters` floor rejects when ATR / price < 0.5%, passes inside
 *      the band, rejects above the max, and reports `no_atr` (still passing)
 *      when no ATR is stamped — the historical behaviour, now observable.
 *   4. Regression — a metadata.atr-only (pre-fix trend_follow) signal and an
 *      indicators.atr-only (momentum-shaped) signal get IDENTICAL verdicts; the
 *      old read path is shown to miss the legacy shape.
 *   5. End-to-end — a plugin-generated trend_follow signal under the floor is
 *      rejected, and the persisted blotter reason keeps the pre-fix format
 *      (`"atr_vol: atr_below_min (atrPct=…)"`).
 *   6. Backtest parity — `BacktestEngine.handleSignal` rejects the legacy
 *      metadata.atr-only shape below the floor exactly like the canonical shape.
 */
import { describe, it, expect, vi } from 'vitest';
import path from 'node:path';
import { TrendFollowStrategy, type MarketContext } from '../strategies/plugins';
import type { RegimeState } from '../strategies/regime-detector';
import type { OHLCV } from '../indicators/technical';
import type { Signal } from '../strategies/signal-processor';
import type { Logger } from '../core/logger';
import { loadGuardrails } from '../config/loadGuardrails';
import { BacktestEngine, type BacktestConfig } from '../backtesting/backtest-engine';
import { routeRejected, signalRouteColumns } from '../exchanges/signal-route';
import {
  ATR_ABOVE_MAX,
  ATR_BELOW_MIN,
  ATR_VOL_STAGE,
  describeAtrVolatilityReject,
  evaluateAtrVolatilityFilter,
  resolveSignalAtr,
  resolveSignalAtrWithSource,
} from '../strategies/atr-volatility-filter';

const ATLAS_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const guardrails = loadGuardrails(ATLAS_ROOT);
const ATR_MIN = guardrails.filters.atr_volatility_min; // 0.005 desk pin
const ATR_MAX = guardrails.filters.atr_volatility_max; // 0.05

// ────────────────────────────────────────────────────────────────────────
// Synthetic trend_follow context (EMA12 crosses EMA15 on the evaluated bar)
// ────────────────────────────────────────────────────────────────────────

function flatCandles(count: number, price: number): OHLCV[] {
  return Array.from({ length: count }, (_, i) => ({
    time: i * 60_000,
    open: price,
    high: price,
    low: price,
    close: price,
    volume: 100,
  }));
}

function regimeState(): RegimeState {
  return {
    regime: 'strong_trend',
    confidence: 0.8,
    trendDirection: 'up',
    adx: 25,
    plusDI: 20,
    minusDI: 10,
    atrPercent: 0.01,
    bbWidth: 3,
    choppiness: 30,
    directionConsistency: 0.7,
    mtfAlignment: 0.6,
    lastUpdated: new Date(),
    regimeSince: new Date(),
  };
}

function makeTrendContext(opts: { direction: 'bull' | 'bear'; price: number; atr: number; adx?: number }): MarketContext {
  const bars = 31;
  const ema12: number[] = [];
  const ema15: number[] = [];
  for (let i = 0; i < bars; i++) {
    const before = i < bars - 1;
    if (opts.direction === 'bull') {
      ema12.push(before ? 99 : 101);
    } else {
      ema12.push(before ? 101 : 99);
    }
    ema15.push(100);
  }
  const atr = new Array(bars).fill(opts.atr);
  const candles = flatCandles(bars, opts.price);
  const indicators: Record<string, number[]> = { ema12, ema15, atr };
  if (opts.adx !== undefined) indicators.adx = new Array(bars).fill(opts.adx);
  return {
    symbol: 'ETH-USD',
    timestamp: new Date(),
    candles,
    mtfCandles: {},
    indicators,
    latestIndicators: { ema12: ema12[bars - 1], ema15: ema15[bars - 1], atr: opts.atr },
    latestCandle: candles[bars - 1],
    previousCandle: candles[bars - 2],
    regime: regimeState(),
  };
}

function generateTf(opts: { direction: 'bull' | 'bear'; price: number; atr: number; adx?: number }) {
  const signals = new TrendFollowStrategy().generateSignals(makeTrendContext(opts));
  expect(signals, 'fixture must produce exactly one trend_follow signal').toHaveLength(1);
  return signals[0];
}

// ────────────────────────────────────────────────────────────────────────
// 1. Stamp — trend_follow writes the ATR on both paths
// ────────────────────────────────────────────────────────────────────────

describe('TrendFollowStrategy stamps ATR on metadata.indicators (canonical) AND metadata (legacy)', () => {
  it('buy signal: indicators.atr === metadata.atr === the ATR used for stop/TP geometry', () => {
    const sig = generateTf({ direction: 'bull', price: 110, atr: 0.5 });
    const indicators = sig.metadata.indicators as Record<string, number>;
    expect(indicators.atr).toBe(0.5);
    expect(sig.metadata.atr).toBe(0.5);
    expect(indicators.fastEma).toBe(101);
    expect(indicators.slowEma).toBe(100);
    // stopAtr default 2.5 → the same ATR sized the stop.
    expect(sig.stopLoss).toBeCloseTo(110 - 0.5 * 2.5, 10);
  });

  it('sell signal carries the same two-path stamp', () => {
    const sig = generateTf({ direction: 'bear', price: 90, atr: 0.5 });
    expect(sig.direction).toBe('sell');
    expect((sig.metadata.indicators as Record<string, number>).atr).toBe(0.5);
    expect(sig.metadata.atr).toBe(0.5);
  });

  it('adx is stamped on indicators only when the detector supplied it', () => {
    const without = generateTf({ direction: 'bull', price: 110, atr: 0.5 });
    expect((without.metadata.indicators as Record<string, number>).adx).toBeUndefined();
    const withAdx = generateTf({ direction: 'bull', price: 110, atr: 0.5, adx: 27 });
    expect((withAdx.metadata.indicators as Record<string, number>).adx).toBe(27);
    expect(withAdx.metadata.adx).toBe(27);
  });
});

// ────────────────────────────────────────────────────────────────────────
// 2. One SoT reader
// ────────────────────────────────────────────────────────────────────────

describe('resolveSignalAtr — indicators.atr first, metadata.atr second', () => {
  it('reads the canonical path', () => {
    expect(resolveSignalAtrWithSource({ indicators: { atr: 1.25 }, reason: 'x' })).toEqual({ atr: 1.25, source: 'indicators' });
  });

  it('falls back to the legacy trend_follow path', () => {
    expect(resolveSignalAtrWithSource({ indicators: {}, atr: 0.75, reason: 'x' })).toEqual({ atr: 0.75, source: 'metadata' });
    expect(resolveSignalAtr({ atr: 0.75 })).toBe(0.75);
  });

  it('prefers the canonical path when both are present', () => {
    expect(resolveSignalAtrWithSource({ indicators: { atr: 2 }, atr: 3 })).toEqual({ atr: 2, source: 'indicators' });
  });

  it('returns null when neither path carries a positive finite number', () => {
    expect(resolveSignalAtr(undefined)).toBeNull();
    expect(resolveSignalAtr(null)).toBeNull();
    expect(resolveSignalAtr({})).toBeNull();
    expect(resolveSignalAtr({ indicators: {} })).toBeNull();
    expect(resolveSignalAtr({ indicators: { atr: 0 } })).toBeNull();
    expect(resolveSignalAtr({ indicators: { atr: -1 }, atr: NaN })).toBeNull();
    expect(resolveSignalAtr({ indicators: { atr: 'nope' }, atr: '1' })).toBeNull();
  });

  it('skips an unusable canonical value and still finds the legacy one', () => {
    expect(resolveSignalAtrWithSource({ indicators: { atr: 0 }, atr: 0.4 })).toEqual({ atr: 0.4, source: 'metadata' });
  });
});

// ────────────────────────────────────────────────────────────────────────
// 3. Decision with the real guardrails floor
// ────────────────────────────────────────────────────────────────────────

describe('evaluateAtrVolatilityFilter — guardrails.filters.atr_volatility_min/max', () => {
  it('the desk floor under test is 0.5%', () => {
    expect(ATR_MIN).toBe(0.005);
  });

  it('rejects when ATR / price is below the floor', () => {
    const v = evaluateAtrVolatilityFilter({ metadata: { indicators: { atr: 0.3 } }, price: 100, atrMin: ATR_MIN, atrMax: ATR_MAX });
    expect(v.outcome).toBe(ATR_BELOW_MIN);
    if (v.outcome === ATR_BELOW_MIN) {
      expect(v.atrPct).toBeCloseTo(0.003, 12);
      expect(v.atrSource).toBe('indicators');
    }
  });

  it('passes inside the band', () => {
    const v = evaluateAtrVolatilityFilter({ metadata: { indicators: { atr: 2 } }, price: 100, atrMin: ATR_MIN, atrMax: ATR_MAX });
    expect(v.outcome).toBe('pass');
  });

  it('rejects above the ceiling', () => {
    const v = evaluateAtrVolatilityFilter({ metadata: { indicators: { atr: 6 } }, price: 100, atrMin: ATR_MIN, atrMax: ATR_MAX });
    expect(v.outcome).toBe(ATR_ABOVE_MAX);
  });

  it('reports no_atr (does not block) when the signal carries no usable ATR or price', () => {
    expect(evaluateAtrVolatilityFilter({ metadata: { indicators: {} }, price: 100, atrMin: ATR_MIN, atrMax: ATR_MAX }).outcome).toBe('no_atr');
    expect(evaluateAtrVolatilityFilter({ metadata: { indicators: { atr: 1 } }, price: 0, atrMin: ATR_MIN, atrMax: ATR_MAX }).outcome).toBe('no_atr');
  });

  it('exactly at the floor is NOT below it (strict inequality, as before)', () => {
    const v = evaluateAtrVolatilityFilter({ metadata: { atr: 0.5 }, price: 100, atrMin: ATR_MIN, atrMax: ATR_MAX });
    expect(v.outcome).toBe('pass');
  });
});

// ────────────────────────────────────────────────────────────────────────
// 4. Regression — legacy trend_follow shape vs canonical shape
// ────────────────────────────────────────────────────────────────────────

describe('regression — metadata.atr-only (pre-fix trend_follow) vs indicators.atr-only (momentum)', () => {
  const legacyTf = { atr: 0.3, fastEma: 101, slowEma: 100, indicators: {}, reason: 'Bullish EMA crossover' };
  const canonical = { indicators: { atr: 0.3, rsi: 31 }, reason: 'RSI bounce' };

  it('the OLD read path saw no ATR on the trend_follow shape (this is the soak bug)', () => {
    const oldRead = (legacyTf.indicators as Record<string, number>).atr;
    expect(oldRead).toBeUndefined();
  });

  it('both shapes now yield the same sub-floor rejection', () => {
    const a = evaluateAtrVolatilityFilter({ metadata: legacyTf, price: 100, atrMin: ATR_MIN, atrMax: ATR_MAX });
    const b = evaluateAtrVolatilityFilter({ metadata: canonical, price: 100, atrMin: ATR_MIN, atrMax: ATR_MAX });
    expect(a.outcome).toBe(ATR_BELOW_MIN);
    expect(b.outcome).toBe(ATR_BELOW_MIN);
    if (a.outcome === ATR_BELOW_MIN && b.outcome === ATR_BELOW_MIN) {
      expect(a.atrPct).toBe(b.atrPct);
      expect(a.atrSource).toBe('metadata');
      expect(b.atrSource).toBe('indicators');
    }
  });

  it('both shapes pass identically inside the band', () => {
    const a = evaluateAtrVolatilityFilter({ metadata: { ...legacyTf, atr: 1.5 }, price: 100, atrMin: ATR_MIN, atrMax: ATR_MAX });
    const b = evaluateAtrVolatilityFilter({ metadata: { indicators: { atr: 1.5 } }, price: 100, atrMin: ATR_MIN, atrMax: ATR_MAX });
    expect(a.outcome).toBe('pass');
    expect(b.outcome).toBe('pass');
  });
});

// ────────────────────────────────────────────────────────────────────────
// 5. End-to-end — plugin signal under the floor → rejected, blotter format kept
// ────────────────────────────────────────────────────────────────────────

describe('end-to-end — a plugin-generated trend_follow entry under the 0.5% floor is rejected', () => {
  it('ATR 0.5 at price 110 (0.45%) → atr_below_min via the stamped indicators.atr', () => {
    const sig = generateTf({ direction: 'bull', price: 110, atr: 0.5 });
    const v = evaluateAtrVolatilityFilter({ metadata: sig.metadata, price: sig.price, atrMin: ATR_MIN, atrMax: ATR_MAX });
    expect(v.outcome).toBe(ATR_BELOW_MIN);
    if (v.outcome === ATR_BELOW_MIN) {
      expect(v.atrSource).toBe('indicators');
      expect(v.atrPct).toBeCloseTo(0.5 / 110, 12);
      const verdict = routeRejected('coinbase', ATR_VOL_STAGE, describeAtrVolatilityReject(v));
      expect(signalRouteColumns(verdict)).toEqual({
        allowed: false,
        routed_exchange: null,
        reason: 'atr_vol: atr_below_min (atrPct=0.00455)',
      });
    }
  });

  it('ATR 1.1 at price 110 (1.0%) passes', () => {
    const sig = generateTf({ direction: 'bull', price: 110, atr: 1.1 });
    expect(evaluateAtrVolatilityFilter({ metadata: sig.metadata, price: sig.price, atrMin: ATR_MIN, atrMax: ATR_MAX }).outcome).toBe('pass');
  });
});

// ────────────────────────────────────────────────────────────────────────
// 6. Backtest parity — BacktestEngine.handleSignal honours both stamp paths
// ────────────────────────────────────────────────────────────────────────

function makeLogger(): Logger {
  return { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
}

/** Private engine surface the harness drives (mirrors backtest-engine-parity-filters.test.ts). */
interface EngineInternals {
  initializeSignalProcessor(): void;
  currentBarTime: Date;
  handleSignal(signal: Signal): void;
  pendingFills: Map<string, unknown>;
  atrFilterRejects: number;
}

function engineConfig(): BacktestConfig {
  return {
    startDate: new Date('2024-01-01'),
    endDate: new Date('2024-01-02'),
    initialCapital: 10_000,
    commission: 0,
    products: ['BTC-USD'],
    signals: {
      breakout: { enabled: false, parameters: {} },
      vwapMeanReversion: { enabled: false, parameters: {} },
      momentum: { enabled: false, parameters: {} },
      trendFollow: { enabled: true, parameters: {} },
    },
    risk: { maxPositionSize: 3_000, maxTotalExposure: 30_000, stopLossPercent: 0.02, takeProfitPercent: 0.04 },
    account: { equityUsd: 10_000, riskPerTrade: 0.005, maxPositionExposurePct: 0.3, minNotionalBuffer: 1.1 },
    disabledStrategies: ['vwap_mr', 'breakout'],
    evGate: { mode: 'off' },
    filters: { atrVolatilityMin: ATR_MIN, atrVolatilityMax: ATR_MAX },
  };
}

function tfSignal(metadata: Signal['metadata'], price = 100): Signal {
  return {
    id: `sig-${Math.random()}`,
    timestamp: new Date('2030-01-01T00:00:00Z'),
    symbol: 'BTC-USD',
    strategy: 'trend_follow',
    direction: 'buy',
    strength: 0.7,
    price,
    stopLoss: price * 0.98,
    takeProfit: price * 1.06,
    metadata,
  } as Signal;
}

describe('BacktestEngine — atr_vol rejects the legacy metadata.atr-only shape like the canonical shape', () => {
  it('metadata.atr-only at 0.3% is rejected (previously slipped through)', () => {
    const engine = new BacktestEngine(engineConfig(), makeLogger());
    const eng = engine as unknown as EngineInternals;
    eng.initializeSignalProcessor();
    eng.currentBarTime = new Date('2024-01-01T00:00:00Z');

    eng.handleSignal(tfSignal({ indicators: {}, reason: 'tf', atr: 0.3 }));
    expect(eng.pendingFills.size).toBe(0);
    expect(eng.atrFilterRejects).toBe(1);

    eng.handleSignal(tfSignal({ indicators: { atr: 0.3 }, reason: 'canonical' }));
    expect(eng.pendingFills.size).toBe(0);
    expect(eng.atrFilterRejects).toBe(2);

    eng.handleSignal(tfSignal({ indicators: {}, reason: 'tf', atr: 2 }));
    expect(eng.pendingFills.size).toBe(1);
    expect(eng.atrFilterRejects).toBe(2);
  });
});
