/**
 * E4 multi-timeframe FeeModel expectancy harness — Algo Creator Beta card
 * (2026-09-10), TM-corrected order. Eng preflight + 4H screen path only;
 * nothing here is a desk GO (TM decides).
 *
 * Desk order: 1) FeeModel 4H first (this card) · 2) 1D only if counted
 * E[n] ≥ 100 else EXPLORATORY · 3) 1H demoted, do not lead · 4) 15m out.
 *
 * 4H experiment (ZERO KNOBS — asserted, not configurable):
 *   BTC-USD / ETH-USD / SOL-USD spot · long-only · trend_follow A1
 *   stopAtr 2.5 / takeProfitAtr 6.0 · true 4H bars (fixture width asserted)
 *   · cooldown = 1 × 4H bar (bar clock; live trade_cooldown_min analog)
 *   · atr_volatility_min 0.005 · EV gate on, min_ev_threshold 0
 *   · GO fee book = FeeModel 40 bps/side (80 RT); stress 25/75/120 separate,
 *   never cherry-picked · no synthetic (any ⇒ VOID) · INTX/perps out.
 *
 * Walk-forward LOCKED: tune 2023-03-01 → 2025-03-01 (diagnostics only),
 * eval 2025-03-01 → 2026-03-01 (run once; GO bars here only).
 *
 * Pipeline per run:
 *   P. HARD PREFLIGHT — counted pooled long-only E[n] + per-symbol n on the
 *      fee book (40 bps, EV on). E[n] < 100 ⇒ RESEARCH SCREEN ONLY (4H) /
 *      EXPLORATORY (1D): no GO packaging, MC informational.
 *   1. Zero-fee fail-fast — PF < LOCKED floor (4H 1.61 · 1D 1.44 · 1H 2.25)
 *      ⇒ STOP: no fee-sensitivity, no GO MC.
 *   2. FeeModel 40 expectancy (already computed in P) + Beta bars.
 *   3. Month-block bootstrap (4H default): P(PF ≥ 1.20) ≥ 0.60 is a SCREEN,
 *      not GO.
 *   4. Fee stress 25 / 75 / 120 bps per side — separate, informational.
 *
 * Labels are DERIVED, never operator-asserted: SYNTHETIC ⇒ VOID; < 365 d ⇒
 * SMOKE ONLY; FULL without --run-card ⇒ UNGRADED (burn hold); tune window ⇒
 * TUNE DIAGNOSTIC; only the locked eval window can reach BETA BARS PASS.
 *
 * The cited pre-registration docs (quant-prereg-atr-fee-floors.md,
 * e4-timeframe-brief.md) are not in the repo; every threshold is encoded
 * here (frozen constants) and in docs/research/2026-09-10_e4-multi-tf-feemodel-harness.md.
 * No new dependencies. Arithmetic is on realized backtest P&L; nothing
 * flows to execution.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Logger } from '../core/logger';
import type { GuardrailConfig } from '../config/loadGuardrails';
import { venueForSymbol, type MarketVenue } from '../trading/execution/venue-capabilities';
import type { BacktestConfig, BacktestResult, BacktestTrade, EvGateMode } from './backtest-engine';
import type { BacktestDataOptions, BacktestRunner, FeeTierLabel, SavedBacktestPaths } from './backtest-runner';
import type { DataProvenance } from './data-loader';
import type { SeriesProvider } from './bar-aggregation';
import { buildBacktestConfig, buildFeeModel, resolveFeeTier, type StrategySelector } from './backtest-cli-config';

// ---------------------------------------------------------------------------
// Locked thresholds, card, walk-forward windows, timeframe policy
// ---------------------------------------------------------------------------

export type E4Timeframe = '4h' | '1d' | '1h';
export type McBlockMode = 'month' | 'trade' | 'none';
export type WindowRole = 'eval' | 'tune' | 'custom';

/** LOCKED. Zero-fee PF floors (PF needed for PF 1.2 at 40 bps, audit §4.1). Below ⇒ STOP. */
export const E4_ZERO_FEE_PF_FLOOR: Readonly<Record<E4Timeframe, number>> = Object.freeze({
  '4h': 1.61,
  '1d': 1.44,
  '1h': 2.25,
});

/** Hard preflight: counted 12-month E[n] must reach this or the run is screen-only. */
export const E4_MIN_EXPECTED_TRADES: Readonly<Record<E4Timeframe, number>> = Object.freeze({
  '4h': 100,
  '1d': 100,
  '1h': 100,
});

/** Below this zero-fee trade count a PF is noise: INCONCLUSIVE, STOP. */
export const E4_MIN_ZERO_FEE_TRADES = 10;

/** Windows shorter than this are SMOKE ONLY (the eval window is exactly 12 months). */
export const E4_FULL_WINDOW_MIN_DAYS = 365;

/** Beta bars evaluated on the fee-book pass (TASK_018 gates). */
export const E4_BETA_BARS = Object.freeze({
  feePassPfMin: 1.2,
  maxDrawdownMax: 0.15,
  quartersMin: 3,
  quartersTotal: 4,
});

/** Month-block bootstrap screen (NOT a GO bar). */
export const E4_MC_SCREEN = Object.freeze({ pfMin: 1.2, probMin: 0.6 });

/** The Algo Creator Beta card — every value asserted at run time (zero knobs). */
export const E4_CARD = Object.freeze({
  id: 'AlgoCreator-Beta-CLEAR-2026-09-10',
  products: Object.freeze(['BTC-USD', 'ETH-USD', 'SOL-USD']),
  strategy: 'trend_follow' as const,
  a1: Object.freeze({ stopAtr: 2.5, takeProfitAtr: 6.0 }),
  atrVolatilityMin: 0.005,
  minEvThreshold: 0,
  cooldownBars: 1,
  goFeeBpsPerSide: 40,
  stressBpsPerSide: Object.freeze([25, 75, 120]),
});

/** Walk-forward windows, LOCKED. */
export const E4_WALK_FORWARD = Object.freeze({
  tune: Object.freeze({ role: 'tune' as const, start: '2023-03-01T00:00:00.000Z', end: '2025-03-01T00:00:00.000Z', note: 'diagnostics only; zero knobs; never GO bars' }),
  eval: Object.freeze({ role: 'eval' as const, start: '2025-03-01T00:00:00.000Z', end: '2026-03-01T00:00:00.000Z', note: 'run ONCE; GO bars here only' }),
});

/** Default per-TF fixture directories (Dev Backtest #47/#49), relative to atlas/apps/core-node. */
export const E4_DEFAULT_FIXTURE_DIR: Readonly<Record<E4Timeframe, Partial<Record<'eval' | 'tune', string>>>> = Object.freeze({
  '4h': Object.freeze({ eval: 'fixtures/bars/4h/holdout-2025-03_2026-03', tune: 'fixtures/bars/4h/tune-2023-03_2025-03' }),
  '1d': Object.freeze({ eval: 'fixtures/bars/1d', tune: 'fixtures/bars/1d' }),
  '1h': Object.freeze({}),
});

/** Which locked window (if any) a date pair is. */
export function classifyWindow(start: Date, end: Date): WindowRole {
  for (const w of [E4_WALK_FORWARD.eval, E4_WALK_FORWARD.tune]) {
    if (start.getTime() === Date.parse(w.start) && end.getTime() === Date.parse(w.end)) return w.role;
  }
  return 'custom';
}

export interface E4TimeframePolicy {
  tf: E4Timeframe;
  barMinutes: 60 | 240 | 1440;
  order: number;
  status: 'primary' | 'secondary' | 'demoted';
  zeroFeePfMin: number;
  minExpectedTrades: number;
  /** Verdict when the hard preflight E[n] is below the minimum. */
  thinCountVerdict: 'RESEARCH SCREEN ONLY' | 'EXPLORATORY';
  defaultMcBlock: McBlockMode;
  /** Whether this TF can ever reach BETA BARS PASS from this harness. */
  goEligible: boolean;
  fixtureHint: string;
  note: string;
}

export const E4_TF_POLICY: Record<E4Timeframe, E4TimeframePolicy> = {
  '4h': {
    tf: '4h', barMinutes: 240, order: 1, status: 'primary', zeroFeePfMin: E4_ZERO_FEE_PF_FLOOR['4h'],
    minExpectedTrades: E4_MIN_EXPECTED_TRADES['4h'], thinCountVerdict: 'RESEARCH SCREEN ONLY', defaultMcBlock: 'month', goEligible: true,
    fixtureHint: 'fixtures/bars/4h/holdout-2025-03_2026-03 (eval, GO bars) · fixtures/bars/4h/tune-2023-03_2025-03 (tune) · fixtures/bars/4h/smoke-aug2026 (SMOKE ONLY)',
    note: 'FeeModel 4H first (this card). Hard preflight E[n] ≥ 100 else RESEARCH SCREEN ONLY. Zero-fee floor 1.61 ⇒ STOP. GO fee book 40 bps/side. Month-block MC screen.',
  },
  '1d': {
    tf: '1d', barMinutes: 1440, order: 2, status: 'secondary', zeroFeePfMin: E4_ZERO_FEE_PF_FLOOR['1d'],
    minExpectedTrades: E4_MIN_EXPECTED_TRADES['1d'], thinCountVerdict: 'EXPLORATORY', defaultMcBlock: 'trade', goEligible: true,
    fixtureHint: 'fixtures/bars/1d (native ONE_DAY, 2024-09-01 → 2026-08-31; eval window sliced from it)',
    note: '1D only if counted E[n] ≥ 100 else EXPLORATORY. Zero-fee floor 1.44 ⇒ STOP. Trade-level MC default.',
  },
  '1h': {
    tf: '1h', barMinutes: 60, order: 3, status: 'demoted', zeroFeePfMin: E4_ZERO_FEE_PF_FLOOR['1h'],
    minExpectedTrades: E4_MIN_EXPECTED_TRADES['1h'], thinCountVerdict: 'RESEARCH SCREEN ONLY', defaultMcBlock: 'month', goEligible: false,
    fixtureHint: 'a per-TF native ONE_HOUR fixture directory — none committed',
    note: '1H DEMOTED — do not lead. Zero-fee floor 2.25 ⇒ STOP. Never GO-eligible until the multi-ATR/maker path is proven (E5/E6).',
  },
};

