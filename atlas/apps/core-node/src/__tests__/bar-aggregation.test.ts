/**
 * Bar aggregation (TASK_017 step 5 / E4 frequency lever).
 *
 *   1. 15m→60m rollup equals a hand-computed OHLCV fixture.
 *   2. Buckets are UTC-aligned (4H at 00/04/…, 1D at 00:00Z) regardless of
 *      where the series starts.
 *   3. Partial buckets are dropped below `minBucketFill` and counted.
 *   4. Impossible geometry (disaggregation, non-integer ratio) throws
 *      BAR_AGGREGATION_INVALID — never a silent resample.
 *   5. The committed real 7d fixtures roll up to 42 × 4H and 7 × 1D bars
 *      with provenance intact (source, sha256, aggregation record).
 *   6. `pnpm backtest --strategy <one>` really isolates that strategy.
 */
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  aggregateCandles,
  subBarsPerBucket,
  withBarAggregation,
  describeBarTimeframe,
  isBarAggregationError,
  BarAggregationError,
  DEFAULT_MIN_BUCKET_FILL,
} from '../backtesting/bar-aggregation';
import { HistoricalDataLoader, type DataProvenance } from '../backtesting/data-loader';
import { BacktestRunner } from '../backtesting/backtest-runner';
import { BacktestEngine, type BacktestConfig } from '../backtesting/backtest-engine';
import type { OHLCV } from '../indicators/technical';

function makeLogger() {
  return { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as any;
}

const T0 = Date.UTC(2026, 0, 1, 0, 0, 0); // 2026-01-01T00:00:00Z
const MIN = 60_000;

function bar(time: number, open: number, high: number, low: number, close: number, volume: number): OHLCV {
  return { time, open, high, low, close, volume };
}

/** Deterministic 15m series starting at `start`, `count` bars. */
function series15m(start: number, count: number, seed = 7): OHLCV[] {
  let state = seed >>> 0;
  const next = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return (state >>> 8) / 0x01000000;
  };
  const out: OHLCV[] = [];
  let price = 1000;
  for (let i = 0; i < count; i++) {
    const open = price;
    const close = price + (next() - 0.5) * 10;
    const high = Math.max(open, close) + next() * 3;
    const low = Math.min(open, close) - next() * 3;
    out.push(bar(start + i * 15 * MIN, open, high, low, close, 1 + next()));
    price = close;
  }
  return out;
}

const FIXTURE_DIR = path.resolve(__dirname, '../../fixtures/bars');

describe('bar-aggregation §1 — hand-computed 15m→60m rollup', () => {
  const four15m = [
    bar(T0 + 0 * MIN, 100, 105, 99, 104, 10),
    bar(T0 + 15 * MIN, 104, 110, 103, 108, 20),
    bar(T0 + 30 * MIN, 108, 109, 101, 102, 30),
    bar(T0 + 45 * MIN, 102, 106, 100, 105, 40),
  ];

  it('open=first, high=max, low=min, close=last, volume=sum, time=bucket start', () => {
    const { candles, summary } = aggregateCandles(four15m, 60, 15);
    expect(candles).toEqual([bar(T0, 100, 110, 99, 105, 100)]);
    expect(summary).toEqual({
      targetMinutes: 60,
      sourceMinutes: 15,
      sourceCandleCount: 4,
      outputCandleCount: 1,
      subBarsPerBucket: 4,
      bucketsDropped: 0,
      partialBucketsKept: 0,
      minBucketFill: DEFAULT_MIN_BUCKET_FILL,
    });
  });

  it('is order- and duplicate-insensitive (normalizes first)', () => {
    const shuffled = [four15m[2], four15m[0], four15m[3], four15m[1], { ...four15m[1] }];
    const { candles } = aggregateCandles(shuffled, 60, 15);
    expect(candles).toEqual([bar(T0, 100, 110, 99, 105, 100)]);
  });

  it('identity when target == source', () => {
    const { candles, summary } = aggregateCandles(four15m, 15, 15);
    expect(candles).toEqual(four15m);
    expect(summary.subBarsPerBucket).toBe(1);
    expect(summary.bucketsDropped).toBe(0);
  });
});

