/**
 * H1 Apex Trend v1 research harness — SHORT DRY-RUN ONLY.
 *
 *   1. Indicators are index-aligned and match the canonical
 *      `ValidatedIndicators` SMA / ATR value-for-value.
 *   2. Ensemble vote / band, vol-target leverage and the ratchet trail follow
 *      the card's stated rules.
 *   3. Simulation semantics on synthetic bars (TEST DATA ONLY — never
 *      evidence): lag-1 fills, trail vs reversal exits, re-entry flag,
 *      end_of_data, leverage cap, cost accounting identities, cost-invariant
 *      trade timing.
 *   4. Hard path lock: banned dir, sealed loose 1d dir and any other path are
 *      refused before reading; seal-boundary, gap, rollup and synthetic
 *      fixtures are refused by the loader.
 *   5. The committed TRAIN window (`fixtures/bars/1d/tune-2017-01_2025-03`)
 *      loads with the committed sha256s and reproduces the dry-run pack's
 *      counts (n / exit mix) — a change here means the harness semantics
 *      changed and the pack must be re-issued.
 *   6. Report: banner first and last, DATA stamp, the five required prints,
 *      UNVERIFIED labels; CLI refusals exit 2 / strict-args exit 1.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ValidatedIndicators } from '../indicators/validated-indicators';
import {
  H1_BANNER,
  H1_FEE_SHEET,
  H1_VARIANT,
  atrWilderAligned,
  computeTradeStats,
  ensembleVote,
  initTrail,
  maxDrawdown,
  realizedVolAligned,
  runApexTrendV1,
  sharpeRatio,
  smaAligned,
  updateTrail,
  volTargetLeverage,
  type DailyBar,
  type H1Series,
} from '../research/apex-trend-v1';
import {
  H1_PATH_LOCK,
  H1DataError,
  H1PathLockError,
  assertTrainFixtureDir,
  loadTrainSeries,
  type H1FixtureFile,
} from '../research/apex-trend-v1-data';
import { renderH1Report } from '../research/apex-trend-v1-report';

const CORE_NODE_ROOT = path.resolve(__dirname, '../..');
const TRAIN_DIR = path.join(CORE_NODE_ROOT, H1_PATH_LOCK.trainDir);
const DAY = 86_400;
const T0 = Date.UTC(2020, 0, 1) / 1000;

/** Deterministic bars from a close path (test data only). */
function barsFromCloses(closes: readonly number[], rangePct = 0.0015): DailyBar[] {
  return closes.map((c, i) => {
    const o = i === 0 ? c : closes[i - 1];
    const hi = Math.max(o, c) * (1 + rangePct);
    const lo = Math.min(o, c) * (1 - rangePct);
    return { time: T0 + i * DAY, open: o, high: hi, low: lo, close: c, volume: 1 };
  });
}

function driftPath(n: number, start: number, dailyDrift: number): number[] {
  const out: number[] = [];
  let p = start;
  for (let i = 0; i < n; i++) {
    out.push(p);
    p *= 1 + dailyDrift;
  }
  return out;
}

/** Trend with an alternating ±noise wobble so realised vol is well-defined (never exactly zero). */
function trendPath(n: number, start: number, dailyDrift: number, noise: number, startIndex = 0): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const k = startIndex + i;
    out.push(start * Math.pow(1 + dailyDrift, i) * (1 + (k % 2 === 0 ? noise : -noise)));
  }
  return out;
}

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

function randomWalkBars(n: number, seed: number): DailyBar[] {
  const rnd = lcg(seed);
  const bars: DailyBar[] = [];
  let p = 100;
  for (let i = 0; i < n; i++) {
    const o = p;
    const c = p * (1 + (rnd() - 0.5) * 0.06);
    const h = Math.max(o, c) * (1 + rnd() * 0.02);
    const l = Math.min(o, c) * (1 - rnd() * 0.02);
    bars.push({ time: T0 + i * DAY, open: o, high: h, low: l, close: c, volume: 1 });
    p = c;
  }
  return bars;
}