/** Parse `--tf`. Accepts 4h|1d|1h (case-insensitive) or 240|1440|60. 15m is out. */
export function parseTimeframe(raw: string | number): E4Timeframe {
  const s = String(raw).trim().toLowerCase();
  if (s === '4h' || s === '240' || s === '240m') return '4h';
  if (s === '1d' || s === '1440' || s === '1440m' || s === '24h') return '1d';
  if (s === '1h' || s === '60' || s === '60m') return '1h';
  if (s === '15m' || s === '15') {
    throw new Error('15m is NOT an E4 timeframe: FeeModel 15m spot trend_follow is NO-GO per desk (15m out). Use --tf 4h | 1d | 1h.');
  }
  throw new Error(`Unknown --tf "${raw}". Use 4h | 1d | 1h (or 240 | 1440 | 60).`);
}

/** Thrown before any engine work when the run is not the experiment the card describes. */
export class E4DataPathError extends Error {
  public readonly code: 'E4_FIXTURE_TF_MISMATCH' | 'E4_SPOT_ONLY' | 'E4_FIXTURE_DIR_REQUIRED' | 'E4_ZERO_KNOBS_DRIFT';
  constructor(code: E4DataPathError['code'], message: string) {
    super(`${code}: ${message}`);
    this.name = 'E4DataPathError';
    this.code = code;
  }
}

export function isE4DataPathError(err: unknown): err is E4DataPathError {
  return Boolean(err) && typeof err === 'object' && String((err as { code?: string }).code ?? '').startsWith('E4_');
}

// ---------------------------------------------------------------------------
// Request / report types
// ---------------------------------------------------------------------------

export interface E4Request {
  tf: E4Timeframe;
  startDate: Date;
  endDate: Date;
  products: string[];
  strategy: StrategySelector | string;
  initialCapital: number;
  /** Fee pass tier. GO fee book = guardrails spot bucket (40 bps taker). Anything else is a sensitivity run. */
  feeTier: FeeTierLabel;
  /** EV-gate mode for the fee-book pass (the zero-fee pass always runs `off`). Card: enforce. */
  evGateMode: EvGateMode;
  regimeGates: boolean;
  /** Per-TF fixture directory (absolute or relative to core-node). Required. */
  fixtureDir: string;
  minCoverage?: number;
  /** Min hold in bars before an opposite-signal exit (card: 1). */
  cooldownBars: number;
  mc: { runs: number; block: McBlockMode; seed: number };
  /** Run separate 25/75/120 bps-per-side stress passes (informational). */
  feeStress: boolean;
  /** Algo Alpha / Algo Creator run card id. Required for a FULL window to be graded. */
  runCard?: string;
  /** JSONL ledger of graded eval-window runs (anti-overfitting: eval once). */
  evalLedgerPath?: string;
  /** SMOKE ONLY runs: keep going past a STOP so every stage is exercised. */
  smokeRunAllStages: boolean;
}

export type E4Label = 'SMOKE' | 'FULL' | 'VOID';
export type E4Verdict =
  | 'VOID'
  | 'SMOKE ONLY'
  | 'UNGRADED'
  | 'TUNE DIAGNOSTIC'
  | 'RESEARCH SCREEN ONLY'
  | 'EXPLORATORY'
  | 'INCONCLUSIVE'
  | 'STOP'
  | 'BETA BARS FAIL'
  | 'BETA BARS PASS';

export interface QuarterStat {
  index: number;
  start: string;
  end: string;
  n: number;
  netProfit: number;
  profitFactor: number | null;
}

export interface ExpectancyStats {
  n: number;
  wins: number;
  losses: number;
  winRate: number;
  grossProfit: number;
  grossLoss: number;
  netProfit: number;
  /** Infinity when losses are 0 and wins > 0; null when n = 0. */
  profitFactor: number | null;
  meanPnl: number;
  stdPnl: number;
  tStatPnl: number | null;
  meanR: number;
  stdR: number;
  tStatR: number | null;
  payoffRatio: number | null;
  averageWin: number;
  averageLoss: number;
  totalFees: number;
  feesPerTrade: number;
  feesPctOfGrossProfit: number | null;
  longEntries: number;
  shortEntries: number;
  exitReasons: Record<string, number>;
  bySymbol: Record<string, { n: number; netProfit: number; profitFactor: number | null; meanR: number }>;
  byStrategy: Record<string, { n: number; netProfit: number; profitFactor: number | null; meanR: number }>;
}

export interface TradeFrequency {
  n: number;
  windowDays: number;
  tradesPerMonth: number;
  /** n × 365.25 / windowDays — the counted E[n] the preflight reads. */
  expectedTrades12m: number;
  firstTradeAt: string | null;
  lastTradeAt: string | null;
}

export interface MonteCarloSummary {
  block: McBlockMode;
  runs: number;
  seed: number;
  blocks: number;
  net: { p05: number; p50: number; p95: number; mean: number };
  meanR: { p05: number; p50: number; p95: number };
  profitFactor: { p05: number; p50: number; p95: number };
  maxDrawdownPct: { p50: number; p95: number; max: number };
  probNetLeqZero: number;
  /** Share of replicates with PF ≥ E4_MC_SCREEN.pfMin (screen, not GO). */
  probPfGteScreen: number;
}

export interface E4Gate {
  id: string;
  label: string;
  value: string;
  threshold: string;
  status: 'pass' | 'fail' | 'n/a' | 'info';
  hard: boolean;
  note?: string;
}

export interface E4PassSummary {
  metrics: Pick<BacktestResult['metrics'], 'totalTrades' | 'profitFactor' | 'winRate' | 'netProfit' | 'totalFees' | 'maxDrawdownPercent' | 'returnPercent' | 'longEntries' | 'shortEntries' | 'shortBlocked' | 'sellSignalExits' | 'evGate' | 'activeStrategies' | 'atrFilterRejects' | 'exitsIgnoredMinHold'>;
  stats: ExpectancyStats;
  fees: BacktestResult['fees'];
  saved: SavedBacktestPaths | null;
  trades: Array<{ product: string; strategy: string; side: string; entry: string; exit: string | null; pnl: number; r: number; exitReason: string }>;
}

export interface E4Preflight {
  pooledN: number;
  perSymbolN: Record<string, number>;
  windowDays: number;
  expectedTrades12m: number;
  gateMin: number;
  passed: boolean;
  /** Zero-fee / EV-off count — an upper bound on the fee-book count. */
  rawN: number;
  rawExpectedTrades12m: number;
}

export interface E4StressPass {
  bpsPerSide: number;
  n: number;
  profitFactor: number | null;
  netProfit: number;
  meanR: number;
  maxDrawdownPct: number;
  evRejected: number;
  saved: SavedBacktestPaths | null;
}

export interface E4ZeroKnobs {
  a1PerSymbol: Record<string, { stopAtr: unknown; takeProfitAtr: unknown }>;
  atrVolatilityMin: number;
  minEvThreshold: number;
  cooldownBars: number;
  feeBookBpsPerSide: number;
  goFeeBook: boolean;
}

export interface E4Report {
  harness: 'e4-multi-tf-feemodel';
  version: 3;
  generatedAt: string;
  card: typeof E4_CARD;
  label: E4Label;
  graded: boolean;
  runCard: string | null;
  labelLine: string;
  window: { role: WindowRole; start: string; end: string; days: number; note: string };
  verdict: E4Verdict;
  reasons: string[];
  tf: E4Timeframe;
  barMinutes: number;
  policy: E4TimeframePolicy;
  thresholds: {
    zeroFeePfFloor: number;
    minZeroFeeTrades: number;
    minExpectedTrades: number;
    fullWindowMinDays: number;
    feePassPfMin: number;
    maxDrawdownMax: number;
    quartersMin: string;
    mcScreen: { pfMin: number; probMin: number };
  };
  zeroKnobs: E4ZeroKnobs;
  request: {
    startDate: string; endDate: string; windowDays: number; products: string[]; strategy: string;
    initialCapital: number; feeTier: FeeTierLabel; evGateMode: EvGateMode; regimeGates: boolean;
    fixtureDir: string; minCoverage: number; cooldownBars: number; mc: E4Request['mc']; feeStress: boolean; smokeRunAllStages: boolean;
  };
  data: { stamp: 'REAL' | 'SYNTHETIC'; provenance: Record<string, DataProvenance>; venueBySymbol: Record<string, MarketVenue> };
  preflight: E4Preflight;
  zeroFee: E4PassSummary & { threshold: number; passed: boolean | null; failFast: 'none' | 'inconclusive' | 'pf'; frequency: TradeFrequency };
  fee: E4PassSummary & { frequency: TradeFrequency; quarters: QuarterStat[]; quartersPassing: number; quartersEvaluable: boolean };
  monteCarlo: MonteCarloSummary | null;
  stress: E4StressPass[];
  evalLedger: { path: string; priorGradedEvalRuns: number; appended: boolean } | null;
  gates: E4Gate[];
}

