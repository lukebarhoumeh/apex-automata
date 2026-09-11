/**
 * H1 Apex Trend v1 — minimal research harness (SHORT DRY-RUN ONLY).
 *
 * Daily multi-speed MA ensemble on closes. Each speed votes −1/0/+1 on
 * sign(close − MA); the plain average of the votes is the direction once it
 * clears the no-trade band. Exits are signal reversal OR a daily ATR trail.
 * Sizing is a per-sleeve vol target with a hard leverage cap. Fills are the
 * NEXT bar's close (lag-1) — there is no maker-fill simulation here, so the
 * cost label is a bps-per-side bracket, nothing more.
 *
 * This module is research-only: it is not a strategy plugin, it is not
 * registered anywhere, and nothing in `atlas/config/**` reads it. The variant
 * is frozen (`H1_VARIANT`) on purpose — the card is one default variant, not
 * a grid. P&L is float like `backtest-engine.ts`; this is a research
 * estimate, not a ledger.
 *
 * NOT GO · NOT SEALED · NOT RESEARCH-PASS.
 */

/** Banner printed first and last on every run. */
export const H1_BANNER = 'H1 SHORT DRY-RUN — NOT GO · NOT SEALED · NOT RESEARCH-PASS';

/** Frozen default variant (1 of ≤12). No CLI knob exposes any of these. */
export const H1_VARIANT = Object.freeze({
  id: 'A1/B1/C3.0/D0.25',
  /** A1 — MA speeds (bars) on daily closes. */
  maSpeeds: Object.freeze([20, 50, 100, 200]) as readonly number[],
  /** B1 — plain (unweighted) average of the per-speed votes. */
  vote: 'plain_average' as const,
  /** C — daily ATR trail multiple. */
  trailAtrMultiple: 3.0,
  /** D — no-trade band on the averaged vote (|avg| ≤ band ⇒ no new direction). */
  noTradeBand: 0.25,
  /** Wilder ATR period (daily bars). Codebase default (`ValidatedIndicators.ATR`). */
  atrPeriod: 14,
  /** Realised-vol lookback (daily log returns) for the vol target. */
  volLookbackDays: 30,
  /** Annualised vol target per sleeve. */
  volTargetAnnual: 0.2,
  /** Hard leverage cap per sleeve (UI 4.1× ignored per card). */
  leverageCap: 2.0,
  /** Sleeve capital weight = 1/N for the BTC+ETH universe. */
  sleeveWeight: 0.5,
  /** 24/7 venue ⇒ 365 return days per year. */
  annualizationDays: 365,
  /** Signals decided on close[t], filled at close[t+1] (maker sim missing). */
  fillRule: 'next_bar_close' as const,
  /** No fixed take-profit anywhere in the design. */
  fixedTakeProfit: false,
  timeframe: 'daily' as const,
  universe: Object.freeze(['BTC-USD', 'ETH-USD']) as readonly string[],
});

/**
 * Fee sheet reference for the cost label. The cited sheet is NOT on the box
 * (searched `/workspace`, `origin/main`, all branches — no `CFM-NANO-H1-v0.1`,
 * no "Research v0.2" brackets). Every bps number below is therefore a
 * PLACEHOLDER bracket and is labelled UNVERIFIED wherever it is printed; the
 * CLI takes the real brackets as flags once the sheet exists. Never Intro-1
 * (60/120 bps spot) — that book is not this venue.
 */
export const H1_FEE_SHEET = Object.freeze({
  id: 'CFM-NANO-H1-v0.1',
  status: 'DRAFT / UNVERIFIED',
  bracketsSource: 'Research v0.2 DRAFT brackets (sheet not on box → placeholder)',
  /** Placeholder commission incl. exchange + NFA, bps per side (maker-first framing). */
  placeholderFeeBpsPerSide: 5,
  /** Placeholder adverse-fill allowance, bps per side (next-bar close, no maker sim). */
  placeholderSlippageBpsPerSide: 2,
  /** All-in bps-per-side ladder printed as informational sensitivity (never graded). */
  ladderAllInBpsPerSide: Object.freeze([0, 5, 7, 10, 15, 25]) as readonly number[],
  notModelled: Object.freeze([
    'futures basis / monthly roll (dated nano contracts)',
    'perp-style funding',
    'per-contract minimum fee ($/contract) at low notional',
    'maker fill probability / queue position (fills are next-bar close)',
    'contract-size rounding (0.01 BTC / 0.1 ETH nano lots)',
  ]) as readonly string[],
});

