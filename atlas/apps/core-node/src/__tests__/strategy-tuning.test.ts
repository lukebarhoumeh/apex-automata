/**
 * Regression tests for fix/strategy-tuning.
 *
 * Bug A — TrendFollowStrategy was emitting on every bar for up to 10 bars
 *         after a single EMA crossover, was reading a 1m DI proxy as its
 *         "MTF alignment" gate, and was happily firing in ranging regimes.
 *         Live evidence: ~3.6 signals/min/symbol in `regime: ranging` with
 *         `mtfAligned: true` even though no 1h check ran.
 *
 * Bug B — MomentumStrategy was reading aggressive RSI thresholds (40/55–60)
 *         from both the schema defaults and the inline `getConfig` fallback,
 *         producing SELL signals at RSI 56.5. Restored to the textbook
 *         30/70.
 *
 * These tests pin the new behaviour so neither bug regresses.
 */

import { describe, it, expect } from 'vitest';
import {
  TrendFollowStrategy,
  MomentumStrategy,
  type MarketContext,
} from '../strategies/plugins';
import type { RegimeState, MarketRegime } from '../strategies/regime-detector';
import type { OHLCV } from '../indicators/technical';

// ────────────────────────────────────────────────────────────────────────────
// Synthetic context helpers
// ────────────────────────────────────────────────────────────────────────────

function flatCandles(count: number, price: number, startTime = 0): OHLCV[] {
  const out: OHLCV[] = [];
  for (let i = 0; i < count; i++) {
    out.push({
      time: startTime + i * 60_000,
      open: price,
      high: price,
      low: price,
      close: price,
      volume: 100,
    });
  }
  return out;
}

function regime(state: Partial<RegimeState> & { regime: MarketRegime }): RegimeState {
  return {
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
    ...state,
  };
}

interface MakeTrendCtxArgs {
  /** Index at which the EMA12 vs EMA15 crossover occurs (0-based). */
  crossAtBar: number;
  /** Bar index we are calling generateSignals at (>= crossAtBar). */
  evaluateAtBar: number;
  /** Regime to attach to the context. */
  regimeState?: MarketRegime;
  /** Optional 1h candle override for the MTF gate. */
  mtfH1Candles?: OHLCV[];
  /** Direction of the cross — 'bull' (EMA12 crosses above EMA15) or 'bear'. */
  direction?: 'bull' | 'bear';
}

/**
 * Builds a MarketContext where the EMA12 array crosses EMA15 at exactly
 * `crossAtBar`. We construct the indicator arrays directly so we control
 * the exact bar-by-bar values seen by the plugin.
 */
