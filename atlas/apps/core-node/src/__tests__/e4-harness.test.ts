/**
 * E4 multi-TF FeeModel expectancy harness (TASK_018 E4, TM-corrected).
 *
 *   1. Timeframe policy: 4h → 1d → 1h (demoted); 15m refused; LOCKED floors
 *      (4H 1.61 · 1D 1.44 · 1H 2.25); fee pass defaults to FeeModel 40.
 *   2. Expectancy statistics from a hand-built trade set (PF, R, t-stat, fees).
 *   3. E[n] annualisation and window-quarter bucketing.
 *   4. Seeded Monte Carlo: deterministic, month-block vs trade units.
 *   5. Derived label: SYNTHETIC ⇒ VOID, < 365d ⇒ SMOKE ONLY, FULL without a
 *      run card ⇒ UNGRADED, FULL + run card ⇒ GRADED.
 *   6. Verdict order: SMOKE / UNGRADED never graded; INCONCLUSIVE; zero-fee
 *      floor NO-GO (STOP); 1D E[n] < 100 ⇒ EXPLORATORY; 1H capped at
 *      EXPLORATORY; GO-ELIGIBLE only when every hard gate passes.
 *   7. Data path: per-TF fixtures only (15m gate fixtures refused), spot only.
 *   8. End-to-end on the committed REAL 4h / 1d fixtures through the runner.
 */
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  E4_TF_POLICY,
  E4_ZERO_FEE_PF_FLOOR,
  E4_MIN_EXPECTED_TRADES,
  E4_MIN_ZERO_FEE_TRADES,
  E4_FULL_WINDOW_MIN_DAYS,
  parseTimeframe,
  computeExpectancy,
  computeTradeFrequency,
  computeWindowQuarters,
  runMonteCarlo,
  mulberry32,
  deriveLabel,
  evaluateVerdict,
  assertSpotProducts,
  assertFixtureTimeframe,
  memoizeProvider,
  runE4,
  renderE4Report,
  resolveE4FeeTier,
  profitFactorOf,
  tradeR,
  isE4DataPathError,
  type E4Request,
  type VerdictInput,
  type ExpectancyStats,
  type TradeFrequency,
} from '../backtesting/e4-harness';
import { BacktestRunner } from '../backtesting/backtest-runner';
import type { BacktestTrade } from '../backtesting/backtest-engine';
import type { DataProvenance } from '../backtesting/data-loader';
import { loadGuardrails } from '../config/loadGuardrails';