/** One daily bar. `time` is epoch SECONDS (fixture convention). */
export interface DailyBar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** Cost bracket applied per side (entry and exit legs each pay both). */
export interface H1CostModel {
  /** Commission incl. exchange/NFA, bps of traded notional per side. */
  feeBpsPerSide: number;
  /** Adverse fill allowance folded into the fill price, bps per side. */
  slippageBpsPerSide: number;
}

export type H1Side = 'long' | 'short';
export type H1ExitReason = 'reversal' | 'trail' | 'end_of_data';

/** A closed round trip on one symbol. Prices are fills (slippage included). */
export interface H1Trade {
  symbol: string;
  side: H1Side;
  entryIndex: number;
  exitIndex: number;
  entryTime: number;
  exitTime: number;
  entryPrice: number;
  exitPrice: number;
  qty: number;
  notionalAtEntry: number;
  leverage: number;
  equityAtEntry: number;
  grossPnl: number;
  fees: number;
  slippageCost: number;
  pnl: number;
  returnOnEquityAtEntry: number;
  holdDays: number;
  exitReason: H1ExitReason;
  /** Entry taken while the previous exit on this symbol was a trail in the same direction. */
  reentryAfterTrail: boolean;
}

export interface H1ExitMixRow {
  n: number;
  share: number | null;
  winRate: number | null;
  netPnl: number;
  meanHoldDays: number | null;
}

export interface H1TradeStats {
  n: number;
  wins: number;
  losses: number;
  winRate: number | null;
  avgWin: number | null;
  avgLoss: number | null;
  /** avg win / |avg loss| on after-cost $ P&L. */
  payoff: number | null;
  profitFactor: number | null;
  expectancy: number | null;
  netPnl: number;
  grossPnl: number;
  fees: number;
  slippageCost: number;
  meanHoldDays: number | null;
  medianHoldDays: number | null;
  exitMix: Record<H1ExitReason, H1ExitMixRow>;
  reentriesAfterTrail: number;
}

export interface H1YearRow {
  year: number;
  days: number;
  netReturn: number;
  sharpe: number | null;
  maxDrawdown: number;
  exposure: number;
  tradesClosed: number;
}

export interface H1SignalStats {
  eligibleBars: number;
  longBars: number;
  shortBars: number;
  bandBars: number;
  avgVoteHistogram: Record<string, number>;
}

export interface H1Metrics {
  evalStartTime: number;
  evalEndTime: number;
  evalDays: number;
  initialCapital: number;
  finalEquity: number;
  netReturn: number;
  cagr: number | null;
  annVol: number | null;
  sharpe: number | null;
  sortino: number | null;
  maxDrawdown: number;
  calmar: number | null;
  exposure: number;
  grossTurnoverPerYear: number | null;
  costDragBpsPerYear: number | null;
  trades: H1TradeStats;
  perSymbol: Record<string, H1TradeStats & { daysInMarket: number; exposure: number }>;
  perSide: Record<H1Side, H1TradeStats>;
  perYear: H1YearRow[];
  signals: Record<string, H1SignalStats>;
  leverage: { mean: number | null; max: number | null; capBinds: number };
}

export interface H1Series {
  symbol: string;
  bars: DailyBar[];
}

export interface H1RunConfig {
  initialCapital: number;
  cost: H1CostModel;
}

export interface H1EquityPoint {
  time: number;
  equity: number;
}

export interface H1RunResult {
  variant: typeof H1_VARIANT;
  config: H1RunConfig;
  window: { startTime: number; endTime: number; bars: number };
  warmupBars: number;
  equityCurve: H1EquityPoint[];
  dailyReturns: number[];
  trades: H1Trade[];
  metrics: H1Metrics;
}

