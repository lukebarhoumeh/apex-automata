import { mulberry32, makeSeries } from "./rng";
import type { EquityPoint } from "@/types/equity";
import type { Position } from "@/types/positions";
import type { SignalRecord, FeedEvent } from "@/types/signals";
import type { StrategyCardData, StrategyConfig, MetaModelInfo } from "@/types/strategy";
import type { MarketRegime } from "@/types/regime";
import type { SessionStats } from "@/types/session";
import type { OrderRecord, FillRecord } from "@/types/orders";
import type { RiskData } from "@/types/risk";
import type { ModelData } from "@/types/model";
import type { BacktestData } from "@/types/backtest";
import type { JournalEntry } from "@/types/journal";
import type { AlertRule, AlertFiredEvent } from "@/types/alerts";

export const SESSION_SEED: SessionStats = {
  openedAt: "09:00:00",
  pnl: 1_291.97,
  pnlR: 1.82,
  realized: 982.10,
  unrealized: 309.87,
  trades: 6,
  wins: 4,
  losses: 2,
  winRate: 0.624,
  heat: 1.4,
  heatCap: 3.0,
  maxDrawDown: -0.6,
  signalsSeen: 17,
  signalsTaken: 6,
  acceptanceRate: 0.353,
  uptime: "03h 12m",
  mode: "paper",
  engineVersion: "v2.4.1",
  markets: 6,
  metaThreshold: 0.65,
};

export const POSITIONS_SEED: readonly Position[] = [
  {
    id: "p1",
    sym: "BTC-USD",
    side: "LONG",
    qty: 0.4182,
    entry: 66_840.0,
    stop: 65_920,
    target: 68_900,
    opened: "09:34:12",
    strat: "breakout",
    conf: 0.81,
    mark: 67_497.38,
    sparkline: makeSeries(101, 40, 66_840, 120),
  },
  {
    id: "p2",
    sym: "ETH-USD",
    side: "LONG",
    qty: 3.21,
    entry: 3_261.0,
    stop: 3_218,
    target: 3_340,
    opened: "10:12:47",
    strat: "vwap_mr",
    conf: 0.72,
    mark: 3_282.23,
    sparkline: makeSeries(102, 40, 3_261, 10),
  },
  {
    id: "p3",
    sym: "SOL-USD",
    side: "SHORT",
    qty: 42,
    entry: 184.9,
    stop: 188.4,
    target: 178.2,
    opened: "10:48:03",
    strat: "vwap_mr",
    conf: 0.76,
    mark: 182.51,
    sparkline: makeSeries(103, 40, 184.9, 1.2),
  },
].map((p) => ({
  ...p,
  pnl:
    p.side === "LONG"
      ? (p.mark - p.entry) * p.qty
      : (p.entry - p.mark) * p.qty,
  pnlPct:
    p.side === "LONG"
      ? ((p.mark - p.entry) / p.entry) * 100
      : ((p.entry - p.mark) / p.entry) * 100,
}));