// ---------------------------------------------------------------------------
// Statistics (pure)
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;

/** R multiple of a closed trade: pnl / (|entry − stop| × size). 0 when the stop distance is degenerate. */
export function tradeR(trade: Pick<BacktestTrade, 'pnl' | 'entryPrice' | 'stopLoss' | 'size'>): number {
  const riskUsd = Math.abs(trade.entryPrice - trade.stopLoss) * trade.size;
  return riskUsd > 0 ? (trade.pnl ?? 0) / riskUsd : 0;
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

function sampleStd(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
}

function tStat(xs: number[]): number | null {
  if (xs.length < 2) return null;
  const sd = sampleStd(xs);
  if (sd === 0) return null;
  return mean(xs) / (sd / Math.sqrt(xs.length));
}

/** PF from gross figures: Infinity when no losses but wins; null when nothing. */
export function profitFactorOf(grossProfit: number, grossLoss: number): number | null {
  if (grossLoss > 0) return grossProfit / grossLoss;
  if (grossProfit > 0) return Infinity;
  return null;
}

function groupStats(trades: BacktestTrade[]): { n: number; netProfit: number; profitFactor: number | null; meanR: number } {
  const pnls = trades.map((t) => t.pnl ?? 0);
  const gp = pnls.filter((p) => p > 0).reduce((a, b) => a + b, 0);
  const gl = Math.abs(pnls.filter((p) => p <= 0).reduce((a, b) => a + b, 0));
  return { n: trades.length, netProfit: gp - gl, profitFactor: profitFactorOf(gp, gl), meanR: mean(trades.map(tradeR)) };
}

/** Expectancy statistics for a closed-trade set (win = pnl > 0, matching the engine). */
export function computeExpectancy(trades: BacktestTrade[]): ExpectancyStats {
  const pnls = trades.map((t) => t.pnl ?? 0);
  const rs = trades.map(tradeR);
  const winsArr = pnls.filter((p) => p > 0);
  const lossArr = pnls.filter((p) => p <= 0);
  const grossProfit = winsArr.reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(lossArr.reduce((a, b) => a + b, 0));
  const totalFees = trades.reduce((s, t) => s + t.entryFee + (t.exitFee ?? 0), 0);
  const averageWin = winsArr.length ? grossProfit / winsArr.length : 0;
  const averageLoss = lossArr.length ? grossLoss / lossArr.length : 0;

  const bySymbol: ExpectancyStats['bySymbol'] = {};
  const byStrategy: ExpectancyStats['byStrategy'] = {};
  const exitReasons: Record<string, number> = {};
  for (const product of new Set(trades.map((t) => t.product))) {
    bySymbol[product] = groupStats(trades.filter((t) => t.product === product));
  }
  for (const strategy of new Set(trades.map((t) => t.strategy))) {
    byStrategy[strategy] = groupStats(trades.filter((t) => t.strategy === strategy));
  }
  for (const t of trades) {
    const reason = t.exitReason ?? 'open';
    exitReasons[reason] = (exitReasons[reason] ?? 0) + 1;
  }

  return {
    n: trades.length,
    wins: winsArr.length,
    losses: lossArr.length,
    winRate: trades.length ? winsArr.length / trades.length : 0,
    grossProfit,
    grossLoss,
    netProfit: grossProfit - grossLoss,
    profitFactor: profitFactorOf(grossProfit, grossLoss),
    meanPnl: mean(pnls),
    stdPnl: sampleStd(pnls),
    tStatPnl: tStat(pnls),
    meanR: mean(rs),
    stdR: sampleStd(rs),
    tStatR: tStat(rs),
    payoffRatio: averageLoss > 0 && winsArr.length > 0 ? averageWin / averageLoss : null,
    averageWin,
    averageLoss,
    totalFees,
    feesPerTrade: trades.length ? totalFees / trades.length : 0,
    feesPctOfGrossProfit: grossProfit > 0 ? totalFees / grossProfit : null,
    longEntries: trades.filter((t) => t.side === 'BUY').length,
    shortEntries: trades.filter((t) => t.side === 'SELL').length,
    exitReasons,
    bySymbol,
    byStrategy,
  };
}

/** E[n]: annualize the observed trade count over the run window. */
export function computeTradeFrequency(trades: BacktestTrade[], startDate: Date, endDate: Date): TradeFrequency {
  const windowDays = Math.max(0, (endDate.getTime() - startDate.getTime()) / DAY_MS);
  const n = trades.length;
  const sorted = [...trades].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  return {
    n,
    windowDays,
    tradesPerMonth: windowDays > 0 ? (n / windowDays) * (365.25 / 12) : 0,
    expectedTrades12m: windowDays > 0 ? (n * 365.25) / windowDays : 0,
    firstTradeAt: sorted.length ? sorted[0].timestamp.toISOString() : null,
    lastTradeAt: sorted.length ? sorted[sorted.length - 1].timestamp.toISOString() : null,
  };
}

/** 4 equal window segments scored by trades that EXITED inside them. */
export function computeWindowQuarters(trades: BacktestTrade[], startDate: Date, endDate: Date): QuarterStat[] {
  const span = endDate.getTime() - startDate.getTime();
  const out: QuarterStat[] = [];
  for (let i = 0; i < 4; i++) {
    const qStart = startDate.getTime() + (span * i) / 4;
    const qEnd = i === 3 ? endDate.getTime() : startDate.getTime() + (span * (i + 1)) / 4;
    const inQ = trades.filter((t) => {
      const exit = (t.exitTimestamp ?? t.timestamp).getTime();
      return exit >= qStart && (i === 3 ? exit <= qEnd : exit < qEnd);
    });
    const g = groupStats(inQ);
    out.push({ index: i + 1, start: new Date(qStart).toISOString(), end: new Date(qEnd).toISOString(), n: g.n, netProfit: g.netProfit, profitFactor: g.profitFactor });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Monte Carlo (seeded, dependency-free)
// ---------------------------------------------------------------------------

/** mulberry32 — small, fast, deterministic; adequate for bootstrap resampling. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * sorted.length)));
  return sorted[idx];
}

function monthKey(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * Bootstrap the fee-book trade set. `month` resamples calendar-month blocks
 * (by exit month) with replacement; `trade` resamples i.i.d. trades. Each
 * replicate: net $, mean R, PF, max DD % on the cumulative P&L path from
 * `initialCapital` (realized P&L as-is; sizing is not re-compounded).
 */
export function runMonteCarlo(
  trades: BacktestTrade[],
  opts: { runs: number; block: McBlockMode; seed: number; initialCapital: number },
): MonteCarloSummary | null {
  if (opts.block === 'none' || trades.length === 0 || opts.runs <= 0) return null;

  const units: BacktestTrade[][] = [];
  if (opts.block === 'month') {
    const byMonth = new Map<string, BacktestTrade[]>();
    for (const t of [...trades].sort((a, b) => (a.exitTimestamp ?? a.timestamp).getTime() - (b.exitTimestamp ?? b.timestamp).getTime())) {
      const key = monthKey(t.exitTimestamp ?? t.timestamp);
      const arr = byMonth.get(key);
      if (arr) arr.push(t);
      else byMonth.set(key, [t]);
    }
    for (const key of Array.from(byMonth.keys()).sort()) units.push(byMonth.get(key)!);
  } else {
    for (const t of trades) units.push([t]);
  }

  const rng = mulberry32(opts.seed);
  const nets: number[] = [];
  const meanRs: number[] = [];
  const pfs: number[] = [];
  const dds: number[] = [];
  let leq0 = 0;
  let pfScreen = 0;
  for (let run = 0; run < opts.runs; run++) {
    let equity = opts.initialCapital;
    let peak = equity;
    let maxDd = 0;
    let gp = 0;
    let gl = 0;
    let rSum = 0;
    let count = 0;
    for (let u = 0; u < units.length; u++) {
      const block = units[Math.floor(rng() * units.length)];
      for (const t of block) {
        const pnl = t.pnl ?? 0;
        equity += pnl;
        if (equity > peak) peak = equity;
        const dd = peak > 0 ? (peak - equity) / peak : 0;
        if (dd > maxDd) maxDd = dd;
        if (pnl > 0) gp += pnl;
        else gl += -pnl;
        rSum += tradeR(t);
        count += 1;
      }
    }
    const net = equity - opts.initialCapital;
    const pf = gl > 0 ? gp / gl : gp > 0 ? Infinity : 0;
    nets.push(net);
    meanRs.push(count ? rSum / count : 0);
    pfs.push(pf);
    dds.push(maxDd);
    if (net <= 0) leq0 += 1;
    if (pf >= E4_MC_SCREEN.pfMin) pfScreen += 1;
  }
  const sortNum = (xs: number[]) => [...xs].sort((a, b) => a - b);
  const sNet = sortNum(nets);
  const sR = sortNum(meanRs);
  const sPf = sortNum(pfs);
  const sDd = sortNum(dds);
  return {
    block: opts.block,
    runs: opts.runs,
    seed: opts.seed,
    blocks: units.length,
    net: { p05: percentile(sNet, 0.05), p50: percentile(sNet, 0.5), p95: percentile(sNet, 0.95), mean: mean(nets) },
    meanR: { p05: percentile(sR, 0.05), p50: percentile(sR, 0.5), p95: percentile(sR, 0.95) },
    profitFactor: { p05: percentile(sPf, 0.05), p50: percentile(sPf, 0.5), p95: percentile(sPf, 0.95) },
    maxDrawdownPct: { p50: percentile(sDd, 0.5), p95: percentile(sDd, 0.95), max: sDd[sDd.length - 1] },
    probNetLeqZero: leq0 / opts.runs,
    probPfGteScreen: pfScreen / opts.runs,
  };
}

// ---------------------------------------------------------------------------
// Label / gates / verdict (pure)
// ---------------------------------------------------------------------------

/** Derive the run label from data stamp, window length and run card. */
export function deriveLabel(
  stamp: 'REAL' | 'SYNTHETIC',
  windowDays: number,
  runCard: string | undefined | null,
): { label: E4Label; graded: boolean; line: string } {
  if (stamp === 'SYNTHETIC') {
    return { label: 'VOID', graded: false, line: 'VOID — DATA: SYNTHETIC (whole run VOID; random-walk candles; not evidence of anything)' };
  }
  if (windowDays < E4_FULL_WINDOW_MIN_DAYS) {
    return {
      label: 'SMOKE',
      graded: false,
      line: `SMOKE ONLY — NOT screen, NOT holdout, NOT Beta hard-preflight (window ${windowDays.toFixed(1)}d < ${E4_FULL_WINDOW_MIN_DAYS}d; no grade issued)`,
    };
  }
  const card = runCard?.trim();
  if (!card) {
    return {
      label: 'FULL',
      graded: false,
      line: `FULL WINDOW — DATA: REAL, ${windowDays.toFixed(1)}d ≥ ${E4_FULL_WINDOW_MIN_DAYS}d — UNGRADED (burn hold: pass --run-card <card id>; stats only, no grade)`,
    };
  }
  return {
    label: 'FULL',
    graded: true,
    line: `FULL WINDOW — DATA: REAL, ${windowDays.toFixed(1)}d ≥ ${E4_FULL_WINDOW_MIN_DAYS}d — GRADED under run card ${card} (Eng screen; NOT a desk GO)`,
  };
}

function fmt(x: number | null | undefined, digits = 2): string {
  if (x === null || x === undefined || Number.isNaN(x)) return 'n/a';
  if (x === Infinity) return '∞';
  if (x === -Infinity) return '-∞';
  return x.toFixed(digits);
}

export interface VerdictInput {
  label: E4Label;
  graded: boolean;
  policy: E4TimeframePolicy;
  windowRole: WindowRole;
  stamp: 'REAL' | 'SYNTHETIC';
  /** Fee-book pass uses the GO fee book (40 bps/side taker)? */
  goFeeBook: boolean;
  preflight: E4Preflight;
  zeroFee: { n: number; profitFactor: number | null; threshold: number; minTrades: number };
  fee: {
    stats: ExpectancyStats;
    maxDrawdownPct: number;
    quarters: QuarterStat[];
    quartersEvaluable: boolean;
    shortEntries: number;
  };
  mc: MonteCarloSummary | null;
}

/**
 * Beta bars + verdict. Order: VOID → SMOKE ONLY → UNGRADED → TUNE DIAGNOSTIC →
 * preflight E[n] (RESEARCH SCREEN ONLY / EXPLORATORY) → INCONCLUSIVE → STOP →
 * caps (custom window, non-GO fee book, 1H demoted ⇒ RESEARCH SCREEN ONLY) →
 * BETA BARS FAIL / PASS. PASS is an Eng screen statement, never a desk GO.
 */
export function evaluateVerdict(input: VerdictInput): { verdict: E4Verdict; reasons: string[]; gates: E4Gate[] } {
  const gates: E4Gate[] = [];
  const reasons: string[] = [];
  const { policy, preflight, zeroFee, fee } = input;

  gates.push({ id: 'data_real', label: 'Data 100% REAL (no synthetic)', value: input.stamp, threshold: 'REAL', hard: true, status: input.stamp === 'REAL' ? 'pass' : 'fail' });
  gates.push({
    id: 'window_eval', label: 'Window = locked eval (GO bars here only)', value: input.windowRole, threshold: 'eval', hard: true,
    status: input.windowRole === 'eval' ? 'pass' : input.windowRole === 'tune' ? 'n/a' : 'fail',
    note: input.windowRole === 'tune' ? 'tune window: diagnostics only' : undefined,
  });
  gates.push({
    id: 'preflight_expected_trades', label: 'HARD PREFLIGHT counted E[n] (fee book, EV on)',
    value: `${preflight.expectedTrades12m.toFixed(1)} (pooled n=${preflight.pooledN} over ${preflight.windowDays.toFixed(1)}d; ${Object.entries(preflight.perSymbolN).map(([s, n]) => `${s}=${n}`).join(' ')})`,
    threshold: `≥ ${preflight.gateMin}`, hard: true, status: preflight.passed ? 'pass' : 'fail',
    note: preflight.passed ? undefined : `${policy.thinCountVerdict}: no GO packaging; MC informational`,
  });
  const zEnough = zeroFee.n >= zeroFee.minTrades;
  gates.push({
    id: 'zero_fee_n', label: 'Zero-fee pass trade count', value: String(zeroFee.n), threshold: `≥ ${zeroFee.minTrades}`, hard: true,
    status: zEnough ? 'pass' : 'fail', note: zEnough ? undefined : 'INCONCLUSIVE — too few zero-fee trades to evaluate PF',
  });
  const zPfOk = zeroFee.profitFactor !== null && zeroFee.profitFactor >= zeroFee.threshold;
  gates.push({
    id: 'zero_fee_pf', label: `Zero-fee PF fail-fast floor (${policy.tf}, LOCKED)`, value: fmt(zeroFee.profitFactor), threshold: `≥ ${zeroFee.threshold}`, hard: true,
    status: !zEnough ? 'n/a' : zPfOk ? 'pass' : 'fail', note: 'Below the floor ⇒ STOP: no fee-sensitivity, no GO MC.',
  });
  gates.push({ id: 'go_fee_book', label: 'Fee book = GO fee book (40 bps/side, 80 RT)', value: input.goFeeBook ? '40/side' : 'other', threshold: '40 bps/side', hard: true, status: input.goFeeBook ? 'pass' : 'fail', note: input.goFeeBook ? undefined : 'sensitivity run — never a GO source' });
  const pf = fee.stats.profitFactor;
  gates.push({ id: 'fee_pf', label: 'Fee-book PF', value: fmt(pf), threshold: `≥ ${E4_BETA_BARS.feePassPfMin}`, hard: true, status: pf !== null && pf >= E4_BETA_BARS.feePassPfMin ? 'pass' : 'fail' });
  gates.push({ id: 'max_dd', label: 'Max drawdown', value: `${(fee.maxDrawdownPct * 100).toFixed(2)}%`, threshold: `≤ ${E4_BETA_BARS.maxDrawdownMax * 100}%`, hard: true, status: fee.maxDrawdownPct <= E4_BETA_BARS.maxDrawdownMax ? 'pass' : 'fail' });
  const passing = fee.quarters.filter((q) => q.profitFactor !== null && q.profitFactor >= 1.0).length;
  gates.push({
    id: 'quarters', label: 'Window-quarters with PF ≥ 1.0', value: `${passing}/${E4_BETA_BARS.quartersTotal} (n per quarter: ${fee.quarters.map((q) => q.n).join('/')})`, threshold: `≥ ${E4_BETA_BARS.quartersMin}/${E4_BETA_BARS.quartersTotal}`,
    hard: true, status: !fee.quartersEvaluable ? 'n/a' : passing >= E4_BETA_BARS.quartersMin ? 'pass' : 'fail', note: fee.quartersEvaluable ? undefined : 'Not evaluable: window shorter than 12 months.',
  });
  gates.push({ id: 'long_only', label: 'Long-only spot (short entries)', value: String(fee.shortEntries), threshold: '= 0', hard: true, status: fee.shortEntries === 0 ? 'pass' : 'fail' });
  gates.push({ id: 't_stat_r', label: 't-stat of mean R per trade', value: fmt(fee.stats.tStatR), threshold: '≥ 2 ≈ proof; PF 1.2 on 60 trades is a screen', hard: false, status: 'info' });
  if (input.mc) {
    gates.push({ id: 'mc_prob_loss', label: `MC P(net ≤ 0) [${input.mc.block}-block, ${input.mc.runs} runs]`, value: `${(input.mc.probNetLeqZero * 100).toFixed(1)}%`, threshold: 'reported, not gated', hard: false, status: 'info' });
    gates.push({
      id: 'mc_pf_screen', label: `MC screen P(PF ≥ ${E4_MC_SCREEN.pfMin})`, value: `${(input.mc.probPfGteScreen * 100).toFixed(1)}%`, threshold: `≥ ${E4_MC_SCREEN.probMin * 100}% (screen, NOT GO)`, hard: false,
      status: 'info', note: input.mc.probPfGteScreen >= E4_MC_SCREEN.probMin ? 'screen met' : 'screen not met',
    });
  }

  // ---- verdict ----------------------------------------------------------
  const contextFails = () => {
    for (const g of gates.filter((x) => x.hard && x.status === 'fail')) reasons.push(`(context) bar would fail: ${g.label} = ${g.value} (need ${g.threshold}).`);
  };
  if (input.stamp === 'SYNTHETIC') {
    reasons.push('DATA: SYNTHETIC — whole run VOID.');
    return { verdict: 'VOID', reasons, gates };
  }
  if (input.label === 'SMOKE') {
    reasons.push('Window shorter than the full-window minimum: SMOKE ONLY, no grade issued (desk label lock).');
    reasons.push('Numbers above validate the pipeline; they are not a screen, holdout, or Beta hard-preflight.');
    return { verdict: 'SMOKE ONLY', reasons, gates };
  }
  if (!input.graded) {
    reasons.push('FULL window without a run card: UNGRADED (burn hold). Statistics and bar statuses are informational only.');
    contextFails();
    reasons.push('To grade: re-run with --run-card <id> once the desk clears the burn.');
    return { verdict: 'UNGRADED', reasons, gates };
  }
  if (input.windowRole === 'tune') {
    reasons.push('Tune window 2023-03 → 2025-03: TUNE DIAGNOSTIC (zero knobs; never GO bars).');
    contextFails();
    return { verdict: 'TUNE DIAGNOSTIC', reasons, gates };
  }
  if (!preflight.passed) {
    reasons.push(
      `HARD PREFLIGHT: counted E[n] ${preflight.expectedTrades12m.toFixed(1)} < ${preflight.gateMin} (pooled n=${preflight.pooledN}; ${Object.entries(preflight.perSymbolN).map(([s, n]) => `${s} ${n}`).join(', ')}) ⇒ ${policy.thinCountVerdict} — no GO packaging; MC informational.`,
    );
    if (!zEnough) reasons.push(`(context) zero-fee n=${zeroFee.n} < ${zeroFee.minTrades}.`);
    else if (!zPfOk) reasons.push(`(context) zero-fee PF ${fmt(zeroFee.profitFactor)} < locked floor ${zeroFee.threshold}: STOP applied to MC/stress.`);
    contextFails();
    return { verdict: policy.thinCountVerdict, reasons, gates };
  }
  if (!zEnough) {
    reasons.push(`Zero-fee pass produced n=${zeroFee.n} < ${zeroFee.minTrades}: nothing to evaluate.`);
    return { verdict: 'INCONCLUSIVE', reasons, gates };
  }
  if (!zPfOk) {
    reasons.push(`STOP — holdout zero-fee PF ${fmt(zeroFee.profitFactor)} < locked floor ${zeroFee.threshold} (${policy.tf}): no fee-sensitivity, no GO MC.`);
    return { verdict: 'STOP', reasons, gates };
  }
  reasons.push(`Zero-fee PF ${fmt(zeroFee.profitFactor)} ≥ locked floor ${zeroFee.threshold}: fail-fast passed.`);
  if (input.windowRole !== 'eval') {
    reasons.push(`Window is not the locked eval window (${input.windowRole}): GO bars are eval-only ⇒ RESEARCH SCREEN ONLY.`);
    contextFails();
    return { verdict: 'RESEARCH SCREEN ONLY', reasons, gates };
  }
  if (!input.goFeeBook) {
    reasons.push('Fee book is not the GO fee book (40 bps/side): sensitivity run ⇒ RESEARCH SCREEN ONLY (never cherry-pick for GO).');
    contextFails();
    return { verdict: 'RESEARCH SCREEN ONLY', reasons, gates };
  }
  if (!policy.goEligible) {
    reasons.push(`${policy.tf.toUpperCase()} is demoted — do not lead; never GO-eligible from this harness ⇒ RESEARCH SCREEN ONLY.`);
    contextFails();
    return { verdict: 'RESEARCH SCREEN ONLY', reasons, gates };
  }
  const hardFails = gates.filter((g) => g.hard && g.status === 'fail');
  if (hardFails.length > 0) {
    for (const g of hardFails) reasons.push(`Beta bar failed: ${g.label} = ${g.value} (need ${g.threshold}).`);
    return { verdict: 'BETA BARS FAIL', reasons, gates };
  }
  const notEvaluable = gates.filter((g) => g.hard && g.status === 'n/a');
  if (notEvaluable.length > 0) {
    for (const g of notEvaluable) reasons.push(`Beta bar not evaluable: ${g.label}${g.note ? ` — ${g.note}` : ''} ⇒ RESEARCH SCREEN ONLY.`);
    return { verdict: 'RESEARCH SCREEN ONLY', reasons, gates };
  }
  reasons.push('All Beta bars met on the locked eval window at the GO fee book. This is an Eng screen result — NOT a desk GO; TM decides.');
  if (input.mc) {
    reasons.push(`MC screen P(PF ≥ ${E4_MC_SCREEN.pfMin}) = ${(input.mc.probPfGteScreen * 100).toFixed(1)}% (${input.mc.probPfGteScreen >= E4_MC_SCREEN.probMin ? 'screen met' : 'screen NOT met'}; screen, not GO).`);
  }
  return { verdict: 'BETA BARS PASS', reasons, gates };
}

// ---------------------------------------------------------------------------
// Run-time assertions (zero knobs, data path)
// ---------------------------------------------------------------------------

/** Spot-only: E4 is spot long-only; INTX/perps are out. */
export function assertSpotProducts(products: string[]): void {
  const perps = products.filter((p) => venueForSymbol(p) === 'perps');
  if (perps.length > 0) {
    throw new E4DataPathError('E4_SPOT_ONLY', `E4 is spot long-only (INTX/perps out); remove ${perps.join(', ')} from --products.`);
  }
}

/** The fixture directory must hold bars of exactly the TF's width (true 4H — no silent granularity mapping). */
export function assertFixtureTimeframe(provenance: DataProvenance, policy: E4TimeframePolicy, fixtureDir: string): void {
  const declaredMinutes = provenance.granularitySeconds / 60;
  const inferred = provenance.inferredBarMinutes;
  const ok =
    provenance.source === 'fixture' &&
    !provenance.aggregation &&
    declaredMinutes === policy.barMinutes &&
    (inferred === null || inferred === policy.barMinutes);
  if (!ok) {
    throw new E4DataPathError(
      'E4_FIXTURE_TF_MISMATCH',
      `${provenance.symbol} in ${fixtureDir}: source=${provenance.source} declared=${declaredMinutes}m spacing=${inferred ?? 'n/a'}m, ` +
        `but --tf ${policy.tf} needs native ${policy.barMinutes}m fixtures. Use a per-TF directory (${policy.fixtureHint}). ` +
        'The 15m fixtures under fixtures/bars/ are backtest-gate only (~7d) and are not E4 data; ' +
        'on-the-fly rollup lives on `pnpm backtest --bar-minutes`, not on the E4 harness.',
    );
  }
}

/**
 * Zero knobs: the run must be exactly the card's experiment. Verifies the
 * guardrails.yaml pins the engine will read (A1 2.5/6.0 per symbol,
 * atr_volatility_min 0.005, min_ev_threshold 0) and echoes the cooldown and
 * fee book. Drift ⇒ E4_ZERO_KNOBS_DRIFT (fail-closed; "do not retune").
 */
export function assertZeroKnobs(
  guardrails: GuardrailConfig,
  products: string[],
  strategy: string,
  cooldownBars: number,
  feeTier: FeeTierLabel,
): E4ZeroKnobs {
  const problems: string[] = [];
  const a1PerSymbol: E4ZeroKnobs['a1PerSymbol'] = {};
  if (strategy === 'trend_follow' || strategy === 'all') {
    for (const product of products) {
      const tf = guardrails.per_symbol?.[product]?.strategy_overrides?.trend_follow as Record<string, unknown> | undefined;
      const stopAtr = tf?.stopAtr;
      const takeProfitAtr = tf?.takeProfitAtr;
      a1PerSymbol[product] = { stopAtr, takeProfitAtr };
      if (stopAtr !== E4_CARD.a1.stopAtr || takeProfitAtr !== E4_CARD.a1.takeProfitAtr) {
        problems.push(`${product} trend_follow override is stopAtr=${String(stopAtr)} takeProfitAtr=${String(takeProfitAtr)}, card A1 requires ${E4_CARD.a1.stopAtr}/${E4_CARD.a1.takeProfitAtr}`);
      }
    }
  }
  if (guardrails.filters.atr_volatility_min !== E4_CARD.atrVolatilityMin) {
    problems.push(`filters.atr_volatility_min=${guardrails.filters.atr_volatility_min}, card requires ${E4_CARD.atrVolatilityMin} (do not retune)`);
  }
  if (guardrails.risk.min_ev_threshold !== E4_CARD.minEvThreshold) {
    problems.push(`risk.min_ev_threshold=${guardrails.risk.min_ev_threshold}, card requires ${E4_CARD.minEvThreshold}`);
  }
  if (!Number.isInteger(cooldownBars) || cooldownBars < 1) {
    problems.push(`cooldown must be ≥ 1 bar (card: ${E4_CARD.cooldownBars} × bar), got ${cooldownBars}`);
  }
  if (problems.length > 0) {
    throw new E4DataPathError('E4_ZERO_KNOBS_DRIFT', problems.join('; '));
  }
  return {
    a1PerSymbol,
    atrVolatilityMin: guardrails.filters.atr_volatility_min,
    minEvThreshold: guardrails.risk.min_ev_threshold,
    cooldownBars,
    feeBookBpsPerSide: feeTier.takerBps,
    goFeeBook: feeTier.takerBps === E4_CARD.goFeeBpsPerSide,
  };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/** Cache a provider per (product, window) so multi-pass runs load once. */
export function memoizeProvider(provider: SeriesProvider): SeriesProvider {
  const cache = new Map<string, ReturnType<SeriesProvider>>();
  return (product, start, end) => {
    const key = `${product}|${start.getTime()}|${end.getTime()}`;
    let hit = cache.get(key);
    if (!hit) {
      hit = provider(product, start, end);
      cache.set(key, hit);
    }
    return hit;
  };
}

function summarizePass(result: BacktestResult, saved: SavedBacktestPaths | null): E4PassSummary {
  const m = result.metrics;
  return {
    metrics: {
      totalTrades: m.totalTrades, profitFactor: m.profitFactor, winRate: m.winRate, netProfit: m.netProfit, totalFees: m.totalFees,
      maxDrawdownPercent: m.maxDrawdownPercent, returnPercent: m.returnPercent, longEntries: m.longEntries, shortEntries: m.shortEntries,
      shortBlocked: m.shortBlocked, sellSignalExits: m.sellSignalExits, evGate: m.evGate, activeStrategies: m.activeStrategies,
      atrFilterRejects: m.atrFilterRejects, exitsIgnoredMinHold: m.exitsIgnoredMinHold,
    },
    stats: computeExpectancy(result.trades),
    fees: result.fees,
    saved,
    trades: result.trades.map((t) => ({
      product: t.product, strategy: t.strategy, side: t.side, entry: t.timestamp.toISOString(),
      exit: t.exitTimestamp ? t.exitTimestamp.toISOString() : null, pnl: t.pnl ?? 0, r: tradeR(t), exitReason: t.exitReason ?? 'open',
    })),
  };
}

function perSymbolCounts(products: string[], trades: BacktestTrade[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of products) out[p] = 0;
  for (const t of trades) out[t.product] = (out[t.product] ?? 0) + 1;
  return out;
}

function readLedger(ledgerPath: string, tf: E4Timeframe): number {
  if (!fs.existsSync(ledgerPath)) return 0;
  let count = 0;
  for (const line of fs.readFileSync(ledgerPath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as { tf?: string; window?: string; graded?: boolean };
      if (row.tf === tf && row.window === 'eval' && row.graded) count += 1;
    } catch {
      count += 1; // an unparsable line is still a prior run on record
    }
  }
  return count;
}

/**
 * Run the E4 pipeline for one timeframe on one per-TF fixture directory.
 * `runner` must be constructed with `fixtureDir = request.fixtureDir`.
 */
export async function runE4(
  request: E4Request,
  runner: BacktestRunner,
  guardrails: GuardrailConfig,
  logger: Logger,
): Promise<E4Report> {
  const policy = E4_TF_POLICY[request.tf];
  const zeroFeePfMin = E4_ZERO_FEE_PF_FLOOR[request.tf];
  const minExpectedTrades = E4_MIN_EXPECTED_TRADES[request.tf];
  const windowDays = Math.max(0, (request.endDate.getTime() - request.startDate.getTime()) / DAY_MS);
  const windowRole = classifyWindow(request.startDate, request.endDate);

  if (!request.fixtureDir) {
    throw new E4DataPathError('E4_FIXTURE_DIR_REQUIRED', `--fixture-dir is required (per-TF fixtures: ${policy.fixtureHint}).`);
  }
  assertSpotProducts(request.products);
  const zeroKnobs = assertZeroKnobs(guardrails, request.products, String(request.strategy), request.cooldownBars, request.feeTier);

  const dataOptions: BacktestDataOptions = { minCoverage: request.minCoverage ?? 0.5, allowSynthetic: false };
  const provider = memoizeProvider(runner.createDataProvider(dataOptions));

  // Stage 0 — data path pre-flight (true-TF fixtures; surfaces DATA_UNAVAILABLE before engine work).
  for (const product of request.products) {
    const out = await provider(product, request.startDate, request.endDate);
    assertFixtureTimeframe(out.provenance, policy, request.fixtureDir);
  }

  const baseInput = {
    startDate: request.startDate,
    endDate: request.endDate,
    initialCapital: request.initialCapital,
    products: request.products,
    strategy: request.strategy,
    regimeGates: request.regimeGates,
    minHoldBars: request.cooldownBars,
  };
  const feeModel = buildFeeModel(guardrails, request.feeTier);
  const tag = (suffix: string) => `e4-${request.tf}-${windowRole}-${suffix}`;

  // Stage P — HARD PREFLIGHT: fee-book pass (GO fee book, EV gate on) ⇒ counted E[n].
  logger.info('E4 harness: stage P — hard preflight (fee book, EV on)', { tf: request.tf, window: windowRole, feeTier: request.feeTier, cooldownBars: request.cooldownBars });
  const feeConfig: BacktestConfig = buildBacktestConfig({ ...baseInput, feeModel, evGateMode: request.evGateMode }, guardrails);
  const feeRun = await runner.runBacktestDetailed(feeConfig, dataOptions, { feeTier: request.feeTier, fileTag: tag('feebook') }, provider);
  const stamp = feeRun.result.dataStamp;
  const { label, graded, line: labelLine } = deriveLabel(stamp, windowDays, request.runCard);
  const feeSummary = summarizePass(feeRun.result, feeRun.saved);
  const feeFrequency = computeTradeFrequency(feeRun.result.trades, request.startDate, request.endDate);
  const quarters = computeWindowQuarters(feeRun.result.trades, request.startDate, request.endDate);

  // Stage 1 — zero-fee fail-fast.
  logger.info('E4 harness: stage 1 — zero-fee pass', { floor: zeroFeePfMin });
  const zeroFeeConfig: BacktestConfig = buildBacktestConfig({ ...baseInput, feeModel, commissionOverride: 0, evGateMode: 'off' }, guardrails);
  const zeroFeeRun = await runner.runBacktestDetailed(
    zeroFeeConfig, dataOptions, { feeTier: { name: 'zero-fee pass (commission 0)', makerBps: 0, takerBps: 0 }, fileTag: tag('zero-fee') }, provider,
  );
  const zeroFeeSummary = summarizePass(zeroFeeRun.result, zeroFeeRun.saved);
  const zeroFeeFrequency = computeTradeFrequency(zeroFeeRun.result.trades, request.startDate, request.endDate);
  const zPf = zeroFeeSummary.stats.profitFactor;
  const zEnough = zeroFeeSummary.stats.n >= E4_MIN_ZERO_FEE_TRADES;
  const zPass = !zEnough ? null : zPf !== null && zPf >= zeroFeePfMin;
  const failFast: 'none' | 'inconclusive' | 'pf' = !zEnough ? 'inconclusive' : zPass ? 'none' : 'pf';

  const preflight: E4Preflight = {
    pooledN: feeSummary.stats.n,
    perSymbolN: perSymbolCounts(request.products, feeRun.result.trades),
    windowDays,
    expectedTrades12m: feeFrequency.expectedTrades12m,
    gateMin: minExpectedTrades,
    passed: feeFrequency.expectedTrades12m >= minExpectedTrades,
    rawN: zeroFeeSummary.stats.n,
    rawExpectedTrades12m: zeroFeeFrequency.expectedTrades12m,
  };

  // Stages 3/4 — MC + fee stress only past the STOP (SMOKE ONLY may force them).
  const pastStop = stamp === 'REAL' && (failFast === 'none' || (label === 'SMOKE' && request.smokeRunAllStages));
  let monteCarlo: MonteCarloSummary | null = null;
  const stress: E4StressPass[] = [];
  if (pastStop) {
    if (failFast !== 'none') logger.warn('E4 harness: SMOKE ONLY run continuing past STOP because --smoke-run-all-stages is set', { failFast });
    logger.info('E4 harness: stage 3 — Monte Carlo', { block: request.mc.block, runs: request.mc.runs, seed: request.mc.seed });
    monteCarlo = runMonteCarlo(feeRun.result.trades, { ...request.mc, initialCapital: request.initialCapital });
    if (request.feeStress) {
      for (const bps of E4_CARD.stressBpsPerSide) {
        logger.info('E4 harness: stage 4 — fee stress pass', { bpsPerSide: bps });
        const stressTier: FeeTierLabel = { name: `stress ${bps} bps/side`, makerBps: bps, takerBps: bps };
        const cfg = buildBacktestConfig({ ...baseInput, feeModel: buildFeeModel(guardrails, stressTier), evGateMode: request.evGateMode }, guardrails);
        const run = await runner.runBacktestDetailed(cfg, dataOptions, { feeTier: stressTier, fileTag: tag(`stress-${bps}bps`) }, provider);
        const s = computeExpectancy(run.result.trades);
        stress.push({
          bpsPerSide: bps, n: s.n, profitFactor: s.profitFactor, netProfit: s.netProfit, meanR: s.meanR,
          maxDrawdownPct: run.result.metrics.maxDrawdownPercent, evRejected: run.result.metrics.evGate.rejected, saved: run.saved,
        });
      }
    }
  } else {
    logger.warn('E4 harness: STOP — Monte Carlo and fee stress not run', { stamp, failFast, label });
  }

  const evaluation = evaluateVerdict({
    label, graded, policy, windowRole, stamp, goFeeBook: zeroKnobs.goFeeBook, preflight,
    zeroFee: { n: zeroFeeSummary.stats.n, profitFactor: zPf, threshold: zeroFeePfMin, minTrades: E4_MIN_ZERO_FEE_TRADES },
    fee: { stats: feeSummary.stats, maxDrawdownPct: feeSummary.metrics.maxDrawdownPercent, quarters, quartersEvaluable: windowDays >= E4_FULL_WINDOW_MIN_DAYS, shortEntries: feeSummary.metrics.shortEntries },
    mc: monteCarlo,
  });

  // Eval ledger (anti-overfitting: eval once). Only graded eval-window runs are recorded.
  let evalLedger: E4Report['evalLedger'] = null;
  if (request.evalLedgerPath && windowRole === 'eval') {
    const prior = readLedger(request.evalLedgerPath, request.tf);
    let appended = false;
    if (graded) {
      fs.mkdirSync(path.dirname(request.evalLedgerPath), { recursive: true });
      fs.appendFileSync(
        request.evalLedgerPath,
        `${JSON.stringify({ ts: new Date().toISOString(), tf: request.tf, window: 'eval', graded, runCard: request.runCard?.trim() ?? null, verdict: evaluation.verdict, pooledN: preflight.pooledN, expectedTrades12m: preflight.expectedTrades12m, zeroFeePF: zPf, feePF: feeSummary.stats.profitFactor, feeTier: request.feeTier.name })}\n`,
      );
      appended = true;
      if (prior > 0) {
        evaluation.reasons.unshift(`WARNING: eval window already graded ${prior} time(s) before this run (ledger ${request.evalLedgerPath}) — walk-forward rule is EVAL ONCE.`);
        logger.warn('E4 harness: eval window re-run', { prior, ledger: request.evalLedgerPath });
      }
    }
    evalLedger = { path: request.evalLedgerPath, priorGradedEvalRuns: prior, appended };
  }

  const window: E4Report['window'] = windowRole === 'custom'
    ? { role: 'custom', start: request.startDate.toISOString(), end: request.endDate.toISOString(), days: windowDays, note: 'custom window — not the locked eval window; GO bars are eval-only' }
    : { ...E4_WALK_FORWARD[windowRole], days: windowDays };

  return {
    harness: 'e4-multi-tf-feemodel',
    version: 3,
    generatedAt: new Date().toISOString(),
    card: E4_CARD,
    label,
    graded,
    runCard: request.runCard?.trim() || null,
    labelLine,
    window,
    verdict: evaluation.verdict,
    reasons: evaluation.reasons,
    tf: request.tf,
    barMinutes: policy.barMinutes,
    policy,
    thresholds: {
      zeroFeePfFloor: zeroFeePfMin, minZeroFeeTrades: E4_MIN_ZERO_FEE_TRADES, minExpectedTrades, fullWindowMinDays: E4_FULL_WINDOW_MIN_DAYS,
      feePassPfMin: E4_BETA_BARS.feePassPfMin, maxDrawdownMax: E4_BETA_BARS.maxDrawdownMax, quartersMin: `${E4_BETA_BARS.quartersMin}/${E4_BETA_BARS.quartersTotal}`,
      mcScreen: { pfMin: E4_MC_SCREEN.pfMin, probMin: E4_MC_SCREEN.probMin },
    },
    zeroKnobs,
    request: {
      startDate: request.startDate.toISOString(), endDate: request.endDate.toISOString(), windowDays,
      products: request.products, strategy: String(request.strategy), initialCapital: request.initialCapital,
      feeTier: request.feeTier, evGateMode: request.evGateMode, regimeGates: request.regimeGates,
      fixtureDir: request.fixtureDir, minCoverage: request.minCoverage ?? 0.5, cooldownBars: request.cooldownBars, mc: request.mc,
      feeStress: request.feeStress, smokeRunAllStages: request.smokeRunAllStages,
    },
    data: { stamp, provenance: feeRun.result.dataProvenance, venueBySymbol: feeRun.result.venueBySymbol },
    preflight,
    zeroFee: { ...zeroFeeSummary, threshold: zeroFeePfMin, passed: zPass, failFast, frequency: zeroFeeFrequency },
    fee: { ...feeSummary, frequency: feeFrequency, quarters, quartersPassing: quarters.filter((q) => q.profitFactor !== null && q.profitFactor >= 1.0).length, quartersEvaluable: windowDays >= E4_FULL_WINDOW_MIN_DAYS },
    monteCarlo,
    stress,
    evalLedger,
    gates: evaluation.gates,
  };
}

/** Fee tier for the fee-book pass: explicit `--fee-tier` wins; else guardrails spot bucket (GO fee book, 40 bps taker). */
export function resolveE4FeeTier(flag: string | undefined, guardrails: GuardrailConfig): FeeTierLabel {
  return resolveFeeTier(flag, guardrails.fees.coinbase.spot);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function pct(x: number): string {
  return `${(x * 100).toFixed(2)}%`;
}

function renderPassStats(title: string, pass: E4PassSummary): string[] {
  const s = pass.stats;
  const lines = [
    title,
    `  trades=${s.n} (long=${s.longEntries} short=${s.shortEntries})  WR=${pct(s.winRate)}  PF=${fmt(s.profitFactor)}  payoff=${fmt(s.payoffRatio)}`,
    `  net=$${s.netProfit.toFixed(2)}  gross+=$${s.grossProfit.toFixed(2)}  gross−=$${s.grossLoss.toFixed(2)}  fees=$${s.totalFees.toFixed(2)} ($${s.feesPerTrade.toFixed(2)}/trade; ${s.feesPctOfGrossProfit === null ? 'n/a' : pct(s.feesPctOfGrossProfit)} of gross wins)`,
    `  mean$=${s.meanPnl.toFixed(2)} sd$=${s.stdPnl.toFixed(2)} t($)=${fmt(s.tStatPnl)}   meanR=${s.meanR.toFixed(3)} sdR=${s.stdR.toFixed(3)} t(R)=${fmt(s.tStatR)}`,
    `  maxDD=${pct(pass.metrics.maxDrawdownPercent)}  return=${pass.metrics.returnPercent.toFixed(2)}%  EV gate: mode=${pass.metrics.evGate.mode} evaluated=${pass.metrics.evGate.evaluated} rejected=${pass.metrics.evGate.rejected}  SELLs blocked (spot)=${pass.metrics.shortBlocked}  ATR-filter rejects=${pass.metrics.atrFilterRejects}  min-hold exit ignores=${pass.metrics.exitsIgnoredMinHold}`,
    `  exits: ${Object.entries(s.exitReasons).map(([k, v]) => `${k}=${v}`).join(', ') || 'none'}`,
    `  by symbol: ${Object.entries(s.bySymbol).map(([k, v]) => `${k} n=${v.n} PF=${fmt(v.profitFactor)} net=$${v.netProfit.toFixed(2)} meanR=${v.meanR.toFixed(2)}`).join(' | ') || 'none'}`,
    `  by strategy: ${Object.entries(s.byStrategy).map(([k, v]) => `${k} n=${v.n} PF=${fmt(v.profitFactor)} net=$${v.netProfit.toFixed(2)} meanR=${v.meanR.toFixed(2)}`).join(' | ') || 'none'}`,
  ];
  if (pass.saved) lines.push(`  backtest artefacts: ${pass.saved.jsonPath}`);
  return lines;
}

/** Human-readable report. Line 1 = derived label; line 2 = DATA stamp; preflight block first. */
export function renderE4Report(report: E4Report): string {
  const r = report.request;
  const t = report.thresholds;
  const p = report.preflight;
  const z = report.zeroFee;
  const f = report.fee;
  const k = report.zeroKnobs;
  const out: string[] = [];
  out.push(report.labelLine);
  out.push(`DATA: ${report.data.stamp}`);
  out.push(`E4 FeeModel expectancy harness — TF=${report.tf.toUpperCase()} (${report.barMinutes}m bars) [${report.policy.status.toUpperCase()}, desk order ${report.policy.order}/3]   card: ${report.card.id}   run card: ${report.runCard ?? 'none (UNGRADED on full windows)'}`);
  out.push(`Window: ${report.window.role.toUpperCase()} ${report.window.start.slice(0, 10)} → ${report.window.end.slice(0, 10)} (${report.window.days.toFixed(1)} days) — ${report.window.note}`);
  out.push(`Policy: ${report.policy.note}`);
  out.push(
    `Zero knobs (verified): products ${r.products.join('/')} spot long-only · strategy ${r.strategy} A1 ${Object.entries(k.a1PerSymbol).map(([s, v]) => `${s} ${String(v.stopAtr)}/${String(v.takeProfitAtr)}`).join(', ') || 'n/a'} · ` +
      `atr_volatility_min ${k.atrVolatilityMin} · EV gate ${r.evGateMode}, min_ev_threshold ${k.minEvThreshold} · cooldown ${k.cooldownBars} bar = ${k.cooldownBars * report.barMinutes} min (min hold before opposite-signal exit; live trade_cooldown_min analog) · ` +
      `fee book ${k.feeBookBpsPerSide} bps/side (${k.feeBookBpsPerSide * 2} RT)${k.goFeeBook ? ' = GO fee book' : ' ≠ GO fee book (40) — sensitivity run'} · stress ${report.card.stressBpsPerSide.join('/')} separate`,
  );
  out.push(`Locked thresholds: preflight E[n] ≥ ${t.minExpectedTrades}/12m  zero-fee PF floor ≥ ${t.zeroFeePfFloor} (STOP below)  min zero-fee trades ${t.minZeroFeeTrades}  Beta bars: fee PF ≥ ${t.feePassPfMin}, maxDD ≤ ${pct(t.maxDrawdownMax)}, window-quarters ≥ ${t.quartersMin}, long-only  MC screen P(PF ≥ ${t.mcScreen.pfMin}) ≥ ${t.mcScreen.probMin} (screen, not GO)  full window ≥ ${t.fullWindowMinDays}d`);
  out.push(`Fixture dir: ${r.fixtureDir}   Fee pass: ${r.feeTier.name} (maker ${r.feeTier.makerBps} / taker ${r.feeTier.takerBps} bps; taker charged per fill)   Regime gates: ${r.regimeGates ? 'on' : 'off'}   Initial capital: $${r.initialCapital}`);
  for (const pv of Object.values(report.data.provenance)) {
    out.push(`Data source ${pv.symbol}: ${pv.source} bars=${pv.candleCount}/${pv.expectedCount} coverage=${(pv.coverage * 100).toFixed(1)}% spacing=${pv.inferredBarMinutes ?? 'n/a'}m declared=${pv.granularitySeconds / 60}m first=${pv.firstBarTime ?? 'n/a'} last=${pv.lastBarTime ?? 'n/a'}${pv.fixtureSha256 ? ` sha256=${pv.fixtureSha256.slice(0, 12)}` : ''}${pv.source === 'synthetic' ? ' [SYNTHETIC — VOID]' : ''}`);
  }
  out.push('');
  out.push(`Stage P — HARD PREFLIGHT: counted long-only E[n] (fee book ${k.feeBookBpsPerSide} bps/side, EV gate ${r.evGateMode})`);
  out.push(`  pooled n = ${p.pooledN}   per-symbol: ${Object.entries(p.perSymbolN).map(([s, n]) => `${s} n=${n}`).join(' | ')}   window ${p.windowDays.toFixed(1)}d → counted E[n] (12m) = ${p.expectedTrades12m.toFixed(1)}   gate ≥ ${p.gateMin} → ${p.passed ? 'CONTINUE (subject to zero-fee fail-fast + Beta bars)' : `${report.policy.thinCountVerdict} (no GO packaging; MC informational)`}`);
  out.push(`  raw count (zero-fee, EV off) n = ${p.rawN} → E[n] ${p.rawExpectedTrades12m.toFixed(1)} (upper bound)   SELLs blocked (spot) = ${f.metrics.shortBlocked}   EV-gate rejects = ${f.metrics.evGate.rejected}   ATR-filter rejects = ${f.metrics.atrFilterRejects}   min-hold exit ignores = ${f.metrics.exitsIgnoredMinHold}`);
  out.push(`E4_PREFLIGHT tf=${report.tf} window=${report.window.role} data=${report.data.stamp} pooledN=${p.pooledN} ${Object.entries(p.perSymbolN).map(([s, n]) => `${s}=${n}`).join(' ')} windowDays=${p.windowDays.toFixed(1)} E_n_12m=${p.expectedTrades12m.toFixed(1)} gate=${p.gateMin} result=${p.passed ? 'CONTINUE' : report.policy.thinCountVerdict.replace(/ /g, '_')} rawN=${p.rawN}`);
  out.push('');
  out.push(...renderPassStats(`Stage 1 — zero-fee PF fail-fast (commission 0, EV gate off)   LOCKED floor PF ≥ ${z.threshold}  min trades ${t.minZeroFeeTrades}  → ${z.failFast === 'inconclusive' ? 'INCONCLUSIVE (too few trades) — STOP' : z.failFast === 'pf' ? 'BELOW FLOOR — STOP (no fee-sensitivity, no GO MC)' : 'PASS'}`, z));
  out.push('');
  out.push(...renderPassStats(`Stage 2 — FeeModel expectancy @ ${r.feeTier.name} (${k.goFeeBook ? 'GO fee book' : 'NOT the GO fee book'}; EV gate ${r.evGateMode}; cooldown ${k.cooldownBars} bar)`, f));
  out.push(`  E[n] (12m) = ${f.frequency.expectedTrades12m.toFixed(1)}  from n=${f.frequency.n} over ${f.frequency.windowDays.toFixed(1)} days (${f.frequency.tradesPerMonth.toFixed(2)} trades/month)   first trade ${f.frequency.firstTradeAt ?? 'n/a'}   last ${f.frequency.lastTradeAt ?? 'n/a'}`);
  out.push(`  window quarters (by exit): ${f.quarters.map((q) => `Q${q.index} ${q.start.slice(0, 10)}→${q.end.slice(0, 10)} n=${q.n} PF=${fmt(q.profitFactor)} net=$${q.netProfit.toFixed(2)}`).join(' | ')}${f.quartersEvaluable ? '' : '   [not evaluable: window < 12 months]'}`);
  out.push('');
  if (report.monteCarlo) {
    const m = report.monteCarlo;
    out.push(`Stage 3 — Monte Carlo bootstrap (${m.block}-block, ${m.runs} runs, seed ${m.seed}, ${m.blocks} resampling units; realized P&L path from $${r.initialCapital}, sizing not re-compounded)${!p.passed ? '   [INFORMATIONAL — preflight E[n] below gate]' : ''}`);
    out.push(`  net$ p05/p50/p95 = ${m.net.p05.toFixed(2)} / ${m.net.p50.toFixed(2)} / ${m.net.p95.toFixed(2)} (mean ${m.net.mean.toFixed(2)})   P(net ≤ 0) = ${pct(m.probNetLeqZero)}   SCREEN P(PF ≥ ${t.mcScreen.pfMin}) = ${pct(m.probPfGteScreen)} (screen ≥ ${pct(t.mcScreen.probMin)}; NOT GO)`);
    out.push(`  meanR p05/p50/p95 = ${m.meanR.p05.toFixed(3)} / ${m.meanR.p50.toFixed(3)} / ${m.meanR.p95.toFixed(3)}   PF p05/p50/p95 = ${fmt(m.profitFactor.p05)} / ${fmt(m.profitFactor.p50)} / ${fmt(m.profitFactor.p95)}   maxDD p50/p95/max = ${pct(m.maxDrawdownPct.p50)} / ${pct(m.maxDrawdownPct.p95)} / ${pct(m.maxDrawdownPct.max)}`);
  } else {
    out.push(`Stage 3 — Monte Carlo: NOT RUN (${z.failFast === 'inconclusive' ? 'STOP: zero-fee pass inconclusive' : z.failFast === 'pf' ? 'STOP: zero-fee PF below locked floor' : r.mc.block === 'none' ? '--mc-block none' : f.stats.n === 0 ? 'no fee-book trades' : 'data not REAL'})`);
  }
  out.push('');
  if (report.stress.length > 0) {
    out.push('Stage 4 — Fee stress (SEPARATE, informational; never cherry-pick for GO):');
    out.push(`  ${'bps/side'.padEnd(9)} ${'RT'.padEnd(5)} ${'n'.padStart(4)} ${'PF'.padStart(7)} ${'net$'.padStart(10)} ${'meanR'.padStart(7)} ${'maxDD'.padStart(8)} ${'EVrej'.padStart(6)}`);
    out.push(`  ${String(k.feeBookBpsPerSide).padEnd(9)} ${String(k.feeBookBpsPerSide * 2).padEnd(5)} ${String(f.stats.n).padStart(4)} ${fmt(f.stats.profitFactor).padStart(7)} ${f.stats.netProfit.toFixed(2).padStart(10)} ${f.stats.meanR.toFixed(3).padStart(7)} ${pct(f.metrics.maxDrawdownPercent).padStart(8)} ${String(f.metrics.evGate.rejected).padStart(6)}   ← fee book (GO)`);
    for (const s of report.stress) {
      out.push(`  ${String(s.bpsPerSide).padEnd(9)} ${String(s.bpsPerSide * 2).padEnd(5)} ${String(s.n).padStart(4)} ${fmt(s.profitFactor).padStart(7)} ${s.netProfit.toFixed(2).padStart(10)} ${s.meanR.toFixed(3).padStart(7)} ${pct(s.maxDrawdownPct).padStart(8)} ${String(s.evRejected).padStart(6)}`);
    }
    out.push('');
  } else if (r.feeStress) {
    out.push('Stage 4 — Fee stress: NOT RUN (STOP or not past fail-fast)');
    out.push('');
  }
  if (report.evalLedger) {
    out.push(`Eval ledger: ${report.evalLedger.path} — prior graded eval runs for ${report.tf}: ${report.evalLedger.priorGradedEvalRuns}${report.evalLedger.appended ? ' (this run appended)' : ''} — walk-forward rule: EVAL ONCE`);
    out.push('');
  }
  out.push('Beta bars:');
  for (const g of report.gates) {
    out.push(`  [${g.status.toUpperCase().padEnd(4)}] ${g.hard ? 'HARD' : 'INFO'}  ${g.label}: ${g.value}  (need ${g.threshold})${g.note ? `  — ${g.note}` : ''}`);
  }
  out.push('');
  out.push(`VERDICT: ${report.verdict}${report.verdict === 'BETA BARS PASS' ? ' — Eng screen; NOT a desk GO (TM decides)' : ''}`);
  for (const reason of report.reasons) out.push(`  - ${reason}`);
  out.push('');
  out.push(
    `E4_RESULT tf=${report.tf} window=${report.window.role} label=${report.label} graded=${report.graded} runCard=${report.runCard ?? 'none'} verdict="${report.verdict}" data=${report.data.stamp} ` +
      `preflightN=${p.pooledN} E_n_12m=${p.expectedTrades12m.toFixed(1)} preflightGate=${p.gateMin} ` +
      `zeroFeeN=${z.stats.n} zeroFeePF=${fmt(z.stats.profitFactor)} zeroFeeFloor=${t.zeroFeePfFloor} ` +
      `feeN=${f.stats.n} feePF=${fmt(f.stats.profitFactor)} feeMeanR=${f.stats.meanR.toFixed(3)} maxDD=${pct(f.metrics.maxDrawdownPercent)} ` +
      `mcProbLoss=${report.monteCarlo ? pct(report.monteCarlo.probNetLeqZero) : 'n/a'} mcScreenPF120=${report.monteCarlo ? pct(report.monteCarlo.probPfGteScreen) : 'n/a'} ` +
      `feeBook=${k.feeBookBpsPerSide}bps cooldownBars=${k.cooldownBars} fixtureDir=${r.fixtureDir}`,
  );
  return out.join('\n');
}
