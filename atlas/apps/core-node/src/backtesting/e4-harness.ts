/**
 * E4 multi-timeframe FeeModel expectancy harness (TASK_018 E4, TM-corrected).
 *
 * One invocation = ONE timeframe. Desk run order: 4H first (month-block MC
 * default) → 1D next (EXPLORATORY unless E[n] ≥ 100) → 1H demoted (never
 * GO-eligible here; zero-fee fail-fast 2.25; not a marketable-fill lead).
 * 15m is refused: FeeModel 15m spot trend_follow is NO-GO per desk.
 *
 * Pipeline per run (fail-fast, in this order):
 *   0. Data: fail-closed loader, DATA stamp. SYNTHETIC ⇒ VOID, nothing else runs.
 *   1. Zero-fee pass (commission 0, EV gate off) ⇒ raw-signal PF. If n is
 *      below `minZeroFeeTrades` ⇒ INCONCLUSIVE; if PF < TF threshold
 *      (1H 2.25 · 4H 1.61 · 1D 1.44, live-readiness audit §4.1) ⇒ NO-GO.
 *      Fee pass and Monte Carlo are skipped on either.
 *   2. Fee pass at the tier-consistent FeeModel (EV gate = live parity by
 *      default) ⇒ expectancy stats, E[n] (12-month trade count), gates.
 *   3. Monte Carlo bootstrap on the fee-pass trades (month-block on 4H).
 *
 * LABEL LOCK (desk, 2026-09-10): the run label is DERIVED from the data,
 * never asserted by the operator. REAL data over ≥ `minFullWindowDays`
 * (default 365) is a full window and receives a grade
 * (GO-ELIGIBLE / NO-GO / EXPLORATORY / INCONCLUSIVE). Anything shorter is
 * `SMOKE ONLY` — stats are printed for pipeline validation but NO grade is
 * issued and the numbers must not be packaged as a screen or preflight.
 *
 * No new dependencies. Financial arithmetic here is on already-realized
 * backtest P&L (floats from the engine); nothing flows to execution.
 */

import type { Logger } from '../core/logger';
import type { GuardrailConfig } from '../config/loadGuardrails';
import type { MarketVenue } from '../trading/execution/venue-capabilities';
import type { BacktestConfig, BacktestResult, BacktestTrade, EvGateMode } from './backtest-engine';
import type { BacktestDataOptions, BacktestRunner, FeeTierLabel, SavedBacktestPaths } from './backtest-runner';
import type { DataProvenance } from './data-loader';
import type { SeriesProvider } from './bar-aggregation';
import { buildBacktestConfig, buildFeeModel, resolveFeeTier, type StrategySelector } from './backtest-cli-config';

// ---------------------------------------------------------------------------
// Timeframe policy
// ---------------------------------------------------------------------------

export type E4Timeframe = '4h' | '1d' | '1h';
export type McBlockMode = 'month' | 'trade' | 'none';

export interface E4TimeframePolicy {
  tf: E4Timeframe;
  barMinutes: 60 | 240 | 1440;
  /** Desk run order (1 = first). */
  order: number;
  status: 'primary' | 'secondary' | 'demoted';
  /** Zero-fee PF needed for PF 1.2 at 40 bps (live-readiness audit §4.1). */
  zeroFeePfMin: number;
  /** Tier a $1K account would actually be in at this frequency (TASK_018 E4). */
  defaultFeeTier: 'intro1' | 't1k';
  defaultMcBlock: McBlockMode;
  /** Minimum expected 12-month trade count for GO eligibility. */
  minExpectedTrades: number;
  /** Whether this TF can ever be GO-ELIGIBLE from this harness. */
  goEligible: boolean;
  note: string;
}

export const E4_TF_POLICY: Record<E4Timeframe, E4TimeframePolicy> = {
  '4h': {
    tf: '4h', barMinutes: 240, order: 1, status: 'primary', zeroFeePfMin: 1.61,
    defaultFeeTier: 'intro1', defaultMcBlock: 'month', minExpectedTrades: 60, goEligible: true,
    note: '4H first. Month-block bootstrap default. Gate set: PF ≥ 1.20, E[n] ≥ 60/12m, maxDD ≤ 15%, ≥ 3/4 window-quarters PF ≥ 1.0.',
  },
  '1d': {
    tf: '1d', barMinutes: 1440, order: 2, status: 'secondary', zeroFeePfMin: 1.44,
    defaultFeeTier: 'intro1', defaultMcBlock: 'trade', minExpectedTrades: 100, goEligible: true,
    note: '1D next. EXPLORATORY if E[n] < 100; GO-eligible only if E[n] ≥ 100 (TM). Trade-level bootstrap default (≈1–3 trades/month makes month blocks degenerate).',
  },
  '1h': {
    tf: '1h', barMinutes: 60, order: 3, status: 'demoted', zeroFeePfMin: 2.25,
    defaultFeeTier: 't1k', defaultMcBlock: 'month', minExpectedTrades: 60, goEligible: false,
    note: '1H DEMOTED: GO-ineligible until the multi-ATR/maker path is proven (E5/E6). Marketable-fill assumption. Do not lead with 1H.',
  },
};