export const SIGNAL_SEED: readonly SignalRecord[] = [
  { id: "s211", ts: "10:48:03", sym: "SOL-USD",  strat: "vwap_mr",  side: "SELL", conf: 0.76, state: "ACCEPTED", z: -2.34, adx: 18, note: "z<-2σ, ADX<20" },
  { id: "s210", ts: "10:32:18", sym: "BTC-USD",  strat: "breakout", side: "BUY",  conf: 0.81, state: "ACCEPTED", z: null,  adx: 31, note: "20-donchian break, vol 1.4x" },
  { id: "s209", ts: "10:19:04", sym: "AVAX-USD", strat: "breakout", side: "BUY",  conf: 0.58, state: "REJECTED", z: null,  adx: 22, note: "meta p=0.58 < 0.65" },
  { id: "s208", ts: "10:12:47", sym: "ETH-USD",  strat: "vwap_mr",  side: "BUY",  conf: 0.72, state: "ACCEPTED", z: 2.12,  adx: 17, note: "z>2σ reversion, chop" },
  { id: "s207", ts: "10:04:31", sym: "ARB-USD",  strat: "breakout", side: "BUY",  conf: 0.69, state: "CANCELLED", z: null, adx: 28, note: "spread widened" },
  { id: "s206", ts: "09:58:16", sym: "LINK-USD", strat: "vwap_mr",  side: "SELL", conf: 0.54, state: "REJECTED", z: -1.88, adx: 22, note: "z threshold 2.0" },
  { id: "s205", ts: "09:44:02", sym: "BTC-USD",  strat: "vwap_mr",  side: "SELL", conf: 0.61, state: "REJECTED", z: 2.05,  adx: 34, note: "ADX>25 regime block" },
  { id: "s204", ts: "09:34:12", sym: "BTC-USD",  strat: "breakout", side: "BUY",  conf: 0.81, state: "ACCEPTED", z: null,  adx: 30, note: "donchian+vol confluence" },
  { id: "s203", ts: "09:22:41", sym: "ETH-USD",  strat: "breakout", side: "SELL", conf: 0.55, state: "REJECTED", z: null,  adx: 19, note: "ADX<20" },
  { id: "s202", ts: "09:18:55", sym: "ETH-USD",  strat: "vwap_mr",  side: "SELL", conf: 0.79, state: "ACCEPTED", z: 2.41,  adx: 18, note: "extreme reversion" },
];

export const FEED_SEED: readonly FeedEvent[] = [
  { id: "f11", ts: "10:48:03", kind: "FILL",    msg: "SOL-USD SELL 42 @ 184.88",     tag: "vwap_mr",  score: 0.76, risk: "LOW" },
  { id: "f10", ts: "10:48:02", kind: "SIGNAL",  msg: "SOL-USD accepted p=0.76",      tag: "vwap_mr",  score: 0.76, risk: "LOW" },
  { id: "f09", ts: "10:47:58", kind: "SIGNAL",  msg: "SOL-USD candidate z=-2.34",    tag: "vwap_mr",  score: 0.72, risk: "LOW" },
  { id: "f08", ts: "10:44:12", kind: "REGIME",  msg: "ADX → 31 (trend regime)",      tag: "system" },
  { id: "f07", ts: "10:32:18", kind: "FILL",    msg: "BTC-USD BUY 0.12 @ 67,388.20", tag: "breakout", score: 0.81, risk: "MED" },
  { id: "f06", ts: "10:32:15", kind: "SIGNAL",  msg: "BTC-USD accepted p=0.81",      tag: "breakout", score: 0.81, risk: "MED" },
  { id: "f05", ts: "10:19:04", kind: "REJECT",  msg: "AVAX-USD p=0.58 < meta 0.65",  tag: "meta",     score: 0.58 },
  { id: "f04", ts: "10:12:47", kind: "FILL",    msg: "ETH-USD BUY 3.21 @ 3,260.88",  tag: "vwap_mr",  score: 0.72, risk: "LOW" },
  { id: "f03", ts: "10:04:31", kind: "RISK",    msg: "ARB-USD spread >98 pctile",    tag: "system" },
  { id: "f02", ts: "09:34:12", kind: "FILL",    msg: "BTC-USD BUY 0.30 @ 66,839.10", tag: "breakout", score: 0.81, risk: "MED" },
  { id: "f01", ts: "09:00:00", kind: "SESSION", msg: "Session opened — paper $100k", tag: "system" },
];

export const STRATEGY_CARDS_SEED: readonly StrategyCardData[] = [
  {
    id: "trend_follow",
    name: "Trend Follow · ETH",
    status: "on",
    pnlToday: 682.4,
    trades: 3,
    winRate: 0.667,
    sparkline: makeSeries(201, 40, 100, 2.5, 0.3),
  },
  {
    id: "momentum",
    name: "Momentum · ETH",
    status: "on",
    pnlToday: 441.2,
    trades: 2,
    winRate: 0.5,
    sparkline: makeSeries(202, 40, 100, 3.0, 0.2),
  },
  {
    id: "breakout",
    name: "Breakout + Volume",
    status: "cooldown",
    pnlToday: 168.4,
    trades: 1,
    winRate: 0.5,
    sparkline: makeSeries(203, 40, 100, 2.0, -0.1),
  },
];

