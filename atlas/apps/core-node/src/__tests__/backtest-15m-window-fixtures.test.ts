/**
 * Native 15m bar fixtures for E2-MOM-ISO (fixtures/bars/15m/<window>).
 *
 *   1. Committed files are real Coinbase Advanced Trade public FIFTEEN_MINUTE
 *      candles: provenance declared, no rollup block, UTC-aligned, OHLC-sane,
 *      and contiguous at 900 s except for the documented upstream holes —
 *      an undocumented hole, or a silently filled one, fails the suite.
 *   2. Tune and holdout are adjacent and disjoint (fit on tune, count on
 *      holdout, never the other way round).
 *   3. 15m → 1d reproduces the native ONE_DAY fixtures' OHLC exactly on every
 *      complete day both sets cover — the 15m series is the same market.
 *   4. The fail-closed loader serves the holdout / tune windows as REAL
 *      fixture data with honest coverage, and the bare 15m/ container (or a
 *      window a set does not cover) is DATA_UNAVAILABLE.
 *
 * Windows (see fixtures/bars/15m/README.md):
 *   holdout-2025-03_2026-03/ 2025-03-01 → 2026-03-01 — hard-preflight / counted path
 *   tune-2023-03_2025-03/    2023-03-01 → 2025-03-01 — tuning window (in-sample)
 */
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { rollupCandles } from '../cli/backtest-backfill';
import { HistoricalDataLoader, type BarFixtureFile } from '../backtesting/data-loader';