/** Parse `--tf`. Accepts 4h|1d|1h (case-insensitive) or 240|1440|60. 15m is refused. */
export function parseTimeframe(raw: string | number): E4Timeframe {
  const s = String(raw).trim().toLowerCase();
  if (s === '4h' || s === '240' || s === '240m') return '4h';
  if (s === '1d' || s === '1440' || s === '1440m' || s === '24h') return '1d';
  if (s === '1h' || s === '60' || s === '60m') return '1h';
  if (s === '15m' || s === '15') {
    throw new Error('15m is NOT an E4 timeframe: FeeModel 15m spot trend_follow is NO-GO per desk (no 15m work). Use --tf 4h | 1d | 1h.');
  }
  throw new Error(`Unknown --tf "${raw}". Use 4h | 1d | 1h (or 240 | 1440 | 60).`);
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
  feeTier: FeeTierLabel;
  /** EV-gate mode for the FEE pass (the zero-fee pass always runs `off`). */
  evGateMode: EvGateMode;
  regimeGates: boolean;
  venueOverride?: MarketVenue;
  /** Loader options (fixtureDir lives on the runner). Never allowSynthetic. */
  data: Pick<BacktestDataOptions, 'minCoverage' | 'minBucketFill' | 'granularitySeconds'>;
  mc: { runs: number; block: McBlockMode; seed: number };
  /** Overrides for the policy thresholds (report always prints the effective value). */
  zeroFeePfMin?: number;
  minZeroFeeTrades: number;
  minExpectedTrades?: number;
  /** Window length (days) below which the run is SMOKE ONLY (default 365). */
  minFullWindowDays: number;
  /** SMOKE ONLY runs: keep going past a fail-fast so every stage is exercised. */
  smokeRunAllStages: boolean;
}

export type E4Label = 'SMOKE' | 'FULL' | 'VOID';
export type E4Verdict = 'GO-ELIGIBLE' | 'NO-GO' | 'EXPLORATORY' | 'INCONCLUSIVE' | 'SMOKE ONLY' | 'VOID';

export interface QuarterStat {
  index: number;
  start: string;
  end: string;
  n: number;
  netProfit: number;
  /** null when no losing trades and no winning trades (n = 0). */
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
  /** mean / (std / √n); null when n < 2 or std = 0. */
  tStatPnl: number | null;
  meanR: number;
  stdR: number;
  tStatR: number | null;
  /** avgWin / avgLoss; null when there are no losses or no wins. */
  payoffRatio: number | null;
  averageWin: number;
  averageLoss: number;
  totalFees: number;
  feesPerTrade: number;
  /** totalFees / grossProfit; null when grossProfit = 0. */
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
  /** n × 365.25 / windowDays — the E[n] the 1D GO gate reads. */
  expectedTrades12m: number;
  firstTradeAt: string | null;
  lastTradeAt: string | null;
}

export interface MonteCarloSummary {
  block: McBlockMode;
  runs: number;
  seed: number;
  /** Number of resampling units (month blocks or trades). */
  blocks: number;
  net: { p05: number; p50: number; p95: number; mean: number };
  meanR: { p05: number; p50: number; p95: number };
  profitFactor: { p05: number; p50: number; p95: number };
  maxDrawdownPct: { p50: number; p95: number; max: number };
  probNetLeqZero: number;
}

export interface E4Gate {
  id: string;
  label: string;
  value: string;
  threshold: string;
  status: 'pass' | 'fail' | 'n/a' | 'info';
  /** Hard gates decide GO/NO-GO; info gates are reported only. */
  hard: boolean;
  note?: string;
}

export interface E4PassSummary {
  metrics: Pick<BacktestResult['metrics'], 'totalTrades' | 'profitFactor' | 'winRate' | 'netProfit' | 'totalFees' | 'maxDrawdownPercent' | 'returnPercent' | 'longEntries' | 'shortEntries' | 'shortBlocked' | 'sellSignalExits' | 'evGate' | 'activeStrategies'>;
  stats: ExpectancyStats;
  fees: BacktestResult['fees'];
  saved: SavedBacktestPaths | null;
  trades: Array<{ product: string; strategy: string; side: string; entry: string; exit: string | null; pnl: number; r: number; exitReason: string }>;
}