export const REGIME_SEED: MarketRegime = {
  label: "TRENDING",
  timeframe: "4h",
  meters: [
    { key: "vol", label: "Volatility", value: 64, cap: 100, display: "64 · exp", tone: "warn" },
    { key: "mom", label: "Momentum",   value: 72, cap: 100, display: "+0.72σ",  tone: "up" },
    { key: "bre", label: "Breadth",    value: 58, cap: 100, display: "58% long", tone: "up" },
    { key: "fund", label: "Funding",   value: 22, cap: 100, display: "+0.008%",  tone: "info" },
  ],
};

/** Equity curve — deterministic random walk with drift shifts every ~60 steps. */
function buildEquityCurve(): EquityPoint[] {
  const rnd = mulberry32(42);
  const n = 180;
  const out: EquityPoint[] = [];
  let v = 100_000;
  for (let i = 0; i < n; i++) {
    const dayDrift = 120 + (i > 60 ? 40 : 0) + (i > 130 ? 80 : 0);
    const shock = (rnd() - 0.45) * 900;
    v = Math.max(90_000, v + dayDrift + shock);
    out.push({ t: i, v });
  }
  return out;
}

const FULL_EQUITY = buildEquityCurve();

export function equityForRange(range: "1D" | "1W" | "1M" | "ALL"): EquityPoint[] {
  const n = FULL_EQUITY.length;
  if (range === "1D") return FULL_EQUITY.slice(n - 24);
  if (range === "1W") return FULL_EQUITY.slice(n - 60);
  if (range === "1M") return FULL_EQUITY.slice(n - 120);
  return FULL_EQUITY;
}

export const ORDERS_SEED: readonly OrderRecord[] = [
  { id: "o108", ts: "10:48:03", sym: "SOL-USD",  side: "SELL", type: "LMT", qty: 42,    px: 184.90,    fillAvg: 184.88,    status: "FILLED",    strat: "vwap_mr",  venue: "Coinbase" },
  { id: "o107", ts: "10:32:18", sym: "BTC-USD",  side: "BUY",  type: "MKT", qty: 0.12,  px: null,      fillAvg: 67_388.20, status: "FILLED",    strat: "breakout", venue: "Coinbase" },
  { id: "o106", ts: "10:12:47", sym: "ETH-USD",  side: "BUY",  type: "LMT", qty: 3.21,  px: 3_261.00,  fillAvg: 3_260.88,  status: "FILLED",    strat: "vwap_mr",  venue: "Coinbase" },
  { id: "o105", ts: "10:04:31", sym: "ARB-USD",  side: "BUY",  type: "LMT", qty: 820,   px: 1.082,     fillAvg: null,      status: "CANCELLED", strat: "breakout", venue: "Coinbase" },
  { id: "o104", ts: "09:34:12", sym: "BTC-USD",  side: "BUY",  type: "LMT", qty: 0.30,  px: 66_840,    fillAvg: 66_839.10, status: "FILLED",    strat: "breakout", venue: "Coinbase" },
  { id: "o103", ts: "09:30:02", sym: "LINK-USD", side: "BUY",  type: "LMT", qty: 120,   px: 17.10,     fillAvg: null,      status: "REJECTED",  strat: "breakout", venue: "Coinbase", reason: "Spread percentile > 98 — venue rejected order" },
  { id: "o102", ts: "09:18:55", sym: "ETH-USD",  side: "SELL", type: "MKT", qty: 2.00,  px: null,      fillAvg: 3_278.44,  status: "FILLED",    strat: "vwap_mr",  venue: "Coinbase" },
  { id: "o101", ts: "09:02:11", sym: "BTC-USD",  side: "SELL", type: "MKT", qty: 0.18,  px: null,      fillAvg: 67_512.00, status: "FILLED",    strat: "breakout", venue: "Coinbase" },
];