// ---------------------------------------------------------------------------
// Indicators (index-aligned; NaN during warm-up)
// ---------------------------------------------------------------------------

/**
 * Simple moving average of `values`, aligned to the input index. `NaN` for the
 * first `period − 1` entries.
 */
export function smaAligned(values: readonly number[], period: number): number[] {
  if (!Number.isInteger(period) || period <= 0) throw new Error(`smaAligned: invalid period ${period}`);
  const out = new Array<number>(values.length).fill(Number.NaN);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/**
 * Wilder ATR aligned to the input index. True range on bar 0 is high − low
 * (no previous close, TradingView / `trading-signals` convention); the seed
 * is the simple mean of the first `period` true ranges (defined at index
 * `period − 1`), then RMA smoothing. Matches `ValidatedIndicators.ATR`
 * value-for-value (asserted in the harness test).
 */
export function atrWilderAligned(bars: readonly DailyBar[], period: number): number[] {
  if (!Number.isInteger(period) || period <= 0) throw new Error(`atrWilderAligned: invalid period ${period}`);
  const out = new Array<number>(bars.length).fill(Number.NaN);
  let seedSum = 0;
  let prev = Number.NaN;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const tr = i === 0 ? b.high - b.low : Math.max(b.high - b.low, Math.abs(b.high - bars[i - 1].close), Math.abs(b.low - bars[i - 1].close));
    if (i < period) {
      seedSum += tr;
      if (i === period - 1) {
        prev = seedSum / period;
        out[i] = prev;
      }
    } else {
      prev = (prev * (period - 1) + tr) / period;
      out[i] = prev;
    }
  }
  return out;
}

/**
 * Rolling sample standard deviation of daily log returns, annualised by
 * √`annualizationDays`, aligned to the input index (`NaN` until `lookback`
 * returns exist, i.e. index ≥ `lookback`).
 */