export interface E4Report {
  harness: 'e4-multi-tf-feemodel';
  version: 1;
  generatedAt: string;
  label: E4Label;
  labelLine: string;
  verdict: E4Verdict;
  reasons: string[];
  tf: E4Timeframe;
  barMinutes: number;
  policy: E4TimeframePolicy;
  request: {
    startDate: string; endDate: string; windowDays: number; products: string[]; strategy: string;
    initialCapital: number; feeTier: FeeTierLabel; evGateMode: EvGateMode; regimeGates: boolean;
    venueOverride: MarketVenue | 'per-symbol'; mc: E4Request['mc']; zeroFeePfMin: number;
    minZeroFeeTrades: number; minExpectedTrades: number; minFullWindowDays: number; smokeRunAllStages: boolean;
    data: E4Request['data'];
  };
  data: { stamp: 'REAL' | 'SYNTHETIC'; provenance: Record<string, DataProvenance>; venueBySymbol: Record<string, MarketVenue> };
  zeroFee: (E4PassSummary & { threshold: number; passed: boolean | null; failFast: 'none' | 'inconclusive' | 'pf'; frequency: TradeFrequency }) | null;
  fee: (E4PassSummary & { frequency: TradeFrequency; quarters: QuarterStat[]; quartersPassing: number; quartersEvaluable: boolean }) | null;
  monteCarlo: MonteCarloSummary | null;
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

/** Sample standard deviation (n − 1). 0 when n < 2. */
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

/**
 * Expectancy statistics for a closed-trade set. Win = pnl > 0 (matches the
 * engine's classification). Everything is derived from the trades so the
 * harness never depends on the engine's `profitFactor: 0 when no losses`
 * quirk.
 */
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

/**
 * Split the run window into 4 equal segments ("window quarters") and score
 * each by the trades that EXITED inside it. Deterministic and independent
 * of calendar alignment, so a 2025-03-05 → 2026-03-05 holdout yields exactly
 * four comparable segments.
 */
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
    out.push({
      index: i + 1,
      start: new Date(qStart).toISOString(),
      end: new Date(qEnd).toISOString(),
      n: g.n,
      netProfit: g.netProfit,
      profitFactor: g.profitFactor,
    });
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
 * Bootstrap the fee-pass trade set.
 *   month — resample calendar-month blocks (by exit month) with replacement,
 *           preserving intra-month sequence/clustering (4H default).
 *   trade — i.i.d. trade resampling (1D default).
 * Each replicate: net $, mean R, PF, and max drawdown % on the cumulative
 * P&L path from `initialCapital` (realized P&L as-is; sizing is not
 * re-compounded — an approximation, stated in the report).
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
    nets.push(net);
    meanRs.push(count ? rSum / count : 0);
    pfs.push(gl > 0 ? gp / gl : gp > 0 ? Infinity : 0);
    dds.push(maxDd);
    if (net <= 0) leq0 += 1;
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
  };
}

// ---------------------------------------------------------------------------
// Label / gates / verdict (pure)
// ---------------------------------------------------------------------------

/** Derive the run label from data stamp + window length. Never operator-asserted. */
export function deriveLabel(stamp: 'REAL' | 'SYNTHETIC', windowDays: number, minFullWindowDays: number): { label: E4Label; line: string } {
  if (stamp === 'SYNTHETIC') {
    return { label: 'VOID', line: 'VOID — DATA: SYNTHETIC (SMOKE/VOID; random-walk candles; not evidence of anything)' };
  }
  if (windowDays < minFullWindowDays) {
    return {
      label: 'SMOKE',
      line: `SMOKE ONLY — NOT screen, NOT holdout, NOT Beta hard-preflight (window ${windowDays.toFixed(1)}d < ${minFullWindowDays}d; no grade issued)`,
    };
  }
  return { label: 'FULL', line: `FULL WINDOW — DATA: REAL, ${windowDays.toFixed(1)}d ≥ ${minFullWindowDays}d (grade issued below)` };
}

function fmt(x: number | null | undefined, digits = 2): string {
  if (x === null || x === undefined || Number.isNaN(x)) return 'n/a';
  if (x === Infinity) return '∞';
  if (x === -Infinity) return '-∞';
  return x.toFixed(digits);
}

export interface VerdictInput {
  label: E4Label;
  policy: E4TimeframePolicy;
  /**
   * `frequency` is the zero-fee E[n] — an UPPER bound on the tier E[n]
   * (the EV gate only removes entries), used for the 1D rule when the fee
   * pass was skipped by the fail-fast.
   */
  zeroFee: { n: number; profitFactor: number | null; threshold: number; minTrades: number; frequency: TradeFrequency } | null;
  fee: {
    stats: ExpectancyStats;
    maxDrawdownPct: number;
    frequency: TradeFrequency;
    quarters: QuarterStat[];
    quartersEvaluable: boolean;
    shortEntries: number;
  } | null;
  mc: MonteCarloSummary | null;
  minExpectedTrades: number;
  stamp: 'REAL' | 'SYNTHETIC';
}