export const FILLS_SEED: readonly FillRecord[] = [
  { id: "fill-1", ts: "10:48:03.214", sym: "SOL-USD", side: "SELL", qty: 42,   px: 184.88,   fee: 1.55, slip: -0.02 },
  { id: "fill-2", ts: "10:32:18.102", sym: "BTC-USD", side: "BUY",  qty: 0.12, px: 67_388.20, fee: 4.04, slip:  0.80 },
  { id: "fill-3", ts: "10:12:47.840", sym: "ETH-USD", side: "BUY",  qty: 3.21, px: 3_260.88,  fee: 3.14, slip: -0.12 },
  { id: "fill-4", ts: "09:34:12.901", sym: "BTC-USD", side: "BUY",  qty: 0.30, px: 66_839.10, fee: 8.02, slip: -0.90 },
  { id: "fill-5", ts: "09:18:55.032", sym: "ETH-USD", side: "SELL", qty: 2.00, px: 3_278.44,  fee: 3.93, slip:  0.04 },
  { id: "fill-6", ts: "09:02:11.500", sym: "BTC-USD", side: "SELL", qty: 0.18, px: 67_512.00, fee: 4.86, slip:  0.20 },
];

export const META_MODEL_SEED: MetaModelInfo = {
  name: "xgb_v2.4 · 128 features",
  features: 128,
  rocAuc: 0.784,
  precision: 0.642,
  recall: 0.718,
  f1: 0.678,
  threshold: 0.65,
  trainedOn: 47_331,
};

export const STRATEGY_CONFIG_SEED: readonly StrategyConfig[] = [
  {
    id: "breakout",
    name: "Breakout + Volume",
    desc: "20-period Donchian breakout gated by ADX and volume",
    kind: "trend",
    enabled: true,
    params: [
      { key: "adxMin",    label: "ADX minimum",     val: 25, min: 15, max: 40, step: 1, format: (v) => `${v}` },
      { key: "donchianN", label: "Donchian period", val: 20, min: 10, max: 40, step: 1, format: (v) => `${v}` },
      { key: "atrPctile", label: "ATR pctile min",  val: 60, min: 30, max: 90, step: 5, format: (v) => `${v}` },
    ],
    stats: { winRate: 0.564, avgR: 1.42, trades: 48, lastR: [0.8, -1, 1.4, 2.1, -1, 0.9, 1.6, -1, 0.7, 2.2, 1.1, -1] },
  },
  {
    id: "vwap_mr",
    name: "VWAP Mean Reversion",
    desc: "Fade extreme deviations from VWAP in low-ADX regimes",
    kind: "revert",
    enabled: true,
    params: [
      { key: "zAbsMin", label: "|Z| minimum", val: 2.0, min: 1.5, max: 3.0, step: 0.1, format: (v) => `${v.toFixed(1)}σ` },
      { key: "adxMax",  label: "ADX maximum", val: 25,  min: 15,  max: 35,  step: 1,   format: (v) => `${v}` },
    ],
    stats: { winRate: 0.612, avgR: 0.82, trades: 63, lastR: [1.1, 0.8, -1, 1.3, 0.9, -1, 1.2, 0.7, -1, 1.1, 1.4, 0.6] },
  },
];

