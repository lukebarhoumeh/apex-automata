// ============================================================
// Apex Automata — synthetic data engine + live simulation
// ============================================================

const SYMBOLS = [
  { s: "BTC-USD", name: "Bitcoin",   px: 67_412.50, atr: 820,  dec: 2 },
  { s: "ETH-USD", name: "Ethereum",  px:  3_284.10, atr:  48,  dec: 2 },
  { s: "SOL-USD", name: "Solana",    px:   182.44,  atr:  5.2, dec: 2 },
  { s: "AVAX-USD",name: "Avalanche", px:    38.91,  atr:  1.4, dec: 3 },
  { s: "LINK-USD",name: "Chainlink", px:    17.22,  atr:  0.6, dec: 3 },
  { s: "ARB-USD", name: "Arbitrum",  px:     1.084, atr:  0.04,dec: 4 },
];

// Seeded random — deterministic story
function mulberry32(seed) {
  return function() {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = seed;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function makeSeries(seed, n, base, vol, drift = 0) {
  const rnd = mulberry32(seed);
  const pts = [];
  let v = base;
  for (let i = 0; i < n; i++) {
    const shock = (rnd() - 0.5) * 2 * vol;
    v = v + drift + shock + (base - v) * 0.012;
    pts.push(v);
  }
  return pts;
}

// ---- Equity curve -------------------------------------------------
const EQUITY = (() => {
  const rnd = mulberry32(42);
  const n = 180;
  const out = [];
  let v = 100_000;
  for (let i = 0; i < n; i++) {
    const dayDrift = 120 + (i > 60 ? 40 : 0) + (i > 130 ? 80 : 0);
    const shock = (rnd() - 0.45) * 900;
    v = Math.max(90_000, v + dayDrift + shock);
    out.push({ i, v });
  }
  return out;
})();

// ---- Intraday candles for focal chart -----------------------------
function makeCandles(seed, base, atr, n = 90) {
  const rnd = mulberry32(seed);
  const out = [];
  let close = base - atr * 6;
  for (let i = 0; i < n; i++) {
    const o = close;
    const move = (rnd() - 0.48) * atr * 1.3;
    const c = o + move;
    const hi = Math.max(o, c) + rnd() * atr * 0.6;
    const lo = Math.min(o, c) - rnd() * atr * 0.6;
    out.push({ i, o, h: hi, l: lo, c });
    close = c;
  }
  return out;
}

// ---- Positions ----------------------------------------------------
const POSITIONS = [
  { id: "p1", sym: "BTC-USD", side: "LONG",  qty: 0.4182, entry: 66_840.00, stop: 65_920, target: 68_900, opened: "09:34:12", strat: "breakout",  conf: 0.81 },
  { id: "p2", sym: "ETH-USD", side: "LONG",  qty: 3.210,  entry:  3_261.00, stop:  3_218, target:  3_340, opened: "10:12:47", strat: "vwap_mr",   conf: 0.72 },
  { id: "p3", sym: "SOL-USD", side: "SHORT", qty: 42.00,  entry:    184.90, stop:    188.40, target:  178.20, opened: "10:48:03", strat: "vwap_mr", conf: 0.76 },
];

// ---- Orders blotter ----------------------------------------------
const ORDERS = [
  { id: "o108", ts: "10:48:03", sym: "SOL-USD", side: "SELL", type: "LMT", qty: 42,    px: 184.90,   status: "FILLED",  fillAvg: 184.88, strat: "vwap_mr", venue: "Coinbase" },
  { id: "o107", ts: "10:32:18", sym: "BTC-USD", side: "BUY",  type: "MKT", qty: 0.12,  px: null,     status: "FILLED",  fillAvg: 67_388.20, strat: "breakout", venue: "Coinbase" },
  { id: "o106", ts: "10:12:47", sym: "ETH-USD", side: "BUY",  type: "LMT", qty: 3.21,  px: 3261.00,  status: "FILLED",  fillAvg: 3260.88, strat: "vwap_mr", venue: "Coinbase" },
  { id: "o105", ts: "10:04:31", sym: "ARB-USD", side: "BUY",  type: "LMT", qty: 820,   px: 1.082,    status: "CANCELLED", fillAvg: null, strat: "breakout", venue: "Coinbase" },
  { id: "o104", ts: "09:34:12", sym: "BTC-USD", side: "BUY",  type: "LMT", qty: 0.30,  px: 66_840,   status: "FILLED",  fillAvg: 66_839.10, strat: "breakout", venue: "Coinbase" },
  { id: "o103", ts: "09:30:02", sym: "LINK-USD",side: "BUY",  type: "LMT", qty: 120,   px: 17.10,    status: "REJECTED", fillAvg: null, strat: "breakout", venue: "Coinbase", reason: "spread pctile >98" },
  { id: "o102", ts: "09:18:55", sym: "ETH-USD", side: "SELL", type: "MKT", qty: 2.00,  px: null,     status: "FILLED",  fillAvg: 3278.44, strat: "vwap_mr", venue: "Coinbase" },
  { id: "o101", ts: "09:02:11", sym: "BTC-USD", side: "SELL", type: "MKT", qty: 0.18,  px: null,     status: "FILLED",  fillAvg: 67_512.00, strat: "breakout", venue: "Coinbase" },
];

// ---- Signals ------------------------------------------------------
const SIGNALS = [
  { id: "s211", ts: "10:48:03", sym: "SOL-USD", strat: "vwap_mr",   side: "SELL", conf: 0.76, state: "ACCEPTED", z: -2.34, adx: 18, note: "z<-2σ, ADX<20" },
  { id: "s210", ts: "10:32:18", sym: "BTC-USD", strat: "breakout",  side: "BUY",  conf: 0.81, state: "ACCEPTED", z:  null, adx: 31, note: "20-donchian break, vol 1.4x" },
  { id: "s209", ts: "10:19:04", sym: "AVAX-USD",strat: "breakout",  side: "BUY",  conf: 0.58, state: "REJECTED", z:  null, adx: 22, note: "meta p=0.58 < 0.65" },
  { id: "s208", ts: "10:12:47", sym: "ETH-USD", strat: "vwap_mr",   side: "BUY",  conf: 0.72, state: "ACCEPTED", z:  2.12, adx: 17, note: "z>2σ reversion, chop" },
  { id: "s207", ts: "10:04:31", sym: "ARB-USD", strat: "breakout",  side: "BUY",  conf: 0.69, state: "CANCELLED",z:  null, adx: 28, note: "spread widened" },
  { id: "s206", ts: "09:58:16", sym: "LINK-USD",strat: "vwap_mr",   side: "SELL", conf: 0.54, state: "REJECTED", z: -1.88, adx: 22, note: "z threshold 2.0" },
  { id: "s205", ts: "09:44:02", sym: "BTC-USD", strat: "vwap_mr",   side: "SELL", conf: 0.61, state: "REJECTED", z:  2.05, adx: 34, note: "ADX>25 regime block" },
  { id: "s204", ts: "09:34:12", sym: "BTC-USD", strat: "breakout",  side: "BUY",  conf: 0.81, state: "ACCEPTED", z:  null, adx: 30, note: "donchian+vol confluence" },
  { id: "s203", ts: "09:22:41", sym: "ETH-USD", strat: "breakout",  side: "SELL", conf: 0.55, state: "REJECTED", z:  null, adx: 19, note: "ADX<20" },
  { id: "s202", ts: "09:18:55", sym: "ETH-USD", strat: "vwap_mr",   side: "SELL", conf: 0.79, state: "ACCEPTED", z:  2.41, adx: 18, note: "extreme reversion" },
];

// ---- Fills --------------------------------------------------------
const FILLS = [
  { ts: "10:48:03.214", sym: "SOL-USD", side: "SELL", qty: 42,   px: 184.88,  fee: 1.55,  slip: -0.02 },
  { ts: "10:32:18.102", sym: "BTC-USD", side: "BUY",  qty: 0.12, px: 67388.20, fee: 4.04, slip:  0.80 },
  { ts: "10:12:47.840", sym: "ETH-USD", side: "BUY",  qty: 3.21, px: 3260.88,  fee: 3.14, slip: -0.12 },
  { ts: "09:34:12.901", sym: "BTC-USD", side: "BUY",  qty: 0.30, px: 66839.10, fee: 8.02, slip: -0.90 },
  { ts: "09:18:55.032", sym: "ETH-USD", side: "SELL", qty: 2.00, px: 3278.44,  fee: 3.93, slip:  0.04 },
  { ts: "09:02:11.500", sym: "BTC-USD", side: "SELL", qty: 0.18, px: 67512.00, fee: 4.86, slip:  0.20 },
];

// ---- Risk events -------------------------------------------------
const RISK_EVENTS = [
  { ts: "10:04:31", sev: "warn", kind: "spread_widened",  msg: "ARB-USD spread 98.4pctile — order cancelled" },
  { ts: "09:30:02", sev: "warn", kind: "spread_rejected", msg: "LINK-USD rejected: spread >98th pctile" },
  { ts: "09:00:00", sev: "info", kind: "session_open",    msg: "Session opened — paper equity $100,000" },
];

// ---- Strategy config ---------------------------------------------
const STRATEGIES = [
  {
    id: "meta",
    name: "Meta Signal (ML)",
    desc: "Machine-learning filter that gates all signals",
    enabled: true, kind: "ml",
    params: [{ key: "threshold", label: "Probability threshold", val: 0.65, min: 0.5, max: 0.9, step: 0.01, format: (v)=>`${(v*100).toFixed(0)}%` }],
    stats: { winRate: 0.586, avgR: 0.34, acceptance: 0.68, volume: 8 },
  },
  {
    id: "breakout",
    name: "Breakout + Volume",
    desc: "20-period Donchian breakout gated by ADX and volume",
    enabled: true, kind: "trend",
    params: [
      { key: "adxMin",       label: "ADX minimum",     val: 25, min: 15, max: 40, step: 1,  format: (v)=>`${v}` },
      { key: "donchianN",    label: "Donchian period", val: 20, min: 10, max: 40, step: 1,  format: (v)=>`${v}` },
      { key: "atrPctileMin", label: "ATR pctile min",  val: 60, min: 30, max: 90, step: 5,  format: (v)=>`${v}` },
    ],
    stats: { winRate: 0.564, avgR: 1.42, trades: 48, lastR: [0.8,-1,1.4,2.1,-1,0.9,1.6,-1,0.7,2.2,1.1,-1] },
  },
  {
    id: "vwap_mr",
    name: "VWAP Mean Reversion",
    desc: "Fade extreme deviations from VWAP in low-ADX regimes",
    enabled: true, kind: "revert",
    params: [
      { key: "zAbsMin", label: "|Z| minimum", val: 2.0, min: 1.5, max: 3.0, step: 0.1, format: (v)=>`${v.toFixed(1)}σ` },
      { key: "adxMax",  label: "ADX maximum", val: 25,  min: 15,  max: 35,  step: 1,   format: (v)=>`${v}` },
    ],
    stats: { winRate: 0.612, avgR: 0.82, trades: 63, lastR: [1.1,0.8,-1,1.3,0.9,-1,1.2,0.7,-1,1.1,1.4,0.6] },
  },
];

// ---- Regime -------------------------------------------------------
const REGIME = { label: "TREND • BULL", adx: 31, atrPctile: 64, spreadPctile: 42, session: "NY AM", volState: "EXPANDING" };

// ---- Session stats ------------------------------------------------
const SESSION = {
  openedAt: "09:00:00",
  pnl: 1284.40, pnlR: 1.82,
  realized: 982.10,
  unrealized: 302.30,
  trades: 6, wins: 4, losses: 2,
  winRate: 0.667,
  heat: 1.4,       // %
  heatCap: 3.0,
  maxDrawDown: -0.6, // R
  signalsSeen: 17, signalsTaken: 6, acceptanceRate: 0.353,
  uptime: "03h 12m",
};

// ---- System health -----------------------------------------------
const HEALTH = [
  { k: "MD WS",          ok: true,  v: "43 ms" },
  { k: "BROKER",         ok: true,  v: "112 ms" },
  { k: "DB",             ok: true,  v: "28 ms" },
  { k: "MODEL (ONNX)",   ok: true,  v: "11 ms" },
  { k: "CLOCK SKEW",     ok: true,  v: "0.08 s" },
  { k: "EVENT BUS",      ok: true,  v: "ok"   },
];

// ---- Live ticker feed --------------------------------------------
class LiveFeed {
  constructor() {
    this.listeners = new Set();
    this.state = SYMBOLS.map(s => ({
      ...s,
      last: s.px,
      prev: s.px,
      chg: 0, chgPct: 0,
      hi: s.px * 1.008, lo: s.px * 0.993,
      vol: 0,
      spark: makeSeries(s.s.charCodeAt(0) + s.s.charCodeAt(2), 40, s.px, s.atr * 0.08),
      trend: (Math.random() - 0.5) * 0.0002,
    }));
    this.start();
  }
  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  start() {
    this.interval = setInterval(() => {
      this.state = this.state.map(t => {
        const shock = (Math.random() - 0.5) * t.atr * 0.04;
        const drift = t.trend * t.px;
        const next = Math.max(0.0001, t.last + drift + shock);
        const spark = [...t.spark.slice(1), next];
        return {
          ...t,
          prev: t.last,
          last: next,
          chg: next - t.px,
          chgPct: ((next - t.px) / t.px) * 100,
          hi: Math.max(t.hi, next),
          lo: Math.min(t.lo, next),
          spark,
        };
      });
      this.listeners.forEach(fn => fn(this.state));
    }, 900);
  }
  stop() { clearInterval(this.interval); }
  snapshot() { return this.state; }
}

const FEED = new LiveFeed();

// ---- Engine events (right-rail feed) -----------------------------
const INIT_EVENTS = [
  { ts: "10:48:03", kind: "FILL",    msg: "SOL-USD SELL 42 @ 184.88",       tag: "vwap_mr" },
  { ts: "10:48:02", kind: "SIGNAL",  msg: "SOL-USD accepted p=0.76",        tag: "vwap_mr" },
  { ts: "10:47:58", kind: "SIGNAL",  msg: "SOL-USD candidate z=-2.34",      tag: "vwap_mr" },
  { ts: "10:44:12", kind: "REGIME",  msg: "ADX → 31 (trend regime)",        tag: "system" },
  { ts: "10:32:18", kind: "FILL",    msg: "BTC-USD BUY 0.12 @ 67,388.20",   tag: "breakout" },
  { ts: "10:32:15", kind: "SIGNAL",  msg: "BTC-USD accepted p=0.81",        tag: "breakout" },
  { ts: "10:19:04", kind: "REJECT",  msg: "AVAX-USD p=0.58 < meta 0.65",    tag: "meta" },
  { ts: "10:12:47", kind: "FILL",    msg: "ETH-USD BUY 3.21 @ 3,260.88",    tag: "vwap_mr" },
  { ts: "10:04:31", kind: "RISK",    msg: "ARB-USD spread >98 pctile",      tag: "system" },
  { ts: "09:34:12", kind: "FILL",    msg: "BTC-USD BUY 0.30 @ 66,839.10",   tag: "breakout" },
  { ts: "09:00:00", kind: "SESSION", msg: "Session opened — paper $100k",   tag: "system" },
];

// Format helpers
function fmt(n, dec=2) {
  if (n == null || isNaN(n)) return "—";
  return n.toLocaleString(undefined, { minimumFractionDigits: dec, maximumFractionDigits: dec });
}
function fmtMoney(n, dec=2) { return (n >= 0 ? "$" : "-$") + fmt(Math.abs(n), dec); }
function fmtSign(n, dec=2) { return (n >= 0 ? "+" : "") + fmt(n, dec); }
function fmtPct(n, dec=2) { return fmtSign(n, dec) + "%"; }

// Expose globally
Object.assign(window, {
  SYMBOLS, EQUITY, POSITIONS, ORDERS, SIGNALS, FILLS, RISK_EVENTS,
  STRATEGIES, REGIME, SESSION, HEALTH, INIT_EVENTS,
  FEED, makeCandles, makeSeries, mulberry32,
  fmt, fmtMoney, fmtSign, fmtPct,
});
