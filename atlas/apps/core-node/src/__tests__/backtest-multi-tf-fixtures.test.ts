/**
 * Multi-timeframe bar fixtures for E4 harness experiments (4h + 1d).
 *
 *   1. `rollupCandles` — UTC-aligned OHLCV aggregation semantics, exact
 *      decimal volume, complete-buckets-only, width validation.
 *   2. `buildFixture` — rolled-up fixtures are labelled by bucket width and
 *      carry a `rollup` provenance block; native fixtures are unchanged.
 *   3. Committed fixtures under fixtures/bars/4h/<window> and fixtures/bars/1d
 *      are real, UTC-aligned, declare their provenance, and are contiguous
 *      except for the documented upstream Coinbase gaps (complete-buckets-only
 *      rollup never fabricates a bar over an exchange outage).
 *   4. The fail-closed loader judges coverage against the fixture's declared
 *      bar width, so `--fixture-dir fixtures/bars/4h/<window>` works with the
 *      CLI's 15m default and reports honest coverage; the bare `4h/` container
 *      holds no files and is DATA_UNAVAILABLE.
 *
 * 4h windows (see fixtures/bars/MULTI_TF.md):
 *   smoke-aug2026/           Aug 2026 month-block — SMOKE/SCREEN ONLY
 *   holdout-2025-03_2026-03/ 2025-03-01 → 2026-03-01 — hard-preflight SoT
 *   tune-2023-03_2025-03/    2023-03-01 → 2025-03-01 — tuning window
 */
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  rollupCandles,
  assertRollupWidths,
  buildFixture,
  describeRollup,
  granularityLabelForSeconds,
} from '../cli/backtest-backfill';
import { HistoricalDataLoader, type BarFixtureFile } from '../backtesting/data-loader';
import type { OHLCV } from '../indicators/technical';