export const RISK_SEED: RiskData = {
  portfolio: {
    equity: 124_382.11,
    exposure: 38_220.00,
    heat: 1.82, heatCap: 3.0,
    dd: 2.1, ddCap: 8.0,
    var95: 1_840, var99: 3_120,
    expectedShortfall: 4_280,
    consecLosses: 1, consecCap: 5,
    netBeta: 0.72,
  },
  symbolCaps: [
    { s: "BTC-USD",  used: 14_200, cap: 30_000, pct: 47.3 },
    { s: "ETH-USD",  used:  9_800, cap: 20_000, pct: 49.0 },
    { s: "SOL-USD",  used:  6_420, cap: 10_000, pct: 64.2 },
    { s: "AVAX-USD", used:  3_100, cap: 10_000, pct: 31.0 },
    { s: "LINK-USD", used:  2_700, cap:  8_000, pct: 33.8 },
    { s: "ARB-USD",  used:  2_000, cap:  8_000, pct: 25.0 },
  ],
  radar: [
    { k: "Concentration", v: 54 },
    { k: "Volatility",    v: 68 },
    { k: "Drawdown",      v: 26 },
    { k: "Correlation",   v: 72 },
    { k: "Leverage",      v: 18 },
    { k: "Liquidity",     v: 35 },
  ],
  corr: [
    [1.00, 0.86, 0.79, 0.72, 0.63, 0.68],
    [0.86, 1.00, 0.82, 0.77, 0.69, 0.74],
    [0.79, 0.82, 1.00, 0.88, 0.64, 0.72],
    [0.72, 0.77, 0.88, 1.00, 0.61, 0.70],
    [0.63, 0.69, 0.64, 0.61, 1.00, 0.58],
    [0.68, 0.74, 0.72, 0.70, 0.58, 1.00],
  ],
  corrLabels: ["BTC", "ETH", "SOL", "AVAX", "LINK", "ARB"],
  tree: {
    label: "Portfolio", value: 38_220, children: [
      { label: "Crypto · Spot", value: 34_500, children: [
        { label: "Majors", value: 24_000, children: [
          { label: "BTC-USD", value: 14_200 },
          { label: "ETH-USD", value:  9_800 },
        ]},
        { label: "L1 Alts", value: 9_520, children: [
          { label: "SOL-USD",  value: 6_420 },
          { label: "AVAX-USD", value: 3_100 },
        ]},
        { label: "L2/Oracle", value: 4_700, children: [
          { label: "LINK-USD", value: 2_700 },
          { label: "ARB-USD",  value: 2_000 },
        ]},
      ]},
      { label: "Reserves · Cash", value: 86_162 },
    ],
  },
  killLadder: [
    { lvl: 1, at: "DD > 3%",          action: "Reduce new size 50%",  tripped: false },
    { lvl: 2, at: "DD > 5%",          action: "No new entries",        tripped: false },
    { lvl: 3, at: "3 consec losses",  action: "Pause strategy",        tripped: false },
    { lvl: 4, at: "DD > 8%",          action: "Flatten all positions", tripped: false },
    { lvl: 5, at: "Venue rejects x5", action: "Cold shutdown + page",  tripped: false },
  ],
};