/**
 * Build the gate table and the verdict. Hard gates (PF, E[n], maxDD,
 * window-quarters, REAL data, long-only) decide GO/NO-GO on FULL windows.
 * SMOKE windows get the same table but the verdict is `SMOKE ONLY`.
 */
export function evaluateVerdict(input: VerdictInput): { verdict: E4Verdict; reasons: string[]; gates: E4Gate[] } {
  const gates: E4Gate[] = [];
  const reasons: string[] = [];
  const { policy } = input;

  gates.push({
    id: 'data_real', label: 'Data 100% REAL (no synthetic)', value: input.stamp, threshold: 'REAL', hard: true,
    status: input.stamp === 'REAL' ? 'pass' : 'fail',
  });

  if (input.zeroFee) {
    const z = input.zeroFee;
    const enough = z.n >= z.minTrades;
    gates.push({
      id: 'zero_fee_n', label: 'Zero-fee pass trade count (fail-fast precondition)', value: String(z.n),
      threshold: `≥ ${z.minTrades}`, hard: true, status: enough ? 'pass' : 'fail',
      note: enough ? undefined : 'INCONCLUSIVE — too few zero-fee trades to evaluate PF',
    });
    const pfOk = z.profitFactor !== null && z.profitFactor >= z.threshold;
    gates.push({
      id: 'zero_fee_pf', label: `Zero-fee PF fail-fast (${policy.tf})`, value: fmt(z.profitFactor), threshold: `≥ ${z.threshold}`,
      hard: true, status: !enough ? 'n/a' : pfOk ? 'pass' : 'fail',
      note: 'Raw signal edge before fees; below threshold the fee pass and MC are not run.',
    });
  }

  if (input.fee) {
    const f = input.fee;
    const pf = f.stats.profitFactor;
    gates.push({ id: 'fee_pf', label: 'Fee-pass PF', value: fmt(pf), threshold: '≥ 1.20', hard: true, status: pf !== null && pf >= 1.2 ? 'pass' : 'fail' });
    gates.push({
      id: 'expected_trades', label: 'E[n] (12-month expected trades)', value: `${f.frequency.expectedTrades12m.toFixed(1)} (n=${f.frequency.n} over ${f.frequency.windowDays.toFixed(1)}d)`,
      threshold: `≥ ${input.minExpectedTrades}`, hard: true, status: f.frequency.expectedTrades12m >= input.minExpectedTrades ? 'pass' : 'fail',
    });
    gates.push({ id: 'max_dd', label: 'Max drawdown', value: `${(f.maxDrawdownPct * 100).toFixed(2)}%`, threshold: '≤ 15%', hard: true, status: f.maxDrawdownPct <= 0.15 ? 'pass' : 'fail' });
    const passing = f.quarters.filter((q) => q.profitFactor !== null && q.profitFactor >= 1.0).length;
    gates.push({
      id: 'quarters', label: 'Window-quarters with PF ≥ 1.0', value: `${passing}/4 (n per quarter: ${f.quarters.map((q) => q.n).join('/')})`, threshold: '≥ 3/4',
      hard: true, status: !f.quartersEvaluable ? 'n/a' : passing >= 3 ? 'pass' : 'fail',
      note: f.quartersEvaluable ? undefined : 'Not evaluable: window shorter than 12 months.',
    });
    gates.push({ id: 'long_only', label: 'Long-only spot (short entries)', value: String(f.shortEntries), threshold: '= 0', hard: true, status: f.shortEntries === 0 ? 'pass' : 'fail' });
    gates.push({ id: 't_stat_r', label: 't-stat of mean R per trade', value: fmt(f.stats.tStatR), threshold: '≥ 2 ≈ proof; PF 1.2 on 60 trades is a screen', hard: false, status: 'info' });
    if (input.mc) {
      gates.push({
        id: 'mc_prob_loss', label: `MC P(net ≤ 0) [${input.mc.block}-block, ${input.mc.runs} runs]`, value: `${(input.mc.probNetLeqZero * 100).toFixed(1)}%`,
        threshold: 'reported, not gated', hard: false, status: 'info',
      });
    }
  }

  // ---- verdict ----------------------------------------------------------
  if (input.stamp === 'SYNTHETIC') {
    reasons.push('DATA: SYNTHETIC — run is VOID.');
    return { verdict: 'VOID', reasons, gates };
  }
  if (input.label === 'SMOKE') {
    reasons.push('Window shorter than the full-window minimum: SMOKE ONLY, no grade issued (desk label lock 2026-09-10).');
    reasons.push('Numbers above validate the pipeline; they are not a screen, holdout, or Beta hard-preflight.');
    return { verdict: 'SMOKE ONLY', reasons, gates };
  }
  if (input.zeroFee && input.zeroFee.n < input.zeroFee.minTrades) {
    reasons.push(`Zero-fee pass produced n=${input.zeroFee.n} < ${input.zeroFee.minTrades}: nothing to evaluate.`);
    return { verdict: 'INCONCLUSIVE', reasons, gates };
  }

  // TM rule, unconditional: 1D with E[n] < threshold is EXPLORATORY — too
  // few trades to read as GO *or* NO-GO. Other findings are kept as context.
  const eN = input.fee ? input.fee.frequency.expectedTrades12m : input.zeroFee?.frequency.expectedTrades12m;
  if (policy.tf === '1d' && eN !== undefined && eN < input.minExpectedTrades) {
    reasons.push(
      `1D E[n] ${eN.toFixed(1)} < ${input.minExpectedTrades} (${input.fee ? 'fee pass' : 'zero-fee pass, upper bound'}): EXPLORATORY by TM rule — GO-eligible only if E[n] ≥ ${input.minExpectedTrades}.`,
    );
    for (const g of gates.filter((x) => x.hard && x.status === 'fail')) {
      reasons.push(`(context) gate would fail: ${g.label} = ${g.value} (need ${g.threshold}).`);
    }
    return { verdict: 'EXPLORATORY', reasons, gates };
  }

  if (input.zeroFee) {
    if (input.zeroFee.profitFactor === null || input.zeroFee.profitFactor < input.zeroFee.threshold) {
      reasons.push(`Zero-fee PF ${fmt(input.zeroFee.profitFactor)} < ${input.zeroFee.threshold} (${policy.tf} fail-fast): no raw edge to pay fees with.`);
      return { verdict: 'NO-GO', reasons, gates };
    }
    reasons.push(`Zero-fee PF ${fmt(input.zeroFee.profitFactor)} ≥ ${input.zeroFee.threshold}: fail-fast passed.`);
  }
  if (!input.fee) {
    reasons.push('Fee pass did not run.');
    return { verdict: 'INCONCLUSIVE', reasons, gates };
  }
  const hardFails = gates.filter((g) => g.hard && g.status === 'fail');
  if (hardFails.length > 0) {
    for (const g of hardFails) reasons.push(`Gate failed: ${g.label} = ${g.value} (need ${g.threshold}).`);
    return { verdict: 'NO-GO', reasons, gates };
  }
  if (!policy.goEligible) {
    reasons.push(`${policy.tf.toUpperCase()} is demoted: GO-ineligible from this harness until the multi-ATR/maker path is proven (E5/E6).`);
    return { verdict: 'EXPLORATORY', reasons, gates };
  }
  const notEvaluable = gates.filter((g) => g.hard && g.status === 'n/a');
  if (notEvaluable.length > 0) {
    for (const g of notEvaluable) reasons.push(`Gate not evaluable: ${g.label}${g.note ? ` — ${g.note}` : ''}`);
    return { verdict: 'EXPLORATORY', reasons, gates };
  }
  reasons.push('All hard gates passed at the tier-consistent fee on a full REAL window. Desk GO remains a human decision.');
  return { verdict: 'GO-ELIGIBLE', reasons, gates };
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

/**
 * Run the E4 pipeline for one timeframe. `runner` must already point at the
 * data source (fixtureDir or Supabase); `--allow-synthetic` is deliberately
 * not reachable from here.
 */
export async function runE4(
  request: E4Request,
  runner: BacktestRunner,
  guardrails: GuardrailConfig,
  logger: Logger,
): Promise<E4Report> {
  const policy = E4_TF_POLICY[request.tf];
  const zeroFeePfMin = request.zeroFeePfMin ?? policy.zeroFeePfMin;
  const minExpectedTrades = request.minExpectedTrades ?? policy.minExpectedTrades;
  const windowDays = Math.max(0, (request.endDate.getTime() - request.startDate.getTime()) / DAY_MS);

  const dataOptions: BacktestDataOptions = {
    ...request.data,
    allowSynthetic: false,
    barMinutes: policy.barMinutes,
  };
  const provider = memoizeProvider(runner.createDataProvider(dataOptions));

  const baseInput = {
    startDate: request.startDate,
    endDate: request.endDate,
    initialCapital: request.initialCapital,
    products: request.products,
    strategy: request.strategy,
    venueOverride: request.venueOverride,
    regimeGates: request.regimeGates,
  };
  const feeModel = buildFeeModel(guardrails, request.feeTier);

  logger.info('E4 harness: stage 1 — zero-fee pass', { tf: request.tf, barMinutes: policy.barMinutes, products: request.products });
  const zeroFeeConfig: BacktestConfig = buildBacktestConfig(
    { ...baseInput, feeModel, commissionOverride: 0, evGateMode: 'off' },
    guardrails,
  );
  const zeroFeeRun = await runner.runBacktestDetailed(
    zeroFeeConfig, dataOptions, { feeTier: { name: 'zero-fee pass (commission 0)', makerBps: 0, takerBps: 0 } }, provider,
  );
  const stamp = zeroFeeRun.result.dataStamp;
  const { label, line: labelLine } = deriveLabel(stamp, windowDays, request.minFullWindowDays);
  const zeroFeeSummary = summarizePass(zeroFeeRun.result, zeroFeeRun.saved);
  const zeroFeeFrequency = computeTradeFrequency(zeroFeeRun.result.trades, request.startDate, request.endDate);
  const zPf = zeroFeeSummary.stats.profitFactor;
  const zEnough = zeroFeeSummary.stats.n >= request.minZeroFeeTrades;
  const zPass = !zEnough ? null : zPf !== null && zPf >= zeroFeePfMin;
  const failFast: 'none' | 'inconclusive' | 'pf' = !zEnough ? 'inconclusive' : zPass ? 'none' : 'pf';

  let fee: E4Report['fee'] = null;
  let monteCarlo: MonteCarloSummary | null = null;
  const continueToFee =
    stamp === 'REAL' && (failFast === 'none' || (label === 'SMOKE' && request.smokeRunAllStages));

  if (continueToFee) {
    if (failFast !== 'none') {
      logger.warn('E4 harness: SMOKE ONLY run continuing past fail-fast because --smoke-run-all-stages is set', { failFast });
    }
    logger.info('E4 harness: stage 2 — fee pass', { feeTier: request.feeTier, evGateMode: request.evGateMode });
    const feeConfig: BacktestConfig = buildBacktestConfig(
      { ...baseInput, feeModel, evGateMode: request.evGateMode },
      guardrails,
    );
    const feeRun = await runner.runBacktestDetailed(feeConfig, dataOptions, { feeTier: request.feeTier }, provider);
    const summary = summarizePass(feeRun.result, feeRun.saved);
    const quarters = computeWindowQuarters(feeRun.result.trades, request.startDate, request.endDate);
    fee = {
      ...summary,
      frequency: computeTradeFrequency(feeRun.result.trades, request.startDate, request.endDate),
      quarters,
      quartersPassing: quarters.filter((q) => q.profitFactor !== null && q.profitFactor >= 1.0).length,
      quartersEvaluable: windowDays >= request.minFullWindowDays,
    };
    logger.info('E4 harness: stage 3 — Monte Carlo', { block: request.mc.block, runs: request.mc.runs, seed: request.mc.seed });
    monteCarlo = runMonteCarlo(feeRun.result.trades, { ...request.mc, initialCapital: request.initialCapital });
  } else {
    logger.warn('E4 harness: fee pass and Monte Carlo skipped', { stamp, failFast, label });
  }

  const evaluation = evaluateVerdict({
    label,
    policy,
    stamp,
    minExpectedTrades,
    zeroFee: { n: zeroFeeSummary.stats.n, profitFactor: zPf, threshold: zeroFeePfMin, minTrades: request.minZeroFeeTrades, frequency: zeroFeeFrequency },
    fee: fee
      ? {
          stats: fee.stats, maxDrawdownPct: fee.metrics.maxDrawdownPercent, frequency: fee.frequency,
          quarters: fee.quarters, quartersEvaluable: fee.quartersEvaluable, shortEntries: fee.metrics.shortEntries,
        }
      : null,
    mc: monteCarlo,
  });

  return {
    harness: 'e4-multi-tf-feemodel',
    version: 1,
    generatedAt: new Date().toISOString(),
    label,
    labelLine,
    verdict: evaluation.verdict,
    reasons: evaluation.reasons,
    tf: request.tf,
    barMinutes: policy.barMinutes,
    policy,
    request: {
      startDate: request.startDate.toISOString(), endDate: request.endDate.toISOString(), windowDays,
      products: request.products, strategy: String(request.strategy), initialCapital: request.initialCapital,
      feeTier: request.feeTier, evGateMode: request.evGateMode, regimeGates: request.regimeGates,
      venueOverride: request.venueOverride ?? 'per-symbol', mc: request.mc, zeroFeePfMin,
      minZeroFeeTrades: request.minZeroFeeTrades, minExpectedTrades, minFullWindowDays: request.minFullWindowDays,
      smokeRunAllStages: request.smokeRunAllStages, data: request.data,
    },
    data: { stamp, provenance: zeroFeeRun.result.dataProvenance, venueBySymbol: zeroFeeRun.result.venueBySymbol },
    zeroFee: { ...zeroFeeSummary, threshold: zeroFeePfMin, passed: zPass, failFast, frequency: zeroFeeFrequency },
    fee,
    monteCarlo,
    gates: evaluation.gates,
  };
}

/** Resolve the fee tier for a TF: explicit flag wins, else the policy default. */
export function resolveE4FeeTier(tf: E4Timeframe, flag: string | undefined, guardrails: GuardrailConfig): FeeTierLabel {
  return resolveFeeTier(flag ?? E4_TF_POLICY[tf].defaultFeeTier, guardrails.fees.coinbase.spot);
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
    `  maxDD=${pct(pass.metrics.maxDrawdownPercent)}  return=${pass.metrics.returnPercent.toFixed(2)}%  EV gate: mode=${pass.metrics.evGate.mode} evaluated=${pass.metrics.evGate.evaluated} rejected=${pass.metrics.evGate.rejected}  SELLs blocked (spot)=${pass.metrics.shortBlocked}`,
    `  exits: ${Object.entries(s.exitReasons).map(([k, v]) => `${k}=${v}`).join(', ') || 'none'}`,
    `  by symbol: ${Object.entries(s.bySymbol).map(([k, v]) => `${k} n=${v.n} PF=${fmt(v.profitFactor)} net=$${v.netProfit.toFixed(2)} meanR=${v.meanR.toFixed(2)}`).join(' | ') || 'none'}`,
    `  by strategy: ${Object.entries(s.byStrategy).map(([k, v]) => `${k} n=${v.n} PF=${fmt(v.profitFactor)} net=$${v.netProfit.toFixed(2)} meanR=${v.meanR.toFixed(2)}`).join(' | ') || 'none'}`,
  ];
  if (pass.saved) lines.push(`  backtest artefacts: ${pass.saved.jsonPath}`);
  return lines;
}