function makeLogger() {
  return { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as any;
}

const HOUR_MS = 3_600_000;
const FOUR_H = 14_400;
const DAY = 86_400;
const FIXTURES = path.resolve(__dirname, '../../fixtures/bars');
const TRIO = ['BTC-USD', 'ETH-USD', 'SOL-USD'];

const SMOKE_4H = path.join(FIXTURES, '4h', 'smoke-aug2026');
const HOLDOUT_4H = path.join(FIXTURES, '4h', 'holdout-2025-03_2026-03');
const TUNE_4H = path.join(FIXTURES, '4h', 'tune-2023-03_2025-03');

/**
 * 4h bucket starts that Coinbase's own public candle series cannot fill
 * (exchange outages — no ONE_HOUR / FIFTEEN_MINUTE candles exist upstream).
 * The complete-buckets-only rollup drops them instead of inventing bars.
 */
const HOLDOUT_GAPS = [Date.UTC(2025, 9, 25, 16) / 1000, Date.UTC(2025, 9, 25, 20) / 1000];
const TUNE_GAPS = [Date.UTC(2023, 2, 4, 16) / 1000, Date.UTC(2023, 2, 4, 20) / 1000];

function readFixture(dir: string, symbol: string): BarFixtureFile {
  return JSON.parse(fs.readFileSync(path.join(dir, `${symbol}.json`), 'utf8')) as BarFixtureFile;
}

/** Deterministic hourly bars starting at a UTC midnight; price walks by +1 per bar. */
function hourlyBars(startIso: string, count: number): OHLCV[] {
  const start = new Date(startIso).getTime();
  const out: OHLCV[] = [];
  for (let i = 0; i < count; i++) {
    const open = 100 + i;
    out.push({
      time: start + i * HOUR_MS,
      open,
      high: open + 0.75 + (i % 4 === 2 ? 5 : 0), // bar #2 of every bucket carries the bucket high
      low: open - 0.5 - (i % 4 === 1 ? 3 : 0), // bar #1 of every bucket carries the bucket low
      close: open + 0.25,
      volume: [0.1, 0.2, 0.3, 0.3][i % 4], // float sum drifts to 0.9000000000000001; exact is 0.9
    });
  }
  return out;
}

describe('rollupCandles — UTC-aligned OHLCV rollup', () => {
  it('aggregates 1H → 4H with open=first, high=max, low=min, close=last, volume=exact sum', () => {
    const src = hourlyBars('2026-08-01T00:00:00Z', 48); // 2 days
    const res = rollupCandles(src, 3600, FOUR_H);

    expect(res.sourceBars).toBe(48);
    expect(res.bucketsEmitted).toBe(12);
    expect(res.bucketsDroppedIncomplete).toBe(0);
    expect(res.candles).toHaveLength(12);

    const first = res.candles[0];
    expect(first.time).toBe(new Date('2026-08-01T00:00:00Z').getTime());
    expect(first.open).toBe(100); // bar 0 open
    expect(first.high).toBe(102 + 0.75 + 5); // bar 2 high
    expect(first.low).toBe(101 - 0.5 - 3); // bar 1 low
    expect(first.close).toBe(103 + 0.25); // bar 3 close
    // 0.1 + 0.2 + 0.3 + 0.3 accumulates to 0.9000000000000001 in IEEE-754; the rollup must say exactly 0.9.
    expect(0.1 + 0.2 + 0.3 + 0.3).not.toBe(0.9);
    expect(first.volume).toBe(0.9);

    for (let i = 0; i < res.candles.length; i++) {
      const c = res.candles[i];
      expect(c.time % (FOUR_H * 1000)).toBe(0); // UTC-aligned (00,04,08,12,16,20)
      if (i > 0) expect(c.time - res.candles[i - 1].time).toBe(FOUR_H * 1000);
      expect(c.open).toBe(100 + i * 4);
      expect(c.close).toBe(103 + i * 4 + 0.25);
      expect(c.volume).toBe(0.9);
    }
  });

  it('drops incomplete buckets (window edges or gaps) and counts them', () => {
    const src = hourlyBars('2026-08-01T00:00:00Z', 24);
    // Remove 02:00 (gap inside bucket 0) and the last bar (bucket 5 becomes 3/4).
    const gappy = src.filter((c, i) => i !== 2 && i !== 23);
    const res = rollupCandles(gappy, 3600, FOUR_H);
    expect(res.sourceBars).toBe(22);
    expect(res.bucketsEmitted).toBe(4);
    expect(res.bucketsDroppedIncomplete).toBe(2);
    expect(res.candles.map((c) => new Date(c.time).toISOString())).toEqual([
      '2026-08-01T04:00:00.000Z',
      '2026-08-01T08:00:00.000Z',
      '2026-08-01T12:00:00.000Z',
      '2026-08-01T16:00:00.000Z',
    ]);
  });

  it('starts buckets on UTC boundaries even when the series starts mid-bucket', () => {
    const src = hourlyBars('2026-08-01T00:00:00Z', 12).slice(2); // 02:00 … 11:00
    const res = rollupCandles(src, 3600, FOUR_H);
    // 00:00 bucket has 2/4 bars → dropped; 04:00 and 08:00 complete.
    expect(res.bucketsDroppedIncomplete).toBe(1);
    expect(res.candles.map((c) => new Date(c.time).toISOString())).toEqual([
      '2026-08-01T04:00:00.000Z',
      '2026-08-01T08:00:00.000Z',
    ]);
  });

  it('normalises unsorted / duplicated source bars before bucketing', () => {
    const src = hourlyBars('2026-08-01T00:00:00Z', 8);
    const messy = [...src].reverse().concat([src[3]]); // reversed + one duplicate
    const clean = rollupCandles(src, 3600, FOUR_H);
    const res = rollupCandles(messy, 3600, FOUR_H);
    expect(res.sourceBars).toBe(8);
    expect(res.candles).toEqual(clean.candles);
  });

  it('rolls 4H → 1D and rejects invalid width pairs', () => {
    const src = hourlyBars('2026-08-01T00:00:00Z', 48);
    const h4 = rollupCandles(src, 3600, FOUR_H).candles;
    const d1 = rollupCandles(h4, FOUR_H, DAY);
    expect(d1.bucketsEmitted).toBe(2);
    expect(d1.candles[0].open).toBe(100);
    expect(d1.candles[0].close).toBe(123.25);
    expect(d1.candles[0].volume).toBe(5.4); // 6 × 0.9, exact

    expect(() => assertRollupWidths(3600, 3600)).toThrow(/larger than the source/);
    expect(() => assertRollupWidths(3600, 5400)).toThrow(/whole multiple/);
    expect(() => assertRollupWidths(3600, 18000)).toThrow(/divide 86400/);
    expect(() => assertRollupWidths(0, 14400)).toThrow(/positive integer/);
    expect(() => rollupCandles(src, 3600, 5400)).toThrow();
    expect(() => assertRollupWidths(900, FOUR_H)).not.toThrow();
    expect(() => assertRollupWidths(FOUR_H, DAY)).not.toThrow();
  });
});

describe('buildFixture — native vs rolled-up provenance', () => {
  const start = new Date('2026-08-01T00:00:00Z');
  const end = new Date('2026-08-31T20:00:00Z');

  it('labels a rolled-up fixture by bucket width and records the rollup block', () => {
    const rolled = rollupCandles(hourlyBars('2026-08-01T00:00:00Z', 24), 3600, FOUR_H);
    const fixture = buildFixture('BTC-USD', 'ONE_HOUR', start, end, rolled.candles, new Date('2026-09-10T00:00:00Z'),
      describeRollup('ONE_HOUR', FOUR_H, rolled));
    expect(granularityLabelForSeconds(FOUR_H)).toBe('FOUR_HOUR');
    expect(fixture.granularity).toBe('FOUR_HOUR');
    expect(fixture.granularitySeconds).toBe(FOUR_H);
    expect(fixture.source).toBe('coinbase-advanced-trade-public');
    expect(fixture.endpoint).toBe('https://api.coinbase.com/api/v3/brokerage/market/products/BTC-USD/candles');
    expect(fixture.fetchedAt).toBe('2026-09-10T00:00:00.000Z');
    expect(fixture.rollup).toMatchObject({
      method: 'utc-aligned-ohlcv',
      sourceGranularity: 'ONE_HOUR',
      sourceGranularitySeconds: 3600,
      bucketSeconds: FOUR_H,
      sourceBarsPerBucket: 4,
      sourceBars: 24,
      bucketsEmitted: 6,
      bucketsDroppedIncomplete: 0,
    });
    expect(fixture.candles[0]).toEqual({ time: 1785542400, open: 100, high: 107.75, low: 97.5, close: 103.25, volume: 0.9 });
    // Key order: provenance before the (long) candles array.
    expect(Object.keys(fixture).indexOf('rollup')).toBeLessThan(Object.keys(fixture).indexOf('candles'));
  });

  it('leaves native fixtures exactly as before (backtest-gate format)', () => {
    const fixture = buildFixture('ETH-USD', 'FIFTEEN_MINUTE', start, end, hourlyBars('2026-08-01T00:00:00Z', 4));
    expect(fixture.granularity).toBe('FIFTEEN_MINUTE');
    expect(fixture.granularitySeconds).toBe(900);
    expect('rollup' in fixture).toBe(false);
    expect(granularityLabelForSeconds(1500)).toBe('ROLLUP_25M');
  });
});

describe('committed multi-TF fixtures are real, contiguous and self-describing', () => {
  /**
   * Every bar is UTC-aligned and OHLC-sane, and consecutive bars are exactly
   * `step` apart except across `knownGaps` — the bucket starts that are
   * missing upstream. The set of gaps found must equal the documented set,
   * so an undocumented hole (or a silently filled one) fails the test.
   */
  function assertContiguous(file: BarFixtureFile, step: number, knownGaps: number[] = []): void {
    const found: number[] = [];
    for (let i = 0; i < file.candles.length; i++) {
      const c = file.candles[i];
      expect(c.time % step).toBe(0);
      if (i > 0) {
        for (let t = file.candles[i - 1].time + step; t < c.time; t += step) found.push(t);
      }
      expect(c.low).toBeGreaterThan(0);
      expect(c.low).toBeLessThanOrEqual(Math.min(c.open, c.close));
      expect(c.high).toBeGreaterThanOrEqual(Math.max(c.open, c.close));
      expect(c.volume).toBeGreaterThan(0);
    }
    expect(found).toEqual(knownGaps);
  }

  function assertRealFourHour(file: BarFixtureFile, symbol: string): void {
    expect(file.symbol).toBe(symbol);
    expect(file.exchange).toBe('coinbase');
    expect(file.source).toBe('coinbase-advanced-trade-public');
    expect(file.source).not.toMatch(/synthetic/i);
    expect(file.endpoint).toBe(`https://api.coinbase.com/api/v3/brokerage/market/products/${symbol}/candles`);
    expect(file.granularity).toBe('FOUR_HOUR');
    expect(file.granularitySeconds).toBe(FOUR_H);
    expect(file.rollup).toMatchObject({
      method: 'utc-aligned-ohlcv',
      sourceGranularity: 'ONE_HOUR',
      sourceGranularitySeconds: 3600,
      bucketSeconds: FOUR_H,
      sourceBarsPerBucket: 4,
    });
    expect(file.rollup!.bucketsEmitted).toBe(file.candles.length);
    expect(new Date(file.start).getTime() / 1000).toBe(file.candles[0].time);
    expect(new Date(file.end).getTime() / 1000).toBe(file.candles[file.candles.length - 1].time);
  }

  it('4h/smoke-aug2026/: BTC, ETH, SOL — Aug 2026 month-block, 186 true 4H bars rolled from ONE_HOUR (SMOKE ONLY)', () => {
    for (const symbol of TRIO) {
      const file = readFixture(SMOKE_4H, symbol);
      assertRealFourHour(file, symbol);
      expect(file.rollup).toMatchObject({ sourceBars: 744, bucketsEmitted: 186, bucketsDroppedIncomplete: 0 });
      expect(file.candles).toHaveLength(186);
      expect(file.candles[0].time).toBe(Date.UTC(2026, 7, 1) / 1000);
      expect(file.candles[185].time).toBe(Date.UTC(2026, 7, 31, 20) / 1000);
      assertContiguous(file, FOUR_H);
    }
  });

  it('4h/holdout-2025-03_2026-03/: BTC, ETH, SOL — 2025-03-01 → 2026-03-01, 2188 true 4H bars (one 8h upstream gap on 2025-10-25)', () => {
    for (const symbol of TRIO) {
      const file = readFixture(HOLDOUT_4H, symbol);
      assertRealFourHour(file, symbol);
      // 365 days × 6 = 2190 buckets; Coinbase has no candles 2025-10-25T16:00–20:59Z, so the
      // 16:00 bucket never forms (0/4 source bars) and the 20:00 bucket is dropped as 3/4.
      expect(file.rollup).toMatchObject({ sourceBars: 8755, bucketsEmitted: 2188, bucketsDroppedIncomplete: 1 });
      expect(file.candles).toHaveLength(2188);
      expect(file.candles[0].time).toBe(Date.UTC(2025, 2, 1) / 1000);
      expect(file.candles[2187].time).toBe(Date.UTC(2026, 1, 28, 20) / 1000);
      assertContiguous(file, FOUR_H, HOLDOUT_GAPS);
    }
  });

  it('4h/tune-2023-03_2025-03/: BTC, ETH, SOL — 2023-03-01 → 2025-03-01, 4384 true 4H bars (one 8h upstream gap on 2023-03-04)', () => {
    // 731 days × 6 = 4386 buckets. Coinbase is missing 2023-03-04T18:00–20:59Z on BTC/ETH and
    // 17:00–21:59Z on SOL; either way the 16:00 and 20:00 buckets are incomplete and dropped.
    const sourceBars: Record<string, number> = { 'BTC-USD': 17541, 'ETH-USD': 17541, 'SOL-USD': 17539 };
    for (const symbol of TRIO) {
      const file = readFixture(TUNE_4H, symbol);
      assertRealFourHour(file, symbol);
      expect(file.rollup).toMatchObject({ sourceBars: sourceBars[symbol], bucketsEmitted: 4384, bucketsDroppedIncomplete: 2 });
      expect(file.candles).toHaveLength(4384);
      expect(file.candles[0].time).toBe(Date.UTC(2023, 2, 1) / 1000);
      expect(file.candles[4383].time).toBe(Date.UTC(2025, 1, 28, 20) / 1000);
      assertContiguous(file, FOUR_H, TUNE_GAPS);
    }
  });

  it('tune and holdout windows are adjacent and disjoint (tune ends where holdout begins)', () => {
    for (const symbol of TRIO) {
      const tune = readFixture(TUNE_4H, symbol);
      const holdout = readFixture(HOLDOUT_4H, symbol);
      const smoke = readFixture(SMOKE_4H, symbol);
      expect(tune.candles[tune.candles.length - 1].time + FOUR_H).toBe(holdout.candles[0].time);
      expect(holdout.candles[holdout.candles.length - 1].time).toBeLessThan(smoke.candles[0].time);
    }
  });

  it('1d/: BTC, ETH, SOL — 2024-09-01 → 2026-08-31, 730 native ONE_DAY bars', () => {
    for (const symbol of TRIO) {
      const file = readFixture(path.join(FIXTURES, '1d'), symbol);
      expect(file.symbol).toBe(symbol);
      expect(file.source).toBe('coinbase-advanced-trade-public');
      expect(file.granularity).toBe('ONE_DAY');
      expect(file.granularitySeconds).toBe(DAY);
      expect(file.rollup).toBeUndefined();
      expect(file.candles).toHaveLength(730);
      expect(file.candles[0].time).toBe(Date.UTC(2024, 8, 1) / 1000);
      expect(file.candles[729].time).toBe(Date.UTC(2026, 7, 31) / 1000);
      assertContiguous(file, DAY);
    }
  });

  /**
   * Roll a 4h fixture → 1d and compare with the native ONE_DAY fixture on
   * every day both cover. OHLC must be exact; volume may differ slightly
   * because Coinbase's own series disagree across granularities (MULTI_TF.md).
   */
  function expectFourHourReproducesNativeDaily(dir: string, symbol: string, expectedDays: number, expectedDroppedDays: number): void {
    const h4 = readFixture(dir, symbol);
    const d1 = readFixture(path.join(FIXTURES, '1d'), symbol);
    const rolled = rollupCandles(h4.candles.map((c) => ({ ...c, time: c.time * 1000 })), FOUR_H, DAY);
    expect(rolled.bucketsDroppedIncomplete).toBe(expectedDroppedDays);
    const native = new Map(d1.candles.map((c) => [c.time * 1000, c]));
    let compared = 0;
    for (const day of rolled.candles) {
      const n = native.get(day.time);
      if (!n) continue; // day outside the committed 1d window
      compared++;
      expect([day.open, day.high, day.low, day.close]).toEqual([n.open, n.high, n.low, n.close]);
      expect(Math.abs(day.volume - n.volume) / n.volume).toBeLessThan(0.001);
    }
    expect(compared).toBe(expectedDays);
  }

  it('4h rolled to 1d reproduces the native 1d OHLC for August 2026 (smoke set)', () => {
    for (const symbol of TRIO) expectFourHourReproducesNativeDaily(SMOKE_4H, symbol, 31, 0);
  });

  it('4h rolled to 1d reproduces the native 1d OHLC on all 364 complete holdout days', () => {
    // 365 days; 2025-10-25 is 4/6 buckets after the upstream gap and is dropped, not compared.
    for (const symbol of TRIO) expectFourHourReproducesNativeDaily(HOLDOUT_4H, symbol, 364, 1);
  });

  it('4h rolled to 1d reproduces the native 1d OHLC on the 181 tune days the 1d set covers', () => {
    // 1d/ starts 2024-09-01; tune ends 2025-02-28 → 181 overlapping days. 2023-03-04 is dropped (gap).
    for (const symbol of TRIO) expectFourHourReproducesNativeDaily(TUNE_4H, symbol, 181, 1);
  });
});

describe('fail-closed loader honours the fixture-declared bar width', () => {
  it('loads the smoke 4h fixtures with the CLI default (900s) and reports coverage against 14400s bars', async () => {
    const loader = new HistoricalDataLoader({ fixtureDir: SMOKE_4H }, makeLogger());
    for (const symbol of TRIO) {
      const res = await loader.loadCandles(symbol, new Date('2026-08-01T00:00:00Z'), new Date('2026-09-01T00:00:00Z'), 900);
      expect(res.source).toBe('fixture');
      expect(res.candles).toHaveLength(186);
      expect(res.provenance.granularitySeconds).toBe(FOUR_H);
      expect(res.provenance.expectedCount).toBe(187); // 31d / 4h + 1 (inclusive end bound)
      expect(res.provenance.coverage).toBeCloseTo(186 / 187, 9);
      expect(res.provenance.inferredBarMinutes).toBe(240);
      expect(res.provenance.firstBarTime).toBe('2026-08-01T00:00:00.000Z');
      expect(res.provenance.lastBarTime).toBe('2026-08-31T20:00:00.000Z');
    }
  });

  it('loads the holdout 4h fixtures for 2025-03-01 → 2026-03-01 as REAL fixture data (hard-preflight path)', async () => {
    const loader = new HistoricalDataLoader({ fixtureDir: HOLDOUT_4H }, makeLogger());
    for (const symbol of TRIO) {
      const res = await loader.loadCandles(symbol, new Date('2025-03-01T00:00:00Z'), new Date('2026-03-01T00:00:00Z'), 900);
      expect(res.source).toBe('fixture');
      expect(res.candles).toHaveLength(2188);
      expect(res.provenance.granularitySeconds).toBe(FOUR_H);
      expect(res.provenance.expectedCount).toBe(2191); // 365d / 4h + 1 (inclusive end bound)
      expect(res.provenance.coverage).toBeCloseTo(2188 / 2191, 9);
      expect(res.provenance.inferredBarMinutes).toBe(240);
      expect(res.provenance.firstBarTime).toBe('2025-03-01T00:00:00.000Z');
      expect(res.provenance.lastBarTime).toBe('2026-02-28T20:00:00.000Z');
      expect(res.provenance.fixturePath).toBe(path.join(HOLDOUT_4H, `${symbol}.json`));
      expect(res.provenance.fixtureSha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('loads the tune 4h fixtures for 2023-03-01 → 2025-03-01 as REAL fixture data', async () => {
    const loader = new HistoricalDataLoader({ fixtureDir: TUNE_4H }, makeLogger());
    for (const symbol of TRIO) {
      const res = await loader.loadCandles(symbol, new Date('2023-03-01T00:00:00Z'), new Date('2025-03-01T00:00:00Z'), 900);
      expect(res.source).toBe('fixture');
      expect(res.candles).toHaveLength(4384);
      expect(res.provenance.granularitySeconds).toBe(FOUR_H);
      expect(res.provenance.expectedCount).toBe(4387); // 731d / 4h + 1 (inclusive end bound)
      expect(res.provenance.coverage).toBeCloseTo(4384 / 4387, 9);
      expect(res.provenance.inferredBarMinutes).toBe(240);
      expect(res.provenance.firstBarTime).toBe('2023-03-01T00:00:00.000Z');
      expect(res.provenance.lastBarTime).toBe('2025-02-28T20:00:00.000Z');
    }
  });

  it('the bare 4h/ container holds no fixtures — a run must name a window directory', async () => {
    const loader = new HistoricalDataLoader({ fixtureDir: path.join(FIXTURES, '4h') }, makeLogger());
    for (const symbol of TRIO) {
      await expect(
        loader.loadCandles(symbol, new Date('2025-03-01T00:00:00Z'), new Date('2026-03-01T00:00:00Z'), 900),
      ).rejects.toMatchObject({ code: 'DATA_UNAVAILABLE' });
    }
  });

  it('the holdout set asked for a window it does not cover (tune or smoke months) is DATA_UNAVAILABLE', async () => {
    const loader = new HistoricalDataLoader({ fixtureDir: HOLDOUT_4H }, makeLogger());
    await expect(
      loader.loadCandles('BTC-USD', new Date('2024-03-01T00:00:00Z'), new Date('2025-03-01T00:00:00Z'), 900),
    ).rejects.toMatchObject({ code: 'DATA_UNAVAILABLE' });
    await expect(
      loader.loadCandles('ETH-USD', new Date('2026-08-01T00:00:00Z'), new Date('2026-09-01T00:00:00Z'), 900),
    ).rejects.toMatchObject({ code: 'DATA_UNAVAILABLE' });
  });

  it('loads 1d fixtures for the full 24-month window with 100% coverage', async () => {
    const loader = new HistoricalDataLoader({ fixtureDir: path.join(FIXTURES, '1d') }, makeLogger());
    const res = await loader.loadCandles('SOL-USD', new Date('2024-09-01T00:00:00Z'), new Date('2026-08-31T00:00:00Z'), 900);
    expect(res.candles).toHaveLength(730);
    expect(res.provenance.granularitySeconds).toBe(DAY);
    expect(res.provenance.coverage).toBeCloseTo(1, 9);
    expect(res.provenance.inferredBarMinutes).toBe(1440);
  });

  it('a smoke 4h fixture asked for a window it does not cover is still DATA_UNAVAILABLE', async () => {
    const loader = new HistoricalDataLoader({ fixtureDir: SMOKE_4H }, makeLogger());
    await expect(
      loader.loadCandles('BTC-USD', new Date('2026-06-01T00:00:00Z'), new Date('2026-09-01T00:00:00Z'), 900),
    ).rejects.toMatchObject({ code: 'DATA_UNAVAILABLE' });
    await expect(
      loader.loadCandles('SOL-USD', new Date('2026-07-01T00:00:00Z'), new Date('2026-07-31T00:00:00Z'), 900),
    ).rejects.toMatchObject({ code: 'DATA_UNAVAILABLE' });
  });

  it('a fixture without granularitySeconds falls back to the requested width (legacy files)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-bars-legacy-'));
    const candles = hourlyBars('2026-08-01T00:00:00Z', 24).map((c) => ({ ...c, time: c.time / 1000 }));
    fs.writeFileSync(path.join(dir, 'BTC-USD.json'), JSON.stringify({ symbol: 'BTC-USD', source: 'test', candles }));
    const loader = new HistoricalDataLoader({ fixtureDir: dir }, makeLogger());
    const res = await loader.loadCandles('BTC-USD', new Date('2026-08-01T00:00:00Z'), new Date('2026-08-01T23:00:00Z'), 3600);
    expect(res.candles).toHaveLength(24);
    expect(res.provenance.granularitySeconds).toBe(3600);
    expect(res.provenance.coverage).toBeCloseTo(1, 9);
  });
});
