// ============================================================
// Apex Automata — datasets for Risk/Model/Backtest/Journal/Alerts/Settings
// ============================================================

// ---- RISK ---------------------------------------------------------
const RISK = {
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
  // per-symbol exposure caps (notional %)
  symbolCaps: [
    { s: 'BTC-USD',  used: 14_200, cap: 30_000, pct: 47.3 },
    { s: 'ETH-USD',  used:  9_800, cap: 20_000, pct: 49.0 },
    { s: 'SOL-USD',  used:  6_420, cap: 10_000, pct: 64.2 },
    { s: 'AVAX-USD', used:  3_100, cap: 10_000, pct: 31.0 },
    { s: 'LINK-USD', used:  2_700, cap:  8_000, pct: 33.8 },
    { s: 'ARB-USD',  used:  2_000, cap:  8_000, pct: 25.0 },
  ],
  // risk radar axes (0-100, higher = more risk)
  radar: [
    { k: 'Concentration', v: 54 },
    { k: 'Volatility',    v: 68 },
    { k: 'Drawdown',      v: 26 },
    { k: 'Correlation',   v: 72 },
    { k: 'Leverage',      v: 18 },
    { k: 'Liquidity',     v: 35 },
  ],
  // correlation matrix (7d returns)
  corr: [
    //      BTC   ETH   SOL   AVAX  LINK  ARB
    [ 1.00, 0.86, 0.79, 0.72, 0.63, 0.68 ],
    [ 0.86, 1.00, 0.82, 0.77, 0.69, 0.74 ],
    [ 0.79, 0.82, 1.00, 0.88, 0.64, 0.72 ],
    [ 0.72, 0.77, 0.88, 1.00, 0.61, 0.70 ],
    [ 0.63, 0.69, 0.64, 0.61, 1.00, 0.58 ],
    [ 0.68, 0.74, 0.72, 0.70, 0.58, 1.00 ],
  ],
  corrLabels: ['BTC','ETH','SOL','AVAX','LINK','ARB'],
  // exposure tree
  tree: {
    label: 'Portfolio', value: 38_220, children: [
      { label: 'Crypto · Spot', value: 34_500, children: [
        { label: 'Majors', value: 24_000, children: [
          { label: 'BTC-USD', value: 14_200 },
          { label: 'ETH-USD', value:  9_800 },
        ]},
        { label: 'L1 Alts', value: 9_520, children: [
          { label: 'SOL-USD',  value: 6_420 },
          { label: 'AVAX-USD', value: 3_100 },
        ]},
        { label: 'L2/Oracle', value: 4_700, children: [
          { label: 'LINK-USD', value: 2_700 },
          { label: 'ARB-USD',  value: 2_000 },
        ]},
      ]},
      { label: 'Reserves · Cash', value: 86_162 },
    ],
  },
  // kill switch escalation ladder
  killLadder: [
    { lvl: 1, at: 'DD > 3%',          action: 'Reduce new size 50%',  tripped: false },
    { lvl: 2, at: 'DD > 5%',          action: 'No new entries',        tripped: false },
    { lvl: 3, at: '3 consec losses',  action: 'Pause strategy',        tripped: false },
    { lvl: 4, at: 'DD > 8%',          action: 'Flatten all positions', tripped: false },
    { lvl: 5, at: 'Venue rejects x5', action: 'Cold shutdown + page',  tripped: false },
  ],
};