const ZERO = { feeBpsPerSide: 0, slippageBpsPerSide: 0 };
const PLACEHOLDER = { feeBpsPerSide: H1_FEE_SHEET.placeholderFeeBpsPerSide, slippageBpsPerSide: H1_FEE_SHEET.placeholderSlippageBpsPerSide };

describe('H1 Apex Trend v1 — indicators', () => {
  it('smaAligned is NaN through warm-up and matches ValidatedIndicators.SMA afterwards', () => {
    const closes = randomWalkBars(400, 7).map((b) => b.close);
    const mine = smaAligned(closes, 20);
    expect(mine.length).toBe(400);
    for (let i = 0; i < 19; i++) expect(Number.isNaN(mine[i])).toBe(true);
    const canon = ValidatedIndicators.SMA(closes, 20);
    const tail = mine.filter(Number.isFinite);
    expect(tail.length).toBe(canon.length);
    for (let i = 0; i < canon.length; i++) expect(tail[i]).toBeCloseTo(canon[i], 9);
  });

  it('atrWilderAligned matches ValidatedIndicators.ATR value-for-value (Wilder RMA, bar-0 TR = high − low)', () => {
    const bars = randomWalkBars(400, 42);
    const mine = atrWilderAligned(bars, H1_VARIANT.atrPeriod);
    const canon = ValidatedIndicators.ATR(bars, H1_VARIANT.atrPeriod);
    const tail = mine.filter(Number.isFinite);
    expect(tail.length).toBe(canon.length);
    expect(Number.isNaN(mine[H1_VARIANT.atrPeriod - 2])).toBe(true);
    expect(Number.isFinite(mine[H1_VARIANT.atrPeriod - 1])).toBe(true);
    for (let i = 0; i < canon.length; i++) expect(Math.abs(tail[i] - canon[i]) / canon[i]).toBeLessThan(1e-12);
  });

  it('realizedVolAligned annualises the sample std of log returns and is NaN until the lookback is full', () => {
    const closes = driftPath(50, 100, 0.01); // constant return ⇒ zero vol once warmed up
    const vol = realizedVolAligned(closes, 30, 365);
    for (let i = 0; i < 30; i++) expect(Number.isNaN(vol[i])).toBe(true);
    expect(vol[30]).toBeCloseTo(0, 9);
    const alt = [100, 110, 100, 110, 100, 110, 100]; // alternating ±log(1.1)
    const v2 = realizedVolAligned(alt, 6, 365);
    const r = Math.log(1.1);
    // sample std of {r,−r,r,−r,r,−r} = r·√(6/5)
    expect(v2[6]).toBeCloseTo(r * Math.sqrt(6 / 5) * Math.sqrt(365), 9);
  });
});