export const MODEL_SEED: ModelData = {
  meta: {
    name: "xgb_v2.4",
    arch: "XGBoost · 400 trees · depth 6",
    features: 128,
    params: "1.2M",
    file: "xgb_v2.4.onnx",
    size: "3.4 MB",
    rocAuc: 0.784,
    precision: 0.642,
    recall: 0.718,
    f1: 0.678,
    brier: 0.198,
    trainedOn: 47_331,
    trainedAt: "2026-04-11 14:32 UTC",
  },
  shap: [
    { k: "regime_adx_15m",      v:  0.124, sign:  1, desc: "ADX > 30 on 15m" },
    { k: "breakout_width_20",   v:  0.088, sign:  1, desc: "Donchian 20 compressed" },
    { k: "volume_z_5m",         v:  0.072, sign:  1, desc: "Vol z-score +2.1σ" },
    { k: "vwap_distance",       v:  0.041, sign:  1, desc: "0.3% above VWAP" },
    { k: "spread_pctile",       v:  0.032, sign:  1, desc: "Tight spread (2nd pct)" },
    { k: "hour_of_day",         v: -0.018, sign: -1, desc: "US close approaching" },
    { k: "realized_vol_24h",    v: -0.024, sign: -1, desc: "RV slightly elevated" },
    { k: "correlation_btc_eth", v: -0.041, sign: -1, desc: "High BTC-ETH corr" },
  ],
  infer: [
    { ts: "14:22:04", sym: "BTC-USD",  p: 0.71, state: "ACCEPTED", top: "regime_adx · volume_z" },
    { ts: "14:21:38", sym: "ETH-USD",  p: 0.58, state: "REJECTED", top: "vwap_dist · hour_of_day" },
    { ts: "14:20:51", sym: "SOL-USD",  p: 0.67, state: "ACCEPTED", top: "breakout_width · volume_z" },
    { ts: "14:19:22", sym: "LINK-USD", p: 0.49, state: "REJECTED", top: "spread_pctile · rv_24h" },
    { ts: "14:18:07", sym: "AVAX-USD", p: 0.62, state: "REJECTED", top: "rv_24h · hour_of_day" },
    { ts: "14:17:44", sym: "ARB-USD",  p: 0.74, state: "ACCEPTED", top: "breakout_width · regime_adx" },
  ],
  cm: { tp: 6820, fp: 3810, fn: 2680, tn: 33921 },
  calibration: [
    { bin: 0.10, pred: 0.10, obs: 0.08 },
    { bin: 0.20, pred: 0.20, obs: 0.19 },
    { bin: 0.30, pred: 0.30, obs: 0.28 },
    { bin: 0.40, pred: 0.40, obs: 0.37 },
    { bin: 0.50, pred: 0.50, obs: 0.49 },
    { bin: 0.60, pred: 0.60, obs: 0.58 },
    { bin: 0.70, pred: 0.70, obs: 0.69 },
    { bin: 0.80, pred: 0.80, obs: 0.82 },
    { bin: 0.90, pred: 0.90, obs: 0.91 },
  ],
  runs: [
    { v: "v2.4", date: "2026-04-11", auc: 0.784, prec: 0.642, trades: 47_331, note: "current · expanded features", live: true },
    { v: "v2.3", date: "2026-03-02", auc: 0.762, prec: 0.618, trades: 42_104, note: "regime-aware threshold" },
    { v: "v2.2", date: "2026-01-14", auc: 0.741, prec: 0.597, trades: 38_290, note: "SHAP-driven pruning" },
    { v: "v2.1", date: "2025-11-22", auc: 0.725, prec: 0.581, trades: 35_140, note: "added orderbook features" },
    { v: "v2.0", date: "2025-09-08", auc: 0.701, prec: 0.554, trades: 30_122, note: "first XGBoost baseline" },
  ],
};

function buildBacktestEquity() {
  const rnd = mulberry32(99);
  let v = 100_000;
  let peak = v;
  const out: { i: number; v: number; peak: number; dd: number }[] = [];
  for (let i = 0; i < 90; i++) {
    const drift = 250 + (i > 40 ? 120 : 0);
    const shock = (rnd() - 0.46) * 1_400;
    v = Math.max(92_000, v + drift + shock);
    peak = Math.max(peak, v);
    const dd = ((v - peak) / peak) * 100;
    out.push({ i, v, peak, dd });
  }
  return out;
}