export function realizedVolAligned(closes: readonly number[], lookback: number, annualizationDays: number): number[] {
  if (!Number.isInteger(lookback) || lookback < 2) throw new Error(`realizedVolAligned: invalid lookback ${lookback}`);
  const out = new Array<number>(closes.length).fill(Number.NaN);
  const rets = new Array<number>(closes.length).fill(Number.NaN);
  for (let i = 1; i < closes.length; i++) rets[i] = Math.log(closes[i] / closes[i - 1]);
  for (let i = lookback; i < closes.length; i++) {
    let mean = 0;
    for (let k = i - lookback + 1; k <= i; k++) mean += rets[k];
    mean /= lookback;
    let ss = 0;
    for (let k = i - lookback + 1; k <= i; k++) ss += (rets[k] - mean) ** 2;
    out[i] = Math.sqrt(ss / (lookback - 1)) * Math.sqrt(annualizationDays);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Signal
// ---------------------------------------------------------------------------

export interface H1Vote {
  votes: number[];
  avgVote: number;
  direction: -1 | 0 | 1;
}

/** sign(close − MA) per speed → plain average → banded direction. */
export function ensembleVote(close: number, mas: readonly number[], band: number): H1Vote {
  const votes: number[] = mas.map((ma) => (close > ma ? 1 : close < ma ? -1 : 0));
  const avgVote = votes.reduce((a, b) => a + b, 0) / votes.length;
  const direction: -1 | 0 | 1 = avgVote > band ? 1 : avgVote < -band ? -1 : 0;
  return { votes, avgVote, direction };
}

/** Per-sleeve leverage = min(cap, target / realised vol); `null` when vol is unusable. */
export function volTargetLeverage(realizedVolAnnual: number, target: number, cap: number): number | null {
  if (!Number.isFinite(realizedVolAnnual) || realizedVolAnnual <= 0) return null;
  return Math.min(cap, target / realizedVolAnnual);
}

/** Ratcheting close-based ATR trail state for one open position. */
export interface TrailState {
  side: H1Side;
  extreme: number;
  level: number;
}

export function initTrail(side: H1Side, fillPrice: number, atr: number, multiple: number): TrailState {
  return {
    side,
    extreme: fillPrice,
    level: side === 'long' ? fillPrice - multiple * atr : fillPrice + multiple * atr,
  };
}

/** Update with a new close (ratchet only tightens) and report whether the trail is hit. */
export function updateTrail(state: TrailState, close: number, atr: number, multiple: number): { state: TrailState; hit: boolean } {
  if (state.side === 'long') {
    const extreme = Math.max(state.extreme, close);
    const level = Math.max(state.level, extreme - multiple * atr);
    return { state: { side: 'long', extreme, level }, hit: close <= level };
  }
  const extreme = Math.min(state.extreme, close);
  const level = Math.min(state.level, extreme + multiple * atr);
  return { state: { side: 'short', extreme, level }, hit: close >= level };
}

// ---------------------------------------------------------------------------
// Simulation
// ---------------------------------------------------------------------------

interface OpenPosition {
  side: H1Side;
  qty: number;
  entryIndex: number;
  entryPrice: number;
  entryFee: number;
  entrySlippage: number;
  notionalAtEntry: number;
  leverage: number;
  equityAtEntry: number;
  trail: TrailState;
  reentryAfterTrail: boolean;
}

interface PendingOrder {
  /** Close the current position (reason recorded on the trade). */
  exitReason?: 'reversal' | 'trail';
  /** Open a new position after any exit at the same fill. */
  enter?: { side: H1Side; qty: number; leverage: number; notional: number };
}

interface SleeveState {
  symbol: string;
  bars: DailyBar[];
  mas: number[][];
  atr: number[];
  vol: number[];
  position: OpenPosition | null;
  pending: PendingOrder | null;
  lastExit: { reason: H1ExitReason; side: H1Side } | null;
  daysInMarket: number;
  signalStats: H1SignalStats;
  leverages: number[];
  capBinds: number;
}

function assertAlignedTimeline(series: readonly H1Series[]): number[] {
  if (series.length === 0) throw new Error('H1 simulation needs at least one series');
  const ref = series[0].bars.map((b) => b.time);
  for (const s of series) {
    if (s.bars.length !== ref.length) {
      throw new Error(`H1 timeline mismatch: ${s.symbol} has ${s.bars.length} bars, ${series[0].symbol} has ${ref.length}`);
    }
    for (let i = 0; i < ref.length; i++) {
      if (s.bars[i].time !== ref[i]) {
        throw new Error(`H1 timeline mismatch at index ${i}: ${s.symbol}=${s.bars[i].time} vs ${series[0].symbol}=${ref[i]}`);
      }
    }
  }
  return ref;
}

function fillPrice(close: number, isBuy: boolean, slippageBps: number): number {
  const slip = slippageBps / 10_000;
  return isBuy ? close * (1 + slip) : close * (1 - slip);
}

/**
 * Run the frozen variant over aligned daily series sharing one equity pool.
 *
 * Per bar t: (a) fill orders decided at t−1 at close[t] (± slippage, fee per
 * side); (b) mark equity; (c) decide orders for t+1 from indicators at t.
 * Open positions at the last bar are closed at that close as `end_of_data`.
 */
export function runApexTrendV1(series: readonly H1Series[], config: H1RunConfig): H1RunResult {
  const v = H1_VARIANT;
  const times = assertAlignedTimeline(series);
  const n = times.length;
  const maxSpeed = Math.max(...v.maSpeeds);
  const warmupBars = Math.max(maxSpeed, v.atrPeriod + 1, v.volLookbackDays + 1);
  if (n <= warmupBars + 1) {
    throw new Error(`H1 window too short: ${n} bars, need > ${warmupBars + 1} (warm-up ${warmupBars})`);
  }

  const sleeves: SleeveState[] = series.map((s) => {
    const closes = s.bars.map((b) => b.close);
    return {
      symbol: s.symbol,
      bars: s.bars,
      mas: v.maSpeeds.map((p) => smaAligned(closes, p)),
      atr: atrWilderAligned(s.bars, v.atrPeriod),
      vol: realizedVolAligned(closes, v.volLookbackDays, v.annualizationDays),
      position: null,
      pending: null,
      lastExit: null,
      daysInMarket: 0,
      signalStats: { eligibleBars: 0, longBars: 0, shortBars: 0, bandBars: 0, avgVoteHistogram: {} },
      leverages: [],
      capBinds: 0,
    };
  });

  const feeRate = config.cost.feeBpsPerSide / 10_000;
  let cash = config.initialCapital;
  const trades: H1Trade[] = [];
  const equityCurve: H1EquityPoint[] = [];
  const dailyExposure: number[] = new Array<number>(n).fill(0);
  let tradedNotional = 0;

  const markEquity = (i: number): number => {
    let eq = cash;
    for (const s of sleeves) {
      if (s.position) {
        const signed = s.position.side === 'long' ? s.position.qty : -s.position.qty;
        eq += signed * s.bars[i].close;
      }
    }
    return eq;
  };

  const closePosition = (s: SleeveState, i: number, reason: H1ExitReason): void => {
    const p = s.position;
    if (!p) return;
    const close = s.bars[i].close;
    const isBuy = p.side === 'short';
    const px = fillPrice(close, isBuy, config.cost.slippageBpsPerSide);
    const notional = p.qty * px;
    const fee = notional * feeRate;
    const slippageCost = p.qty * Math.abs(px - close);
    if (p.side === 'long') cash += notional - fee;
    else cash -= notional + fee;
    tradedNotional += notional;
    const grossPnl = p.side === 'long' ? p.qty * (px - p.entryPrice) : p.qty * (p.entryPrice - px);
    const fees = p.entryFee + fee;
    const pnl = grossPnl - fees;
    trades.push({
      symbol: s.symbol,
      side: p.side,
      entryIndex: p.entryIndex,
      exitIndex: i,
      entryTime: s.bars[p.entryIndex].time,
      exitTime: s.bars[i].time,
      entryPrice: p.entryPrice,
      exitPrice: px,
      qty: p.qty,
      notionalAtEntry: p.notionalAtEntry,
      leverage: p.leverage,
      equityAtEntry: p.equityAtEntry,
      grossPnl,
      fees,
      slippageCost: p.entrySlippage + slippageCost,
      pnl,
      returnOnEquityAtEntry: p.equityAtEntry > 0 ? pnl / p.equityAtEntry : 0,
      holdDays: i - p.entryIndex,
      exitReason: reason,
      reentryAfterTrail: p.reentryAfterTrail,
    });
    s.lastExit = { reason, side: p.side };
    s.position = null;
  };

  const openPosition = (s: SleeveState, i: number, order: NonNullable<PendingOrder['enter']>, equityAtEntry: number): void => {
    const close = s.bars[i].close;
    const isBuy = order.side === 'long';
    const px = fillPrice(close, isBuy, config.cost.slippageBpsPerSide);
    const notional = order.qty * px;
    const fee = notional * feeRate;
    if (order.side === 'long') cash -= notional + fee;
    else cash += notional - fee;
    tradedNotional += notional;
    const atr = s.atr[i];
    const reentryAfterTrail = s.lastExit?.reason === 'trail' && s.lastExit.side === order.side;
    s.position = {
      side: order.side,
      qty: order.qty,
      entryIndex: i,
      entryPrice: px,
      entryFee: fee,
      entrySlippage: order.qty * Math.abs(px - close),
      notionalAtEntry: notional,
      leverage: order.leverage,
      equityAtEntry,
      trail: initTrail(order.side, px, atr, v.trailAtrMultiple),
      reentryAfterTrail,
    };
    s.leverages.push(order.leverage);
    if (order.leverage >= v.leverageCap - 1e-12) s.capBinds += 1;
  };

  for (let i = 0; i < n; i++) {
    // (a) fills decided at i−1
    for (const s of sleeves) {
      const order = s.pending;
      s.pending = null;
      if (!order) continue;
      if (order.exitReason && s.position) closePosition(s, i, order.exitReason);
      if (order.enter && !s.position) openPosition(s, i, order.enter, markEquity(i));
    }

    // (b) mark
    const equity = markEquity(i);
    equityCurve.push({ time: times[i], equity });
    let anyOpen = 0;
    for (const s of sleeves) {
      if (s.position) {
        s.daysInMarket += 1;
        anyOpen = 1;
      }
    }
    dailyExposure[i] = anyOpen;

    // (c) decisions for i+1 (none on the last bar — end_of_data handles it)
    if (i === n - 1) break;
    for (const s of sleeves) {
      const eligible = i >= warmupBars - 1 && v.maSpeeds.every((_, k) => Number.isFinite(s.mas[k][i])) && Number.isFinite(s.atr[i]);
      if (!eligible) continue;
      const vote = ensembleVote(s.bars[i].close, s.mas.map((m) => m[i]), v.noTradeBand);
      s.signalStats.eligibleBars += 1;
      if (vote.direction === 1) s.signalStats.longBars += 1;
      else if (vote.direction === -1) s.signalStats.shortBars += 1;
      else s.signalStats.bandBars += 1;
      const key = vote.avgVote.toFixed(2);
      s.signalStats.avgVoteHistogram[key] = (s.signalStats.avgVoteHistogram[key] ?? 0) + 1;

      const buildEntry = (side: H1Side): PendingOrder['enter'] | undefined => {
        const lev = volTargetLeverage(s.vol[i], v.volTargetAnnual, v.leverageCap);
        if (lev === null) return undefined;
        const notional = v.sleeveWeight * equity * lev;
        if (!(notional > 0)) return undefined;
        return { side, qty: notional / s.bars[i].close, leverage: lev, notional };
      };

      const p = s.position;
      if (!p) {
        if (vote.direction !== 0) {
          const enter = buildEntry(vote.direction === 1 ? 'long' : 'short');
          if (enter) s.pending = { enter };
        }
        continue;
      }
      const reversed = (p.side === 'long' && vote.direction === -1) || (p.side === 'short' && vote.direction === 1);
      if (reversed) {
        const enter = buildEntry(p.side === 'long' ? 'short' : 'long');
        s.pending = { exitReason: 'reversal', enter };
        continue;
      }
      const upd = updateTrail(p.trail, s.bars[i].close, s.atr[i], v.trailAtrMultiple);
      p.trail = upd.state;
      if (upd.hit) s.pending = { exitReason: 'trail' };
    }
  }

  // end_of_data: close whatever is open at the last close
  const last = n - 1;
  for (const s of sleeves) if (s.position) closePosition(s, last, 'end_of_data');
  equityCurve[last] = { time: times[last], equity: markEquity(last) };

  const evalStartIndex = warmupBars; // first bar a fill could occur on
  const dailyReturns: number[] = [];
  for (let i = evalStartIndex; i < n; i++) {
    const prev = equityCurve[i - 1].equity;
    dailyReturns.push(prev > 0 ? equityCurve[i].equity / prev - 1 : 0);
  }

  const metrics = computeMetrics({
    variant: v,
    config,
    times,
    equityCurve,
    dailyReturns,
    evalStartIndex,
    trades,
    sleeves,
    dailyExposure,
    tradedNotional,
  });

  return {
    variant: v,
    config,
    window: { startTime: times[0], endTime: times[n - 1], bars: n },
    warmupBars,
    equityCurve,
    dailyReturns,
    trades,
    metrics,
  };
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

function mean(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function sampleStd(xs: readonly number[]): number | null {
  if (xs.length < 2) return null;
  const m = mean(xs) as number;
  const ss = xs.reduce((a, x) => a + (x - m) ** 2, 0);
  return Math.sqrt(ss / (xs.length - 1));
}

function median(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Annualised Sharpe of a daily return series (zero risk-free), `null` when undefined. */
export function sharpeRatio(dailyReturns: readonly number[], annualizationDays: number): number | null {
  const m = mean(dailyReturns);
  const sd = sampleStd(dailyReturns);
  if (m === null || sd === null || sd === 0) return null;
  return (m / sd) * Math.sqrt(annualizationDays);
}

/** Annualised Sortino (downside deviation vs 0), `null` when undefined. */
export function sortinoRatio(dailyReturns: readonly number[], annualizationDays: number): number | null {
  const m = mean(dailyReturns);
  if (m === null || dailyReturns.length < 2) return null;
  const dd = Math.sqrt(dailyReturns.reduce((a, r) => a + Math.min(r, 0) ** 2, 0) / dailyReturns.length);
  if (dd === 0) return null;
  return (m / dd) * Math.sqrt(annualizationDays);
}

/** Max peak-to-trough drawdown of an equity path, as a positive fraction. */
export function maxDrawdown(equity: readonly number[]): number {
  let peak = -Infinity;
  let worst = 0;
  for (const e of equity) {
    if (e > peak) peak = e;
    if (peak > 0) worst = Math.max(worst, (peak - e) / peak);
  }
  return worst;
}

function emptyExitMix(): Record<H1ExitReason, H1ExitMixRow> {
  const row = (): H1ExitMixRow => ({ n: 0, share: null, winRate: null, netPnl: 0, meanHoldDays: null });
  return { reversal: row(), trail: row(), end_of_data: row() };
}

/** Trade-level statistics on after-cost $ P&L. */
export function computeTradeStats(trades: readonly H1Trade[]): H1TradeStats {
  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const grossProfit = wins.reduce((a, t) => a + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.pnl, 0));
  const avgWin = mean(wins.map((t) => t.pnl));
  const avgLoss = mean(losses.map((t) => t.pnl));
  const exitMix = emptyExitMix();
  for (const reason of Object.keys(exitMix) as H1ExitReason[]) {
    const rows = trades.filter((t) => t.exitReason === reason);
    const w = rows.filter((t) => t.pnl > 0).length;
    exitMix[reason] = {
      n: rows.length,
      share: trades.length > 0 ? rows.length / trades.length : null,
      winRate: rows.length > 0 ? w / rows.length : null,
      netPnl: rows.reduce((a, t) => a + t.pnl, 0),
      meanHoldDays: mean(rows.map((t) => t.holdDays)),
    };
  }
  return {
    n: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: trades.length > 0 ? wins.length / trades.length : null,
    avgWin,
    avgLoss,
    payoff: avgWin !== null && avgLoss !== null && avgLoss !== 0 ? avgWin / Math.abs(avgLoss) : null,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Number.POSITIVE_INFINITY : null,
    expectancy: mean(trades.map((t) => t.pnl)),
    netPnl: trades.reduce((a, t) => a + t.pnl, 0),
    grossPnl: trades.reduce((a, t) => a + t.grossPnl, 0),
    fees: trades.reduce((a, t) => a + t.fees, 0),
    slippageCost: trades.reduce((a, t) => a + t.slippageCost, 0),
    meanHoldDays: mean(trades.map((t) => t.holdDays)),
    medianHoldDays: median(trades.map((t) => t.holdDays)),
    exitMix,
    reentriesAfterTrail: trades.filter((t) => t.reentryAfterTrail).length,
  };
}

interface MetricsInput {
  variant: typeof H1_VARIANT;
  config: H1RunConfig;
  times: readonly number[];
  equityCurve: readonly H1EquityPoint[];
  dailyReturns: readonly number[];
  evalStartIndex: number;
  trades: readonly H1Trade[];
  sleeves: readonly SleeveState[];
  dailyExposure: readonly number[];
  tradedNotional: number;
}

function utcYear(epochSeconds: number): number {
  return new Date(epochSeconds * 1000).getUTCFullYear();
}

function computeMetrics(input: MetricsInput): H1Metrics {
  const { variant: v, config, times, equityCurve, dailyReturns, evalStartIndex, trades, sleeves, dailyExposure, tradedNotional } = input;
  const n = times.length;
  const evalStartTime = times[evalStartIndex];
  const evalEndTime = times[n - 1];
  const evalDays = (evalEndTime - evalStartTime) / 86_400;
  const years = evalDays / v.annualizationDays;
  const startEquity = equityCurve[evalStartIndex - 1].equity;
  const finalEquity = equityCurve[n - 1].equity;
  const evalEquity = equityCurve.slice(evalStartIndex - 1).map((p) => p.equity);
  const sd = sampleStd(dailyReturns);
  const mdd = maxDrawdown(evalEquity);
  const cagr = years > 0 && startEquity > 0 && finalEquity > 0 ? Math.pow(finalEquity / startEquity, 1 / years) - 1 : null;
  const exposureDays = dailyExposure.slice(evalStartIndex).reduce((a, b) => a + b, 0);
  const evalBarCount = n - evalStartIndex;
  const avgEquity = mean(evalEquity) as number;
  const totalCost = trades.reduce((a, t) => a + t.fees + t.slippageCost, 0);

  const perSymbol: H1Metrics['perSymbol'] = {};
  const signals: Record<string, H1SignalStats> = {};
  const allLev: number[] = [];
  let capBinds = 0;
  for (const s of sleeves) {
    perSymbol[s.symbol] = {
      ...computeTradeStats(trades.filter((t) => t.symbol === s.symbol)),
      daysInMarket: s.daysInMarket,
      exposure: evalBarCount > 0 ? s.daysInMarket / evalBarCount : 0,
    };
    signals[s.symbol] = s.signalStats;
    allLev.push(...s.leverages);
    capBinds += s.capBinds;
  }

  const perYear: H1YearRow[] = [];
  const yearsSeen = new Set<number>();
  for (let i = evalStartIndex; i < n; i++) yearsSeen.add(utcYear(times[i]));
  for (const year of [...yearsSeen].sort((a, b) => a - b)) {
    const idx: number[] = [];
    for (let i = evalStartIndex; i < n; i++) if (utcYear(times[i]) === year) idx.push(i);
    const first = idx[0];
    const lastIdx = idx[idx.length - 1];
    const rets = idx.map((i) => dailyReturns[i - evalStartIndex]);
    const eq = equityCurve.slice(first - 1, lastIdx + 1).map((p) => p.equity);
    perYear.push({
      year,
      days: idx.length,
      netReturn: equityCurve[first - 1].equity > 0 ? equityCurve[lastIdx].equity / equityCurve[first - 1].equity - 1 : 0,
      sharpe: sharpeRatio(rets, v.annualizationDays),
      maxDrawdown: maxDrawdown(eq),
      exposure: idx.length > 0 ? idx.reduce((a, i) => a + dailyExposure[i], 0) / idx.length : 0,
      tradesClosed: trades.filter((t) => utcYear(t.exitTime) === year).length,
    });
  }

  return {
    evalStartTime,
    evalEndTime,
    evalDays,
    initialCapital: config.initialCapital,
    finalEquity,
    netReturn: startEquity > 0 ? finalEquity / startEquity - 1 : 0,
    cagr,
    annVol: sd === null ? null : sd * Math.sqrt(v.annualizationDays),
    sharpe: sharpeRatio(dailyReturns, v.annualizationDays),
    sortino: sortinoRatio(dailyReturns, v.annualizationDays),
    maxDrawdown: mdd,
    calmar: cagr !== null && mdd > 0 ? cagr / mdd : null,
    exposure: evalBarCount > 0 ? exposureDays / evalBarCount : 0,
    grossTurnoverPerYear: years > 0 && avgEquity > 0 ? tradedNotional / avgEquity / years : null,
    costDragBpsPerYear: years > 0 && avgEquity > 0 ? (totalCost / avgEquity / years) * 10_000 : null,
    trades: computeTradeStats(trades),
    perSymbol,
    perSide: {
      long: computeTradeStats(trades.filter((t) => t.side === 'long')),
      short: computeTradeStats(trades.filter((t) => t.side === 'short')),
    },
    perYear,
    signals,
    leverage: { mean: mean(allLev), max: allLev.length ? Math.max(...allLev) : null, capBinds },
  };
}