describe('H1 Apex Trend v1 — signal, sizing, trail', () => {
  it('ensembleVote: sign(close − MA) votes, plain average, strict band (avg must exceed ±band)', () => {
    expect(ensembleVote(100, [90, 95, 80, 70], 0.25)).toEqual({ votes: [1, 1, 1, 1], avgVote: 1, direction: 1 });
    expect(ensembleVote(100, [90, 95, 80, 110], 0.25).direction).toBe(1); // 3-of-4 ⇒ avg 0.5
    expect(ensembleVote(100, [90, 95, 110, 120], 0.25)).toMatchObject({ avgVote: 0, direction: 0 }); // 2-2 ⇒ band
    expect(ensembleVote(100, [110, 95, 110, 120], 0.25).direction).toBe(-1); // 1-of-4 ⇒ avg −0.5
    expect(ensembleVote(100, [100, 100, 100, 100], 0.25)).toEqual({ votes: [0, 0, 0, 0], avgVote: 0, direction: 0 });
    // avg exactly at the band is NOT a direction (5 up / 3 down of 8 ⇒ 0.25)
    expect(ensembleVote(100, [90, 90, 90, 90, 90, 110, 110, 110], 0.25).direction).toBe(0);
    expect(ensembleVote(100, [90, 90, 90, 90, 90, 90, 110, 110], 0.25).direction).toBe(1); // 0.5
  });

  it('volTargetLeverage = min(cap, target / vol); unusable vol ⇒ null', () => {
    expect(volTargetLeverage(0.5, 0.2, 2)).toBeCloseTo(0.4, 12);
    expect(volTargetLeverage(0.05, 0.2, 2)).toBe(2);
    expect(volTargetLeverage(0, 0.2, 2)).toBeNull();
    expect(volTargetLeverage(Number.NaN, 0.2, 2)).toBeNull();
  });

  it('trail ratchets only in the protective direction and fires on a close through the level', () => {
    let t = initTrail('long', 100, 2, 3); // level 94
    expect(t.level).toBe(94);
    let u = updateTrail(t, 110, 2, 3); // extreme 110 ⇒ level 104
    expect(u.hit).toBe(false);
    expect(u.state.level).toBe(104);
    u = updateTrail(u.state, 105, 4, 3); // wider ATR would loosen to 98 — must stay 104
    expect(u.state.level).toBe(104);
    expect(u.hit).toBe(false);
    u = updateTrail(u.state, 104, 2, 3);
    expect(u.hit).toBe(true);

    t = initTrail('short', 100, 2, 3); // level 106
    expect(t.level).toBe(106);
    u = updateTrail(t, 90, 2, 3); // extreme 90 ⇒ level 96
    expect(u.state.level).toBe(96);
    u = updateTrail(u.state, 97, 2, 3);
    expect(u.hit).toBe(true);
  });
});