export const BACKTEST_SEED: BacktestData = {
  preset: "Breakout · BTC/ETH/SOL · 90d",
  config: {
    strategy: "Breakout · 20/55 Donchian",
    symbols: ["BTC-USD", "ETH-USD", "SOL-USD"],
    from: "2026-01-15",
    to: "2026-04-15",
    initialCapital: 100_000,
    riskPerTrade: 0.5,
    metaThreshold: 0.65,
    slippageBps: 2.0,
    feeBps: 10.0,
  },
  results: {
    finalEquity: 124_382,
    totalReturn: 24.38,
    cagr: 128.4,
    sharpe: 2.14,
    sortino: 3.08,
    maxDD: 6.2,
    winRate: 0.584,
    trades: 142,
    avgR: 0.42,
    profitFactor: 1.87,
    avgHoldHrs: 8.4,
    turnover: 18.2,
  },
  equity: buildBacktestEquity(),
  monthlyReturns: [
    { m: "Jan", r:  4.2 },
    { m: "Feb", r: -1.8 },
    { m: "Mar", r:  9.1 },
    { m: "Apr", r: 11.4 },
  ],
  trades: [
    { id: "bt-1", sym: "BTC-USD", side: "LONG",  entry: 62_140, exit: 65_890, r:  1.82, pnl:  1_640, dur:  "6h 12m", date: "2026-03-28" },
    { id: "bt-2", sym: "ETH-USD", side: "LONG",  entry:  3_120, exit:  3_080, r: -0.65, pnl:   -310, dur:  "4h 05m", date: "2026-03-26" },
    { id: "bt-3", sym: "SOL-USD", side: "LONG",  entry:    168, exit:    182, r:  2.10, pnl:  2_210, dur: "11h 40m", date: "2026-03-22" },
    { id: "bt-4", sym: "BTC-USD", side: "SHORT", entry: 66_400, exit: 66_800, r: -0.35, pnl:   -470, dur:  "1h 22m", date: "2026-03-19" },
    { id: "bt-5", sym: "ETH-USD", side: "LONG",  entry:  3_042, exit:  3_240, r:  2.44, pnl:  2_610, dur: "18h 08m", date: "2026-03-15" },
    { id: "bt-6", sym: "SOL-USD", side: "LONG",  entry:    151, exit:    147, r: -0.82, pnl:   -440, dur:  "3h 10m", date: "2026-03-12" },
    { id: "bt-7", sym: "BTC-USD", side: "LONG",  entry: 59_800, exit: 62_100, r:  1.64, pnl:  1_420, dur:  "9h 30m", date: "2026-03-08" },
    { id: "bt-8", sym: "ETH-USD", side: "LONG",  entry:  2_980, exit:  2_960, r: -0.41, pnl:   -220, dur:  "2h 14m", date: "2026-03-04" },
  ],
  rDist: [
    { bucket: "<-2R",     n:  4 },
    { bucket: "-2 to -1", n: 18 },
    { bucket: "-1 to 0",  n: 37 },
    { bucket: "0 to 1",   n: 28 },
    { bucket: "1 to 2",   n: 31 },
    { bucket: "2 to 3",   n: 16 },
    { bucket: ">3R",      n:  8 },
  ],
};

export const JOURNAL_SEED: readonly JournalEntry[] = [
  {
    id: "j-142", sym: "BTC-USD", side: "LONG", date: "2026-04-14", time: "09:42 UTC",
    r: 2.1, pnl: 1_840, outcome: "WIN", tags: ["breakout", "hi-conf", "ADX>30"],
    entry: 65_420, exit: 66_980, stop: 64_900, target: 67_200,
    thesis: "Clean 20-period Donchian break after 36h compression. Volume z +2.4σ, meta p=0.78. ADX confirming trend.",
    lessons: "Held full target. Good discipline — trail triggered 40bp above entry, no early exit temptation.",
    seed: 11,
  },
  {
    id: "j-141", sym: "ETH-USD", side: "LONG", date: "2026-04-13", time: "14:12 UTC",
    r: -0.9, pnl: -510, outcome: "LOSS", tags: ["vwap_mr", "chop", "low-conf"],
    entry: 3_180, exit: 3_140, stop: 3_135, target: 3_260,
    thesis: "VWAP mean-reversion on -2.1σ. Meta p=0.62 (borderline, below preferred 0.65).",
    lessons: "Bad environment — ADX rising meant trend, not mean-revert. Should tighten regime gating on MR strategy.",
    seed: 22,
  },
  {
    id: "j-140", sym: "SOL-USD", side: "LONG", date: "2026-04-12", time: "11:08 UTC",
    r: 1.6, pnl: 1_210, outcome: "WIN", tags: ["breakout", "correlated-move"],
    entry: 178.40, exit: 186.20, stop: 174.10, target: 188.50,
    thesis: "SOL lagging BTC breakout by ~20min. Took entry as confluence with BTC above prior range.",
    lessons: "Correlated-move setup working well. Exited slightly early — next time let trail handle it.",
    seed: 33,
  },
  {
    id: "j-139", sym: "LINK-USD", side: "SHORT", date: "2026-04-11", time: "20:51 UTC",
    r: 0.8, pnl: 420, outcome: "WIN", tags: ["vwap_mr", "overnight"],
    entry: 17.80, exit: 17.40, stop: 18.05, target: 17.20,
    thesis: "+2.8σ extension into resistance, overnight session. Meta p=0.69.",
    lessons: "Overnight MR working. Spread was 2x normal — factor that into sizing next time.",
    seed: 44,
  },
  {
    id: "j-138", sym: "AVAX-USD", side: "LONG", date: "2026-04-10", time: "16:04 UTC",
    r: -0.5, pnl: -240, outcome: "LOSS", tags: ["breakout", "false-break"],
    entry: 39.20, exit: 38.70, stop: 38.65, target: 41.00,
    thesis: "Range breakout but volume was weak (+0.8σ, below threshold).",
    lessons: "Strategy should have filtered this. Volume z threshold is too low — raise to 1.5σ.",
    seed: 55,
  },
  {
    id: "j-137", sym: "BTC-USD", side: "SHORT", date: "2026-04-09", time: "02:30 UTC",
    r: 2.8, pnl: 2_310, outcome: "WIN", tags: ["breakout", "asian-session"],
    entry: 68_420, exit: 66_100, stop: 68_800, target: 66_000,
    thesis: "Breakdown from consolidation. Asian session liquidity thin, fast move.",
    lessons: "Best trade of week. Target hit almost exactly. Trust the system.",
    seed: 66,
  },
];

