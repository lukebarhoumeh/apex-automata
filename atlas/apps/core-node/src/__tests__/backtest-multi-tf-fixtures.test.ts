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
 *   smoke-aug2026/           Aug 2026 month-block — SMOKE ONLY, not hard-preflight
 *   holdout-2025-03_2026-03/ 2025-03-01 → 2026-03-01 — hard-preflight SoT
 *   tune-2023-03_2025-03/    2023-03-01 → 2025-03-01 — tuning window
 *   tune-2019-01_2023-03/    2019-01-01 → 2023-03-01 — deep-history tuning window (BTC, ETH)
 *
 * 1d windows:
 *   1d/                      2024-09-01 → 2026-08-31 — sealed HO-H1-DAILY source (BTC, ETH, SOL)
 *   1d/tune-2017-01_2025-03/ 2017-01-01 → 2025-02-28 — deep-history tuning window (BTC, ETH)
 *   1d/btc-eth-2017_plus/    2017-01-01 → present (last complete UTC day) — full daily series (BTC, ETH)
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

/** Deep-history tune windows (TM P0 backfill) — BTC + ETH only. */
const PAIR = ['BTC-USD', 'ETH-USD'];
const TUNE_4H_2019 = path.join(FIXTURES, '4h', 'tune-2019-01_2023-03');
const TUNE_1D_2017 = path.join(FIXTURES, '1d', 'tune-2017-01_2025-03');
const SEALED_1D = path.join(FIXTURES, '1d');
/** Full daily series 2017-01-01 → present; extend by regenerating and bumping these two constants. */
const FULL_1D = path.join(FIXTURES, '1d', 'btc-eth-2017_plus');
const FULL_1D_LAST_DAY = Date.UTC(2026, 8, 10) / 1000; // last complete UTC day at generation (2026-09-10)
const FULL_1D_BARS = 3540;

/**
 * 4h bucket starts that Coinbase's own public candle series cannot fill
 * (exchange outages — no ONE_HOUR / FIFTEEN_MINUTE candles exist upstream).
 * The complete-buckets-only rollup drops them instead of inventing bars.
 */
const HOLDOUT_GAPS = [Date.UTC(2025, 9, 25, 16) / 1000, Date.UTC(2025, 9, 25, 20) / 1000];
const TUNE_GAPS = [Date.UTC(2023, 2, 4, 16) / 1000, Date.UTC(2023, 2, 4, 20) / 1000];

/**
 * tune-2019-01_2023-03/: six (BTC) / four (ETH) single 4h buckets, each
 * missing one native ONE_HOUR candle upstream (two on ETH 2019-06-20) —
 * re-queried at ONE_HOUR and FIFTEEN_MINUTE at generation, the candles do
 * not exist on Coinbase. 2019-04-11 and 2019-10-31 are BTC-only holes.
 */
const TUNE_2019_GAPS: Record<string, number[]> = {
  'BTC-USD': [
    Date.UTC(2019, 3, 11, 12) / 1000, // 13:00 missing
    Date.UTC(2019, 5, 20, 12) / 1000, // 15:00 missing
    Date.UTC(2019, 9, 31, 20) / 1000, // 20:00 missing
    Date.UTC(2020, 0, 30, 16) / 1000, // 17:00 missing
    Date.UTC(2020, 8, 4, 20) / 1000, // 23:00 missing
    Date.UTC(2020, 9, 20, 20) / 1000, // 20:00 missing
  ],
  'ETH-USD': [
    Date.UTC(2019, 5, 20, 12) / 1000, // 14:00 + 15:00 missing
    Date.UTC(2020, 0, 30, 16) / 1000, // 17:00 missing
    Date.UTC(2020, 8, 4, 20) / 1000, // 23:00 missing
    Date.UTC(2020, 9, 20, 20) / 1000, // 20:00 missing
  ],
};