describe('H1 Apex Trend v1 — simulation semantics (synthetic test bars, never evidence)', () => {
  const CRASH = 320;

  // TRAIL scenario: 0.1 %/day drift with ±0.25 % wobble (ATR ≈ 0.8 % ⇒ trail ≈ 2.4 %). A −4 % day at
  // CRASH flips MA20 and MA50 only (avg vote 0 ⇒ band ⇒ hold, no reversal) but is > 3 × ATR ⇒ trail.
  // The uptrend then resumes so the ensemble goes back to +1 ⇒ same-direction re-entry after the trail.
  const trailCloses = trendPath(CRASH, 100, 0.001, 0.0025);
  trailCloses.push(trailCloses[CRASH - 1] * 0.96);
  trailCloses.push(...trendPath(150, trailCloses[CRASH], 0.001, 0.0025, CRASH + 1));
  const series: H1Series[] = [{ symbol: 'BTC-USD', bars: barsFromCloses(trailCloses) }];

  // REVERSAL scenario: same drift but 5 % bar ranges (ATR ≈ 10 % ⇒ trail ≈ 30 %, never near). A −8 % day
  // at CRASH puts price under MA20/50/100 and above MA200 ⇒ avg −0.5 ⇒ reversal, flip to short.
  const revCloses = trendPath(CRASH, 100, 0.001, 0.0025);
  revCloses.push(revCloses[CRASH - 1] * 0.92);
  revCloses.push(...trendPath(100, revCloses[CRASH], -0.005, 0.0025, CRASH + 1));
  const revSeries: H1Series[] = [{ symbol: 'BTC-USD', bars: barsFromCloses(revCloses, 0.05) }];

  it('first fill is one bar after the first eligible decision (lag-1, next-bar close)', () => {
    const r = runApexTrendV1(series, { initialCapital: 10_000, cost: ZERO });
    expect(r.warmupBars).toBe(200);
    expect(r.trades.length).toBeGreaterThan(0);
    expect(r.trades[0].side).toBe('long');
    expect(r.trades[0].entryIndex).toBe(200);
    expect(r.metrics.evalStartTime).toBe(series[0].bars[200].time);
    // sized at the decision close off half the shared equity
    const t0 = r.trades[0];
    expect((t0.qty * series[0].bars[t0.entryIndex - 1].close) / (0.5 * t0.equityAtEntry)).toBeCloseTo(t0.leverage, 9);
  });

  it('a >3×ATR drop without an ensemble flip exits on the trail, filled next bar; the next entry is flagged re-entry-after-trail', () => {
    const r = runApexTrendV1(series, { initialCapital: 10_000, cost: ZERO });
    const trail = r.trades.find((t) => t.exitReason === 'trail');
    expect(trail).toBeDefined();
    expect(trail!.exitIndex).toBe(CRASH + 1);
    expect(trail!.side).toBe('long');
    expect(trail!.entryIndex).toBe(200);
    const after = r.trades.find((t) => t.entryIndex > trail!.exitIndex);
    expect(after).toBeDefined();
    expect(after!.reentryAfterTrail).toBe(true);
    expect(after!.side).toBe('long');
    expect(r.metrics.trades.reentriesAfterTrail).toBeGreaterThanOrEqual(1);
    expect(r.trades.some((t) => t.exitReason === 'reversal')).toBe(false);
  });

  it('a signal reversal closes and flips at the same fill (exit index == next entry index, opposite side)', () => {
    const r = runApexTrendV1(revSeries, { initialCapital: 10_000, cost: ZERO });
    const rev = r.trades.find((t) => t.exitReason === 'reversal');
    expect(rev).toBeDefined();
    expect(rev!.exitIndex).toBe(CRASH + 1);
    expect(rev!.side).toBe('long');
    const next = r.trades.find((t) => t.entryIndex === rev!.exitIndex && t.symbol === rev!.symbol);
    expect(next).toBeDefined();
    expect(next!.side).toBe('short');
    expect(next!.reentryAfterTrail).toBe(false);
    expect(r.trades.some((t) => t.exitReason === 'trail' && t.exitIndex <= CRASH + 1)).toBe(false);
  });

  it('an open position at the last bar is closed as end_of_data at that bar', () => {
    const up: H1Series[] = [{ symbol: 'ETH-USD', bars: barsFromCloses(trendPath(260, 100, 0.002, 0.0025)) }];
    const r = runApexTrendV1(up, { initialCapital: 10_000, cost: ZERO });
    expect(r.trades.length).toBe(1);
    expect(r.trades[0].exitReason).toBe('end_of_data');
    expect(r.trades[0].exitIndex).toBe(259);
    expect(r.metrics.trades.exitMix.end_of_data.n).toBe(1);
  });

  it('leverage is capped at 2× per sleeve when realised vol is tiny', () => {
    const calm: H1Series[] = [{ symbol: 'BTC-USD', bars: barsFromCloses(trendPath(260, 100, 0.0001, 0.00005), 0.00005) }];
    const r = runApexTrendV1(calm, { initialCapital: 10_000, cost: ZERO });
    expect(r.trades.length).toBeGreaterThan(0);
    for (const t of r.trades) expect(t.leverage).toBeLessThanOrEqual(H1_VARIANT.leverageCap + 1e-12);
    expect(r.metrics.leverage.max).toBeCloseTo(H1_VARIANT.leverageCap, 12);
    expect(r.metrics.leverage.capBinds).toBeGreaterThan(0);
    // sleeve notional = 0.5 × equity × 2 = equity (± the decision→fill drift)
    expect(r.trades[0].notionalAtEntry / r.trades[0].equityAtEntry).toBeCloseTo(1, 3);
  });

  it('accounting identities: final equity = initial + Σ pnl; fees = bps × both legs; slippage is adverse on both legs', () => {
    const cost = { feeBpsPerSide: 10, slippageBpsPerSide: 5 };
    const r = runApexTrendV1(series, { initialCapital: 10_000, cost });
    const sumPnl = r.trades.reduce((a, t) => a + t.pnl, 0);
    expect(r.metrics.finalEquity).toBeCloseTo(10_000 + sumPnl, 6);
    for (const t of r.trades) {
      const bars = series[0].bars;
      const entryClose = bars[t.entryIndex].close;
      const exitClose = bars[t.exitIndex].close;
      const slip = cost.slippageBpsPerSide / 10_000;
      if (t.side === 'long') {
        expect(t.entryPrice).toBeCloseTo(entryClose * (1 + slip), 9);
        expect(t.exitPrice).toBeCloseTo(exitClose * (1 - slip), 9);
      } else {
        expect(t.entryPrice).toBeCloseTo(entryClose * (1 - slip), 9);
        expect(t.exitPrice).toBeCloseTo(exitClose * (1 + slip), 9);
      }
      const expectedFees = (cost.feeBpsPerSide / 10_000) * (t.qty * t.entryPrice + t.qty * t.exitPrice);
      expect(t.fees).toBeCloseTo(expectedFees, 9);
      expect(t.pnl).toBeCloseTo(t.grossPnl - t.fees, 9);
      expect(t.holdDays).toBe(t.exitIndex - t.entryIndex);
    }
    const zero = runApexTrendV1(series, { initialCapital: 10_000, cost: ZERO });
    expect(zero.metrics.trades.fees).toBe(0);
    expect(zero.metrics.trades.slippageCost).toBe(0);
    expect(zero.metrics.costDragBpsPerYear).toBeCloseTo(0, 9);
  });

  it('trade timing is cost-invariant (signals never read equity) while sizes shrink with cost', () => {
    const a = runApexTrendV1(series, { initialCapital: 10_000, cost: ZERO });
    const b = runApexTrendV1(series, { initialCapital: 10_000, cost: { feeBpsPerSide: 25, slippageBpsPerSide: 10 } });
    expect(b.trades.map((t) => [t.entryIndex, t.exitIndex, t.side, t.exitReason])).toEqual(
      a.trades.map((t) => [t.entryIndex, t.exitIndex, t.side, t.exitReason]),
    );
    expect(b.metrics.finalEquity).toBeLessThan(a.metrics.finalEquity);
  });

  it('two sleeves share one equity pool and must be time-aligned', () => {
    const two: H1Series[] = [
      { symbol: 'BTC-USD', bars: barsFromCloses(trailCloses) },
      { symbol: 'ETH-USD', bars: barsFromCloses(trailCloses.map((c) => c * 0.1)) },
    ];
    const r = runApexTrendV1(two, { initialCapital: 10_000, cost: ZERO });
    expect(Object.keys(r.metrics.perSymbol).sort()).toEqual(['BTC-USD', 'ETH-USD']);
    expect(r.metrics.perSymbol['BTC-USD'].n + r.metrics.perSymbol['ETH-USD'].n).toBe(r.metrics.trades.n);
    expect(r.metrics.perSide.long.n + r.metrics.perSide.short.n).toBe(r.metrics.trades.n);
    // both sleeves enter on the same bar, each sized off half the SAME shared equity
    const first = r.trades.filter((t) => t.entryIndex === 200);
    expect(first).toHaveLength(2);
    expect(first[0].equityAtEntry).toBeCloseTo(first[1].equityAtEntry, 9);
    for (const t of first) {
      const sym = two.find((s) => s.symbol === t.symbol)!;
      expect((t.qty * sym.bars[199].close) / (0.5 * t.equityAtEntry)).toBeCloseTo(t.leverage, 9);
    }

    const misaligned: H1Series[] = [two[0], { symbol: 'ETH-USD', bars: two[1].bars.slice(1) }];
    expect(() => runApexTrendV1(misaligned, { initialCapital: 10_000, cost: ZERO })).toThrow(/timeline mismatch/);
    expect(() => runApexTrendV1([{ symbol: 'BTC-USD', bars: barsFromCloses(driftPath(150, 100, 0.001)) }], { initialCapital: 10_000, cost: ZERO })).toThrow(
      /too short/,
    );
  });

  it('metrics helpers: Sharpe, max drawdown, trade stats', () => {
    expect(sharpeRatio([0.01, 0.01, 0.01], 365)).toBeNull(); // zero std
    expect(sharpeRatio([], 365)).toBeNull();
    const s = sharpeRatio([0.01, -0.01, 0.02, 0.0], 365) as number;
    const m = 0.005;
    const sd = Math.sqrt(((0.01 - m) ** 2 + (-0.01 - m) ** 2 + (0.02 - m) ** 2 + (0 - m) ** 2) / 3);
    expect(s).toBeCloseTo((m / sd) * Math.sqrt(365), 9);
    expect(maxDrawdown([100, 120, 90, 130, 65])).toBeCloseTo(0.5, 12);
    expect(maxDrawdown([100, 110, 120])).toBe(0);

    const r = runApexTrendV1(series, { initialCapital: 10_000, cost: ZERO });
    const st = computeTradeStats(r.trades);
    expect(st.n).toBe(r.trades.length);
    expect(st.wins + st.losses).toBe(st.n);
    expect(st.exitMix.reversal.n + st.exitMix.trail.n + st.exitMix.end_of_data.n).toBe(st.n);
    if (st.avgWin !== null && st.avgLoss !== null) expect(st.payoff).toBeCloseTo(st.avgWin / Math.abs(st.avgLoss), 9);
    expect(computeTradeStats([]).winRate).toBeNull();
  });
});