function makeLogger() {
  return { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as any;
}

const ATLAS_ROOT = path.resolve(__dirname, '../../../..');
const FIXTURES_ROOT = path.resolve(__dirname, '../../fixtures/bars');
/** Aug-2026 4h set: `4h/smoke-aug2026` once Dev Backtest's #49 lands, `4h/` before that. */
const FIXTURES_4H_SMOKE = fs.existsSync(path.join(FIXTURES_ROOT, '4h/smoke-aug2026'))
  ? path.join(FIXTURES_ROOT, '4h/smoke-aug2026')
  : path.join(FIXTURES_ROOT, '4h');
const FIXTURES_1D = path.join(FIXTURES_ROOT, '1d');
const FIXTURES_15M_GATE = FIXTURES_ROOT;
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

describe('E4 §1 — timeframe policy and LOCKED floors', () => {
  it('zero-fee PF floors are locked at 4H 1.61 · 1D 1.44 · 1H 2.25 and frozen', () => {
    expect(E4_ZERO_FEE_PF_FLOOR).toEqual({ '4h': 1.61, '1d': 1.44, '1h': 2.25 });
    expect(Object.isFrozen(E4_ZERO_FEE_PF_FLOOR)).toBe(true);
    expect(E4_MIN_EXPECTED_TRADES).toEqual({ '4h': 60, '1d': 100, '1h': 60 });
    expect(E4_MIN_ZERO_FEE_TRADES).toBe(10);
    expect(E4_FULL_WINDOW_MIN_DAYS).toBe(365);
    for (const tf of ['4h', '1d', '1h'] as const) {
      expect(E4_TF_POLICY[tf].zeroFeePfMin).toBe(E4_ZERO_FEE_PF_FLOOR[tf]);
      expect(E4_TF_POLICY[tf].minExpectedTrades).toBe(E4_MIN_EXPECTED_TRADES[tf]);
    }
  });

  it('desk order 4h → 1d → 1h, 1h demoted, per-TF fixture hints name the Dev Backtest directories', () => {
    expect(E4_TF_POLICY['4h']).toMatchObject({ order: 1, barMinutes: 240, status: 'primary', defaultMcBlock: 'month', goEligible: true });
    expect(E4_TF_POLICY['1d']).toMatchObject({ order: 2, barMinutes: 1440, status: 'secondary', defaultMcBlock: 'trade', goEligible: true });
    expect(E4_TF_POLICY['1h']).toMatchObject({ order: 3, barMinutes: 60, status: 'demoted', goEligible: false });
    expect(E4_TF_POLICY['4h'].fixtureHint).toContain('fixtures/bars/4h/holdout-2025-03_2026-03');
    expect(E4_TF_POLICY['1d'].fixtureHint).toContain('fixtures/bars/1d');
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

  it('fee pass defaults to the guardrails FeeModel spot bucket (FeeModel 40 = 25/40 bps); explicit --fee-tier wins', () => {
    const dflt = resolveE4FeeTier(undefined, guardrails);
    expect(dflt).toMatchObject({ makerBps: 25, takerBps: 40 });
    expect(dflt.name).toBe('t10k (guardrails.yaml default)');
    expect(guardrails.fees.coinbase.spot).toEqual({ maker_bps: 25, taker_bps: 40 });
    expect(resolveE4FeeTier('intro1', guardrails)).toMatchObject({ name: 'intro1', makerBps: 60, takerBps: 120 });
    expect(resolveE4FeeTier('custom:0,0', guardrails)).toMatchObject({ makerBps: 0, takerBps: 0 });
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
    // sample sd of [30,-10,20,-10,-10]: mean 4; devs 26,-14,16,-14,-14 → SS=1520 → /4 = 380
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
    const year = computeTradeFrequency(new Array(30).fill(0).map(() => trade(1)), new Date('2025-03-01T00:00:00Z'), new Date('2026-03-01T06:00:00Z'));
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

describe('E4 §5 — derived label (desk label lock + burn hold)', () => {
  it('SYNTHETIC ⇒ VOID; short window ⇒ SMOKE ONLY with the locked wording; FULL needs a run card to be GRADED', () => {
    expect(deriveLabel('SYNTHETIC', 800, 'AA-1')).toMatchObject({ label: 'VOID', graded: false });
    const smoke = deriveLabel('REAL', 31, 'AA-1');
    expect(smoke.label).toBe('SMOKE');
    expect(smoke.graded).toBe(false);
    expect(smoke.line.startsWith('SMOKE ONLY — NOT screen, NOT holdout, NOT Beta hard-preflight')).toBe(true);
    expect(deriveLabel('REAL', 364.9, 'AA-1').label).toBe('SMOKE');

    const ungraded = deriveLabel('REAL', 365, undefined);
    expect(ungraded).toMatchObject({ label: 'FULL', graded: false });
    expect(ungraded.line).toMatch(/^FULL WINDOW — DATA: REAL.*UNGRADED \(burn hold/);
    expect(deriveLabel('REAL', 729, '   ').graded).toBe(false); // blank card = no card

    const graded = deriveLabel('REAL', 365, 'AA-E4-4H-001');
    expect(graded).toMatchObject({ label: 'FULL', graded: true });
    expect(graded.line).toContain('GRADED under run card AA-E4-4H-001');
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
      graded: true,
      policy: E4_TF_POLICY['4h'],
      stamp: 'REAL',
      minExpectedTrades: 60,
      zeroFee: { n: 80, profitFactor: 2.0, threshold: 1.61, minTrades: 10, frequency: freq(80, 365.25) },
      fee: { stats: stats(80, 1.35), maxDrawdownPct: 0.08, frequency: freq(80, 365.25), quarters: goodQuarters, quartersEvaluable: true, shortEntries: 0 },
      mc: null,
      ...overrides,
    };
  }

  it('GO-ELIGIBLE only when every hard gate passes on a GRADED FULL REAL window (4h)', () => {
    const v = evaluateVerdict(input());
    expect(v.verdict).toBe('GO-ELIGIBLE');
    expect(v.gates.filter((g) => g.hard).every((g) => g.status === 'pass')).toBe(true);
    expect(v.gates.find((g) => g.id === 't_stat_r')?.status).toBe('info');
    expect(v.gates.find((g) => g.id === 'zero_fee_pf')?.label).toMatch(/LOCKED/);
  });

  it('SMOKE windows are never graded, even with perfect stats', () => {
    const v = evaluateVerdict(input({ label: 'SMOKE', graded: false }));
    expect(v.verdict).toBe('SMOKE ONLY');
    expect(v.reasons.join(' ')).toMatch(/no grade issued/);
  });

  it('FULL window without a run card ⇒ UNGRADED (burn hold), stats + gate statuses kept as context', () => {
    const perfect = evaluateVerdict(input({ graded: false }));
    expect(perfect.verdict).toBe('UNGRADED');
    expect(perfect.reasons[0]).toMatch(/burn hold/);
    expect(perfect.reasons.join(' ')).toMatch(/--run-card/);
    const failing = evaluateVerdict(input({ graded: false, fee: { ...input().fee!, stats: stats(80, 0.9) } }));
    expect(failing.verdict).toBe('UNGRADED'); // never NO-GO without a card
    expect(failing.reasons.some((r) => r.startsWith('(context) gate would fail: Fee-pass PF'))).toBe(true);
    const stopped = evaluateVerdict(input({ graded: false, zeroFee: { n: 80, profitFactor: 1.2, threshold: 1.61, minTrades: 10, frequency: freq(80, 365.25) }, fee: null }));
    expect(stopped.verdict).toBe('UNGRADED');
    expect(stopped.reasons.some((r) => r.includes('STOP'))).toBe(true);
  });

  it('SYNTHETIC ⇒ VOID before anything else', () => {
    expect(evaluateVerdict(input({ stamp: 'SYNTHETIC' })).verdict).toBe('VOID');
  });

  it('too few zero-fee trades ⇒ INCONCLUSIVE; zero-fee PF below the locked floor ⇒ NO-GO (STOP)', () => {
    expect(evaluateVerdict(input({ zeroFee: { n: 5, profitFactor: 9, threshold: 1.61, minTrades: 10, frequency: freq(5, 365.25) }, fee: null })).verdict).toBe('INCONCLUSIVE');
    const ff = evaluateVerdict(input({ zeroFee: { n: 80, profitFactor: 1.6, threshold: 1.61, minTrades: 10, frequency: freq(80, 365.25) }, fee: null }));
    expect(ff.verdict).toBe('NO-GO');
    expect(ff.reasons[0]).toMatch(/locked floor 1\.61.*STOP/);
    expect(ff.gates.find((g) => g.id === 'zero_fee_pf')?.status).toBe('fail');
    // Exactly at the floor passes.
    const at = evaluateVerdict(input({ zeroFee: { n: 80, profitFactor: 1.61, threshold: 1.61, minTrades: 10, frequency: freq(80, 365.25) } }));
    expect(at.verdict).toBe('GO-ELIGIBLE');
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

  it('1H is demoted: passes everything ⇒ EXPLORATORY, never GO-ELIGIBLE; its locked floor is 2.25', () => {
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

describe('E4 §7 — data path: per-TF fixtures only, spot only', () => {
  function prov(overrides: Partial<DataProvenance>): DataProvenance {
    return {
      symbol: 'BTC-USD', source: 'fixture', windowStart: '', windowEnd: '', granularitySeconds: 14_400,
      candleCount: 2188, expectedCount: 2191, coverage: 0.999, firstBarTime: null, lastBarTime: null,
      inferredBarMinutes: 240, loadTimeMs: 1, ...overrides,
    };
  }

  it('accepts a native 4h fixture; refuses 15m gate fixtures, rolled-up series, non-fixture sources and mismatched widths', () => {
    expect(() => assertFixtureTimeframe(prov({}), E4_TF_POLICY['4h'], 'x')).not.toThrow();
    expect(() => assertFixtureTimeframe(prov({ granularitySeconds: 900, inferredBarMinutes: 15 }), E4_TF_POLICY['4h'], 'fixtures/bars')).toThrow(/E4_FIXTURE_TF_MISMATCH.*declared=15m.*needs native 240m/);
    expect(() => assertFixtureTimeframe(prov({ aggregation: { targetMinutes: 240, sourceMinutes: 15, sourceCandleCount: 1, outputCandleCount: 1, subBarsPerBucket: 16, bucketsDropped: 0, partialBucketsKept: 0, minBucketFill: 0.5 } }), E4_TF_POLICY['4h'], 'x')).toThrow(/E4_FIXTURE_TF_MISMATCH/);
    expect(() => assertFixtureTimeframe(prov({ source: 'supabase' }), E4_TF_POLICY['4h'], 'x')).toThrow(/E4_FIXTURE_TF_MISMATCH/);
    expect(() => assertFixtureTimeframe(prov({}), E4_TF_POLICY['1d'], 'x')).toThrow(/needs native 1440m/);
    try {
      assertFixtureTimeframe(prov({ granularitySeconds: 900, inferredBarMinutes: 15 }), E4_TF_POLICY['4h'], 'fixtures/bars');
    } catch (err) {
      expect(isE4DataPathError(err)).toBe(true);
      expect((err as Error).message).toContain('backtest-gate only');
      expect((err as Error).message).toContain('pnpm backtest --bar-minutes');
    }
  });

  it('refuses perps products (spot long-only; INTX parked)', () => {
    expect(() => assertSpotProducts(['BTC-USD', 'ETH-USD', 'SOL-USD'])).not.toThrow();
    expect(() => assertSpotProducts(['BTC-USD', 'ETH-PERP-INTX'])).toThrow(/E4_SPOT_ONLY.*ETH-PERP-INTX/);
  });
});

describe('E4 §8 — end-to-end on committed REAL fixtures', () => {
  function request(overrides: Partial<E4Request>): E4Request {
    return {
      tf: '4h',
      startDate: new Date('2026-08-01T00:00:00Z'),
      endDate: new Date('2026-09-01T00:00:00Z'),
      products: ['BTC-USD', 'ETH-USD', 'SOL-USD'],
      strategy: 'trend_follow',
      initialCapital: 1000,
      feeTier: resolveE4FeeTier(undefined, guardrails),
      evGateMode: 'enforce',
      regimeGates: true,
      fixtureDir: FIXTURES_4H_SMOKE,
      mc: { runs: 200, block: 'month', seed: 20260910 },
      smokeRunAllStages: false,
      ...overrides,
    };
  }

  it('4h Aug-2026 month-block ⇒ SMOKE ONLY on line 1, DATA: REAL, pooled n=3 (1/1/1), fee pass + MC stopped by fail-fast', async () => {
    const resultsPath = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-e4-4h-'));
    const runner = new BacktestRunner({ resultsPath, fixtureDir: FIXTURES_4H_SMOKE }, makeLogger());
    const report = await runE4(request({}), runner, guardrails, makeLogger());

    expect(report.label).toBe('SMOKE');
    expect(report.graded).toBe(false);
    expect(report.verdict).toBe('SMOKE ONLY');
    expect(report.data.stamp).toBe('REAL');
    expect(report.thresholds).toMatchObject({ zeroFeePfFloor: 1.61, minZeroFeeTrades: 10, minExpectedTrades: 60, fullWindowMinDays: 365 });
    expect(report.request.feeTier).toMatchObject({ makerBps: 25, takerBps: 40 });
    for (const p of Object.values(report.data.provenance)) {
      expect(p.source).toBe('fixture');
      expect(p.granularitySeconds).toBe(14_400);
      expect(p.inferredBarMinutes).toBe(240);
      expect(p.candleCount).toBe(186);
      expect(p.aggregation).toBeUndefined(); // native 4h fixture — nothing rolled up
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
    expect(text).toContain('Locked thresholds: zero-fee PF floor ≥ 1.61 (STOP below)');
    expect(text).toContain('VERDICT: SMOKE ONLY');
    expect(text).toContain('Stage 2 — fee pass: NOT RUN (STOP: zero-fee pass inconclusive)');
    expect(text).toMatch(/E4_RESULT tf=4h label=SMOKE graded=false runCard=none verdict="SMOKE ONLY" data=REAL zeroFeeN=3/);
  });

  it('--smoke-run-all-stages exercises the fee pass at FeeModel 40 and loads each series once; artefacts are distinct per pass', async () => {
    const resultsPath = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-e4-4h-all-'));
    const runner = new BacktestRunner({ resultsPath, fixtureDir: FIXTURES_4H_SMOKE }, makeLogger());
    const spy = vi.spyOn(runner, 'createDataProvider');
    const report = await runE4(request({ smokeRunAllStages: true }), runner, guardrails, makeLogger());
    expect(report.label).toBe('SMOKE');
    expect(report.verdict).toBe('SMOKE ONLY');
    expect(report.fee).not.toBeNull();
    expect(report.fee!.fees.routing).toBe('fee-model');
    expect(report.fee!.fees.perVenue.spot).toEqual({ makerBps: 25, takerBps: 40 });
    expect(report.fee!.metrics.evGate.mode).toBe('enforce');
    expect(report.fee!.metrics.evGate.evaluated).toBe(3);
    expect(report.fee!.saved?.jsonPath).toMatch(/backtest_.*_e4-4h-fee\.json$/);
    expect(report.zeroFee!.saved?.jsonPath).toMatch(/backtest_.*_e4-4h-zero-fee\.json$/);
    expect(report.zeroFee!.saved!.jsonPath).not.toBe(report.fee!.saved!.jsonPath);
    expect(fs.existsSync(report.zeroFee!.saved!.jsonPath)).toBe(true);
    expect(fs.existsSync(report.fee!.saved!.jsonPath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(report.zeroFee!.saved!.jsonPath, 'utf8')).fees.routing).toBe('flat-override');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(renderE4Report(report)).toContain('[SMOKE ONLY: ran past fail-fast via --smoke-run-all-stages]');
  });

  it('refuses the 15m gate fixtures for --tf 4h before any engine work (E4_FIXTURE_TF_MISMATCH)', async () => {
    const resultsPath = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-e4-15m-'));
    const runner = new BacktestRunner({ resultsPath, fixtureDir: FIXTURES_15M_GATE }, makeLogger());
    await expect(
      runE4(request({
        fixtureDir: FIXTURES_15M_GATE, products: ['BTC-USD', 'ETH-USD'],
        startDate: new Date('2026-09-03T00:00:00Z'), endDate: new Date('2026-09-10T00:00:00Z'),
      }), runner, guardrails, makeLogger()),
    ).rejects.toMatchObject({ code: 'E4_FIXTURE_TF_MISMATCH' });
    expect(fs.readdirSync(resultsPath).length).toBe(0); // nothing ran, nothing saved
  });

  it('refuses perps products and a missing fixture dir', async () => {
    const runner = new BacktestRunner({ resultsPath: os.tmpdir(), fixtureDir: FIXTURES_4H_SMOKE }, makeLogger());
    await expect(runE4(request({ products: ['BTC-USD', 'BTC-PERP-INTX'] }), runner, guardrails, makeLogger())).rejects.toMatchObject({ code: 'E4_SPOT_ONLY' });
    await expect(runE4(request({ fixtureDir: '' }), runner, guardrails, makeLogger())).rejects.toMatchObject({ code: 'E4_FIXTURE_DIR_REQUIRED' });
  });

  it('runner never overwrites a same-second run: collision guard appends -2, -3', async () => {
    const resultsPath = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-e4-collide-'));
    const runner = new BacktestRunner({ resultsPath, fixtureDir: FIXTURES_4H_SMOKE }, makeLogger());
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

  it('1d 24-month fixtures ⇒ FULL window: UNGRADED without a run card, graded with one (never SMOKE ONLY)', async () => {
    const base = request({
      tf: '1d',
      startDate: new Date('2024-09-01T00:00:00Z'),
      endDate: new Date('2026-08-31T00:00:00Z'),
      fixtureDir: FIXTURES_1D,
      mc: { runs: 300, block: 'trade', seed: 20260910 },
    });

    const held = await runE4(base, new BacktestRunner({ resultsPath: fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-e4-1d-')), fixtureDir: FIXTURES_1D }, makeLogger()), guardrails, makeLogger());
    expect(held.label).toBe('FULL');
    expect(held.graded).toBe(false);
    expect(held.verdict).toBe('UNGRADED');
    expect(held.data.stamp).toBe('REAL');
    expect(held.request.windowDays).toBe(729);
    expect(held.thresholds.zeroFeePfFloor).toBe(1.44);
    for (const p of Object.values(held.data.provenance)) {
      expect(p.granularitySeconds).toBe(86_400);
      expect(p.inferredBarMinutes).toBe(1440);
      expect(p.candleCount).toBe(730);
    }
    expect(held.zeroFee!.stats.n).toBeGreaterThanOrEqual(10); // 17 on the committed fixtures
    expect(held.zeroFee!.stats.shortEntries).toBe(0);
    // The STOP rule is independent of grading: fee pass runs iff the floor was cleared.
    expect(held.fee !== null).toBe(held.zeroFee!.failFast === 'none');
    const heldText = renderE4Report(held);
    expect(heldText.split('\n')[0]).toMatch(/^FULL WINDOW — DATA: REAL, 729\.0d ≥ 365d — UNGRADED \(burn hold/);
    expect(heldText).toContain('VERDICT: UNGRADED');
    expect(heldText).toMatch(/E4_RESULT tf=1d label=FULL graded=false runCard=none verdict="UNGRADED"/);

    const graded = await runE4({ ...base, runCard: 'TEST-CARD-UNIT' }, new BacktestRunner({ resultsPath: fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-e4-1d-g-')), fixtureDir: FIXTURES_1D }, makeLogger()), guardrails, makeLogger());
    expect(graded.graded).toBe(true);
    expect(graded.runCard).toBe('TEST-CARD-UNIT');
    expect(['GO-ELIGIBLE', 'NO-GO', 'EXPLORATORY', 'INCONCLUSIVE']).toContain(graded.verdict);
    // Same data, same stats — only the grading differs.
    expect(graded.zeroFee!.stats.n).toBe(held.zeroFee!.stats.n);
    expect(graded.fee?.stats.n).toBe(held.fee?.stats.n);
    if (graded.fee) {
      expect(graded.fee.frequency.expectedTrades12m).toBeCloseTo((graded.fee.stats.n * 365.25) / 729, 6);
      expect(graded.fee.quartersEvaluable).toBe(true);
      if (graded.fee.frequency.expectedTrades12m < 100) expect(graded.verdict).toBe('EXPLORATORY');
      if (graded.fee.stats.n > 0) expect(graded.monteCarlo).toMatchObject({ block: 'trade', runs: 300, blocks: graded.fee.stats.n });
    }
    expect(renderE4Report(graded).split('\n')[0]).toContain('GRADED under run card TEST-CARD-UNIT');
  }, 60_000);
});