/**
 * The one day in 2019-01 → 2023-03 where Coinbase's native ONE_DAY volume
 * disagrees with the sum of its own 24 ONE_HOUR candles by more than 0.1 %
 * (BTC +2.6 %, ETH +2.8 %; the 17:00Z hourly candle under-reports volume
 * versus its own four FIFTEEN_MINUTE candles). OHLC is exact on that day.
 */
const TUNE_2019_VOLUME_OUTLIER_DAYS = [Date.UTC(2021, 10, 24) / 1000];

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

describe('deep-history tune fixtures (TM P0 backfill): 4h/tune-2019-01_2023-03 and 1d/tune-2017-01_2025-03', () => {
  const HO_H1_DAILY_START = Date.UTC(2025, 2, 1) / 1000; // sealed HO-H1-DAILY window begins 2025-03-01

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

  function assertRealProvenance(file: BarFixtureFile, symbol: string): void {
    expect(file.symbol).toBe(symbol);
    expect(file.exchange).toBe('coinbase');
    expect(file.source).toBe('coinbase-advanced-trade-public');
    expect(file.source).not.toMatch(/synthetic/i);
    expect(file.endpoint).toBe(`https://api.coinbase.com/api/v3/brokerage/market/products/${symbol}/candles`);
    expect(new Date(file.start).getTime() / 1000).toBe(file.candles[0].time);
    expect(new Date(file.end).getTime() / 1000).toBe(file.candles[file.candles.length - 1].time);
  }

  it('4h/tune-2019-01_2023-03/: BTC 9114 / ETH 9116 true 4H bars rolled from ONE_HOUR, 2019-01-01 → 2023-03-01, only the documented single-bucket holes', () => {
    // 1520 days × 6 = 9120 buckets. Each hole is one bucket with 1–2 native hours missing upstream.
    const expected: Record<string, { sourceBars: number; bucketsEmitted: number; bucketsDroppedIncomplete: number }> = {
      'BTC-USD': { sourceBars: 36474, bucketsEmitted: 9114, bucketsDroppedIncomplete: 6 },
      'ETH-USD': { sourceBars: 36475, bucketsEmitted: 9116, bucketsDroppedIncomplete: 4 },
    };
    for (const symbol of PAIR) {
      const file = readFixture(TUNE_4H_2019, symbol);
      assertRealProvenance(file, symbol);
      expect(file.granularity).toBe('FOUR_HOUR');
      expect(file.granularitySeconds).toBe(FOUR_H);
      expect(file.rollup).toMatchObject({
        method: 'utc-aligned-ohlcv',
        sourceGranularity: 'ONE_HOUR',
        sourceGranularitySeconds: 3600,
        bucketSeconds: FOUR_H,
        sourceBarsPerBucket: 4,
        ...expected[symbol],
      });
      expect(file.candles).toHaveLength(expected[symbol].bucketsEmitted);
      expect(file.rollup!.bucketsEmitted).toBe(file.candles.length);
      expect(9120 - file.candles.length).toBe(TUNE_2019_GAPS[symbol].length);
      expect(file.candles[0].time).toBe(Date.UTC(2019, 0, 1) / 1000);
      expect(file.candles[file.candles.length - 1].time).toBe(Date.UTC(2023, 1, 28, 20) / 1000);
      assertContiguous(file, FOUR_H, TUNE_2019_GAPS[symbol]);
    }
  });

  it('4h/tune-2019-01_2023-03/ is not in the directory for SOL-USD (BTC + ETH only)', () => {
    expect(fs.existsSync(path.join(TUNE_4H_2019, 'SOL-USD.json'))).toBe(false);
    expect(fs.existsSync(path.join(TUNE_1D_2017, 'SOL-USD.json'))).toBe(false);
  });

  it('4h tune windows are adjacent and disjoint: 2019-01_2023-03 ends where 2023-03_2025-03 begins', () => {
    for (const symbol of PAIR) {
      const older = readFixture(TUNE_4H_2019, symbol);
      const newer = readFixture(TUNE_4H, symbol);
      expect(older.candles[older.candles.length - 1].time + FOUR_H).toBe(newer.candles[0].time);
      expect(older.candles[older.candles.length - 1].time).toBeLessThan(readFixture(HOLDOUT_4H, symbol).candles[0].time);
    }
  });

  it('1d/tune-2017-01_2025-03/: BTC, ETH — 2981 native ONE_DAY bars 2017-01-01 → 2025-02-28, no upstream gaps', () => {
    for (const symbol of PAIR) {
      const file = readFixture(TUNE_1D_2017, symbol);
      assertRealProvenance(file, symbol);
      expect(file.granularity).toBe('ONE_DAY');
      expect(file.granularitySeconds).toBe(DAY);
      expect(file.rollup).toBeUndefined();
      expect(file.candles).toHaveLength(2981);
      expect(file.candles[0].time).toBe(Date.UTC(2017, 0, 1) / 1000);
      expect(file.candles[2980].time).toBe(Date.UTC(2025, 1, 28) / 1000);
      assertContiguous(file, DAY);
    }
  });

  it('1d/tune-2017-01_2025-03/ ends the day before the sealed HO-H1-DAILY window and never serves a holdout bar', () => {
    for (const symbol of PAIR) {
      const tune = readFixture(TUNE_1D_2017, symbol);
      const last = tune.candles[tune.candles.length - 1].time;
      expect(last + DAY).toBe(HO_H1_DAILY_START);
      expect(tune.candles.some((c) => c.time >= HO_H1_DAILY_START)).toBe(false);
    }
  });

  it('1d/tune-2017-01_2025-03/ is byte-identical to the sealed 1d/ files on the 181 days both cover (2024-09-01 → 2025-02-28)', () => {
    // Same public endpoint, same native ONE_DAY candles; Coinbase serves stable history.
    // The sealed files themselves are not touched by this set — this only reads them.
    for (const symbol of PAIR) {
      const tune = new Map(readFixture(TUNE_1D_2017, symbol).candles.map((c) => [c.time, c]));
      const sealed = readFixture(SEALED_1D, symbol);
      let compared = 0;
      for (const s of sealed.candles) {
        const t = tune.get(s.time);
        if (!t) continue;
        compared++;
        expect(t).toEqual(s);
      }
      expect(compared).toBe(181);
    }
  });

  /**
   * Roll a 4h fixture → 1d and compare with a native ONE_DAY fixture on every
   * day both cover. OHLC must be exact on every day. Volume must be within
   * 0.1 % on every day except the documented `volumeOutlierDays`, where
   * Coinbase's own granularities disagree (MULTI_TF.md); the set of days over
   * 0.1 % must equal that list exactly, so a new divergence fails the suite.
   */
  function expectFourHourReproducesDaily(
    dir4h: string,
    dir1d: string,
    symbol: string,
    expectedDays: number,
    expectedDroppedDays: number,
    volumeOutlierDays: number[] = [],
  ): void {
    const h4 = readFixture(dir4h, symbol);
    const d1 = readFixture(dir1d, symbol);
    const rolled = rollupCandles(h4.candles.map((c) => ({ ...c, time: c.time * 1000 })), FOUR_H, DAY);
    expect(rolled.bucketsDroppedIncomplete).toBe(expectedDroppedDays);
    const native = new Map(d1.candles.map((c) => [c.time * 1000, c]));
    let compared = 0;
    const volumeOutliers: number[] = [];
    for (const day of rolled.candles) {
      const n = native.get(day.time);
      if (!n) continue;
      compared++;
      expect([day.open, day.high, day.low, day.close]).toEqual([n.open, n.high, n.low, n.close]);
      const rel = Math.abs(day.volume - n.volume) / n.volume;
      if (rel >= 0.001) {
        volumeOutliers.push(day.time / 1000);
        expect(rel).toBeLessThan(0.03);
      }
    }
    expect(compared).toBe(expectedDays);
    expect(volumeOutliers).toEqual(volumeOutlierDays);
  }

  it('new 4h tune rolled to 1d reproduces the new daily tune OHLC exactly on all 1514 (BTC) / 1516 (ETH) complete days', () => {
    // 1520 days; each single-bucket hole makes its day 5/6 buckets → dropped, not compared.
    expectFourHourReproducesDaily(TUNE_4H_2019, TUNE_1D_2017, 'BTC-USD', 1514, 6, TUNE_2019_VOLUME_OUTLIER_DAYS);
    expectFourHourReproducesDaily(TUNE_4H_2019, TUNE_1D_2017, 'ETH-USD', 1516, 4, TUNE_2019_VOLUME_OUTLIER_DAYS);
  });

  it('existing 4h/tune-2023-03_2025-03 rolled to 1d reproduces the new daily tune OHLC on all 730 complete days', () => {
    // 731 days; 2023-03-04 is 4/6 buckets after the upstream gap and is dropped, not compared.
    for (const symbol of PAIR) expectFourHourReproducesDaily(TUNE_4H, TUNE_1D_2017, symbol, 730, 1);
  });

  describe('1d/btc-eth-2017_plus/: full daily series 2017-01-01 → present (BTC, ETH)', () => {
    it(`holds ${FULL_1D_BARS} native ONE_DAY bars 2017-01-01 → last complete UTC day, no gaps, no forming candle`, () => {
      for (const symbol of PAIR) {
        const file = readFixture(FULL_1D, symbol);
        assertRealProvenance(file, symbol);
        expect(file.granularity).toBe('ONE_DAY');
        expect(file.granularitySeconds).toBe(DAY);
        expect(file.rollup).toBeUndefined();
        expect(file.candles).toHaveLength(FULL_1D_BARS);
        expect(file.candles[0].time).toBe(Date.UTC(2017, 0, 1) / 1000);
        expect(file.candles[FULL_1D_BARS - 1].time).toBe(FULL_1D_LAST_DAY);
        // The day the file was fetched is still forming and must never be in the file.
        expect(FULL_1D_LAST_DAY).toBeLessThan(Math.floor(new Date(file.fetchedAt).getTime() / 1000 / DAY) * DAY);
        assertContiguous(file, DAY);
      }
    });

    it('reproduces the sealed 1d/ files byte-for-byte on all 730 days they cover (2024-09-01 → 2026-08-31)', () => {
      // The sealed HO-H1-DAILY source is a strict sub-window of this series; it is read, never written, here.
      for (const symbol of PAIR) {
        const full = new Map(readFixture(FULL_1D, symbol).candles.map((c) => [c.time, c]));
        const sealed = readFixture(SEALED_1D, symbol);
        let compared = 0;
        for (const s of sealed.candles) {
          expect(full.get(s.time)).toEqual(s);
          compared++;
        }
        expect(compared).toBe(730);
      }
    });

    it('has 1d/tune-2017-01_2025-03 as an exact prefix (2981 identical bars, then continues into the holdout months)', () => {
      for (const symbol of PAIR) {
        const full = readFixture(FULL_1D, symbol).candles;
        const tune = readFixture(TUNE_1D_2017, symbol).candles;
        expect(full.slice(0, tune.length)).toEqual(tune);
        expect(full[tune.length].time).toBe(HO_H1_DAILY_START);
      }
    });

    it('every committed 4h set rolled to 1d reproduces its OHLC exactly (holdout 364, smoke 31, tune 730, deep tune 1514/1516 days)', () => {
      for (const symbol of PAIR) {
        expectFourHourReproducesDaily(HOLDOUT_4H, FULL_1D, symbol, 364, 1);
        expectFourHourReproducesDaily(SMOKE_4H, FULL_1D, symbol, 31, 0);
        expectFourHourReproducesDaily(TUNE_4H, FULL_1D, symbol, 730, 1);
      }
      expectFourHourReproducesDaily(TUNE_4H_2019, FULL_1D, 'BTC-USD', 1514, 6, TUNE_2019_VOLUME_OUTLIER_DAYS);
      expectFourHourReproducesDaily(TUNE_4H_2019, FULL_1D, 'ETH-USD', 1516, 4, TUNE_2019_VOLUME_OUTLIER_DAYS);
    });
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

  it('loads the deep-history 4h tune (2019-01-01 → 2023-03-01) as REAL fixture data with honest coverage', async () => {
    const loader = new HistoricalDataLoader({ fixtureDir: TUNE_4H_2019 }, makeLogger());
    const bars: Record<string, number> = { 'BTC-USD': 9114, 'ETH-USD': 9116 };
    for (const symbol of PAIR) {
      const res = await loader.loadCandles(symbol, new Date('2019-01-01T00:00:00Z'), new Date('2023-03-01T00:00:00Z'), 900);
      expect(res.source).toBe('fixture');
      expect(res.candles).toHaveLength(bars[symbol]);
      expect(res.provenance.granularitySeconds).toBe(FOUR_H);
      expect(res.provenance.expectedCount).toBe(9121); // 1520d / 4h + 1 (inclusive end bound)
      expect(res.provenance.coverage).toBeCloseTo(bars[symbol] / 9121, 9);
      expect(res.provenance.inferredBarMinutes).toBe(240);
      expect(res.provenance.firstBarTime).toBe('2019-01-01T00:00:00.000Z');
      expect(res.provenance.lastBarTime).toBe('2023-02-28T20:00:00.000Z');
      expect(res.provenance.fixturePath).toBe(path.join(TUNE_4H_2019, `${symbol}.json`));
      expect(res.provenance.fixtureSha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('loads the deep-history 1d tune (2017-01-01 → 2025-02-28) as REAL fixture data with 100% coverage', async () => {
    const loader = new HistoricalDataLoader({ fixtureDir: TUNE_1D_2017 }, makeLogger());
    for (const symbol of PAIR) {
      const res = await loader.loadCandles(symbol, new Date('2017-01-01T00:00:00Z'), new Date('2025-02-28T00:00:00Z'), 900);
      expect(res.source).toBe('fixture');
      expect(res.candles).toHaveLength(2981);
      expect(res.provenance.granularitySeconds).toBe(DAY);
      expect(res.provenance.expectedCount).toBe(2981);
      expect(res.provenance.coverage).toBeCloseTo(1, 9);
      expect(res.provenance.inferredBarMinutes).toBe(1440);
      expect(res.provenance.firstBarTime).toBe('2017-01-01T00:00:00.000Z');
      expect(res.provenance.lastBarTime).toBe('2025-02-28T00:00:00.000Z');
      expect(res.provenance.fixturePath).toBe(path.join(TUNE_1D_2017, `${symbol}.json`));
      expect(res.provenance.fixtureSha256).toMatch(/^[0-9a-f]{64}$/);
    }
    // --end-date 2025-03-01 (month boundary) counts one would-be bar at T00:00 that is deliberately absent.
    const res = await loader.loadCandles('BTC-USD', new Date('2017-01-01T00:00:00Z'), new Date('2025-03-01T00:00:00Z'), 900);
    expect(res.candles).toHaveLength(2981);
    expect(res.provenance.expectedCount).toBe(2982);
    expect(res.provenance.lastBarTime).toBe('2025-02-28T00:00:00.000Z');
  });

  it('loads the full daily series (2017-01-01 → present) as REAL fixture data; SOL-USD and future windows are DATA_UNAVAILABLE', async () => {
    const loader = new HistoricalDataLoader({ fixtureDir: FULL_1D }, makeLogger());
    const lastDay = new Date(FULL_1D_LAST_DAY * 1000);
    for (const symbol of PAIR) {
      const res = await loader.loadCandles(symbol, new Date('2017-01-01T00:00:00Z'), lastDay, 900);
      expect(res.source).toBe('fixture');
      expect(res.candles).toHaveLength(FULL_1D_BARS);
      expect(res.provenance.granularitySeconds).toBe(DAY);
      expect(res.provenance.expectedCount).toBe(FULL_1D_BARS);
      expect(res.provenance.coverage).toBeCloseTo(1, 9);
      expect(res.provenance.inferredBarMinutes).toBe(1440);
      expect(res.provenance.firstBarTime).toBe('2017-01-01T00:00:00.000Z');
      expect(res.provenance.lastBarTime).toBe(lastDay.toISOString());
      expect(res.provenance.fixturePath).toBe(path.join(FULL_1D, `${symbol}.json`));
      expect(res.provenance.fixtureSha256).toMatch(/^[0-9a-f]{64}$/);
    }
    // The sealed HO-H1-DAILY window is servable from this series and must match the sealed set bar-for-bar.
    const sealedLoader = new HistoricalDataLoader({ fixtureDir: SEALED_1D }, makeLogger());
    const fromFull = await loader.loadCandles('BTC-USD', new Date('2025-03-01T00:00:00Z'), new Date('2026-08-31T00:00:00Z'), 900);
    const fromSealed = await sealedLoader.loadCandles('BTC-USD', new Date('2025-03-01T00:00:00Z'), new Date('2026-08-31T00:00:00Z'), 900);
    expect(fromFull.candles).toHaveLength(549);
    expect(fromFull.candles).toEqual(fromSealed.candles);
    await expect(
      loader.loadCandles('SOL-USD', new Date('2017-01-01T00:00:00Z'), lastDay, 900),
    ).rejects.toMatchObject({ code: 'DATA_UNAVAILABLE' });
    await expect(
      loader.loadCandles('ETH-USD', new Date('2026-10-01T00:00:00Z'), new Date('2026-12-31T00:00:00Z'), 900),
    ).rejects.toMatchObject({ code: 'DATA_UNAVAILABLE' });
  });

  it('deep-history tune dirs are DATA_UNAVAILABLE for SOL-USD and for windows they do not cover (incl. the sealed holdout)', async () => {
    const loader4h = new HistoricalDataLoader({ fixtureDir: TUNE_4H_2019 }, makeLogger());
    const loader1d = new HistoricalDataLoader({ fixtureDir: TUNE_1D_2017 }, makeLogger());
    // No SOL-USD file in either directory.
    await expect(
      loader4h.loadCandles('SOL-USD', new Date('2019-01-01T00:00:00Z'), new Date('2023-03-01T00:00:00Z'), 900),
    ).rejects.toMatchObject({ code: 'DATA_UNAVAILABLE' });
    await expect(
      loader1d.loadCandles('SOL-USD', new Date('2017-01-01T00:00:00Z'), new Date('2025-03-01T00:00:00Z'), 900),
    ).rejects.toMatchObject({ code: 'DATA_UNAVAILABLE' });
    // The 4h window after this set (the 2023-03 → 2025-03 tune) is not here.
    await expect(
      loader4h.loadCandles('BTC-USD', new Date('2023-03-01T00:00:00Z'), new Date('2025-03-01T00:00:00Z'), 900),
    ).rejects.toMatchObject({ code: 'DATA_UNAVAILABLE' });
    // The sealed HO-H1-DAILY window (2025-03-01 → 2026-08-31) must never be served from the tune set.
    await expect(
      loader1d.loadCandles('ETH-USD', new Date('2025-03-01T00:00:00Z'), new Date('2026-08-31T00:00:00Z'), 900),
    ).rejects.toMatchObject({ code: 'DATA_UNAVAILABLE' });
    // Pre-history: Coinbase has no 2016 bars in this window's file.
    await expect(
      loader1d.loadCandles('BTC-USD', new Date('2016-01-01T00:00:00Z'), new Date('2016-12-31T00:00:00Z'), 900),
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