describe('H1 Apex Trend v1 — hard path lock and fail-closed loader', () => {
  it('accepts only the TRAIN directory (relative, absolute, or un-normalised)', () => {
    expect(assertTrainFixtureDir(H1_PATH_LOCK.trainDir, CORE_NODE_ROOT)).toBe(TRAIN_DIR);
    expect(assertTrainFixtureDir(TRAIN_DIR, CORE_NODE_ROOT)).toBe(TRAIN_DIR);
    expect(assertTrainFixtureDir(`fixtures/bars/4h/../1d/tune-2017-01_2025-03`, CORE_NODE_ROOT)).toBe(TRAIN_DIR);
  });

  it('refuses the BANNED seal-contaminated directory even though it does not exist', () => {
    for (const banned of H1_PATH_LOCK.bannedDirs) {
      expect(fs.existsSync(path.join(CORE_NODE_ROOT, banned))).toBe(false);
      expect(() => assertTrainFixtureDir(banned, CORE_NODE_ROOT)).toThrow(H1PathLockError);
      expect(() => assertTrainFixtureDir(banned, CORE_NODE_ROOT)).toThrow(/BANNED/);
    }
  });

  it('refuses the sealed loose 1d directory (HO-H1-DAILY), other windows and arbitrary paths', () => {
    expect(() => assertTrainFixtureDir(H1_PATH_LOCK.sealedLooseDir, CORE_NODE_ROOT)).toThrow(/SEALED HO-H1-DAILY/);
    expect(() => assertTrainFixtureDir('fixtures/bars/4h/tune-2019-01_2023-03', CORE_NODE_ROOT)).toThrow(H1PathLockError);
    expect(() => assertTrainFixtureDir('fixtures/bars/15m/tune-2023-03_2025-03', CORE_NODE_ROOT)).toThrow(H1PathLockError);
    expect(() => assertTrainFixtureDir(os.tmpdir(), CORE_NODE_ROOT)).toThrow(H1PathLockError);
  });

  it('loads the committed TRAIN pair: REAL, native ONE_DAY, 2981 contiguous bars, committed sha256s, all before the seal', () => {
    const data = loadTrainSeries(TRAIN_DIR);
    expect(data.dataStamp).toBe('REAL');
    expect(data.openedFiles).toHaveLength(2);
    expect(data.series.map((s) => s.symbol)).toEqual(['BTC-USD', 'ETH-USD']);
    for (const s of data.series) {
      expect(s.bars).toHaveLength(2981);
      expect(s.totalBarsInFile).toBe(2981);
      expect(s.granularity).toBe('ONE_DAY');
      expect(s.granularitySeconds).toBe(86_400);
      expect(s.sha256).toBe(H1_PATH_LOCK.committedSha256[s.symbol]);
      expect(s.sha256MatchesCommitted).toBe(true);
      expect(new Date(s.bars[0].time * 1000).toISOString()).toBe('2017-01-01T00:00:00.000Z');
      expect(new Date(s.bars[s.bars.length - 1].time * 1000).toISOString()).toBe('2025-02-28T00:00:00.000Z');
      expect(s.bars[s.bars.length - 1].time).toBeLessThan(data.sealBoundaryEpochSeconds);
    }
    for (const present of Object.values(data.bannedDirsPresentOnDisk)) expect(present).toBe(false);
    expect(() => loadTrainSeries(TRAIN_DIR, ['SOL-USD'])).toThrow(H1DataError);
    const sub = loadTrainSeries(TRAIN_DIR, ['BTC-USD'], { startTime: Date.UTC(2020, 0, 1) / 1000, endTime: Date.UTC(2020, 11, 31) / 1000 });
    expect(sub.series[0].bars).toHaveLength(366);
  });

  it('fails closed on a seal-boundary bar, a daily gap, a rollup block or a synthetic source', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'h1-lock-'));
    const base = JSON.parse(fs.readFileSync(path.join(TRAIN_DIR, 'BTC-USD.json'), 'utf8')) as H1FixtureFile;
    const write = (mutate: (f: H1FixtureFile) => void): void => {
      const f: H1FixtureFile = { ...base, candles: base.candles.slice(-300).map((c) => ({ ...c })) };
      mutate(f);
      fs.writeFileSync(path.join(tmp, 'BTC-USD.json'), JSON.stringify(f));
    };
    write((f) => f.candles.push({ ...f.candles[f.candles.length - 1], time: Date.UTC(2025, 2, 1) / 1000 }));
    expect(() => loadTrainSeries(tmp, ['BTC-USD'])).toThrow(/SEAL BREACH/);
    write((f) => f.candles.splice(100, 1));
    expect(() => loadTrainSeries(tmp, ['BTC-USD'])).toThrow(/non-daily spacing/);
    write((f) => {
      f.rollup = { method: 'utc-aligned-ohlcv' };
    });
    expect(() => loadTrainSeries(tmp, ['BTC-USD'])).toThrow(/rollup/);
    write((f) => {
      f.source = 'synthetic-random-walk';
    });
    expect(() => loadTrainSeries(tmp, ['BTC-USD'])).toThrow(/synthetic/);
    write((f) => {
      f.granularity = 'SIX_HOUR';
      f.granularitySeconds = 21_600;
    });
    expect(() => loadTrainSeries(tmp, ['BTC-USD'])).toThrow(/ONE_DAY/);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

describe('H1 Apex Trend v1 — committed TRAIN dry-run reproduces the pack', () => {
  const data = loadTrainSeries(TRAIN_DIR);
  const result = runApexTrendV1(data.series, { initialCapital: 10_000, cost: PLACEHOLDER });

  it('pins n and the exit mix of the dry-run pack (change ⇒ semantics changed ⇒ re-issue the pack)', () => {
    const m = result.metrics;
    expect(m.trades.n).toBe(212);
    expect(m.trades.exitMix.reversal.n).toBe(127);
    expect(m.trades.exitMix.trail.n).toBe(83);
    expect(m.trades.exitMix.end_of_data.n).toBe(2);
    expect(m.perSymbol['BTC-USD'].n).toBe(104);
    expect(m.perSymbol['ETH-USD'].n).toBe(108);
    expect(result.warmupBars).toBe(200);
    expect(new Date(m.evalStartTime * 1000).toISOString().slice(0, 10)).toBe('2017-07-20');
  });

  it('every fill sits inside TRAIN, after warm-up, before the seal; leverage never exceeds the cap', () => {
    for (const t of result.trades) {
      expect(t.entryIndex).toBeGreaterThanOrEqual(200);
      expect(t.exitIndex).toBeGreaterThan(t.entryIndex);
      expect(t.exitTime).toBeLessThan(data.sealBoundaryEpochSeconds);
      expect(t.leverage).toBeLessThanOrEqual(H1_VARIANT.leverageCap + 1e-12);
    }
    expect(Number.isFinite(result.metrics.sharpe as number)).toBe(true);
    expect(result.metrics.maxDrawdown).toBeGreaterThan(0);
    expect(result.metrics.maxDrawdown).toBeLessThan(1);
    expect(result.equityCurve).toHaveLength(2981);
    expect(result.dailyReturns).toHaveLength(2981 - 200);
  });

  it('report: banner on line 1 and last line, DATA: REAL on line 2, five required prints, UNVERIFIED labels, no Intro-1 book', () => {
    const text = renderH1Report({
      data,
      requestedFixtureDir: H1_PATH_LOCK.trainDir,
      coreNodeRoot: CORE_NODE_ROOT,
      result,
      ladder: [],
      zeroCost: null,
      generatedAt: '2026-09-11T00:00:00.000Z',
    });
    const lines = text.split('\n');
    expect(lines[0]).toBe(H1_BANNER);
    expect(lines[1]).toBe('DATA: REAL');
    expect(lines[lines.length - 1]).toBe(`5. ${H1_BANNER}`);
    expect(text).toContain('1. PATH (TRAIN ONLY)');
    expect(text).toContain(H1_PATH_LOCK.trainDir);
    expect(text).toContain('BANNED fixtures/bars/1d/btc-eth-2017_plus: not present on disk, never opened');
    expect(text).toContain('2. VARIANT A1/B1/C3.0/D0.25 · TF daily · BTC-USD+ETH-USD');
    expect(text).toContain('3. FEE SHEET CFM-NANO-H1-v0.1 — DRAFT / UNVERIFIED');
    expect(text).toContain('4. RESULTS — DRY-RUN DRAFT');
    expect(text).toContain('n = 212 closed trades');
    expect(text).toContain('after-cost Sharpe = ');
    expect(text).toContain('exit mix = reversal 127');
    expect(text).toMatch(/UNVERIFIED/);
    expect(text).not.toMatch(/intro1|60\s*\/\s*120 bps/i);
    // every "GO" token in the pack is negated
    for (const match of text.matchAll(/\bGO\b/g)) {
      expect(text.slice(Math.max(0, match.index! - 4), match.index!).toLowerCase()).toBe('not ');
    }
  });
});

describe('H1 Apex Trend v1 — CLI refusals', () => {
  const TSX = path.join(CORE_NODE_ROOT, 'node_modules', '.bin', 'tsx');
  const CLI = path.join(CORE_NODE_ROOT, 'src', 'cli', 'research-apex-trend-v1.ts');
  const run = (args: string[]) => spawnSync(TSX, [CLI, ...args], { cwd: CORE_NODE_ROOT, encoding: 'utf8', timeout: 20_000 });

  it('exit 2 on the sealed loose 1d dir and on the banned dir; exit 1 on --allow-synthetic (strict args)', () => {
    const sealed = run(['--fixture-dir', 'fixtures/bars/1d', '--results-path', os.tmpdir()]);
    expect(sealed.status).toBe(2);
    expect(sealed.stderr).toContain('H1_PATH_LOCK');
    expect(sealed.stderr).toContain('SEALED HO-H1-DAILY');

    const banned = run(['--fixture-dir', 'fixtures/bars/1d/btc-eth-2017_plus', '--results-path', os.tmpdir()]);
    expect(banned.status).toBe(2);
    expect(banned.stderr).toContain('BANNED');

    const synthetic = run(['--allow-synthetic', '--results-path', os.tmpdir()]);
    expect(synthetic.status).toBe(1);
    expect(synthetic.stderr).toMatch(/Unknown argument/);
  }, 60_000);
});