/** Human-readable report. Line 1 is ALWAYS the derived label. */
export function renderE4Report(report: E4Report): string {
  const r = report.request;
  const out: string[] = [];
  out.push(report.labelLine);
  out.push(`DATA: ${report.data.stamp}`);
  out.push(`E4 FeeModel expectancy harness — TF=${report.tf.toUpperCase()} (${report.barMinutes}m bars) [${report.policy.status.toUpperCase()}, desk run order ${report.policy.order}/3]`);
  out.push(`Policy: ${report.policy.note}`);
  out.push(`Window: ${r.startDate} → ${r.endDate} (${r.windowDays.toFixed(1)} days)   Products: ${r.products.join(', ')}   Strategy: ${r.strategy}   Venue: ${Object.entries(report.data.venueBySymbol).map(([k, v]) => `${k}=${v}`).join(', ')}`);
  out.push(`Fee tier (fee pass): ${r.feeTier.name} (maker ${r.feeTier.makerBps} / taker ${r.feeTier.takerBps} bps; taker charged per fill)   EV gate (fee pass): ${r.evGateMode}   Regime gates: ${r.regimeGates ? 'on' : 'off'}   Initial capital: $${r.initialCapital}`);
  for (const p of Object.values(report.data.provenance)) {
    const agg = p.aggregation && p.aggregation.subBarsPerBucket > 1
      ? ` aggregated=${p.aggregation.sourceMinutes}m→${p.aggregation.targetMinutes}m (src=${p.aggregation.sourceCandleCount}, dropped=${p.aggregation.bucketsDropped})`
      : '';
    out.push(`Data source ${p.symbol}: ${p.source} bars=${p.candleCount}/${p.expectedCount} coverage=${(p.coverage * 100).toFixed(1)}% spacing=${p.inferredBarMinutes ?? 'n/a'}m first=${p.firstBarTime ?? 'n/a'} last=${p.lastBarTime ?? 'n/a'}${agg}${p.fixtureSha256 ? ` sha256=${p.fixtureSha256.slice(0, 12)}` : ''}${p.source === 'synthetic' ? ' [SYNTHETIC — VOID]' : ''}`);
  }
  out.push('');
  if (report.zeroFee) {
    const z = report.zeroFee;
    out.push(...renderPassStats(`Stage 1 — zero-fee PF fail-fast (commission 0, EV gate off)   threshold PF ≥ ${z.threshold}  min trades ${r.minZeroFeeTrades}  → ${z.failFast === 'inconclusive' ? 'INCONCLUSIVE (too few trades)' : z.failFast === 'pf' ? 'FAIL (fee pass + MC skipped)' : 'PASS'}`, z));
    out.push(`  zero-fee E[n] (12m, upper bound) = ${z.frequency.expectedTrades12m.toFixed(1)}  from n=${z.frequency.n} over ${z.frequency.windowDays.toFixed(1)} days (${z.frequency.tradesPerMonth.toFixed(2)} trades/month)`);
    out.push('');
  }
  if (report.fee) {
    const f = report.fee;
    out.push(...renderPassStats(`Stage 2 — FeeModel expectancy @ ${r.feeTier.name} (EV gate ${r.evGateMode})`, f));
    out.push(`  E[n] (12m) = ${f.frequency.expectedTrades12m.toFixed(1)}  from n=${f.frequency.n} over ${f.frequency.windowDays.toFixed(1)} days (${f.frequency.tradesPerMonth.toFixed(2)} trades/month)   first trade ${f.frequency.firstTradeAt ?? 'n/a'}   last ${f.frequency.lastTradeAt ?? 'n/a'}`);
    out.push(`  window quarters (by exit): ${f.quarters.map((q) => `Q${q.index} ${q.start.slice(0, 10)}→${q.end.slice(0, 10)} n=${q.n} PF=${fmt(q.profitFactor)} net=$${q.netProfit.toFixed(2)}`).join(' | ')}${f.quartersEvaluable ? '' : '   [not evaluable: window < 12 months]'}`);
    out.push('');
  } else {
    out.push(`Stage 2 — fee pass: SKIPPED (${report.zeroFee?.failFast === 'inconclusive' ? 'zero-fee pass inconclusive' : report.zeroFee?.failFast === 'pf' ? 'zero-fee PF fail-fast' : 'data not REAL'})`);
    out.push('');
  }
  if (report.monteCarlo) {
    const m = report.monteCarlo;
    out.push(`Stage 3 — Monte Carlo bootstrap (${m.block}-block, ${m.runs} runs, seed ${m.seed}, ${m.blocks} resampling units; realized P&L path from $${r.initialCapital}, sizing not re-compounded)`);
    out.push(`  net$ p05/p50/p95 = ${m.net.p05.toFixed(2)} / ${m.net.p50.toFixed(2)} / ${m.net.p95.toFixed(2)} (mean ${m.net.mean.toFixed(2)})   P(net ≤ 0) = ${pct(m.probNetLeqZero)}`);
    out.push(`  meanR p05/p50/p95 = ${m.meanR.p05.toFixed(3)} / ${m.meanR.p50.toFixed(3)} / ${m.meanR.p95.toFixed(3)}   PF p05/p50/p95 = ${fmt(m.profitFactor.p05)} / ${fmt(m.profitFactor.p50)} / ${fmt(m.profitFactor.p95)}   maxDD p50/p95/max = ${pct(m.maxDrawdownPct.p50)} / ${pct(m.maxDrawdownPct.p95)} / ${pct(m.maxDrawdownPct.max)}`);
    out.push('');
  } else if (report.fee) {
    out.push(`Stage 3 — Monte Carlo: SKIPPED (${r.mc.block === 'none' ? '--mc-block none' : 'no fee-pass trades'})`);
    out.push('');
  }
  out.push('Gates:');
  for (const g of report.gates) {
    out.push(`  [${g.status.toUpperCase().padEnd(4)}] ${g.hard ? 'HARD' : 'INFO'}  ${g.label}: ${g.value}  (need ${g.threshold})${g.note ? `  — ${g.note}` : ''}`);
  }
  out.push('');
  out.push(`VERDICT: ${report.verdict}`);
  for (const reason of report.reasons) out.push(`  - ${reason}`);
  out.push('');
  const z = report.zeroFee;
  const f = report.fee;
  out.push(
    `E4_RESULT tf=${report.tf} label=${report.label} verdict="${report.verdict}" data=${report.data.stamp} ` +
      `zeroFeeN=${z ? z.stats.n : 'n/a'} zeroFeePF=${z ? fmt(z.stats.profitFactor) : 'n/a'} zeroFeeMin=${z ? z.threshold : 'n/a'} ` +
      `feeN=${f ? f.stats.n : 'n/a'} feePF=${f ? fmt(f.stats.profitFactor) : 'n/a'} feeMeanR=${f ? f.stats.meanR.toFixed(3) : 'n/a'} ` +
      `E_n_12m=${f ? f.frequency.expectedTrades12m.toFixed(1) : 'n/a'} maxDD=${f ? pct(f.metrics.maxDrawdownPercent) : 'n/a'} ` +
      `mcProbLoss=${report.monteCarlo ? pct(report.monteCarlo.probNetLeqZero) : 'n/a'} feeTier=${r.feeTier.name}`,
  );
  return out.join('\n');
}