export const ALERT_RULES_SEED: readonly AlertRule[] = [
  {
    id: "r-01", name: "Large drawdown", enabled: true,
    when: { source: "portfolio", metric: "drawdown", op: ">", value: 3.0, unit: "%" },
    then: [{ kind: "pause", target: "engine" }, { kind: "notify", channel: "slack" }],
    fired: 0, lastFired: "—",
  },
  {
    id: "r-02", name: "Venue latency spike", enabled: true,
    when: { source: "system", metric: "broker_latency_ms", op: ">", value: 500, unit: "ms" },
    then: [{ kind: "notify", channel: "pagerduty" }],
    fired: 3, lastFired: "2h ago",
  },
  {
    id: "r-03", name: "Meta model drift", enabled: true,
    when: { source: "model", metric: "roc_auc_7d", op: "<", value: 0.70, unit: "" },
    then: [{ kind: "notify", channel: "email" }, { kind: "flag", target: "retrain" }],
    fired: 0, lastFired: "—",
  },
  {
    id: "r-04", name: "Consecutive losses", enabled: true,
    when: { source: "portfolio", metric: "consec_losses", op: ">=", value: 3, unit: "" },
    then: [{ kind: "pause", target: "strategy" }, { kind: "notify", channel: "slack" }],
    fired: 1, lastFired: "yesterday",
  },
  {
    id: "r-05", name: "Symbol exposure breach", enabled: false,
    when: { source: "risk", metric: "symbol_exposure_pct", op: ">", value: 80, unit: "%" },
    then: [{ kind: "block", target: "new_orders" }, { kind: "notify", channel: "slack" }],
    fired: 0, lastFired: "—",
  },
];

export const ALERT_FIRED_SEED: readonly AlertFiredEvent[] = [
  { ts: "12:14:08",  rule: "Venue latency spike", detail: "broker_latency_ms = 612ms > 500ms", level: "warn" },
  { ts: "09:02:55",  rule: "Venue latency spike", detail: "broker_latency_ms = 544ms > 500ms", level: "warn" },
  { ts: "yday 21:48", rule: "Consecutive losses",  detail: "consec = 3; strategy paused",       level: "danger" },
  { ts: "yday 14:11", rule: "Venue latency spike", detail: "broker_latency_ms = 721ms",         level: "warn" },
];