function makeTrendContext({
  crossAtBar,
  evaluateAtBar,
  regimeState = 'strong_trend',
  mtfH1Candles,
  direction = 'bull',
}: MakeTrendCtxArgs): MarketContext {
  if (evaluateAtBar < crossAtBar) {
    throw new Error('evaluateAtBar must be >= crossAtBar');
  }
  const totalBars = evaluateAtBar + 1;

  // Build EMA12 / EMA15 arrays with a hard crossover at `crossAtBar`.
  //
  // bull: before cross, fast=99, slow=100 (fast < slow)
  //       at  cross & after,  fast=101, slow=100 (fast > slow strictly)
  // bear: mirror image.
  const ema12: number[] = [];
  const ema15: number[] = [];
  for (let i = 0; i < totalBars; i++) {
    if (i < crossAtBar) {
      if (direction === 'bull') {
        ema12.push(99);
        ema15.push(100);
      } else {
        ema12.push(101);
        ema15.push(100);
      }
    } else {
      if (direction === 'bull') {
        ema12.push(101);
        ema15.push(100);
      } else {
        ema12.push(99);
        ema15.push(100);
      }
    }
  }
  const atr: number[] = new Array(totalBars).fill(0.5);

  // Candle close needs to confirm direction: price above both EMAs for bull,
  // below for bear. We use a flat close = 110 (bull) or 90 (bear).
  const close = direction === 'bull' ? 110 : 90;
  const candles = flatCandles(totalBars, close);

  return {
    symbol: 'BTC-USD',
    timestamp: new Date(),
    candles,
    mtfCandles: { h1: mtfH1Candles },
    indicators: { ema12, ema15, atr },
    latestIndicators: {
      ema12: ema12[ema12.length - 1],
      ema15: ema15[ema15.length - 1],
      atr: atr[atr.length - 1],
    },
    latestCandle: candles[candles.length - 1],
    previousCandle: candles[candles.length - 2],
    regime: regime({ regime: regimeState }),
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Bug A — trend_follow re-emission, MTF cheat, regime gate
// ────────────────────────────────────────────────────────────────────────────

describe('Bug A — trend_follow emits ONCE per EMA crossover (no per-bar re-emission)', () => {
  it('emits exactly one signal at the bar where the cross occurs', () => {
    const strategy = new TrendFollowStrategy();
    // Cross occurs at bar 30; evaluate at bar 30 (the cross bar).
    const ctx = makeTrendContext({ crossAtBar: 30, evaluateAtBar: 30 });
    const signals = strategy.generateSignals(ctx);
    expect(signals).toHaveLength(1);
    expect(signals[0].direction).toBe('buy');
    expect((signals[0].metadata as any).crossoverBarsAgo).toBe(0);
  });

  it('emits ZERO signals on each of bars N+1 through N+5 after the cross', () => {
    const strategy = new TrendFollowStrategy();
    // We do NOT share state across calls — but with the default
    // crossoverLookback=0 the plugin only fires when the cross is on the
    // current bar. Evaluating at any bar > crossAtBar means prev EMA fast
    // is already > slow, so the current-bar cross detector misses.
    for (let offset = 1; offset <= 5; offset++) {
      const ctx = makeTrendContext({
        crossAtBar: 30,
        evaluateAtBar: 30 + offset,
      });
      const signals = strategy.generateSignals(ctx);
      expect(signals, `bar N+${offset} should not re-emit`).toHaveLength(0);
    }
  });

  it('strength is not boosted by MTF alignment when the gate is disabled by default', () => {
    const strategy = new TrendFollowStrategy();
    const ctx = makeTrendContext({ crossAtBar: 30, evaluateAtBar: 30 });
    const signals = strategy.generateSignals(ctx);
    expect(signals[0].metadata).toMatchObject({
      mtfRequired: false,
      mtfAligned: 'disabled',
    });
  });
});

describe('Bug A — trend_follow refuses to emit in ranging / choppy regimes', () => {
  it('regimeCompatibility marks ranging as incompatible (registry will block)', () => {
    const strategy = new TrendFollowStrategy();
    const ranging = strategy.regimeCompatibility.find(r => r.regime === 'ranging');
    const choppy = strategy.regimeCompatibility.find(r => r.regime === 'choppy');
    expect(ranging?.compatibility).toBe('incompatible');
    expect(choppy?.compatibility).toBe('incompatible');
    expect(ranging?.positionMultiplier).toBe(0);
    expect(choppy?.positionMultiplier).toBe(0);
  });

  // The StrategyRegistry inspects regimeCompatibility BEFORE calling
  // generateSignals, so the plugin itself doesn't need an additional
  // internal check. The previous regression in the live paper run was
  // 90 signal-emitted log lines in `regime: ranging` — fixed at the
  // compatibility-matrix layer.
});

describe('Bug A — MTF gate uses real 1h EMA when required, refuses to lie when data is missing', () => {
  function makeH1(closes: number[]): OHLCV[] {
    return closes.map((c, i) => ({
      time: i * 3_600_000,
      open: c,
      high: c,
      low: c,
      close: c,
      volume: 100,
    }));
  }

  it('refuses to emit when requireMtfAlignment is true and h1 history is insufficient', () => {
    const strategy = new TrendFollowStrategy({ requireMtfAlignment: true });
    // emaSlow defaults to 15; we need >= 20 bars (15 + 5). Pass only 5.
    const tooFew = makeH1([100, 101, 102, 103, 104]);
    const ctx = makeTrendContext({
      crossAtBar: 30,
      evaluateAtBar: 30,
      mtfH1Candles: tooFew,
    });
    expect(strategy.generateSignals(ctx)).toHaveLength(0);
  });

  it('refuses to emit when requireMtfAlignment is true and 1h trend disagrees', () => {
    const strategy = new TrendFollowStrategy({ requireMtfAlignment: true });
    // Downward staircase: any EMA(12) will sit below EMA(15) — bearish 1h.
    const downCloses: number[] = [];
    for (let i = 0; i < 40; i++) downCloses.push(100 - i);
    const ctx = makeTrendContext({
      crossAtBar: 30,
      evaluateAtBar: 30,
      mtfH1Candles: makeH1(downCloses),
      direction: 'bull', // 1m bullish cross — should be vetoed by bearish 1h
    });
    expect(strategy.generateSignals(ctx)).toHaveLength(0);
  });

  it('emits when requireMtfAlignment is true and 1h trend agrees', () => {
    const strategy = new TrendFollowStrategy({ requireMtfAlignment: true });
    // Upward staircase: EMA(12) above EMA(15) — bullish 1h.
    const upCloses: number[] = [];
    for (let i = 0; i < 40; i++) upCloses.push(100 + i);
    const ctx = makeTrendContext({
      crossAtBar: 30,
      evaluateAtBar: 30,
      mtfH1Candles: makeH1(upCloses),
      direction: 'bull',
    });
    const signals = strategy.generateSignals(ctx);
    expect(signals).toHaveLength(1);
    expect(signals[0].metadata).toMatchObject({
      mtfRequired: true,
      mtfAligned: true,
    });
  });

  it('legacy regimeTrend down does NOT block when 1h data is present and agrees (no more DI proxy)', () => {
    // This pins the audit's "1m DI proxy" fix: previously this exact
    // scenario would have been blocked because regime.trendDirection
    // was 'down'. Now the gate ignores regime.trendDirection and looks
    // only at h1 candles.
    const strategy = new TrendFollowStrategy({ requireMtfAlignment: true });
    const upCloses: number[] = [];
    for (let i = 0; i < 40; i++) upCloses.push(100 + i);
    const ctx = makeTrendContext({
      crossAtBar: 30,
      evaluateAtBar: 30,
      mtfH1Candles: makeH1(upCloses),
      direction: 'bull',
    });
    ctx.regime.trendDirection = 'down'; // would have falsely vetoed pre-fix
    const signals = strategy.generateSignals(ctx);
    expect(signals).toHaveLength(1);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Bug B — momentum RSI thresholds
// ────────────────────────────────────────────────────────────────────────────

interface MakeRsiCtxArgs {
  prevRsi: number;
  currRsi: number;
  regimeState?: MarketRegime;
}

function makeMomentumContext({
  prevRsi,
  currRsi,
  regimeState = 'weak_trend',
}: MakeRsiCtxArgs): MarketContext {
  const candles = flatCandles(60, 100);
  // Each indicator needs at least 2 values to satisfy getPrevIndicator.
  const rsi = [...new Array(58).fill(50), prevRsi, currRsi];
  const macd = new Array(60).fill(0);
  const macdSignal = new Array(60).fill(0);
  const macdHistogram = new Array(60).fill(0);
  const atr = new Array(60).fill(0.5);
  return {
    symbol: 'BTC-USD',
    timestamp: new Date(),
    candles,
    indicators: { rsi, macd, macdSignal, macdHistogram, atr },
    latestIndicators: {
      rsi: currRsi,
      macd: 0,
      macdSignal: 0,
      macdHistogram: 0,
      atr: 0.5,
    },
    latestCandle: candles[candles.length - 1],
    previousCandle: candles[candles.length - 2],
    regime: regime({ regime: regimeState }),
  };
}

describe('Bug B — momentum SELL only fires when RSI crosses UP through 70 (not 50)', () => {
  it('does NOT emit SELL when RSI crosses up through 50 (45 → 56.5)', () => {
    const strategy = new MomentumStrategy();
    const ctx = makeMomentumContext({ prevRsi: 45, currRsi: 56.5 });
    const signals = strategy.generateSignals(ctx);
    const sells = signals.filter(s => s.direction === 'sell');
    expect(sells).toHaveLength(0);
  });

  it('does NOT emit SELL when RSI crosses up through 60 (58 → 65)', () => {
    const strategy = new MomentumStrategy();
    const ctx = makeMomentumContext({ prevRsi: 58, currRsi: 65 });
    const signals = strategy.generateSignals(ctx);
    const sells = signals.filter(s => s.direction === 'sell');
    expect(sells).toHaveLength(0);
  });

  it('DOES emit SELL when RSI crosses up through 70 (68 → 72)', () => {
    const strategy = new MomentumStrategy();
    const ctx = makeMomentumContext({ prevRsi: 68, currRsi: 72 });
    const signals = strategy.generateSignals(ctx);
    const sells = signals.filter(s => s.direction === 'sell');
    expect(sells).toHaveLength(1);
    expect((sells[0].metadata as any).rsiCrossedInto).toBe('overbought');
  });
});

describe('Bug B — momentum BUY only fires when RSI crosses DOWN through 30 (not 50)', () => {
  it('does NOT emit BUY when RSI crosses down through 50 (55 → 43)', () => {
    const strategy = new MomentumStrategy();
    const ctx = makeMomentumContext({ prevRsi: 55, currRsi: 43 });
    const signals = strategy.generateSignals(ctx);
    const buys = signals.filter(s => s.direction === 'buy');
    expect(buys).toHaveLength(0);
  });

  it('does NOT emit BUY when RSI crosses down through 40 (42 → 35)', () => {
    const strategy = new MomentumStrategy();
    const ctx = makeMomentumContext({ prevRsi: 42, currRsi: 35 });
    const signals = strategy.generateSignals(ctx);
    const buys = signals.filter(s => s.direction === 'buy');
    expect(buys).toHaveLength(0);
  });

  it('DOES emit BUY when RSI crosses down through 30 (32 → 28)', () => {
    const strategy = new MomentumStrategy();
    const ctx = makeMomentumContext({ prevRsi: 32, currRsi: 28 });
    const signals = strategy.generateSignals(ctx);
    const buys = signals.filter(s => s.direction === 'buy');
    expect(buys).toHaveLength(1);
    expect((buys[0].metadata as any).rsiCrossedInto).toBe('oversold');
  });
});
