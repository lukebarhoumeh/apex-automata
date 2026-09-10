/**
 * E4 multi-TF FeeModel expectancy harness — Algo Creator Beta card (2026-09-10).
 *
 *   1. Card + locked constants: floors (4H 1.61 · 1D 1.44 · 1H 2.25), preflight
 *      E[n] ≥ 100, walk-forward windows, GO fee book 40, cooldown 1 bar.
 *   2. Expectancy statistics from a hand-built trade set.
 *   3. E[n] annualisation and window-quarter bucketing.
 *   4. Seeded Monte Carlo incl. P(PF ≥ 1.20) screen.
 *   5. Derived label: VOID / SMOKE ONLY / UNGRADED / GRADED.
 *   6. Verdict order: SMOKE, UNGRADED, TUNE DIAGNOSTIC, preflight thin count
 *      (RESEARCH SCREEN ONLY / EXPLORATORY), INCONCLUSIVE, STOP, caps
 *      (custom window, non-GO fee book, 1H), BETA BARS FAIL / PASS.
 *   7. Zero-knobs assertion + data-path refusals (15m gate fixtures, perps).
 *   8. End-to-end on committed REAL fixtures: 4h smoke (SMOKE ONLY), 1d eval
 *      window (UNGRADED without card, graded with), preflight print path,
 *      eval ledger, distinct per-pass artefacts.
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
  E4_CARD,
  E4_WALK_FORWARD,
  E4_DEFAULT_FIXTURE_DIR,
  E4_MC_SCREEN,
  classifyWindow,
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
  assertZeroKnobs,
  memoizeProvider,
  runE4,
  renderE4Report,
  resolveE4FeeTier,
  profitFactorOf,
  tradeR,
  isE4DataPathError,
  type E4Request,
  type E4Preflight,
  type VerdictInput,
  type ExpectancyStats,
} from '../backtesting/e4-harness';
import { BacktestRunner } from '../backtesting/backtest-runner';
import type { BacktestTrade } from '../backtesting/backtest-engine';
import type { DataProvenance } from '../backtesting/data-loader';
import { loadGuardrails, type GuardrailConfig } from '../config/loadGuardrails';

function makeLogger() {
  return { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as any;
}

const ATLAS_ROOT = path.resolve(__dirname, '../../../..');
const CORE_NODE = path.resolve(__dirname, '../..');
const FIXTURES_ROOT = path.join(CORE_NODE, 'fixtures/bars');
const FIXTURES_4H_SMOKE = fs.existsSync(path.join(FIXTURES_ROOT, '4h/smoke-aug2026'))
  ? path.join(FIXTURES_ROOT, '4h/smoke-aug2026')
  : path.join(FIXTURES_ROOT, '4h');
const FIXTURES_1D = path.join(FIXTURES_ROOT, '1d');
const FIXTURES_15M_GATE = FIXTURES_ROOT;
const guardrails = loadGuardrails(ATLAS_ROOT);
const CARD = 'TEST-CARD-UNIT';

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

describe('E4 §1 — card, locked floors, walk-forward windows', () => {
  it('floors are locked (4H 1.61 · 1D 1.44 · 1H 2.25), preflight E[n] ≥ 100 everywhere, constants frozen', () => {
    expect(E4_ZERO_FEE_PF_FLOOR).toEqual({ '4h': 1.61, '1d': 1.44, '1h': 2.25 });
    expect(Object.isFrozen(E4_ZERO_FEE_PF_FLOOR)).toBe(true);
    expect(E4_MIN_EXPECTED_TRADES).toEqual({ '4h': 100, '1d': 100, '1h': 100 });
    expect(E4_MIN_ZERO_FEE_TRADES).toBe(10);
    expect(E4_FULL_WINDOW_MIN_DAYS).toBe(365);
    expect(E4_MC_SCREEN).toEqual({ pfMin: 1.2, probMin: 0.6 });
    for (const tf of ['4h', '1d', '1h'] as const) {
      expect(E4_TF_POLICY[tf].zeroFeePfMin).toBe(E4_ZERO_FEE_PF_FLOOR[tf]);
      expect(E4_TF_POLICY[tf].minExpectedTrades).toBe(100);
    }
  });

  it('the card is encoded: BTC/ETH/SOL spot, trend_follow A1 2.5/6.0, atr min 0.005, EV 0, cooldown 1 bar, GO fee 40, stress 25/75/120', () => {
    expect(Object.isFrozen(E4_CARD)).toBe(true);
    expect([...E4_CARD.products]).toEqual(['BTC-USD', 'ETH-USD', 'SOL-USD']);
    expect(E4_CARD.strategy).toBe('trend_follow');
    expect(E4_CARD.a1).toEqual({ stopAtr: 2.5, takeProfitAtr: 6.0 });
    expect(E4_CARD.atrVolatilityMin).toBe(0.005);
    expect(E4_CARD.minEvThreshold).toBe(0);
    expect(E4_CARD.cooldownBars).toBe(1);
    expect(E4_CARD.goFeeBpsPerSide).toBe(40);
    expect([...E4_CARD.stressBpsPerSide]).toEqual([25, 75, 120]);
  });

  it('walk-forward windows are locked and classified from dates; default fixture dirs match Dev Backtest', () => {
    expect(E4_WALK_FORWARD.tune).toMatchObject({ start: '2023-03-01T00:00:00.000Z', end: '2025-03-01T00:00:00.000Z' });
    expect(E4_WALK_FORWARD.eval).toMatchObject({ start: '2025-03-01T00:00:00.000Z', end: '2026-03-01T00:00:00.000Z' });
    expect(classifyWindow(new Date('2025-03-01T00:00:00Z'), new Date('2026-03-01T00:00:00Z'))).toBe('eval');
    expect(classifyWindow(new Date('2023-03-01T00:00:00Z'), new Date('2025-03-01T00:00:00Z'))).toBe('tune');
    expect(classifyWindow(new Date('2025-03-01T00:00:00Z'), new Date('2026-02-28T00:00:00Z'))).toBe('custom');
    expect(E4_DEFAULT_FIXTURE_DIR['4h']).toEqual({ eval: 'fixtures/bars/4h/holdout-2025-03_2026-03', tune: 'fixtures/bars/4h/tune-2023-03_2025-03' });
    expect(E4_DEFAULT_FIXTURE_DIR['1d']).toEqual({ eval: 'fixtures/bars/1d', tune: 'fixtures/bars/1d' });
    expect(E4_DEFAULT_FIXTURE_DIR['1h']).toEqual({});
  });

  it('desk order 4h → 1d → 1h; thin-count verdict wording per TF; 1h demoted', () => {
    expect(E4_TF_POLICY['4h']).toMatchObject({ order: 1, barMinutes: 240, thinCountVerdict: 'RESEARCH SCREEN ONLY', defaultMcBlock: 'month', goEligible: true });
    expect(E4_TF_POLICY['1d']).toMatchObject({ order: 2, barMinutes: 1440, thinCountVerdict: 'EXPLORATORY', defaultMcBlock: 'trade', goEligible: true });
    expect(E4_TF_POLICY['1h']).toMatchObject({ order: 3, barMinutes: 60, status: 'demoted', goEligible: false });
  });

  it('parses aliases and refuses 15m (15m out)', () => {
    expect(parseTimeframe('4h')).toBe('4h');
    expect(parseTimeframe('240')).toBe('4h');
    expect(parseTimeframe('1D')).toBe('1d');
    expect(parseTimeframe(1440)).toBe('1d');
    expect(parseTimeframe('60')).toBe('1h');
    expect(() => parseTimeframe('15m')).toThrow(/15m out/);
    expect(() => parseTimeframe('2h')).toThrow(/Unknown --tf/);
  });

  it('fee-book default is the guardrails spot bucket = GO fee book (40 bps taker); explicit --fee-tier wins', () => {
    const dflt = resolveE4FeeTier(undefined, guardrails);
    expect(dflt).toMatchObject({ makerBps: 25, takerBps: 40 });
    expect(dflt.takerBps).toBe(E4_CARD.goFeeBpsPerSide);
    expect(resolveE4FeeTier('intro1', guardrails)).toMatchObject({ name: 'intro1', makerBps: 60, takerBps: 120 });
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

  it('computes PF, win rate, payoff, R multiples, t-stats and fee drag from trades', () => {
    const s = computeExpectancy(trades);
    expect(s.n).toBe(5);
    expect(s.wins).toBe(2);
    expect(s.losses).toBe(3);
    expect(s.winRate).toBeCloseTo(0.4, 9);
    expect(s.grossProfit).toBe(50);
    expect(s.grossLoss).toBe(30);
    expect(s.profitFactor).toBeCloseTo(50 / 30, 9);
    expect(s.payoffRatio).toBeCloseTo(2.5, 9);
    expect(s.meanR).toBeCloseTo(0.4, 9);
    expect(s.stdPnl).toBeCloseTo(Math.sqrt(380), 9);
    expect(s.tStatPnl).toBeCloseTo(4 / (Math.sqrt(380) / Math.sqrt(5)), 9);
    expect(s.totalFees).toBe(10);
    expect(s.feesPctOfGrossProfit).toBeCloseTo(0.2, 9);
    expect(s.longEntries).toBe(4);
    expect(s.shortEntries).toBe(1);
    expect(s.exitReasons).toEqual({ take_profit: 2, stop_loss: 2, signal: 1 });
    expect(s.bySymbol['BTC-USD']).toMatchObject({ n: 2, netProfit: 20, profitFactor: 3 });
    expect(s.byStrategy['momentum'].n).toBe(1);
  });

  it('PF is ∞ with wins and no losses, null with no trades; t-stat null when n < 2', () => {
    expect(profitFactorOf(10, 0)).toBe(Infinity);
    expect(profitFactorOf(0, 0)).toBeNull();
    expect(profitFactorOf(0, 5)).toBe(0);
    const only = computeExpectancy([trade(10)]);
    expect(only.profitFactor).toBe(Infinity);
    expect(only.tStatPnl).toBeNull();
    expect(computeExpectancy([]).profitFactor).toBeNull();
    expect(tradeR(trade(25))).toBeCloseTo(2.5, 9);
    expect(tradeR({ pnl: 5, entryPrice: 100, stopLoss: 100, size: 1 })).toBe(0);
  });
});

describe('E4 §3 — E[n] and window quarters', () => {
  it('E[n] = n × 365.25 / windowDays; the eval window (365d) gives E[n] ≈ n', () => {
    const start = new Date(E4_WALK_FORWARD.eval.start);
    const end = new Date(E4_WALK_FORWARD.eval.end);
    const f = computeTradeFrequency(new Array(42).fill(0).map(() => trade(1)), start, end);
    expect(f.windowDays).toBe(365);
    expect(f.expectedTrades12m).toBeCloseTo(42 * (365.25 / 365), 9);
    const two = computeTradeFrequency(new Array(13).fill(0).map(() => trade(1)), new Date('2024-09-01T00:00:00Z'), new Date('2026-08-31T00:00:00Z'));
    expect(two.expectedTrades12m).toBeCloseTo((13 * 365.25) / 729, 9);
    expect(computeTradeFrequency([], start, end).firstTradeAt).toBeNull();
  });

  it('splits the window into 4 equal segments and scores trades by EXIT time', () => {
    const start = new Date('2025-01-01T00:00:00Z');
    const end = new Date('2026-01-01T00:00:00Z');
    const trades = [
      trade(10, { entry: '2025-01-10T00:00:00Z', exit: '2025-02-01T00:00:00Z' }),
      trade(-5, { entry: '2025-03-30T00:00:00Z', exit: '2025-04-05T00:00:00Z' }),
      trade(5, { entry: '2025-04-10T00:00:00Z', exit: '2025-04-20T00:00:00Z' }),
      trade(-20, { entry: '2025-12-20T00:00:00Z', exit: '2026-01-01T00:00:00Z' }),
    ];
    const q = computeWindowQuarters(trades, start, end);
    expect(q.map((x) => x.n)).toEqual([1, 2, 0, 1]);
    expect(q[0].profitFactor).toBe(Infinity);
    expect(q[1].profitFactor).toBeCloseTo(1, 9);
    expect(q[2].profitFactor).toBeNull();
    expect(q[3].netProfit).toBe(-20);
  });
});

describe('E4 §4 — Monte Carlo bootstrap', () => {
  const trades = [
    trade(30, { exit: '2025-01-05T00:00:00Z' }), trade(-10, { exit: '2025-01-20T00:00:00Z' }),
    trade(20, { exit: '2025-02-03T00:00:00Z' }), trade(-10, { exit: '2025-02-15T00:00:00Z' }), trade(-10, { exit: '2025-02-27T00:00:00Z' }),
    trade(15, { exit: '2025-03-09T00:00:00Z' }),
    trade(-10, { exit: '2025-05-01T00:00:00Z' }), trade(40, { exit: '2025-05-21T00:00:00Z' }),
  ];

  it('is deterministic for a seed; month-block units = distinct exit months; P(PF ≥ 1.20) screen reported', () => {
    const a = runMonteCarlo(trades, { runs: 500, block: 'month', seed: 42, initialCapital: 1000 })!;
    const b = runMonteCarlo(trades, { runs: 500, block: 'month', seed: 42, initialCapital: 1000 })!;
    const c = runMonteCarlo(trades, { runs: 500, block: 'month', seed: 7, initialCapital: 1000 })!;
    expect(a).toEqual(b);
    expect(a.net).not.toEqual(c.net);
    expect(a.blocks).toBe(4);
    expect(a.probPfGteScreen).toBeGreaterThanOrEqual(0);
    expect(a.probPfGteScreen).toBeLessThanOrEqual(1);
    expect(a.net.p05).toBeLessThanOrEqual(a.net.p50);
    expect(a.net.p50).toBeLessThanOrEqual(a.net.p95);
  });

  it('all-positive trades ⇒ P(net ≤ 0) = 0, P(PF ≥ 1.20) = 1, zero drawdown; none/no trades ⇒ null', () => {
    const w = runMonteCarlo([trade(5), trade(7), trade(9)], { runs: 100, block: 'trade', seed: 3, initialCapital: 1000 })!;
    expect(w.blocks).toBe(3);
    expect(w.probNetLeqZero).toBe(0);
    expect(w.probPfGteScreen).toBe(1);
    expect(w.maxDrawdownPct.max).toBe(0);
    expect(runMonteCarlo(trades, { runs: 100, block: 'none', seed: 1, initialCapital: 1000 })).toBeNull();
    expect(runMonteCarlo([], { runs: 100, block: 'trade', seed: 1, initialCapital: 1000 })).toBeNull();
    const r1 = mulberry32(20260910);
    const r2 = mulberry32(20260910);
    for (let i = 0; i < 200; i++) {
      const x = r1();
      expect(x).toBe(r2());
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });
});

describe('E4 §5 — derived label', () => {
  it('SYNTHETIC ⇒ VOID; < 365d ⇒ SMOKE ONLY; FULL needs a run card to be GRADED (never a desk GO)', () => {
    expect(deriveLabel('SYNTHETIC', 800, 'X')).toMatchObject({ label: 'VOID', graded: false });
    const smoke = deriveLabel('REAL', 31, 'X');
    expect(smoke).toMatchObject({ label: 'SMOKE', graded: false });
    expect(smoke.line.startsWith('SMOKE ONLY — NOT screen, NOT holdout, NOT Beta hard-preflight')).toBe(true);
    const held = deriveLabel('REAL', 365, undefined);
    expect(held).toMatchObject({ label: 'FULL', graded: false });
    expect(held.line).toMatch(/UNGRADED \(burn hold/);
    expect(deriveLabel('REAL', 365, '  ').graded).toBe(false);
    const graded = deriveLabel('REAL', 365, 'AA-1');
    expect(graded).toMatchObject({ label: 'FULL', graded: true });
    expect(graded.line).toContain('GRADED under run card AA-1 (Eng screen; NOT a desk GO)');
  });
});

describe('E4 §6 — verdict logic (Beta bars)', () => {
  function stats(n: number, pf: number | null, opts: Partial<ExpectancyStats> = {}): ExpectancyStats {
    return {
      n, wins: 0, losses: 0, winRate: 0, grossProfit: 0, grossLoss: 0, netProfit: 0, profitFactor: pf,
      meanPnl: 0, stdPnl: 0, tStatPnl: null, meanR: 0, stdR: 0, tStatR: 1.5, payoffRatio: null, averageWin: 0, averageLoss: 0,
      totalFees: 0, feesPerTrade: 0, feesPctOfGrossProfit: null, longEntries: n, shortEntries: 0, exitReasons: {}, bySymbol: {}, byStrategy: {},
      ...opts,
    };
  }
  function preflight(n: number, days = 365): E4Preflight {
    const eN = (n * 365.25) / days;
    return { pooledN: n, perSymbolN: { 'BTC-USD': Math.floor(n / 3), 'ETH-USD': Math.floor(n / 3), 'SOL-USD': n - 2 * Math.floor(n / 3) }, windowDays: days, expectedTrades12m: eN, gateMin: 100, passed: eN >= 100, rawN: n + 10, rawExpectedTrades12m: ((n + 10) * 365.25) / days };
  }
  const goodQuarters = [1, 2, 3, 4].map((i) => ({ index: i, start: '', end: '', n: 30, netProfit: 10, profitFactor: 1.3 }));
  function input(overrides: Partial<VerdictInput> = {}): VerdictInput {
    return {
      label: 'FULL', graded: true, policy: E4_TF_POLICY['4h'], windowRole: 'eval', stamp: 'REAL', goFeeBook: true,
      preflight: preflight(120),
      zeroFee: { n: 130, profitFactor: 2.0, threshold: 1.61, minTrades: 10 },
      fee: { stats: stats(120, 1.35), maxDrawdownPct: 0.08, quarters: goodQuarters, quartersEvaluable: true, shortEntries: 0 },
      mc: null,
      ...overrides,
    };
  }

  it('BETA BARS PASS only on the graded eval window at the GO fee book with every hard bar met — and it is not a desk GO', () => {
    const v = evaluateVerdict(input());
    expect(v.verdict).toBe('BETA BARS PASS');
    expect(v.gates.filter((g) => g.hard).every((g) => g.status === 'pass')).toBe(true);
    expect(v.reasons.join(' ')).toMatch(/NOT a desk GO/);
  });

  it('SMOKE / UNGRADED / TUNE are never graded to bars', () => {
    expect(evaluateVerdict(input({ label: 'SMOKE', graded: false })).verdict).toBe('SMOKE ONLY');
    const held = evaluateVerdict(input({ graded: false, fee: { ...input().fee, stats: stats(120, 0.9) } }));
    expect(held.verdict).toBe('UNGRADED');
    expect(held.reasons.some((r) => r.startsWith('(context) bar would fail: Fee-book PF'))).toBe(true);
    const tune = evaluateVerdict(input({ windowRole: 'tune' }));
    expect(tune.verdict).toBe('TUNE DIAGNOSTIC');
    expect(tune.gates.find((g) => g.id === 'window_eval')?.status).toBe('n/a');
    expect(evaluateVerdict(input({ stamp: 'SYNTHETIC' })).verdict).toBe('VOID');
  });

  it('hard preflight: counted E[n] < 100 ⇒ RESEARCH SCREEN ONLY (4h) / EXPLORATORY (1d), before any other bar', () => {
    const thin4h = evaluateVerdict(input({ preflight: preflight(42), zeroFee: { n: 52, profitFactor: 0.94, threshold: 1.61, minTrades: 10 }, fee: { ...input().fee, stats: stats(42, 0.53) } }));
    expect(thin4h.verdict).toBe('RESEARCH SCREEN ONLY');
    expect(thin4h.reasons[0]).toMatch(/HARD PREFLIGHT: counted E\[n\] 42\.0 < 100 \(pooled n=42; BTC-USD 14, ETH-USD 14, SOL-USD 14\)/);
    expect(thin4h.reasons.some((r) => r.includes('STOP applied to MC/stress'))).toBe(true);
    const thin1d = evaluateVerdict(input({ policy: E4_TF_POLICY['1d'], preflight: preflight(6), zeroFee: { n: 6, profitFactor: 1.19, threshold: 1.44, minTrades: 10 } }));
    expect(thin1d.verdict).toBe('EXPLORATORY');
    // Even a perfect fee pass cannot pass bars with a thin count.
    expect(evaluateVerdict(input({ preflight: preflight(99) })).verdict).toBe('RESEARCH SCREEN ONLY');
    expect(evaluateVerdict(input({ preflight: preflight(100) })).verdict).toBe('BETA BARS PASS');
  });

  it('too few zero-fee trades ⇒ INCONCLUSIVE; zero-fee PF below the locked floor ⇒ STOP; exactly at the floor passes', () => {
    expect(evaluateVerdict(input({ zeroFee: { n: 5, profitFactor: 9, threshold: 1.61, minTrades: 10 } })).verdict).toBe('INCONCLUSIVE');
    const stop = evaluateVerdict(input({ zeroFee: { n: 130, profitFactor: 1.6, threshold: 1.61, minTrades: 10 } }));
    expect(stop.verdict).toBe('STOP');
    expect(stop.reasons[0]).toMatch(/STOP — holdout zero-fee PF 1\.60 < locked floor 1\.61/);
    expect(evaluateVerdict(input({ zeroFee: { n: 130, profitFactor: 1.61, threshold: 1.61, minTrades: 10 } })).verdict).toBe('BETA BARS PASS');
  });

  it('caps: custom window, non-GO fee book, 1H demoted ⇒ RESEARCH SCREEN ONLY even when every bar is met', () => {
    expect(evaluateVerdict(input({ windowRole: 'custom' })).verdict).toBe('RESEARCH SCREEN ONLY');
    const sens = evaluateVerdict(input({ goFeeBook: false }));
    expect(sens.verdict).toBe('RESEARCH SCREEN ONLY');
    expect(sens.reasons.join(' ')).toMatch(/never cherry-pick for GO/);
    const oneH = evaluateVerdict(input({ policy: E4_TF_POLICY['1h'], zeroFee: { n: 200, profitFactor: 2.5, threshold: 2.25, minTrades: 10 } }));
    expect(oneH.verdict).toBe('RESEARCH SCREEN ONLY');
    expect(oneH.reasons.join(' ')).toMatch(/demoted/);
  });

  it('Beta bar failures ⇒ BETA BARS FAIL (PF, maxDD, quarters, long-only); MC screen is INFO only', () => {
    expect(evaluateVerdict(input({ fee: { ...input().fee, stats: stats(120, 1.1) } })).verdict).toBe('BETA BARS FAIL');
    expect(evaluateVerdict(input({ fee: { ...input().fee, maxDrawdownPct: 0.2 } })).verdict).toBe('BETA BARS FAIL');
    const badQ = goodQuarters.map((q, i) => (i < 2 ? { ...q, profitFactor: 0.8 } : q));
    expect(evaluateVerdict(input({ fee: { ...input().fee, quarters: badQ } })).verdict).toBe('BETA BARS FAIL');
    expect(evaluateVerdict(input({ fee: { ...input().fee, shortEntries: 1 } })).verdict).toBe('BETA BARS FAIL');
    const mc = { block: 'month' as const, runs: 10, seed: 1, blocks: 12, net: { p05: 0, p50: 0, p95: 0, mean: 0 }, meanR: { p05: 0, p50: 0, p95: 0 }, profitFactor: { p05: 0, p50: 0, p95: 0 }, maxDrawdownPct: { p50: 0, p95: 0, max: 0 }, probNetLeqZero: 0.9, probPfGteScreen: 0.1 };
    const withMc = evaluateVerdict(input({ mc }));
    expect(withMc.verdict).toBe('BETA BARS PASS'); // MC is a screen, not a bar
    expect(withMc.gates.find((g) => g.id === 'mc_pf_screen')).toMatchObject({ status: 'info', hard: false, note: 'screen not met' });
  });
});

describe('E4 §7 — zero knobs + data path', () => {
  function prov(overrides: Partial<DataProvenance>): DataProvenance {
    return {
      symbol: 'BTC-USD', source: 'fixture', windowStart: '', windowEnd: '', granularitySeconds: 14_400,
      candleCount: 2188, expectedCount: 2191, coverage: 0.999, firstBarTime: null, lastBarTime: null,
      inferredBarMinutes: 240, loadTimeMs: 1, ...overrides,
    };
  }

  it('zero knobs pass on the committed guardrails; drift on A1 / atr min / EV threshold / cooldown is refused', () => {
    const feeTier = resolveE4FeeTier(undefined, guardrails);
    const ok = assertZeroKnobs(guardrails, [...E4_CARD.products], 'trend_follow', 1, feeTier);
    expect(ok).toMatchObject({ atrVolatilityMin: 0.005, minEvThreshold: 0, cooldownBars: 1, feeBookBpsPerSide: 40, goFeeBook: true });
    for (const p of E4_CARD.products) expect(ok.a1PerSymbol[p]).toEqual({ stopAtr: 2.5, takeProfitAtr: 6.0 });
    expect(assertZeroKnobs(guardrails, [...E4_CARD.products], 'trend_follow', 1, resolveE4FeeTier('intro1', guardrails)).goFeeBook).toBe(false);

    const drift = (mutate: (g: GuardrailConfig) => void) => {
      const g = JSON.parse(JSON.stringify(guardrails)) as GuardrailConfig;
      mutate(g);
      return () => assertZeroKnobs(g, [...E4_CARD.products], 'trend_follow', 1, feeTier);
    };
    expect(drift((g) => { (g.per_symbol!['ETH-USD'].strategy_overrides as any).trend_follow.takeProfitAtr = 5.0; })).toThrow(/E4_ZERO_KNOBS_DRIFT.*ETH-USD.*card A1 requires 2\.5\/6/);
    expect(drift((g) => { g.filters.atr_volatility_min = 0.004; })).toThrow(/atr_volatility_min=0\.004/);
    expect(drift((g) => { g.risk.min_ev_threshold = 1; })).toThrow(/min_ev_threshold=1/);
    expect(() => assertZeroKnobs(guardrails, [...E4_CARD.products], 'trend_follow', 0, feeTier)).toThrow(/cooldown must be ≥ 1 bar/);
    expect(() => assertZeroKnobs(guardrails, ['LTC-USD'], 'trend_follow', 1, feeTier)).toThrow(/LTC-USD trend_follow override is stopAtr=undefined/);
  });

  it('true-TF fixtures only: refuses 15m gate fixtures, rolled-up series, non-fixture sources, mismatched widths', () => {
    expect(() => assertFixtureTimeframe(prov({}), E4_TF_POLICY['4h'], 'x')).not.toThrow();
    expect(() => assertFixtureTimeframe(prov({ granularitySeconds: 900, inferredBarMinutes: 15 }), E4_TF_POLICY['4h'], 'fixtures/bars')).toThrow(/E4_FIXTURE_TF_MISMATCH.*declared=15m.*needs native 240m/);
    expect(() => assertFixtureTimeframe(prov({ aggregation: { targetMinutes: 240, sourceMinutes: 15, sourceCandleCount: 1, outputCandleCount: 1, subBarsPerBucket: 16, bucketsDropped: 0, partialBucketsKept: 0, minBucketFill: 0.5 } }), E4_TF_POLICY['4h'], 'x')).toThrow(/E4_FIXTURE_TF_MISMATCH/);
    expect(() => assertFixtureTimeframe(prov({ source: 'supabase' }), E4_TF_POLICY['4h'], 'x')).toThrow(/E4_FIXTURE_TF_MISMATCH/);
    expect(() => assertFixtureTimeframe(prov({}), E4_TF_POLICY['1d'], 'x')).toThrow(/needs native 1440m/);
    let thrown: unknown;
    try {
      assertFixtureTimeframe(prov({ granularitySeconds: 900, inferredBarMinutes: 15 }), E4_TF_POLICY['4h'], 'fixtures/bars');
    } catch (err) {
      thrown = err;
    }
    expect(isE4DataPathError(thrown)).toBe(true);
    expect((thrown as Error).message).toContain('backtest-gate only');
  });

  it('refuses perps products (spot long-only; INTX out)', () => {
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
      products: [...E4_CARD.products],
      strategy: 'trend_follow',
      initialCapital: 1000,
      feeTier: resolveE4FeeTier(undefined, guardrails),
      evGateMode: 'enforce',
      regimeGates: true,
      fixtureDir: FIXTURES_4H_SMOKE,
      cooldownBars: 1,
      mc: { runs: 200, block: 'month', seed: 20260910 },
      feeStress: false,
      smokeRunAllStages: false,
      ...overrides,
    };
  }

  it('4h Aug-2026 ⇒ SMOKE ONLY; preflight block first with pooled + per-symbol n at the fee book; STOP keeps MC/stress off', async () => {
    const resultsPath = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-e4-4h-'));
    const runner = new BacktestRunner({ resultsPath, fixtureDir: FIXTURES_4H_SMOKE }, makeLogger());
    const report = await runE4(request({ feeStress: true }), runner, guardrails, makeLogger());

    expect(report.version).toBe(3);
    expect(report.label).toBe('SMOKE');
    expect(report.verdict).toBe('SMOKE ONLY');
    expect(report.window.role).toBe('custom');
    expect(report.data.stamp).toBe('REAL');
    expect(report.zeroKnobs).toMatchObject({ atrVolatilityMin: 0.005, minEvThreshold: 0, cooldownBars: 1, feeBookBpsPerSide: 40, goFeeBook: true });
    expect(report.fee.fees.perVenue.spot).toEqual({ makerBps: 25, takerBps: 40 });
    expect(report.fee.metrics.evGate.mode).toBe('enforce');
    // Preflight: counted at the fee book (EV on); raw = zero-fee/EV-off upper bound; every product listed.
    expect(report.preflight.pooledN).toBe(report.fee.stats.n);
    expect(Object.keys(report.preflight.perSymbolN)).toEqual(['BTC-USD', 'ETH-USD', 'SOL-USD']);
    expect(Object.values(report.preflight.perSymbolN).reduce((a, b) => a + b, 0)).toBe(report.preflight.pooledN);
    expect(report.preflight.rawN).toBe(report.zeroFee.stats.n);
    expect(report.preflight.rawN).toBeGreaterThanOrEqual(report.preflight.pooledN);
    expect(report.preflight.passed).toBe(false);
    expect(report.zeroFee.stats.n).toBe(3);
    expect(report.zeroFee.stats.shortEntries).toBe(0);
    expect(report.zeroFee.metrics.activeStrategies).toEqual(['trend_follow']);
    expect(report.zeroFee.failFast).toBe('inconclusive');
    expect(report.monteCarlo).toBeNull();
    expect(report.stress).toEqual([]);
    expect(report.evalLedger).toBeNull();
    // Distinct per-pass artefacts.
    expect(report.fee.saved?.jsonPath).toMatch(/_e4-4h-custom-feebook\.json$/);
    expect(report.zeroFee.saved?.jsonPath).toMatch(/_e4-4h-custom-zero-fee\.json$/);

    const text = renderE4Report(report);
    const lines = text.split('\n');
    expect(lines[0].startsWith('SMOKE ONLY — NOT screen, NOT holdout, NOT Beta hard-preflight')).toBe(true);
    expect(lines[1]).toBe('DATA: REAL');
    const preflightIdx = lines.findIndex((l) => l.startsWith('Stage P — HARD PREFLIGHT'));
    const stage1Idx = lines.findIndex((l) => l.startsWith('Stage 1 — zero-fee'));
    expect(preflightIdx).toBeGreaterThan(0);
    expect(preflightIdx).toBeLessThan(stage1Idx);
    expect(text).toMatch(/E4_PREFLIGHT tf=4h window=custom data=REAL pooledN=\d+ BTC-USD=\d+ ETH-USD=\d+ SOL-USD=\d+ windowDays=31\.0 E_n_12m=/);
    expect(text).toContain('Zero knobs (verified)');
    expect(text).toContain('cooldown 1 bar = 240 min');
    expect(text).toContain('VERDICT: SMOKE ONLY');
    expect(text).toMatch(/E4_RESULT tf=4h window=custom label=SMOKE graded=false runCard=none verdict="SMOKE ONLY"/);
  });

  it('preflight below gate ⇒ GO packaging stopped: fee stress never runs even when the zero-fee floor is cleared (MC informational only)', async () => {
    // Drive the pure orchestration rule with a stubbed runner: preflight n=42 (< 100), zero-fee PF 2.0 (≥ 1.61).
    const feeTrades = new Array(42).fill(0).map((_, i) => trade(i % 3 === 0 ? 30 : -10, { product: E4_CARD.products[i % 3], entry: `2025-0${1 + (i % 9)}-05T00:00:00Z`, exit: `2025-0${1 + (i % 9)}-06T00:00:00Z` }));
    const zeroTrades = new Array(52).fill(0).map((_, i) => trade(i % 2 === 0 ? 30 : -10, { entry: `2025-0${1 + (i % 9)}-05T00:00:00Z`, exit: `2025-0${1 + (i % 9)}-06T00:00:00Z` }));
    const provenance = (symbol: string): DataProvenance => ({
      symbol, source: 'fixture', windowStart: E4_WALK_FORWARD.eval.start, windowEnd: E4_WALK_FORWARD.eval.end, granularitySeconds: 14_400,
      candleCount: 2188, expectedCount: 2191, coverage: 0.999, firstBarTime: null, lastBarTime: null, inferredBarMinutes: 240, loadTimeMs: 1,
    });
    const resultFor = (trades: BacktestTrade[], commission?: number) => ({
      trades, dataStamp: 'REAL' as const,
      dataProvenance: Object.fromEntries(E4_CARD.products.map((p) => [p, provenance(p)])),
      venueBySymbol: Object.fromEntries(E4_CARD.products.map((p) => [p, 'spot' as const])),
      fees: commission !== undefined ? { routing: 'flat-override' as const, flatRate: commission, perVenue: {}, exchange: 'coinbase' as const } : { routing: 'fee-model' as const, perVenue: { spot: { makerBps: 25, takerBps: 40 } }, exchange: 'coinbase' as const },
      metrics: {
        totalTrades: trades.length, profitFactor: 1, winRate: 0.4, netProfit: 0, totalFees: 0, maxDrawdownPercent: 0.05, returnPercent: 0,
        longEntries: trades.length, shortEntries: 0, shortBlocked: 0, sellSignalExits: 0, activeStrategies: ['trend_follow'],
        evGate: { mode: commission === undefined ? 'enforce' : 'off', evaluated: 0, allowed: 0, rejected: 0, shadowWouldReject: 0, defaultAllowed: 0, rejectedByStrategy: {} },
        atrFilterRejects: 0, exitsIgnoredMinHold: 0,
      },
    });
    const stubRunner = {
      createDataProvider: () => async (product: string) => ({ candles: [], provenance: provenance(product) }),
      runBacktestDetailed: vi.fn(async (config: any) => ({ result: resultFor(config.commission === 0 ? zeroTrades : feeTrades, config.commission), saved: null })),
    } as unknown as BacktestRunner;

    const report = await runE4(request({
      tf: '4h', startDate: new Date(E4_WALK_FORWARD.eval.start), endDate: new Date(E4_WALK_FORWARD.eval.end),
      fixtureDir: '/stub/holdout', runCard: CARD, feeStress: true, mc: { runs: 100, block: 'month', seed: 1 },
    }), stubRunner, guardrails, makeLogger());

    expect(report.preflight).toMatchObject({ pooledN: 42, passed: false, gateMin: 100 });
    expect(report.preflight.perSymbolN).toEqual({ 'BTC-USD': 14, 'ETH-USD': 14, 'SOL-USD': 14 });
    expect(report.zeroFee.stats.profitFactor).toBeGreaterThanOrEqual(1.61);
    expect(report.zeroFee.failFast).toBe('none');
    expect(report.monteCarlo).not.toBeNull(); // informational
    expect(report.stress).toEqual([]); // GO packaging stopped
    expect((stubRunner.runBacktestDetailed as any).mock.calls.length).toBe(2); // fee book + zero-fee only
    expect(report.verdict).toBe('RESEARCH SCREEN ONLY');
    const text = renderE4Report(report);
    expect(text).toContain('Stage 4 — Fee stress: NOT RUN (preflight E[n] below gate ⇒ GO packaging stopped)');
    expect(text).toContain('[INFORMATIONAL — preflight E[n] below gate; GO packaging stopped]');
    expect(text).toContain('[INFORMATIONAL — preflight E[n] below gate]');
  });

  it('--smoke-run-all-stages forces MC + the 25/75/120 stress passes on a SMOKE window (pipeline validation only)', async () => {
    const resultsPath = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-e4-4h-all-'));
    const runner = new BacktestRunner({ resultsPath, fixtureDir: FIXTURES_4H_SMOKE }, makeLogger());
    const spy = vi.spyOn(runner, 'createDataProvider');
    const report = await runE4(request({ smokeRunAllStages: true, feeStress: true }), runner, guardrails, makeLogger());
    expect(report.verdict).toBe('SMOKE ONLY');
    expect(report.stress.map((s) => s.bpsPerSide)).toEqual([25, 75, 120]);
    for (const s of report.stress) {
      expect(s.saved?.jsonPath).toMatch(new RegExp(`_e4-4h-custom-stress-${s.bpsPerSide}bps\\.json$`));
      expect(s.n).toBeLessThanOrEqual(report.zeroFee.stats.n);
    }
    // Higher fees ⇒ EV gate rejects at least as many entries.
    expect(report.stress[2].evRejected).toBeGreaterThanOrEqual(report.stress[0].evRejected);
    expect(spy).toHaveBeenCalledTimes(1); // one memoized provider for all 5 passes
    const text = renderE4Report(report);
    expect(text).toContain('Stage 4 — Fee stress (SEPARATE, informational; never cherry-pick for GO)');
    expect(text).toContain('← fee book (GO)');
  });

  it('refuses the 15m gate fixtures for --tf 4h before any engine work; refuses perps; refuses a missing fixture dir', async () => {
    const resultsPath = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-e4-15m-'));
    const runner = new BacktestRunner({ resultsPath, fixtureDir: FIXTURES_15M_GATE }, makeLogger());
    await expect(
      runE4(request({ fixtureDir: FIXTURES_15M_GATE, products: ['BTC-USD', 'ETH-USD'], startDate: new Date('2026-09-03T00:00:00Z'), endDate: new Date('2026-09-10T00:00:00Z') }), runner, guardrails, makeLogger()),
    ).rejects.toMatchObject({ code: 'E4_FIXTURE_TF_MISMATCH' });
    expect(fs.readdirSync(resultsPath).length).toBe(0);
    const smokeRunner = new BacktestRunner({ resultsPath: os.tmpdir(), fixtureDir: FIXTURES_4H_SMOKE }, makeLogger());
    await expect(runE4(request({ products: ['BTC-USD', 'BTC-PERP-INTX'] }), smokeRunner, guardrails, makeLogger())).rejects.toMatchObject({ code: 'E4_SPOT_ONLY' });
    await expect(runE4(request({ fixtureDir: '' }), smokeRunner, guardrails, makeLogger())).rejects.toMatchObject({ code: 'E4_FIXTURE_DIR_REQUIRED' });
    await expect(runE4(request({ cooldownBars: 0 }), smokeRunner, guardrails, makeLogger())).rejects.toMatchObject({ code: 'E4_ZERO_KNOBS_DRIFT' });
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
      expect(saved!.jsonPath).toMatch(/_same-tag-(-\d+)?\.json$/);
    }
    expect(paths.size).toBe(3);
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

  it('1d eval window ⇒ FULL: UNGRADED without a card; graded with one (EXPLORATORY when E[n] < 100); eval ledger records graded runs', async () => {
    const ledger = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-e4-ledger-')), 'E4_EVAL_LEDGER.jsonl');
    const base = request({
      tf: '1d',
      startDate: new Date(E4_WALK_FORWARD.eval.start),
      endDate: new Date(E4_WALK_FORWARD.eval.end),
      fixtureDir: FIXTURES_1D,
      mc: { runs: 300, block: 'trade', seed: 20260910 },
      evalLedgerPath: ledger,
    });
    const mk = () => new BacktestRunner({ resultsPath: fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-e4-1d-')), fixtureDir: FIXTURES_1D }, makeLogger());

    const held = await runE4(base, mk(), guardrails, makeLogger());
    expect(held.window.role).toBe('eval');
    expect(held.label).toBe('FULL');
    expect(held.graded).toBe(false);
    expect(held.verdict).toBe('UNGRADED');
    expect(held.request.windowDays).toBe(365);
    expect(held.thresholds.zeroFeePfFloor).toBe(1.44);
    for (const p of Object.values(held.data.provenance)) {
      expect(p.granularitySeconds).toBe(86_400);
      expect(p.candleCount).toBe(366);
    }
    expect(held.evalLedger).toEqual({ path: ledger, priorGradedEvalRuns: 0, appended: false });
    expect(fs.existsSync(ledger)).toBe(false);
    expect(renderE4Report(held).split('\n')[0]).toMatch(/^FULL WINDOW — DATA: REAL, 365\.0d ≥ 365d — UNGRADED/);

    const graded = await runE4({ ...base, runCard: CARD }, mk(), guardrails, makeLogger());
    expect(graded.graded).toBe(true);
    expect(graded.runCard).toBe(CARD);
    expect(['BETA BARS PASS', 'BETA BARS FAIL', 'RESEARCH SCREEN ONLY', 'EXPLORATORY', 'INCONCLUSIVE', 'STOP']).toContain(graded.verdict);
    expect(graded.preflight.pooledN).toBe(held.preflight.pooledN); // same data, same stats — only grading differs
    if (!graded.preflight.passed) expect(graded.verdict).toBe('EXPLORATORY'); // 1D thin-count wording
    expect(graded.evalLedger).toEqual({ path: ledger, priorGradedEvalRuns: 0, appended: true });
    const rows = fs.readFileSync(ledger, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tf: '1d', window: 'eval', graded: true, runCard: CARD, verdict: graded.verdict, pooledN: graded.preflight.pooledN });

    const again = await runE4({ ...base, runCard: CARD }, mk(), guardrails, makeLogger());
    expect(again.evalLedger?.priorGradedEvalRuns).toBe(1);
    expect(again.reasons[0]).toMatch(/WARNING: eval window already graded 1 time\(s\)/);
    expect(renderE4Report(again)).toContain('walk-forward rule: EVAL ONCE');
  }, 60_000);
});
