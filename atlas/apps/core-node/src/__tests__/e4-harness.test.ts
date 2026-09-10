/**
 * E4 multi-TF FeeModel expectancy harness (TASK_018 E4, TM-corrected).
 *
 *   1. Timeframe policy: 4h → 1d → 1h (demoted); 15m refused.
 *   2. Expectancy statistics from a hand-built trade set (PF, R, t-stat, fees).
 *   3. E[n] annualisation and window-quarter bucketing.
 *   4. Seeded Monte Carlo: deterministic, month-block vs trade units.
 *   5. Derived label: SYNTHETIC ⇒ VOID, < 365d ⇒ SMOKE ONLY, else FULL.
 *   6. Verdict order: SMOKE never graded; INCONCLUSIVE; zero-fee fail-fast
 *      NO-GO; 1D E[n] < 100 ⇒ EXPLORATORY; 1H capped at EXPLORATORY;
 *      GO-ELIGIBLE only when every hard gate passes on a FULL window.
 *   7. End-to-end on the committed REAL 4h / 1d fixtures (#47) through the
 *      runner: label lock honoured, per-symbol n, fail-fast skips fee/MC,
 *      data loaded once across passes.
 */
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  E4_TF_POLICY,
  parseTimeframe,
  computeExpectancy,
  computeTradeFrequency,
  computeWindowQuarters,
  runMonteCarlo,
  mulberry32,
  deriveLabel,
  evaluateVerdict,
  memoizeProvider,
  runE4,
  renderE4Report,
  resolveE4FeeTier,
  profitFactorOf,
  tradeR,
  type E4Request,
  type VerdictInput,
  type ExpectancyStats,
  type TradeFrequency,
} from '../backtesting/e4-harness';
import { BacktestRunner } from '../backtesting/backtest-runner';
import type { BacktestTrade } from '../backtesting/backtest-engine';
import { loadGuardrails } from '../config/loadGuardrails';