// ---- MODEL --------------------------------------------------------
const MODEL = {
  name: 'xgb_v2.4',
  arch: 'XGBoost · 400 trees · depth 6',
  features: 128,
  params: '1.2M',
  file: 'xgb_v2.4.onnx',
  size: '3.4 MB',
  rocAuc: 0.784,
  precision: 0.642,
  recall: 0.718,
  f1: 0.678,
  brier: 0.198,
  trainedOn: 47_331,
  trainedAt: '2026-04-11 14:32 UTC',
  // SHAP-style top features for current prediction
  shap: [
    { k: 'regime_adx_15m',      v:  0.124, sign: 1, desc: 'ADX > 30 on 15m' },
    { k: 'breakout_width_20',   v:  0.088, sign: 1, desc: 'Donchian 20 compressed' },
    { k: 'volume_z_5m',         v:  0.072, sign: 1, desc: 'Vol z-score +2.1σ' },
    { k: 'vwap_distance',       v:  0.041, sign: 1, desc: '0.3% above VWAP' },
    { k: 'spread_pctile',       v:  0.032, sign: 1, desc: 'Tight spread (2nd pct)' },
    { k: 'hour_of_day',         v: -0.018, sign: -1, desc: 'US close approaching' },
    { k: 'realized_vol_24h',    v: -0.024, sign: -1, desc: 'RV slightly elevated' },
    { k: 'correlation_btc_eth', v: -0.041, sign: -1, desc: 'High BTC-ETH corr' },
  ],
  // Live inference trace
  infer: [
    { ts: '14:22:04', sym: 'BTC-USD', p: 0.71, state: 'ACCEPTED', top: 'regime_adx · volume_z' },
    { ts: '14:21:38', sym: 'ETH-USD', p: 0.58, state: 'REJECTED', top: 'vwap_dist · hour_of_day' },
    { ts: '14:20:51', sym: 'SOL-USD', p: 0.67, state: 'ACCEPTED', top: 'breakout_width · volume_z' },
    { ts: '14:19:22', sym: 'LINK-USD',p: 0.49, state: 'REJECTED', top: 'spread_pctile · rv_24h' },
    { ts: '14:18:07', sym: 'AVAX-USD',p: 0.62, state: 'REJECTED', top: 'rv_24h · hour_of_day' },
    { ts: '14:17:44', sym: 'ARB-USD', p: 0.74, state: 'ACCEPTED', top: 'breakout_width · regime_adx' },
  ],
  // Training runs / versions
  runs: [
    { v: 'v2.4', date: '2026-04-11', auc: 0.784, prec: 0.642, trades: 47331, note: 'current · expanded features', live: true },
    { v: 'v2.3', date: '2026-03-02', auc: 0.762, prec: 0.618, trades: 42104, note: 'regime-aware threshold' },
    { v: 'v2.2', date: '2026-01-14', auc: 0.741, prec: 0.597, trades: 38290, note: 'SHAP-driven pruning' },
    { v: 'v2.1', date: '2025-11-22', auc: 0.725, prec: 0.581, trades: 35140, note: 'added orderbook features' },
    { v: 'v2.0', date: '2025-09-08', auc: 0.701, prec: 0.554, trades: 30122, note: 'first XGBoost baseline' },
  ],
  // Confusion matrix (counts)
  cm: { tp: 6820, fp: 3810, fn: 2680, tn: 33921 },
  // Calibration: predicted prob vs observed frequency
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
};