describe('bar-aggregation §2/§3 — UTC alignment and partial buckets', () => {
  it('4H buckets open at 00/04/08… UTC even when the series starts mid-bucket', () => {
    // Start 02:15Z → first bucket (00:00–04:00) holds 7 of 16 sub-bars (43.75% < 50%) → dropped.
    const start = T0 + (2 * 60 + 15) * MIN;
    const src = series15m(start, 7 + 16 * 3); // partial + 3 full buckets
    const { candles, summary } = aggregateCandles(src, 240, 15);
    expect(summary.subBarsPerBucket).toBe(16);
    expect(summary.bucketsDropped).toBe(1);
    expect(summary.partialBucketsKept).toBe(0);
    expect(candles.map((c) => new Date(c.time).toISOString())).toEqual([
      '2026-01-01T04:00:00.000Z',
      '2026-01-01T08:00:00.000Z',
      '2026-01-01T12:00:00.000Z',
    ]);
    // Every emitted bar is UTC-aligned to its period.
    for (const c of candles) expect(c.time % (240 * MIN)).toBe(0);
  });

  it('1D bars open at 00:00Z and a trailing single sub-bar is dropped, not emitted', () => {
    // 7 full days + the 00:00 bar of day 8 (the inclusive-window shape of the committed fixtures).
    const src = series15m(T0, 96 * 7 + 1);
    const { candles, summary } = aggregateCandles(src, 1440, 15);
    expect(candles.length).toBe(7);
    expect(summary.bucketsDropped).toBe(1);
    expect(candles[0].time).toBe(T0);
    for (const c of candles) expect(new Date(c.time).toISOString().endsWith('T00:00:00.000Z')).toBe(true);
  });

  it('minBucketFill controls keep/drop of partial buckets and reports both counts', () => {
    const src = series15m(T0, 4 + 1); // one full hour + one lone 15m bar
    const strict = aggregateCandles(src, 60, 15, { minBucketFill: 1 });
    expect(strict.candles.length).toBe(1);
    expect(strict.summary.bucketsDropped).toBe(1);
    expect(strict.summary.partialBucketsKept).toBe(0);

    const lenient = aggregateCandles(src, 60, 15, { minBucketFill: 0.25 });
    expect(lenient.candles.length).toBe(2);
    expect(lenient.summary.bucketsDropped).toBe(0);
    expect(lenient.summary.partialBucketsKept).toBe(1);
    // The partial bar is still a correct rollup of what it contains.
    expect(lenient.candles[1]).toEqual({ ...src[4], time: T0 + 60 * MIN });
  });

  it('interior gap: a bucket missing half its sub-bars is kept at the default fill, dropped at 1.0', () => {
    const full = series15m(T0, 16 * 2);
    const gapped = full.filter((c, i) => !(i >= 16 && i < 16 + 8)); // second 4H bucket keeps 8/16
    const dflt = aggregateCandles(gapped, 240, 15);
    expect(dflt.candles.length).toBe(2);
    expect(dflt.summary.partialBucketsKept).toBe(1);
    const strict = aggregateCandles(gapped, 240, 15, { minBucketFill: 1 });
    expect(strict.candles.length).toBe(1);
    expect(strict.summary.bucketsDropped).toBe(1);
  });
});

describe('bar-aggregation §4 — fail-closed geometry', () => {
  it('refuses to disaggregate or to use a non-integer ratio', () => {
    expect(() => subBarsPerBucket(60, 15)).toThrow(BarAggregationError);
    expect(() => subBarsPerBucket(15, 100)).toThrow(/not an integer multiple/);
    expect(() => subBarsPerBucket(0, 60)).toThrow(/positive number/);
    expect(() => subBarsPerBucket(15, 240.5)).toThrow(/positive integer/);
    expect(subBarsPerBucket(15, 240)).toBe(16);
    expect(subBarsPerBucket(60, 1440)).toBe(24);
    expect(subBarsPerBucket(15, 90)).toBe(6);

    let thrown: unknown;
    try {
      aggregateCandles(series15m(T0, 8), 25, 15);
    } catch (err) {
      thrown = err;
    }
    expect(isBarAggregationError(thrown)).toBe(true);
    expect((thrown as Error).message).toContain('BAR_AGGREGATION_INVALID');
    expect(isBarAggregationError(new Error('x'))).toBe(false);
  });

  it('provider wrapper throws when the stored spacing cannot feed the target', async () => {
    const loader = new HistoricalDataLoader({ fixtureDir: FIXTURE_DIR }, makeLogger());
    const native = loader.createDataProvider({});
    const bad = withBarAggregation(native, 100, {}, makeLogger());
    await expect(bad('BTC-USD', new Date('2026-09-03T00:00:00Z'), new Date('2026-09-10T00:00:00Z'))).rejects.toMatchObject({
      code: 'BAR_AGGREGATION_INVALID',
    });
  });
});