function makeLogger() {
  return { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as any;
}

const ATLAS_ROOT = path.resolve(__dirname, '../../../..');
const FIXTURES_4H = path.resolve(__dirname, '../../fixtures/bars/4h');
const FIXTURES_1D = path.resolve(__dirname, '../../fixtures/bars/1d');
const guardrails = loadGuardrails(ATLAS_ROOT);

/** Minimal closed trade for the pure statistics functions. */
function trade(
  pnl: number,
  opts: { product?: string; strategy?: string; entry?: string; exit?: string; side?: 'BUY' | 'SELL'; entryPrice?: number; stop?: number; size?: number; fee?: number; reason?: BacktestTrade['exitReason'] } = {},
): BacktestTrade {
  const entryPrice = opts.entryPrice ?? 100;
  const stop = opts.stop ?? 98; // risk $2/unit
  const size = opts.size ?? 5; // risk $10/trade → R = pnl / 10
  const fee = opts.fee ?? 0;
  return {
    id: `t-${Math.random()}`,
    timestamp: new Date(opts.entry ?? '2025-06-01T00:00:00Z'),
    exitTimestamp: new Date(opts.exit ?? opts.entry ?? '2025-06-02T00:00:00Z'),
    product: opts.product ?? 'BTC-USD',
    strategy: opts.strategy ?? 'trend_follow',
    side: opts.side ?? 'BUY',
    entryPrice,
    exitPrice: entryPrice + pnl / size,
    size,
    entryFee: fee / 2,
    exitFee: fee / 2,
    pnl,
    pnlPercent: pnl / (entryPrice * size),
    exitReason: opts.reason ?? (pnl > 0 ? 'take_profit' : 'stop_loss'),
    signal: {} as any,
    stopLoss: stop,
    takeProfit: entryPrice + 3 * (entryPrice - stop),
    venue: 'spot',
    equityAtEntry: 1000,
  };
}

describe('E4 §1 — timeframe policy', () => {
  it('desk order 4h → 1d → 1h, thresholds from the live-readiness audit §4.1, 1h demoted', () => {
    expect(E4_TF_POLICY['4h']).toMatchObject({ order: 1, barMinutes: 240, zeroFeePfMin: 1.61, defaultFeeTier: 'intro1', defaultMcBlock: 'month', minExpectedTrades: 60, goEligible: true });
    expect(E4_TF_POLICY['1d']).toMatchObject({ order: 2, barMinutes: 1440, zeroFeePfMin: 1.44, defaultFeeTier: 'intro1', defaultMcBlock: 'trade', minExpectedTrades: 100, goEligible: true });
    expect(E4_TF_POLICY['1h']).toMatchObject({ order: 3, barMinutes: 60, zeroFeePfMin: 2.25, defaultFeeTier: 't1k', status: 'demoted', goEligible: false });
  });

  it('parses aliases and refuses 15m (FeeModel 15m spot trend_follow = NO-GO)', () => {
    expect(parseTimeframe('4h')).toBe('4h');
    expect(parseTimeframe('240')).toBe('4h');
    expect(parseTimeframe('1D')).toBe('1d');
    expect(parseTimeframe(1440)).toBe('1d');
    expect(parseTimeframe('1h')).toBe('1h');
    expect(parseTimeframe('60')).toBe('1h');
    expect(() => parseTimeframe('15m')).toThrow(/NO-GO per desk/);
    expect(() => parseTimeframe('15')).toThrow(/15m is NOT an E4 timeframe/);
    expect(() => parseTimeframe('2h')).toThrow(/Unknown --tf/);
  });

  it('fee tier defaults per TF (tier a $1K account sits in), explicit flag wins', () => {
    expect(resolveE4FeeTier('4h', undefined, guardrails)).toMatchObject({ name: 'intro1', makerBps: 60, takerBps: 120 });
    expect(resolveE4FeeTier('1d', undefined, guardrails)).toMatchObject({ name: 'intro1' });
    expect(resolveE4FeeTier('1h', undefined, guardrails)).toMatchObject({ name: 't1k', makerBps: 35, takerBps: 75 });
    expect(resolveE4FeeTier('4h', 'custom:0,0', guardrails)).toMatchObject({ makerBps: 0, takerBps: 0 });
  });
});

describe('E4 §2 — expectancy statistics', () => {
  const trades = [
    trade(30, { product: 'BTC-USD', fee: 2 }),
    trade(-10, { product: 'BTC-USD', fee: 2 }),
    trade(20, { product: 'ETH-USD', fee: 2, strategy: 'momentum' }),
    trade(-10, { product: 'ETH-USD', fee: 2 }),
    trade(-10, { product: 'SOL-USD', fee: 2, side: 'SELL', reason: 'signal' }),
  ];

  it('computes PF, win rate, payoff, R multiples, t-stats and fee drag from trades (not engine quirks)', () => {
    const s = computeExpectancy(trades);
    expect(s.n).toBe(5);
    expect(s.wins).toBe(2);
    expect(s.losses).toBe(3);
    expect(s.winRate).toBeCloseTo(0.4, 9);
    expect(s.grossProfit).toBe(50);
    expect(s.grossLoss).toBe(30);
    expect(s.netProfit).toBe(20);
    expect(s.profitFactor).toBeCloseTo(50 / 30, 9);
    expect(s.averageWin).toBe(25);
    expect(s.averageLoss).toBe(10);
    expect(s.payoffRatio).toBeCloseTo(2.5, 9);
    // R = pnl / (|100 − 98| × 5) = pnl / 10.
    expect(s.meanR).toBeCloseTo(0.4, 9);
    expect(s.meanPnl).toBeCloseTo(4, 9);
    // sample sd of [30,-10,20,-10,-10]: mean 4; devs 26,-14,16,-14,-14 → SS=676+196+256+196+196=1520 → /4 = 380
    expect(s.stdPnl).toBeCloseTo(Math.sqrt(380), 9);
    expect(s.tStatPnl).toBeCloseTo(4 / (Math.sqrt(380) / Math.sqrt(5)), 9);
    expect(s.tStatR).toBeCloseTo(s.tStatPnl!, 9); // R is a constant rescaling of pnl here
    expect(s.totalFees).toBe(10);
    expect(s.feesPerTrade).toBe(2);
    expect(s.feesPctOfGrossProfit).toBeCloseTo(0.2, 9);
    expect(s.longEntries).toBe(4);
    expect(s.shortEntries).toBe(1);
    expect(s.exitReasons).toEqual({ take_profit: 2, stop_loss: 2, signal: 1 });
    expect(s.bySymbol['BTC-USD']).toMatchObject({ n: 2, netProfit: 20, profitFactor: 3 });
    expect(s.bySymbol['ETH-USD']).toMatchObject({ n: 2, netProfit: 10, profitFactor: 2 });
    expect(s.bySymbol['SOL-USD']).toMatchObject({ n: 1, netProfit: -10, profitFactor: 0 });
    expect(s.byStrategy['trend_follow'].n).toBe(4);
    expect(s.byStrategy['momentum'].n).toBe(1);
  });

  it('PF is ∞ with wins and no losses, null with no trades; t-stat null when n < 2', () => {
    expect(profitFactorOf(10, 0)).toBe(Infinity);
    expect(profitFactorOf(0, 0)).toBeNull();
    expect(profitFactorOf(0, 5)).toBe(0);
    const only = computeExpectancy([trade(10)]);
    expect(only.profitFactor).toBe(Infinity);
    expect(only.tStatPnl).toBeNull();
    expect(only.payoffRatio).toBeNull();
    const none = computeExpectancy([]);
    expect(none.n).toBe(0);
    expect(none.profitFactor).toBeNull();
    expect(none.feesPctOfGrossProfit).toBeNull();
    expect(tradeR(trade(25))).toBeCloseTo(2.5, 9);
    expect(tradeR({ pnl: 5, entryPrice: 100, stopLoss: 100, size: 1 })).toBe(0);
  });
});

describe('E4 §3 — E[n] and window quarters', () => {
  it('E[n] = n × 365.25 / windowDays', () => {
    const start = new Date('2024-09-01T00:00:00Z');
    const end = new Date('2026-08-31T00:00:00Z'); // 729 days
    const f = computeTradeFrequency(new Array(13).fill(0).map(() => trade(1)), start, end);
    expect(f.windowDays).toBe(729);
    expect(f.n).toBe(13);
    expect(f.expectedTrades12m).toBeCloseTo((13 * 365.25) / 729, 9);
    expect(f.tradesPerMonth).toBeCloseTo((13 / 729) * (365.25 / 12), 9);
    const year = computeTradeFrequency(new Array(30).fill(0).map(() => trade(1)), new Date('2025-03-05T00:00:00Z'), new Date('2026-03-05T06:00:00Z'));
    expect(year.expectedTrades12m).toBeCloseTo(30, 9);
    expect(computeTradeFrequency([], start, end).firstTradeAt).toBeNull();
  });

  it('splits the window into 4 equal segments and scores trades by EXIT time', () => {
    const start = new Date('2025-01-01T00:00:00Z');
    const end = new Date('2026-01-01T00:00:00Z');
    const trades = [
      trade(10, { entry: '2025-01-10T00:00:00Z', exit: '2025-02-01T00:00:00Z' }), // Q1
      trade(-5, { entry: '2025-03-30T00:00:00Z', exit: '2025-04-05T00:00:00Z' }), // entered Q1, exited Q2 → Q2
      trade(5, { entry: '2025-04-10T00:00:00Z', exit: '2025-04-20T00:00:00Z' }), // Q2
      trade(-20, { entry: '2025-12-20T00:00:00Z', exit: '2026-01-01T00:00:00Z' }), // exits exactly at window end → Q4 (inclusive)
    ];
    const q = computeWindowQuarters(trades, start, end);
    expect(q.length).toBe(4);
    expect(q.map((x) => x.n)).toEqual([1, 2, 0, 1]);
    expect(q[0].profitFactor).toBe(Infinity);
    expect(q[1].profitFactor).toBeCloseTo(1, 9);
    expect(q[2].profitFactor).toBeNull();
    expect(q[3].netProfit).toBe(-20);
    expect(q[0].start).toBe('2025-01-01T00:00:00.000Z');
    expect(q[3].end).toBe('2026-01-01T00:00:00.000Z');
    const spanQ = new Date(q[1].start).getTime() - new Date(q[0].start).getTime();
    expect(spanQ).toBe((end.getTime() - start.getTime()) / 4);
  });
});

describe('E4 §4 — Monte Carlo bootstrap', () => {
  const trades = [
    trade(30, { exit: '2025-01-05T00:00:00Z' }), trade(-10, { exit: '2025-01-20T00:00:00Z' }),
    trade(20, { exit: '2025-02-03T00:00:00Z' }), trade(-10, { exit: '2025-02-15T00:00:00Z' }), trade(-10, { exit: '2025-02-27T00:00:00Z' }),
    trade(15, { exit: '2025-03-09T00:00:00Z' }),
    trade(-10, { exit: '2025-05-01T00:00:00Z' }), trade(40, { exit: '2025-05-21T00:00:00Z' }),
  ];

  it('is deterministic for a seed and differs across seeds; month-block units = distinct exit months', () => {
    const a = runMonteCarlo(trades, { runs: 500, block: 'month', seed: 42, initialCapital: 1000 })!;
    const b = runMonteCarlo(trades, { runs: 500, block: 'month', seed: 42, initialCapital: 1000 })!;
    const c = runMonteCarlo(trades, { runs: 500, block: 'month', seed: 7, initialCapital: 1000 })!;
    expect(a).toEqual(b);
    expect(a.net).not.toEqual(c.net);
    expect(a.blocks).toBe(4); // Jan, Feb, Mar, May
    expect(a.runs).toBe(500);
    expect(a.net.p05).toBeLessThanOrEqual(a.net.p50);
    expect(a.net.p50).toBeLessThanOrEqual(a.net.p95);
    expect(a.maxDrawdownPct.p50).toBeLessThanOrEqual(a.maxDrawdownPct.p95);
    expect(a.maxDrawdownPct.p95).toBeLessThanOrEqual(a.maxDrawdownPct.max);
    expect(a.probNetLeqZero).toBeGreaterThanOrEqual(0);
    expect(a.probNetLeqZero).toBeLessThanOrEqual(1);
  });

  it('trade-block resamples n units; all-positive trades ⇒ P(net ≤ 0) = 0 and zero drawdown', () => {
    const t = runMonteCarlo(trades, { runs: 200, block: 'trade', seed: 1, initialCapital: 1000 })!;
    expect(t.blocks).toBe(trades.length);
    const winners = [trade(5), trade(7), trade(9)];
    const w = runMonteCarlo(winners, { runs: 100, block: 'trade', seed: 3, initialCapital: 1000 })!;
    expect(w.probNetLeqZero).toBe(0);
    expect(w.maxDrawdownPct.max).toBe(0);
    expect(w.profitFactor.p50).toBe(Infinity);
    expect(w.net.p05).toBeGreaterThan(0);
  });

  it('"none" or no trades ⇒ null; PRNG is in [0,1) and reproducible', () => {
    expect(runMonteCarlo(trades, { runs: 100, block: 'none', seed: 1, initialCapital: 1000 })).toBeNull();
    expect(runMonteCarlo([], { runs: 100, block: 'trade', seed: 1, initialCapital: 1000 })).toBeNull();
    const r1 = mulberry32(20260910);
    const r2 = mulberry32(20260910);
    for (let i = 0; i < 1000; i++) {
      const x = r1();
      expect(x).toBe(r2());
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });
});

describe('E4 §5 — derived label (desk label lock)', () => {
  it('SYNTHETIC ⇒ VOID, short window ⇒ SMOKE ONLY with the locked wording, ≥ 365d REAL ⇒ FULL', () => {
    expect(deriveLabel('SYNTHETIC', 800, 365)).toMatchObject({ label: 'VOID' });
    const smoke = deriveLabel('REAL', 31, 365);
    expect(smoke.label).toBe('SMOKE');
    expect(smoke.line.startsWith('SMOKE ONLY — NOT screen, NOT holdout, NOT Beta hard-preflight')).toBe(true);
    expect(deriveLabel('REAL', 364.9, 365).label).toBe('SMOKE');
    expect(deriveLabel('REAL', 365, 365).label).toBe('FULL');
    expect(deriveLabel('REAL', 729, 365).label).toBe('FULL');
  });
});

describe('E4 §6 — verdict logic', () => {
  function stats(n: number, pf: number | null, opts: Partial<ExpectancyStats> = {}): ExpectancyStats {
    return {
      n, wins: 0, losses: 0, winRate: 0, grossProfit: 0, grossLoss: 0, netProfit: 0, profitFactor: pf,
      meanPnl: 0, stdPnl: 0, tStatPnl: null, meanR: 0, stdR: 0, tStatR: 1.5, payoffRatio: null, averageWin: 0, averageLoss: 0,
      totalFees: 0, feesPerTrade: 0, feesPctOfGrossProfit: null, longEntries: n, shortEntries: 0, exitReasons: {}, bySymbol: {}, byStrategy: {},
      ...opts,
    };
  }
  function freq(n: number, days: number): TradeFrequency {
    return { n, windowDays: days, tradesPerMonth: 0, expectedTrades12m: (n * 365.25) / days, firstTradeAt: null, lastTradeAt: null };
  }
  const goodQuarters = [1, 2, 3, 4].map((i) => ({ index: i, start: '', end: '', n: 20, netProfit: 10, profitFactor: 1.3 }));
  function input(overrides: Partial<VerdictInput> = {}): VerdictInput {
    return {
      label: 'FULL',
      policy: E4_TF_POLICY['4h'],
      stamp: 'REAL',
      minExpectedTrades: 60,
      zeroFee: { n: 80, profitFactor: 2.0, threshold: 1.61, minTrades: 10, frequency: freq(80, 365.25) },
      fee: { stats: stats(80, 1.35), maxDrawdownPct: 0.08, frequency: freq(80, 365.25), quarters: goodQuarters, quartersEvaluable: true, shortEntries: 0 },
      mc: null,
      ...overrides,
    };
  }

  it('GO-ELIGIBLE only when every hard gate passes on a FULL REAL window (4h)', () => {
    const v = evaluateVerdict(input());
    expect(v.verdict).toBe('GO-ELIGIBLE');
    expect(v.gates.filter((g) => g.hard).every((g) => g.status === 'pass')).toBe(true);
    expect(v.gates.find((g) => g.id === 't_stat_r')?.status).toBe('info');
  });

  it('SMOKE windows are never graded, even with perfect stats', () => {
    const v = evaluateVerdict(input({ label: 'SMOKE' }));
    expect(v.verdict).toBe('SMOKE ONLY');
    expect(v.reasons.join(' ')).toMatch(/no grade issued/);
  });

  it('SYNTHETIC ⇒ VOID before anything else', () => {
    expect(evaluateVerdict(input({ stamp: 'SYNTHETIC' })).verdict).toBe('VOID');
  });

  it('too few zero-fee trades ⇒ INCONCLUSIVE; zero-fee PF below threshold ⇒ NO-GO (fail-fast)', () => {
    expect(evaluateVerdict(input({ zeroFee: { n: 5, profitFactor: 9, threshold: 1.61, minTrades: 10, frequency: freq(5, 365.25) }, fee: null })).verdict).toBe('INCONCLUSIVE');
    const ff = evaluateVerdict(input({ zeroFee: { n: 80, profitFactor: 1.2, threshold: 1.61, minTrades: 10, frequency: freq(80, 365.25) }, fee: null }));
    expect(ff.verdict).toBe('NO-GO');
    expect(ff.reasons[0]).toMatch(/fail-fast/);
    expect(ff.gates.find((g) => g.id === 'zero_fee_pf')?.status).toBe('fail');
  });

  it('hard gate failures on the fee pass ⇒ NO-GO (PF, E[n], maxDD, quarters, long-only)', () => {
    expect(evaluateVerdict(input({ fee: { ...input().fee!, stats: stats(80, 1.1) } })).verdict).toBe('NO-GO');
    expect(evaluateVerdict(input({ fee: { ...input().fee!, frequency: freq(40, 365.25) } })).verdict).toBe('NO-GO');
    expect(evaluateVerdict(input({ fee: { ...input().fee!, maxDrawdownPct: 0.2 } })).verdict).toBe('NO-GO');
    const badQ = goodQuarters.map((q, i) => (i < 2 ? { ...q, profitFactor: 0.8 } : q));
    expect(evaluateVerdict(input({ fee: { ...input().fee!, quarters: badQ } })).verdict).toBe('NO-GO');
    expect(evaluateVerdict(input({ fee: { ...input().fee!, shortEntries: 1 } })).verdict).toBe('NO-GO');
  });

  it('1D with E[n] < 100 is EXPLORATORY by TM rule, even when other gates fail; ≥ 100 can be GO-ELIGIBLE', () => {
    const thin = evaluateVerdict(input({
      policy: E4_TF_POLICY['1d'], minExpectedTrades: 100,
      zeroFee: { n: 17, profitFactor: 1.54, threshold: 1.44, minTrades: 10, frequency: freq(17, 729) },
      fee: { stats: stats(13, 0.71), maxDrawdownPct: 0.03, frequency: freq(13, 729), quarters: goodQuarters.map((q) => ({ ...q, profitFactor: 0.5 })), quartersEvaluable: true, shortEntries: 0 },
    }));
    expect(thin.verdict).toBe('EXPLORATORY');
    expect(thin.reasons[0]).toMatch(/1D E\[n\] 6\.5 < 100/);
    expect(thin.reasons.some((r) => r.startsWith('(context) gate would fail: Fee-pass PF'))).toBe(true);
    // Fail-fast tripped on 1D with a thin count: still EXPLORATORY (zero-fee E[n] is the upper bound).
    const thinFf = evaluateVerdict(input({
      policy: E4_TF_POLICY['1d'], minExpectedTrades: 100,
      zeroFee: { n: 12, profitFactor: 1.0, threshold: 1.44, minTrades: 10, frequency: freq(12, 729) }, fee: null,
    }));
    expect(thinFf.verdict).toBe('EXPLORATORY');
    expect(thinFf.reasons[0]).toMatch(/upper bound/);
    const rich = evaluateVerdict(input({
      policy: E4_TF_POLICY['1d'], minExpectedTrades: 100,
      zeroFee: { n: 120, profitFactor: 2.0, threshold: 1.44, minTrades: 10, frequency: freq(120, 365.25) },
      fee: { ...input().fee!, stats: stats(110, 1.3), frequency: freq(110, 365.25) },
    }));
    expect(rich.verdict).toBe('GO-ELIGIBLE');
  });

  it('1H is demoted: passes everything ⇒ EXPLORATORY, never GO-ELIGIBLE; its fail-fast threshold is 2.25', () => {
    const v = evaluateVerdict(input({
      policy: E4_TF_POLICY['1h'],
      zeroFee: { n: 200, profitFactor: 2.5, threshold: 2.25, minTrades: 10, frequency: freq(200, 365.25) },
      fee: { ...input().fee!, stats: stats(180, 1.4), frequency: freq(180, 365.25) },
    }));
    expect(v.verdict).toBe('EXPLORATORY');
    expect(v.reasons.join(' ')).toMatch(/demoted/);
    const ff = evaluateVerdict(input({
      policy: E4_TF_POLICY['1h'],
      zeroFee: { n: 200, profitFactor: 2.0, threshold: 2.25, minTrades: 10, frequency: freq(200, 365.25) }, fee: null,
    }));
    expect(ff.verdict).toBe('NO-GO');
  });

  it('a non-evaluable hard gate (quarters) blocks GO-ELIGIBLE ⇒ EXPLORATORY', () => {
    const v = evaluateVerdict(input({ fee: { ...input().fee!, quartersEvaluable: false } }));
    expect(v.verdict).toBe('EXPLORATORY');
    expect(v.gates.find((g) => g.id === 'quarters')?.status).toBe('n/a');
  });
});

describe('E4 §7 — end-to-end on committed REAL fixtures (#47)', () => {
  function request(overrides: Partial<E4Request>): E4Request {
    return {
      tf: '4h',
      startDate: new Date('2026-08-01T00:00:00Z'),
      endDate: new Date('2026-09-01T00:00:00Z'),
      products: ['BTC-USD', 'ETH-USD', 'SOL-USD'],
      strategy: 'trend_follow',
      initialCapital: 1000,
      feeTier: resolveE4FeeTier('4h', undefined, guardrails),
      evGateMode: 'enforce',
      regimeGates: true,
      data: { minCoverage: 0.5, minBucketFill: 0.5 },
      mc: { runs: 200, block: 'month', seed: 20260910 },
      minZeroFeeTrades: 10,
      minFullWindowDays: 365,
      smokeRunAllStages: false,
      ...overrides,
    };
  }

  it('4h Aug-2026 month-block ⇒ SMOKE ONLY on line 1, DATA: REAL, pooled n=3 (1/1/1), fee pass + MC skipped by fail-fast', async () => {
    const resultsPath = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-e4-4h-'));
    const runner = new BacktestRunner({ resultsPath, fixtureDir: FIXTURES_4H }, makeLogger());
    const report = await runE4(request({}), runner, guardrails, makeLogger());

    expect(report.label).toBe('SMOKE');
    expect(report.verdict).toBe('SMOKE ONLY');
    expect(report.data.stamp).toBe('REAL');
    for (const p of Object.values(report.data.provenance)) {
      expect(p.source).toBe('fixture');
      expect(p.inferredBarMinutes).toBe(240);
      expect(p.candleCount).toBe(186);
      expect(p.aggregation).toBeUndefined(); // fixture already is 4h — identity, no rollup record
    }
    expect(report.zeroFee!.stats.n).toBe(3);
    expect(report.zeroFee!.stats.bySymbol).toMatchObject({ 'BTC-USD': { n: 1 }, 'ETH-USD': { n: 1 }, 'SOL-USD': { n: 1 } });
    expect(report.zeroFee!.stats.shortEntries).toBe(0);
    expect(report.zeroFee!.metrics.activeStrategies).toEqual(['trend_follow']);
    expect(report.zeroFee!.trades.every((t) => t.strategy === 'trend_follow' && t.side === 'BUY')).toBe(true);
    expect(report.zeroFee!.failFast).toBe('inconclusive');
    expect(report.fee).toBeNull();
    expect(report.monteCarlo).toBeNull();

    const text = renderE4Report(report);
    const lines = text.split('\n');
    expect(lines[0].startsWith('SMOKE ONLY — NOT screen, NOT holdout, NOT Beta hard-preflight')).toBe(true);
    expect(lines[1]).toBe('DATA: REAL');
    expect(text).toContain('VERDICT: SMOKE ONLY');
    expect(text).toContain('Stage 2 — fee pass: SKIPPED (zero-fee pass inconclusive)');
    expect(text).toMatch(/E4_RESULT tf=4h label=SMOKE verdict="SMOKE ONLY" data=REAL zeroFeeN=3/);
  });

  it('--smoke-run-all-stages exercises the fee pass (EV gate rejects all 3 at intro1) and loads each series once', async () => {
    const resultsPath = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-e4-4h-all-'));
    const runner = new BacktestRunner({ resultsPath, fixtureDir: FIXTURES_4H }, makeLogger());
    const spy = vi.spyOn(runner, 'createDataProvider');
    const report = await runE4(request({ smokeRunAllStages: true }), runner, guardrails, makeLogger());
    expect(report.label).toBe('SMOKE');
    expect(report.verdict).toBe('SMOKE ONLY');
    expect(report.fee).not.toBeNull();
    expect(report.fee!.metrics.evGate).toMatchObject({ mode: 'enforce', evaluated: 3, rejected: 3 });
    expect(report.fee!.stats.n).toBe(0);
    expect(report.monteCarlo).toBeNull(); // no fee-pass trades to bootstrap
    expect(report.fee!.saved?.jsonPath).toMatch(/backtest_.*_e4-4h-fee\.json$/);
    expect(report.zeroFee!.saved?.jsonPath).toMatch(/backtest_.*_e4-4h-zero-fee\.json$/);
    // Two passes in the same second must NOT overwrite each other's artefacts.
    expect(report.zeroFee!.saved!.jsonPath).not.toBe(report.fee!.saved!.jsonPath);
    expect(fs.existsSync(report.zeroFee!.saved!.jsonPath)).toBe(true);
    expect(fs.existsSync(report.fee!.saved!.jsonPath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(report.zeroFee!.saved!.jsonPath, 'utf8')).fees.routing).toBe('flat-override');
    expect(JSON.parse(fs.readFileSync(report.fee!.saved!.jsonPath, 'utf8')).fees.routing).toBe('fee-model');
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('runner never overwrites a same-second run: collision guard appends -2, -3', async () => {
    const resultsPath = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-e4-collide-'));
    const runner = new BacktestRunner({ resultsPath, fixtureDir: FIXTURES_4H }, makeLogger());
    const cfg = {
      startDate: new Date('2026-08-01T00:00:00Z'), endDate: new Date('2026-09-01T00:00:00Z'), initialCapital: 1000, commission: 0,
      products: ['BTC-USD'],
      signals: {
        breakout: { enabled: false, parameters: {} }, vwapMeanReversion: { enabled: false, parameters: {} },
        momentum: { enabled: false, parameters: {} }, trendFollow: { enabled: true, parameters: {} },
      },
      risk: { maxPositionSize: 300, maxTotalExposure: 3000, stopLossPercent: 0.02, takeProfitPercent: 0.04 },
      disabledStrategies: ['vwap_mr', 'breakout'], evGate: { mode: 'off' as const },
    };
    const paths = new Set<string>();
    for (let i = 0; i < 3; i++) {
      const { saved } = await runner.runBacktestDetailed(cfg, {}, { fileTag: 'same tag!' });
      paths.add(saved!.jsonPath);
      // 'same tag!' sanitizes to 'same-tag-'; same-second collisions get '-2', '-3'.
      expect(saved!.jsonPath).toMatch(/_same-tag-(-\d+)?\.json$/);
    }
    expect(paths.size).toBe(3);
    expect(fs.readdirSync(resultsPath).filter((f) => f.startsWith('backtest_')).length).toBe(3);
  });

  it('memoizeProvider loads each (product, window) once across passes', async () => {
    const calls: string[] = [];
    const provider = memoizeProvider(async (product) => {
      calls.push(product);
      return { candles: [], provenance: {} as any };
    });
    const s = new Date('2026-08-01T00:00:00Z');
    const e = new Date('2026-09-01T00:00:00Z');
    await provider('BTC-USD', s, e);
    await provider('BTC-USD', s, e);
    await provider('ETH-USD', s, e);
    await provider('BTC-USD', s, new Date('2026-09-02T00:00:00Z'));
    expect(calls).toEqual(['BTC-USD', 'ETH-USD', 'BTC-USD']);
  });

  it('1d 24-month fixtures ⇒ FULL window, graded (never SMOKE ONLY), E[n] reported from the fee pass', async () => {
    const resultsPath = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-e4-1d-'));
    const runner = new BacktestRunner({ resultsPath, fixtureDir: FIXTURES_1D }, makeLogger());
    const report = await runE4(
      request({
        tf: '1d',
        startDate: new Date('2024-09-01T00:00:00Z'),
        endDate: new Date('2026-08-31T00:00:00Z'),
        products: ['BTC-USD', 'ETH-USD', 'SOL-USD'],
        feeTier: resolveE4FeeTier('1d', undefined, guardrails),
        mc: { runs: 300, block: 'trade', seed: 20260910 },
      }),
      runner, guardrails, makeLogger(),
    );
    expect(report.label).toBe('FULL');
    expect(report.data.stamp).toBe('REAL');
    expect(['GO-ELIGIBLE', 'NO-GO', 'EXPLORATORY', 'INCONCLUSIVE']).toContain(report.verdict);
    expect(report.verdict).not.toBe('SMOKE ONLY');
    expect(report.request.windowDays).toBe(729);
    for (const p of Object.values(report.data.provenance)) {
      expect(p.inferredBarMinutes).toBe(1440);
      expect(p.candleCount).toBe(730);
    }
    expect(report.zeroFee!.stats.n).toBeGreaterThanOrEqual(10); // 17 on the committed fixtures
    expect(report.zeroFee!.stats.shortEntries).toBe(0);
    if (report.zeroFee!.failFast === 'none') {
      expect(report.fee).not.toBeNull();
      expect(report.fee!.frequency.expectedTrades12m).toBeCloseTo((report.fee!.stats.n * 365.25) / 729, 6);
      expect(report.fee!.quartersEvaluable).toBe(true);
      expect(report.gates.find((g) => g.id === 'expected_trades')).toBeDefined();
      if (report.fee!.frequency.expectedTrades12m < 100) {
        expect(report.verdict).toBe('EXPLORATORY');
      }
      if (report.fee!.stats.n > 0) {
        expect(report.monteCarlo).toMatchObject({ block: 'trade', runs: 300, blocks: report.fee!.stats.n });
      }
    }
    const text = renderE4Report(report);
    expect(text.split('\n')[0].startsWith('FULL WINDOW — DATA: REAL')).toBe(true);
    expect(text).toContain('E4_RESULT tf=1d label=FULL');
  }, 30_000);
});