// ---- BACKTEST -----------------------------------------------------
const BACKTEST = {
  preset: 'Breakout · BTC/ETH/SOL · 90d',
  config: {
    strategy: 'Breakout · 20/55 Donchian',
    symbols: ['BTC-USD', 'ETH-USD', 'SOL-USD'],
    from: '2026-01-15',
    to: '2026-04-15',
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
  // equity curve with drawdown underlay
  equity: (() => {
    const rnd = mulberry32(99);
    let v = 100_000, peak = v; const out = [];
    for (let i = 0; i < 90; i++) {
      const drift = 250 + (i > 40 ? 120 : 0);
      const shock = (rnd() - 0.46) * 1_400;
      v = Math.max(92_000, v + drift + shock);
      peak = Math.max(peak, v);
      const dd = ((v - peak) / peak) * 100;
      out.push({ i, v, peak, dd });
    }
    return out;
  })(),
  // monthly returns
  monthlyReturns: [
    { m: 'Jan',  r:  4.2 },
    { m: 'Feb',  r: -1.8 },
    { m: 'Mar',  r:  9.1 },
    { m: 'Apr',  r: 11.4 },
  ],
  // trade log sample
  trades: [
    { id: 'bt-1', sym: 'BTC-USD', side: 'LONG',  entry: 62140, exit: 65890, r:  1.82, pnl: 1_640, dur: '6h 12m', date: '2026-03-28' },
    { id: 'bt-2', sym: 'ETH-USD', side: 'LONG',  entry:  3120, exit:  3080, r: -0.65, pnl:  -310, dur: '4h 05m', date: '2026-03-26' },
    { id: 'bt-3', sym: 'SOL-USD', side: 'LONG',  entry:   168, exit:   182, r:  2.10, pnl: 2_210, dur: '11h 40m',date: '2026-03-22' },
    { id: 'bt-4', sym: 'BTC-USD', side: 'SHORT', entry: 66400, exit: 66800, r: -0.35, pnl:  -470, dur: '1h 22m', date: '2026-03-19' },
    { id: 'bt-5', sym: 'ETH-USD', side: 'LONG',  entry:  3042, exit:  3240, r:  2.44, pnl: 2_610, dur: '18h 08m',date: '2026-03-15' },
    { id: 'bt-6', sym: 'SOL-USD', side: 'LONG',  entry:   151, exit:   147, r: -0.82, pnl:  -440, dur: '3h 10m', date: '2026-03-12' },
    { id: 'bt-7', sym: 'BTC-USD', side: 'LONG',  entry: 59800, exit: 62100, r:  1.64, pnl: 1_420, dur: '9h 30m', date: '2026-03-08' },
    { id: 'bt-8', sym: 'ETH-USD', side: 'LONG',  entry:  2980, exit:  2960, r: -0.41, pnl:  -220, dur: '2h 14m', date: '2026-03-04' },
  ],
  // R distribution histogram
  rDist: [
    { bucket: '<-2R',   n:  4 },
    { bucket: '-2 to -1', n: 18 },
    { bucket: '-1 to 0',  n: 37 },
    { bucket: '0 to 1',   n: 28 },
    { bucket: '1 to 2',   n: 31 },
    { bucket: '2 to 3',   n: 16 },
    { bucket: '>3R',      n:  8 },
  ],
};

// ---- JOURNAL ------------------------------------------------------
const JOURNAL = [
  {
    id: 'j-142', sym: 'BTC-USD', side: 'LONG', date: '2026-04-14', time: '09:42 UTC',
    r: 2.1, pnl: 1_840, outcome: 'WIN', tags: ['breakout', 'hi-conf', 'ADX>30'],
    entry: 65_420, exit: 66_980, stop: 64_900, target: 67_200,
    thesis: 'Clean 20-period Donchian break after 36h compression. Volume z +2.4σ, meta p=0.78. ADX confirming trend.',
    lessons: 'Held full target. Good discipline — trail triggered 40bp above entry, no early exit temptation.',
    seed: 11,
  },
  {
    id: 'j-141', sym: 'ETH-USD', side: 'LONG', date: '2026-04-13', time: '14:12 UTC',
    r: -0.9, pnl: -510, outcome: 'LOSS', tags: ['vwap_mr', 'chop', 'low-conf'],
    entry: 3_180, exit: 3_140, stop: 3_135, target: 3_260,
    thesis: 'VWAP mean-reversion on -2.1σ. Meta p=0.62 (borderline, below preferred 0.65).',
    lessons: 'Bad environment — ADX rising meant trend, not mean-revert. Should tighten regime gating on MR strategy.',
    seed: 22,
  },
  {
    id: 'j-140', sym: 'SOL-USD', side: 'LONG', date: '2026-04-12', time: '11:08 UTC',
    r: 1.6, pnl: 1_210, outcome: 'WIN', tags: ['breakout', 'correlated-move'],
    entry: 178.40, exit: 186.20, stop: 174.10, target: 188.50,
    thesis: 'SOL lagging BTC breakout by ~20min. Took entry as confluence with BTC above prior range.',
    lessons: 'Correlated-move setup working well. Exited slightly early — next time let trail handle it.',
    seed: 33,
  },
  {
    id: 'j-139', sym: 'LINK-USD', side: 'SHORT', date: '2026-04-11', time: '20:51 UTC',
    r: 0.8, pnl: 420, outcome: 'WIN', tags: ['vwap_mr', 'overnight'],
    entry: 17.80, exit: 17.40, stop: 18.05, target: 17.20,
    thesis: '+2.8σ extension into resistance, overnight session. Meta p=0.69.',
    lessons: 'Overnight MR working. Spread was 2x normal — factor that into sizing next time.',
    seed: 44,
  },
  {
    id: 'j-138', sym: 'AVAX-USD', side: 'LONG', date: '2026-04-10', time: '16:04 UTC',
    r: -0.5, pnl: -240, outcome: 'LOSS', tags: ['breakout', 'false-break'],
    entry: 39.20, exit: 38.70, stop: 38.65, target: 41.00,
    thesis: 'Range breakout but volume was weak (+0.8σ, below threshold).',
    lessons: 'Strategy should have filtered this. Volume z threshold is too low — raise to 1.5σ.',
    seed: 55,
  },
  {
    id: 'j-137', sym: 'BTC-USD', side: 'SHORT', date: '2026-04-09', time: '02:30 UTC',
    r: 2.8, pnl: 2_310, outcome: 'WIN', tags: ['breakout', 'asian-session'],
    entry: 68_420, exit: 66_100, stop: 68_800, target: 66_000,
    thesis: 'Breakdown from consolidation. Asian session liquidity thin, fast move.',
    lessons: 'Best trade of week. Target hit almost exactly. Trust the system.',
    seed: 66,
  },
];

// ---- ALERT RULES --------------------------------------------------
const ALERT_RULES = [
  {
    id: 'r-01', name: 'Large drawdown', enabled: true,
    when: { source: 'portfolio', metric: 'drawdown', op: '>', value: 3.0, unit: '%' },
    then: [{ kind: 'pause', target: 'engine' }, { kind: 'notify', channel: 'slack' }],
    fired: 0, lastFired: '—',
  },
  {
    id: 'r-02', name: 'Venue latency spike', enabled: true,
    when: { source: 'system', metric: 'broker_latency_ms', op: '>', value: 500, unit: 'ms' },
    then: [{ kind: 'notify', channel: 'pagerduty' }],
    fired: 3, lastFired: '2h ago',
  },
  {
    id: 'r-03', name: 'Meta model drift', enabled: true,
    when: { source: 'model', metric: 'roc_auc_7d', op: '<', value: 0.70, unit: '' },
    then: [{ kind: 'notify', channel: 'email' }, { kind: 'flag', target: 'retrain' }],
    fired: 0, lastFired: '—',
  },
  {
    id: 'r-04', name: 'Consecutive losses', enabled: true,
    when: { source: 'portfolio', metric: 'consec_losses', op: '>=', value: 3, unit: '' },
    then: [{ kind: 'pause', target: 'strategy' }, { kind: 'notify', channel: 'slack' }],
    fired: 1, lastFired: 'yesterday',
  },
  {
    id: 'r-05', name: 'Symbol exposure breach', enabled: false,
    when: { source: 'risk', metric: 'symbol_exposure_pct', op: '>', value: 80, unit: '%' },
    then: [{ kind: 'block', target: 'new_orders' }, { kind: 'notify', channel: 'slack' }],
    fired: 0, lastFired: '—',
  },
];
const ALERT_FIRED = [
  { ts: '12:14:08', rule: 'Venue latency spike', detail: 'broker_latency_ms = 612ms > 500ms', level: 'warn' },
  { ts: '09:02:55', rule: 'Venue latency spike', detail: 'broker_latency_ms = 544ms > 500ms', level: 'warn' },
  { ts: 'yday 21:48', rule: 'Consecutive losses', detail: 'consec = 3; strategy paused', level: 'danger' },
  { ts: 'yday 14:11', rule: 'Venue latency spike', detail: 'broker_latency_ms = 721ms', level: 'warn' },
];

// ---- SETTINGS -----------------------------------------------------
const SETTINGS = {
  account: { name: 'Jordan Decker', email: 'jordan@apexautomata.io', plan: 'Pro · annual', seat: 'Seat 1 of 3' },
  venues: [
    { name: 'Coinbase Advanced', kind: 'Spot · Crypto', status: 'connected', latency: 112, key: 'cb_live_...aF3x' },
    { name: 'Kraken',            kind: 'Spot · Crypto', status: 'connected', latency:  94, key: 'kr_live_...9C2q' },
    { name: 'Binance.US',        kind: 'Spot · Crypto', status: 'disabled',  latency: null, key: null },
    { name: 'Alpaca',            kind: 'Equities',      status: 'disabled',  latency: null, key: null },
  ],
  notifications: [
    { channel: 'Slack',       enabled: true,  target: '#trading-alerts' },
    { channel: 'Email',       enabled: true,  target: 'jordan@apexautomata.io' },
    { channel: 'PagerDuty',   enabled: true,  target: 'Apex · Primary' },
    { channel: 'SMS',         enabled: false, target: '+1 •••-•••-4281' },
    { channel: 'Webhook',     enabled: false, target: 'https://…/apex/hook' },
  ],
  riskLimits: {
    maxPortfolioHeatPct: 3.0,
    maxDrawdownPct: 8.0,
    maxPositionPct: 30.0,
    maxConsecLosses: 5,
    maxDailyLoss: 2_500,
    allowShort: true,
    allowOvernight: true,
    killSwitchArmed: true,
  },
};

Object.assign(window, { RISK, MODEL, BACKTEST, JOURNAL, ALERT_RULES, ALERT_FIRED, SETTINGS });
