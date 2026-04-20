import { mulberry32, makeSeries } from "./rng";
import type { EquityPoint } from "@/types/equity";
import type { Position } from "@/types/positions";
import type { SignalRecord, FeedEvent } from "@/types/signals";
import type { StrategyCardData } from "@/types/strategy";
import type { MarketRegime } from "@/types/regime";
import type { SessionStats } from "@/types/session";
import type { OrderRecord, FillRecord } from "@/types/orders";

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