function makeLogger() {
  return { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as any;
}

const STEP = 900;
const DAY = 86_400;
const FIXTURES = path.resolve(__dirname, '../../fixtures/bars');
const HOLDOUT_15M = path.join(FIXTURES, '15m', 'holdout-2025-03_2026-03');
const TUNE_15M = path.join(FIXTURES, '15m', 'tune-2023-03_2025-03');
const TRIO = ['BTC-USD', 'ETH-USD', 'SOL-USD'] as const;
type Symbol3 = (typeof TRIO)[number];

/** Inclusive range of missing 15m bar starts → list of epoch seconds. */
function missing(fromIso: string, toIso: string = fromIso): number[] {
  const from = new Date(fromIso).getTime() / 1000;
  const to = new Date(toIso).getTime() / 1000;
  const out: number[] = [];
  for (let t = from; t <= to; t += STEP) out.push(t);
  return out;
}

/**
 * Bar starts Coinbase's own public 15m series does not have (exchange
 * outages — re-queried directly against the endpoint at generation).
 */
const HOLDOUT_GAPS: Record<Symbol3, number[]> = {
  'BTC-USD': missing('2025-10-25T15:15:00Z', '2025-10-25T20:45:00Z'),
  'ETH-USD': [...missing('2025-04-25T07:30:00Z', '2025-04-25T07:45:00Z'), ...missing('2025-10-25T15:15:00Z', '2025-10-25T20:45:00Z')],
  'SOL-USD': missing('2025-10-25T15:15:00Z', '2025-10-25T20:45:00Z'),
};
const TUNE_COMMON_GAPS = [
  ...missing('2023-05-19T07:45:00Z', '2023-05-19T08:00:00Z'),
  ...missing('2024-02-09T21:45:00Z'),
  ...missing('2024-05-31T22:15:00Z', '2024-05-31T23:00:00Z'),
  ...missing('2024-10-26T16:15:00Z', '2024-10-26T17:00:00Z'),
];
const TUNE_GAPS: Record<Symbol3, number[]> = {
  'BTC-USD': [...missing('2023-03-04T17:00:00Z', '2023-03-04T21:15:00Z'), ...TUNE_COMMON_GAPS],
  'ETH-USD': [...missing('2023-03-04T17:15:00Z', '2023-03-04T21:15:00Z'), ...TUNE_COMMON_GAPS],
  'SOL-USD': [...missing('2023-03-04T17:00:00Z', '2023-03-04T21:45:00Z'), ...TUNE_COMMON_GAPS, ...missing('2024-12-09T07:00:00Z')],
};

const HOLDOUT_BARS: Record<Symbol3, number> = { 'BTC-USD': 35017, 'ETH-USD': 35015, 'SOL-USD': 35017 };
const TUNE_BARS: Record<Symbol3, number> = { 'BTC-USD': 70147, 'ETH-USD': 70148, 'SOL-USD': 70144 };

// The files are 5–10 MB each; parse each once per run.
const cache = new Map<string, BarFixtureFile>();
function readFixture(dir: string, symbol: string): BarFixtureFile {
  const file = path.join(dir, `${symbol}.json`);
  let parsed = cache.get(file);
  if (!parsed) {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as BarFixtureFile;
    cache.set(file, parsed);
  }
  return parsed;
}

/**
 * Every bar is UTC-aligned and OHLC-sane, and consecutive bars are exactly
 * STEP apart except across `knownGaps`. The set of gaps found must equal
 * the documented set exactly.
 */
function assertContiguous(file: BarFixtureFile, knownGaps: number[]): void {
  const found: number[] = [];
  let violations = 0;
  for (let i = 0; i < file.candles.length; i++) {
    const c = file.candles[i];
    if (c.time % STEP !== 0) violations++;
    if (i > 0) {
      if (c.time <= file.candles[i - 1].time) violations++;
      for (let t = file.candles[i - 1].time + STEP; t < c.time; t += STEP) found.push(t);
    }
    if (!(c.low > 0 && c.low <= Math.min(c.open, c.close) && c.high >= Math.max(c.open, c.close) && c.volume > 0)) {
      violations++;
    }
  }
  expect(violations).toBe(0);
  expect(found).toEqual(knownGaps);
}

function assertRealFifteenMinute(file: BarFixtureFile, symbol: string): void {
  expect(file.symbol).toBe(symbol);
  expect(file.exchange).toBe('coinbase');
  expect(file.source).toBe('coinbase-advanced-trade-public');
  expect(file.source).not.toMatch(/synthetic/i);
  expect(file.endpoint).toBe(`https://api.coinbase.com/api/v3/brokerage/market/products/${symbol}/candles`);
  expect(file.granularity).toBe('FIFTEEN_MINUTE');
  expect(file.granularitySeconds).toBe(STEP);
  expect(file.rollup).toBeUndefined();
  expect(new Date(file.fetchedAt).getTime()).toBeGreaterThan(0);
  expect(new Date(file.start).getTime() / 1000).toBe(file.candles[0].time);
  expect(new Date(file.end).getTime() / 1000).toBe(file.candles[file.candles.length - 1].time);
}

describe('committed 15m window fixtures are real, contiguous and self-describing', () => {
  it('15m/holdout-2025-03_2026-03/: BTC, ETH, SOL — 2025-03-01 → 2026-03-01, native 15m, only the documented upstream holes', () => {
    for (const symbol of TRIO) {
      const file = readFixture(HOLDOUT_15M, symbol);
      assertRealFifteenMinute(file, symbol);
      expect(file.candles).toHaveLength(HOLDOUT_BARS[symbol]);
      expect(file.candles.length + HOLDOUT_GAPS[symbol].length).toBe(365 * 96);
      expect(file.candles[0].time).toBe(Date.UTC(2025, 2, 1) / 1000);
      expect(file.candles[file.candles.length - 1].time).toBe(Date.UTC(2026, 1, 28, 23, 45) / 1000);
      assertContiguous(file, HOLDOUT_GAPS[symbol]);
    }
  });

  it('15m/tune-2023-03_2025-03/: BTC, ETH, SOL — 2023-03-01 → 2025-03-01, native 15m, only the documented upstream holes', () => {
    for (const symbol of TRIO) {
      const file = readFixture(TUNE_15M, symbol);
      assertRealFifteenMinute(file, symbol);
      expect(file.candles).toHaveLength(TUNE_BARS[symbol]);
      expect(file.candles.length + TUNE_GAPS[symbol].length).toBe(731 * 96);
      expect(file.candles[0].time).toBe(Date.UTC(2023, 2, 1) / 1000);
      expect(file.candles[file.candles.length - 1].time).toBe(Date.UTC(2025, 1, 28, 23, 45) / 1000);
      assertContiguous(file, TUNE_GAPS[symbol]);
    }
  });

  it('tune and holdout windows are adjacent and disjoint (tune ends where holdout begins)', () => {
    for (const symbol of TRIO) {
      const tune = readFixture(TUNE_15M, symbol);
      const holdout = readFixture(HOLDOUT_15M, symbol);
      expect(tune.candles[tune.candles.length - 1].time + STEP).toBe(holdout.candles[0].time);
    }
  });

  /**
   * Roll a 15m fixture → 1d and compare with the native ONE_DAY fixture on
   * every day both cover. OHLC must be exact; gap days are incomplete and
   * dropped by the rollup, not compared.
   */
  function expectFifteenMinuteReproducesNativeDaily(dir: string, symbol: string, expectedDays: number): void {
    const m15 = readFixture(dir, symbol);
    const d1 = readFixture(path.join(FIXTURES, '1d'), symbol);
    const rolled = rollupCandles(m15.candles.map((c) => ({ ...c, time: c.time * 1000 })), STEP, DAY);
    const native = new Map(d1.candles.map((c) => [c.time * 1000, c]));
    let compared = 0;
    let mismatches = 0;
    for (const day of rolled.candles) {
      const n = native.get(day.time);
      if (!n) continue;
      compared++;
      if (day.open !== n.open || day.high !== n.high || day.low !== n.low || day.close !== n.close) mismatches++;
    }
    expect(mismatches).toBe(0);
    expect(compared).toBe(expectedDays);
  }

  it('15m rolled to 1d reproduces the native 1d OHLC on every complete holdout day (364 / 363 / 364)', () => {
    // 365 days; 2025-10-25 is incomplete on all three and 2025-04-25 additionally on ETH.
    const days: Record<Symbol3, number> = { 'BTC-USD': 364, 'ETH-USD': 363, 'SOL-USD': 364 };
    for (const symbol of TRIO) expectFifteenMinuteReproducesNativeDaily(HOLDOUT_15M, symbol, days[symbol]);
  });

  it('15m rolled to 1d reproduces the native 1d OHLC on the tune days the 1d set covers (180 / 180 / 179)', () => {
    // 1d/ starts 2024-09-01; tune ends 2025-02-28 → 181 overlapping days minus the incomplete
    // 2024-10-26 (all three) and 2024-12-09 (SOL only).
    const days: Record<Symbol3, number> = { 'BTC-USD': 180, 'ETH-USD': 180, 'SOL-USD': 179 };
    for (const symbol of TRIO) expectFifteenMinuteReproducesNativeDaily(TUNE_15M, symbol, days[symbol]);
  });
});

describe('fail-closed loader serves the 15m windows as REAL fixture data', () => {
  it('holdout 2025-03-01 → 2026-03-01 loads from fixture with honest coverage (hard-preflight path)', async () => {
    const loader = new HistoricalDataLoader({ fixtureDir: HOLDOUT_15M }, makeLogger());
    for (const symbol of TRIO) {
      const res = await loader.loadCandles(symbol, new Date('2025-03-01T00:00:00Z'), new Date('2026-03-01T00:00:00Z'), STEP);
      expect(res.source).toBe('fixture');
      expect(res.candles).toHaveLength(HOLDOUT_BARS[symbol]);
      expect(res.provenance.granularitySeconds).toBe(STEP);
      expect(res.provenance.expectedCount).toBe(365 * 96 + 1); // inclusive end bound
      expect(res.provenance.coverage).toBeCloseTo(HOLDOUT_BARS[symbol] / (365 * 96 + 1), 9);
      expect(res.provenance.inferredBarMinutes).toBe(15);
      expect(res.provenance.firstBarTime).toBe('2025-03-01T00:00:00.000Z');
      expect(res.provenance.lastBarTime).toBe('2026-02-28T23:45:00.000Z');
      expect(res.provenance.fixturePath).toBe(path.join(HOLDOUT_15M, `${symbol}.json`));
      expect(res.provenance.fixtureSha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('tune 2023-03-01 → 2025-03-01 loads from fixture with honest coverage', async () => {
    const loader = new HistoricalDataLoader({ fixtureDir: TUNE_15M }, makeLogger());
    for (const symbol of TRIO) {
      const res = await loader.loadCandles(symbol, new Date('2023-03-01T00:00:00Z'), new Date('2025-03-01T00:00:00Z'), STEP);
      expect(res.source).toBe('fixture');
      expect(res.candles).toHaveLength(TUNE_BARS[symbol]);
      expect(res.provenance.granularitySeconds).toBe(STEP);
      expect(res.provenance.expectedCount).toBe(731 * 96 + 1);
      expect(res.provenance.coverage).toBeCloseTo(TUNE_BARS[symbol] / (731 * 96 + 1), 9);
      expect(res.provenance.inferredBarMinutes).toBe(15);
      expect(res.provenance.firstBarTime).toBe('2023-03-01T00:00:00.000Z');
      expect(res.provenance.lastBarTime).toBe('2025-02-28T23:45:00.000Z');
    }
  });

  it('the bare 15m/ container holds no fixtures — a run must name a window directory', async () => {
    const loader = new HistoricalDataLoader({ fixtureDir: path.join(FIXTURES, '15m') }, makeLogger());
    await expect(
      loader.loadCandles('BTC-USD', new Date('2025-03-01T00:00:00Z'), new Date('2026-03-01T00:00:00Z'), STEP),
    ).rejects.toMatchObject({ code: 'DATA_UNAVAILABLE' });
  });

  it('a window a set does not cover is DATA_UNAVAILABLE (holdout asked for tune months, and vice versa)', async () => {
    const holdout = new HistoricalDataLoader({ fixtureDir: HOLDOUT_15M }, makeLogger());
    await expect(
      holdout.loadCandles('ETH-USD', new Date('2024-03-01T00:00:00Z'), new Date('2025-03-01T00:00:00Z'), STEP),
    ).rejects.toMatchObject({ code: 'DATA_UNAVAILABLE' });
    const tune = new HistoricalDataLoader({ fixtureDir: TUNE_15M }, makeLogger());
    await expect(
      tune.loadCandles('SOL-USD', new Date('2025-06-01T00:00:00Z'), new Date('2026-03-01T00:00:00Z'), STEP),
    ).rejects.toMatchObject({ code: 'DATA_UNAVAILABLE' });
  });
});