describe('bar-aggregation §5 — committed real fixtures roll up with provenance', () => {
  const start = new Date('2026-09-03T00:00:00Z');
  const end = new Date('2026-09-10T00:00:00Z');

  it('BTC-USD/ETH-USD 15m fixtures → 42 × 4H bars, each a faithful rollup of its 16 sub-bars', async () => {
    const loader = new HistoricalDataLoader({ fixtureDir: FIXTURE_DIR }, makeLogger());
    for (const symbol of ['BTC-USD', 'ETH-USD']) {
      const native = await loader.loadCandles(symbol, start, end, 900);
      const { candles, summary } = aggregateCandles(native.candles, 240, 15);
      expect(summary.sourceCandleCount).toBe(673);
      expect(candles.length).toBe(42);
      expect(summary.bucketsDropped).toBe(1); // the lone 2026-09-10T00:00 bar
      expect(summary.partialBucketsKept).toBe(0);
      expect(new Date(candles[0].time).toISOString()).toBe('2026-09-03T00:00:00.000Z');
      expect(new Date(candles[41].time).toISOString()).toBe('2026-09-09T20:00:00.000Z');
      // Spot-check every bucket against the raw sub-bars.
      for (const agg of candles) {
        const sub = native.candles.filter((c) => c.time >= agg.time && c.time < agg.time + 240 * MIN);
        expect(sub.length).toBe(16);
        expect(agg.open).toBe(sub[0].open);
        expect(agg.close).toBe(sub[15].close);
        expect(agg.high).toBe(Math.max(...sub.map((c) => c.high)));
        expect(agg.low).toBe(Math.min(...sub.map((c) => c.low)));
        expect(agg.volume).toBeCloseTo(sub.reduce((s, c) => s + c.volume, 0), 6);
      }
    }
  });

  it('provider wrapper attaches an aggregation record and keeps fixture provenance', async () => {
    const logger = makeLogger();
    const loader = new HistoricalDataLoader({ fixtureDir: FIXTURE_DIR }, logger);
    const provider = withBarAggregation(loader.createDataProvider({}), 1440, {}, logger);
    const out = await provider('ETH-USD', start, end);
    expect(out.candles.length).toBe(7);
    const p = out.provenance;
    expect(p.source).toBe('fixture');
    expect(p.fixtureSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(p.granularitySeconds).toBe(86_400);
    expect(p.inferredBarMinutes).toBe(1440);
    expect(p.candleCount).toBe(7);
    expect(p.expectedCount).toBe(8);
    expect(p.aggregation).toEqual({
      targetMinutes: 1440,
      sourceMinutes: 15,
      sourceCandleCount: 673,
      outputCandleCount: 7,
      subBarsPerBucket: 96,
      bucketsDropped: 1,
      partialBucketsKept: 0,
      minBucketFill: 0.5,
    });
    expect(describeBarTimeframe([p])).toContain('1440 min (aggregated from 15m stored bars');
    expect(describeBarTimeframe([p])).toContain('1 partial bucket(s) dropped');
  });

  it('native (no aggregation) provenance describes native bars', () => {
    const native: DataProvenance = {
      symbol: 'BTC-USD', source: 'fixture', windowStart: '', windowEnd: '', granularitySeconds: 900,
      candleCount: 673, expectedCount: 673, coverage: 1, firstBarTime: null, lastBarTime: null,
      inferredBarMinutes: 15, loadTimeMs: 1,
    };
    expect(describeBarTimeframe([native])).toBe('15 min (native stored bars; no aggregation)');
    expect(describeBarTimeframe([])).toBe('n/a');
  });

  it('BacktestRunner.createDataProvider honours barMinutes and the run report names the rollup', async () => {
    const resultsPath = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-e4-agg-'));
    const runner = new BacktestRunner({ resultsPath, fixtureDir: FIXTURE_DIR }, makeLogger());
    const nativeProvider = runner.createDataProvider({});
    const aggProvider = runner.createDataProvider({ barMinutes: 240 });
    const nativeOut = await nativeProvider('BTC-USD', start, end);
    const aggOut = await aggProvider('BTC-USD', start, end);
    expect(nativeOut.candles.length).toBe(673);
    expect(nativeOut.provenance.aggregation).toBeUndefined();
    expect(aggOut.candles.length).toBe(42);
    expect(aggOut.provenance.aggregation?.targetMinutes).toBe(240);

    const config: BacktestConfig = {
      startDate: start, endDate: end, initialCapital: 1000, commission: 0, products: ['BTC-USD'],
      signals: {
        breakout: { enabled: false, parameters: {} },
        vwapMeanReversion: { enabled: false, parameters: {} },
        momentum: { enabled: false, parameters: {} },
        trendFollow: { enabled: true, parameters: {} },
      },
      risk: { maxPositionSize: 300, maxTotalExposure: 3000, stopLossPercent: 0.02, takeProfitPercent: 0.04 },
      account: { equityUsd: 1000, riskPerTrade: 0.005, maxPositionExposurePct: 0.3, minNotionalBuffer: 1.1 },
      disabledStrategies: ['vwap_mr', 'breakout'],
      evGate: { mode: 'off' },
    };
    const { result, saved } = await runner.runBacktestDetailed(config, { barMinutes: 240 });
    expect(result.dataStamp).toBe('REAL');
    expect(result.dataProvenance['BTC-USD'].aggregation?.subBarsPerBucket).toBe(16);
    expect(result.equityCurve.length).toBe(42);
    expect(saved).not.toBeNull();
    const report = fs.readFileSync(saved!.reportPath, 'utf8');
    expect(report.split('\n')[0]).toBe('DATA: REAL');
    expect(report).toContain('Bar timeframe: 240 min (aggregated from 15m stored bars');
    expect(report).toContain('aggregated=15m→240m from 673 bars');
  });
});

describe('bar-aggregation §6 — strategy selector isolation in the engine', () => {
  function cfg(selection: 'trend_follow' | 'momentum' | 'all'): BacktestConfig {
    return {
      startDate: new Date('2024-01-01'), endDate: new Date('2024-01-05'), initialCapital: 10_000, commission: 0,
      products: ['BTC-USD'],
      signals: {
        breakout: { enabled: selection === 'all', parameters: {} },
        vwapMeanReversion: { enabled: selection === 'all', parameters: {} },
        momentum: { enabled: selection === 'momentum' || selection === 'all', parameters: {} },
        trendFollow: { enabled: selection === 'trend_follow' || selection === 'all', parameters: {} },
      },
      risk: { maxPositionSize: 3_000, maxTotalExposure: 30_000, stopLossPercent: 0.02, takeProfitPercent: 0.04 },
      account: { equityUsd: 10_000, riskPerTrade: 0.005, maxPositionExposurePct: 0.3, minNotionalBuffer: 1.1 },
      disabledStrategies: ['vwap_mr', 'breakout'],
      evGate: { mode: 'off' },
    };
  }

  it('--strategy trend_follow runs ONLY trend_follow; --strategy momentum runs ONLY momentum', async () => {
    const candles = series15m(T0, 400, 42);
    const run = async (selection: 'trend_follow' | 'momentum' | 'all') => {
      const engine = new BacktestEngine(cfg(selection), makeLogger());
      await engine.loadHistoricalData(async () => candles);
      return engine.run();
    };
    const tf = await run('trend_follow');
    expect(tf.metrics.activeStrategies).toEqual(['trend_follow']);
    expect(tf.trades.every((t) => t.strategy === 'trend_follow')).toBe(true);

    const mom = await run('momentum');
    expect(mom.metrics.activeStrategies).toEqual(['momentum']);
    expect(mom.trades.every((t) => t.strategy === 'momentum')).toBe(true);

    const all = await run('all');
    expect(new Set(all.metrics.activeStrategies)).toEqual(new Set(['momentum', 'trend_follow']));
    // Kill-listed strategies never register regardless of the selector.
    expect(all.metrics.activeStrategies).not.toContain('breakout');
    expect(all.metrics.activeStrategies).not.toContain('vwap_mr');
  });
});
