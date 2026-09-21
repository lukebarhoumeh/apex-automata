/**
 * Card SH-QMAKER-CFM-PAPER-v0, blocker 5 — inventory ≤2× kill + Fri 5–6pm ET flatten.
 *
 *   - `cde-hours`: phase calendar around the CDE weekly break (Friday 17:00–18:00
 *     America/New_York), DST-safe — September (EDT, UTC−4) and January (EST,
 *     UTC−5) instants are both classified correctly.
 *   - `CfmGuard`: pre-trade gate (CDE_HOURS_GAP / CFM_LEVERAGE_CAP, reduce-only
 *     always passes), and `tick()` emitting `cfm:flatten_required` once per
 *     break episode and `cfm:leverage_breach` once per breach.
 *   - RiskEngine: registered gates veto inside `checkOrder()`; the new
 *     `leverage_breach` halt code is non-daily.
 *   - TradingEngine (paper, real risk/position/order stack): a `*-CDE` entry is
 *     refused in the flatten window and over the cap; `flattenSymbols()`
 *     cancels resting `*-CDE` orders and market-closes inventory tagged with
 *     the reason.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { cdeBreakStatus, etWallClock, isCdeBreak, CDE_WEEKLY_BREAK } from '../trading/cfm/cde-hours';
import { CfmGuard, CfmFlattenRequiredEvent, CfmLeverageSnapshot, CDE_HOURS_GAP, CFM_LEVERAGE_CAP } from '../trading/cfm/cfm-guard';
import { isDailyHaltReason } from '../trading/risk-state';
import { TradingEngine, TradingEngineConfig } from '../trading/trading-engine';
import type { ManagedOrder } from '../trading/order-manager';
import type { Fill } from '../exchanges/coinbase/types';
import type { Logger } from '../core/logger';

vi.mock('../config/secrets');
vi.mock('../exchanges/coinbase');

vi.mock('@supabase/supabase-js', () => {
  const FILTER_METHODS = ['eq', 'neq', 'is', 'in', 'gte', 'lte', 'gt', 'lt', 'order', 'limit'];
  const OP_METHODS = ['select', 'insert', 'upsert', 'update', 'delete'];
  function makeBuilder() {
    const builder: Record<string, unknown> = {};
    const resolve = () => ({ data: null, error: null });
    for (const name of FILTER_METHODS) builder[name] = () => builder;
    for (const op of OP_METHODS) builder[op] = () => builder;
    builder.maybeSingle = () => Promise.resolve(resolve());
    builder.single = () => Promise.resolve(resolve());
    builder.then = (onFulfilled?: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
      Promise.resolve(resolve()).then(onFulfilled, onRejected);
    return builder;
  }
  return { createClient: () => ({ from: () => makeBuilder() }) };
});

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
const BIP = 'BIP-20DEC30-CDE';
const LEADS = { entryBlockLeadMin: 30, flattenLeadMin: 10 };
const T = (iso: string) => new Date(iso);

// ----------------------------------------------------------------------------
// cde-hours
// ----------------------------------------------------------------------------

describe('cde-hours — Friday 17:00–18:00 America/New_York, DST-safe', () => {
  it('pins the venue fact', () => {
    expect(CDE_WEEKLY_BREAK).toEqual({ timeZone: 'America/New_York', weekday: 5, startHour: 17, endHour: 18 });
  });

  it('September (EDT, UTC−4): 17:00 ET is 21:00Z — phases walk open → entry_blocked → flatten → break → open', () => {
    // Friday 2026-09-25
    expect(cdeBreakStatus(T('2026-09-25T20:29:00Z'), LEADS)).toMatchObject({ phase: 'open', msToNextTransition: 60_000, msToBreakStart: 31 * 60_000, episodeKey: null });
    expect(cdeBreakStatus(T('2026-09-25T20:30:00Z'), LEADS)).toMatchObject({ phase: 'entry_blocked', msToNextTransition: 20 * 60_000, episodeKey: '2026-09-25' });
    expect(cdeBreakStatus(T('2026-09-25T20:49:59Z'), LEADS).phase).toBe('entry_blocked');
    expect(cdeBreakStatus(T('2026-09-25T20:50:00Z'), LEADS)).toMatchObject({ phase: 'flatten', msToNextTransition: 10 * 60_000, msToBreakStart: 10 * 60_000 });
    expect(cdeBreakStatus(T('2026-09-25T21:00:00Z'), LEADS)).toMatchObject({ phase: 'break', msToNextTransition: 60 * 60_000, msToBreakStart: 0, episodeKey: '2026-09-25' });
    expect(cdeBreakStatus(T('2026-09-25T21:59:59Z'), LEADS).phase).toBe('break');
    expect(cdeBreakStatus(T('2026-09-25T22:00:00Z'), LEADS)).toMatchObject({ phase: 'open', episodeKey: null });
    expect(etWallClock(T('2026-09-25T21:00:00Z'))).toMatchObject({ weekday: 5, hour: 17, minute: 0, date: '2026-09-25' });
  });

  it('January (EST, UTC−5): 21:00Z is only 16:00 ET (open); the break is 22:00–23:00Z', () => {
    // Friday 2026-01-16
    expect(cdeBreakStatus(T('2026-01-16T21:00:00Z'), LEADS)).toMatchObject({ phase: 'open', msToBreakStart: 60 * 60_000 });
    expect(cdeBreakStatus(T('2026-01-16T21:30:00Z'), LEADS).phase).toBe('entry_blocked');
    expect(cdeBreakStatus(T('2026-01-16T21:55:00Z'), LEADS).phase).toBe('flatten');
    expect(cdeBreakStatus(T('2026-01-16T22:00:00Z'), LEADS).phase).toBe('break');
    expect(cdeBreakStatus(T('2026-01-16T23:00:00Z'), LEADS).phase).toBe('open');
    expect(etWallClock(T('2026-01-16T22:00:00Z'))).toMatchObject({ weekday: 5, hour: 17, minute: 0 });
  });

  it('other weekdays are open even at 17:30 ET; the countdown to the break spans days', () => {
    expect(cdeBreakStatus(T('2026-09-24T21:30:00Z'), LEADS)).toMatchObject({ phase: 'open' }); // Thursday 17:30 ET
    expect(cdeBreakStatus(T('2026-09-24T21:00:00Z'), LEADS).msToBreakStart).toBe(24 * 60 * 60_000);
    expect(cdeBreakStatus(T('2026-09-26T21:30:00Z'), LEADS).phase).toBe('open'); // Saturday
    expect(cdeBreakStatus(T('2026-09-26T04:00:00Z'), LEADS).et).toMatchObject({ weekday: 6, hour: 0, minute: 0 }); // Sat 00:00 EDT (hour "24" edge)
  });

  it('isCdeBreak and lead validation', () => {
    expect(isCdeBreak(T('2026-09-25T21:30:00Z'))).toBe(true);
    expect(isCdeBreak(T('2026-09-25T20:55:00Z'))).toBe(false);
    expect(() => cdeBreakStatus(T('2026-09-25T20:55:00Z'), { entryBlockLeadMin: 5, flattenLeadMin: 10 })).toThrow(/flattenLeadMin/);
  });

  it('zero leads collapse entry_blocked/flatten so only the break itself blocks', () => {
    const zero = { entryBlockLeadMin: 0, flattenLeadMin: 0 };
    expect(cdeBreakStatus(T('2026-09-25T20:59:59Z'), zero).phase).toBe('open');
    expect(cdeBreakStatus(T('2026-09-25T21:00:00Z'), zero).phase).toBe('break');
  });
});

// ----------------------------------------------------------------------------
// CfmGuard
// ----------------------------------------------------------------------------

type Pos = { symbol: string; side: 'long' | 'short' | 'flat'; size: number; marketPrice: number };

function makeGuard(opts: { positions?: Pos[]; equity?: number; at?: string; maxLeverage?: number } = {}) {
  const state = { positions: opts.positions ?? [], equity: opts.equity ?? 10_000, now: T(opts.at ?? '2026-09-23T15:00:00Z').getTime() };
  const guard = new CfmGuard(
    { symbols: [BIP], maxLeverage: opts.maxLeverage ?? 2, hoursGap: LEADS, logger, now: () => state.now },
    { getOpenPositions: () => state.positions, getEquityUsd: () => state.equity },
  );
  return { guard, state, setTime: (iso: string) => (state.now = T(iso).getTime()) };
}

describe('CfmGuard — pre-trade gate', () => {
  it('ignores non-governed symbols and always lets reduce-only exits through (even during the break)', () => {
    const { guard } = makeGuard({ at: '2026-09-25T21:30:00Z' }); // break
    expect(guard.evaluateEntry({ symbol: 'ETH-USD', isReduceOnly: false, newAbsNotional: 1e9, currentAbsNotional: 0 })).toEqual({ allowed: true });
    expect(guard.evaluateEntry({ symbol: BIP, isReduceOnly: true, newAbsNotional: 0, currentAbsNotional: 5000 })).toEqual({ allowed: true });
    expect(guard.preTradeGate()({ symbol: 'BTC-USD', side: 'buy', isReduceOnly: false, newAbsNotional: 1, currentAbsNotional: 0, orderValueUsd: 1, equityUsd: 1 })).toBeNull();
  });

  it('refuses new *-CDE entries in entry_blocked / flatten / break with CDE_HOURS_GAP', () => {
    const { guard, setTime } = makeGuard();
    setTime('2026-09-25T20:35:00Z');
    const blocked = guard.evaluateEntry({ symbol: BIP, isReduceOnly: false, newAbsNotional: 1000, currentAbsNotional: 0 });
    expect(blocked).toMatchObject({ allowed: false, code: CDE_HOURS_GAP });
    expect(blocked.reason).toMatch(/in 25 min/);
    setTime('2026-09-25T20:55:00Z');
    expect(guard.evaluateEntry({ symbol: BIP, isReduceOnly: false, newAbsNotional: 1000, currentAbsNotional: 0 })).toMatchObject({ allowed: false, code: CDE_HOURS_GAP });
    setTime('2026-09-25T21:30:00Z');
    const closed = guard.evaluateEntry({ symbol: BIP, isReduceOnly: false, newAbsNotional: 1000, currentAbsNotional: 0 });
    expect(closed).toMatchObject({ allowed: false, code: CDE_HOURS_GAP });
    expect(closed.reason).toMatch(/venue closed/);
    setTime('2026-09-25T22:00:00Z');
    expect(guard.evaluateEntry({ symbol: BIP, isReduceOnly: false, newAbsNotional: 1000, currentAbsNotional: 0 })).toEqual({ allowed: true });
  });

  it('Charter ≤2×: projected gross *-CDE notional / equity above the cap is CFM_LEVERAGE_CAP', () => {
    const { guard } = makeGuard({ equity: 10_000 });
    expect(guard.evaluateEntry({ symbol: BIP, isReduceOnly: false, newAbsNotional: 20_000, currentAbsNotional: 0 })).toEqual({ allowed: true }); // exactly 2.0×
    const over = guard.evaluateEntry({ symbol: BIP, isReduceOnly: false, newAbsNotional: 20_001, currentAbsNotional: 0 });
    expect(over).toMatchObject({ allowed: false, code: CFM_LEVERAGE_CAP });
    expect(over.reason).toMatch(/2\.00×.*cap 2×/);
  });

  it('the projection replaces the symbol\'s current notional and sums other governed inventory', () => {
    const { guard, state } = makeGuard({ equity: 10_000, positions: [{ symbol: BIP, side: 'long', size: 0.1, marketPrice: 77_000 }] }); // 7,700 gross
    // adding to 15,000 total on the same symbol → 1.5× ok
    expect(guard.evaluateEntry({ symbol: BIP, isReduceOnly: false, newAbsNotional: 15_000, currentAbsNotional: 7_700 })).toEqual({ allowed: true });
    // 25,000 → 2.5× refused
    expect(guard.evaluateEntry({ symbol: BIP, isReduceOnly: false, newAbsNotional: 25_000, currentAbsNotional: 7_700 })).toMatchObject({ allowed: false, code: CFM_LEVERAGE_CAP });
    // spot inventory never counts toward the CFM cap
    state.positions.push({ symbol: 'BTC-USD', side: 'long', size: 1, marketPrice: 85_000 });
    expect(guard.leverageSnapshot()).toMatchObject({ grossNotionalUsd: 7_700, leverage: 0.77, breached: false });
  });

  it('fails closed when equity is not positive and inventory would exist', () => {
    const { guard } = makeGuard({ equity: 0 });
    expect(guard.evaluateEntry({ symbol: BIP, isReduceOnly: false, newAbsNotional: 1, currentAbsNotional: 0 })).toMatchObject({ allowed: false, code: CFM_LEVERAGE_CAP });
    expect(guard.leverageSnapshot()).toMatchObject({ leverage: 0, breached: false }); // no inventory → 0×
  });

  it('constructor refuses non-CDE symbols and a non-positive cap', () => {
    const sources = { getOpenPositions: () => [], getEquityUsd: () => 1 };
    expect(() => new CfmGuard({ symbols: ['BTC-PERP-INTX'], maxLeverage: 2, hoursGap: LEADS, logger }, sources)).toThrow(/\*-CDE/);
    expect(() => new CfmGuard({ symbols: [BIP], maxLeverage: 0, hoursGap: LEADS, logger }, sources)).toThrow(/maxLeverage/);
  });
});

describe('CfmGuard — tick(): flatten once per break episode, kill once per leverage breach', () => {
  it('emits cfm:flatten_required (cde_hours_gap) on the first tick in `flatten`, then stays quiet through the break, and re-arms next week', () => {
    const { guard, setTime, state } = makeGuard({ positions: [{ symbol: BIP, side: 'long', size: 0.1, marketPrice: 77_000 }] });
    const flattens: CfmFlattenRequiredEvent[] = [];
    guard.on('cfm:flatten_required', (e: CfmFlattenRequiredEvent) => flattens.push(e));

    setTime('2026-09-25T20:40:00Z'); // entry_blocked — no flatten yet
    expect(guard.tick()).toMatchObject({ phase: 'entry_blocked', flattenRequired: null });
    setTime('2026-09-25T20:50:00Z'); // flatten
    const first = guard.tick();
    expect(first.phase).toBe('flatten');
    expect(first.flattenRequired).toMatchObject({ reason: 'cde_hours_gap', symbols: [BIP], phase: 'flatten' });
    setTime('2026-09-25T20:55:00Z');
    expect(guard.tick().flattenRequired).toBeNull();
    setTime('2026-09-25T21:30:00Z'); // break
    expect(guard.tick().flattenRequired).toBeNull();
    expect(flattens).toHaveLength(1);

    setTime('2026-09-25T22:05:00Z'); // open again → episode released
    guard.tick();
    setTime('2026-10-02T20:51:00Z'); // next Friday's flatten window
    state.positions = [];
    const next = guard.tick();
    expect(next.flattenRequired).toMatchObject({ reason: 'cde_hours_gap', symbols: [BIP] }); // no inventory → still cancel resting orders on every governed symbol
    expect(flattens).toHaveLength(2);
    expect(guard.getStatus()).toMatchObject({ breakPhase: 'flatten', flattenedEpisode: '2026-10-02', leverageBreachLatched: false });
  });

  it('emits cfm:leverage_breach + flatten (leverage_breach) once, releases when back inside the cap, re-emits on the next breach', () => {
    const { guard, state } = makeGuard({ equity: 10_000, positions: [{ symbol: BIP, side: 'short', size: 0.3, marketPrice: 77_000 }] }); // 23,100 → 2.31×
    const breaches: CfmLeverageSnapshot[] = [];
    const flattens: CfmFlattenRequiredEvent[] = [];
    guard.on('cfm:leverage_breach', (s: CfmLeverageSnapshot) => breaches.push(s));
    guard.on('cfm:flatten_required', (e: CfmFlattenRequiredEvent) => flattens.push(e));

    const first = guard.tick();
    expect(first.leverageBreachEmitted).toBe(true);
    expect(first.leverage).toMatchObject({ grossNotionalUsd: 23_100, equityUsd: 10_000, breached: true, maxLeverage: 2 });
    expect(first.leverage.leverage).toBeCloseTo(2.31, 6);
    expect(flattens[0]).toMatchObject({ reason: 'leverage_breach', symbols: [BIP] });
    expect(guard.tick().leverageBreachEmitted).toBe(false); // latched
    expect(breaches).toHaveLength(1);

    state.positions = [{ symbol: BIP, side: 'short', size: 0.1, marketPrice: 77_000 }]; // 0.77× → released
    expect(guard.tick().leverage.breached).toBe(false);
    expect(guard.getStatus().leverageBreachLatched).toBe(false);

    state.equity = 3_000; // 7,700 / 3,000 = 2.57× → new breach episode
    expect(guard.tick().leverageBreachEmitted).toBe(true);
    expect(breaches).toHaveLength(2);
    expect(flattens).toHaveLength(2);
  });

  it('start()/stop() tick on an interval without throwing', () => {
    vi.useFakeTimers();
    try {
      const { guard } = makeGuard();
      const ticks: unknown[] = [];
      guard.on('cfm:flatten_required', (e) => ticks.push(e));
      guard.start(1000);
      vi.advanceTimersByTime(3500);
      guard.stop();
      guard.stop();
      expect(ticks).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('risk-state — leverage_breach is a non-daily halt (operator resume required)', () => {
  it('is not auto-cleared on the risk-day rollover', () => {
    expect(isDailyHaltReason('leverage_breach')).toBe(false);
    expect(isDailyHaltReason('daily_stop')).toBe(true);
  });
});

// ----------------------------------------------------------------------------
// TradingEngine integration (paper, real RiskEngine / PositionTracker / OrderManager / simulator)
// ----------------------------------------------------------------------------

const FEES = {
  coinbase: {
    spot: { maker_bps: 25, taker_bps: 40 },
    perps_intx: { maker_bps: 0, taker_bps: 5 },
    cfm_nano: { maker_bps: 9.5, taker_bps: 10, exchange_fee_per_contract_usd: 0.1 },
  },
  hyperliquid: { perps: { maker_bps: -1.5, taker_bps: 4.5 } },
};

const guardrails = {
  disabled_strategies: ['vwap_mr', 'breakout', 'momentum'],
  account: { equity_usd: 10000, risk_per_trade: 0.005, max_open_positions: 4, max_account_leverage: 3.0, min_notional_buffer: 1.1 },
  fees: FEES,
  risk: { daily_loss_limit: -0.02, weekly_loss_limit: -0.05, max_drawdown_limit: -0.15, max_position_exposure_pct: 0.30, funding_cost_tolerance_bps: 20, slippage_estimate_bps: 3, min_ev_threshold: 0 },
  per_symbol: { 'BTC-USD': { max_notional_usd: 3000, max_daily_loss_usd: 200 } },
  cfm: { max_leverage: 2, execution: { order_type: 'post_only', no_chase: true, max_requotes_per_sec: 4 }, hours_gap: LEADS_YAML() },
  cfm_symbols: { [BIP]: { contract_size: 0.01, price_increment_usd: 5, spot_proxy: 'BTC-USD', max_notional_usd: 2000, max_daily_loss_usd: 100, disabled_strategies: ['trend_follow', 'momentum', 'vwap_mr', 'breakout'] } },
  strategy: { mode: 'momentum_futures', donchian_len: 20, ema_len_1h: 100, atr_len_15m: 20, atr_entry_band: [0.0005, 0.05], stop_init_atr: 1.5, stop_trail_atr: 1.0, time_stop_bars: 96, allow_short: true, trade_cooldown_min: 15 },
  execution: { order_type: 'marketable_limit', price_offset_ticks: 2, max_slippage_bps: 5, order_timeout_sec: 5, retry_backoff_ms: [100, 500, 1000, 5000, 30000] },
  circuit_breakers: { rapid_loss_trigger: -0.02, fill_rate_collapse: 0.1, adverse_selection_spike: 0.6, correlation_spike: 0.8, vol_spike_atr: 0.03, data_gap_sec: 30 },
  filters: { atr_volatility_min: 0.005, atr_volatility_max: 0.05, funding_bias_enabled: true, time_filter_enabled: false, allowed_hours_utc: [0] },
  compliance: { tax_method: 'FIFO', export_frequency_days: 7, log_level: 'INFO', audit_trail_enabled: true, flatten_on_shutdown: false },
  ui: { heartbeat_sec: 15, show_pnl_per_symbol: true, show_risk_status: true, kill_switch_button: true, alert_channels: ['telegram'] },
  go_live_criteria: { paper_parity_max_diff_bps: 20, min_profitable_days: 3, max_error_count_per_day: 0, manual_approval_required: true },
};
function LEADS_YAML() {
  return { entry_block_lead_min: 30, flatten_lead_min: 10 };
}

const engineConfig: TradingEngineConfig = {
  mode: 'paper',
  exchange: { name: 'coinbase', environment: 'production' },
  products: ['BTC-USD'],
  supabase: { url: 'http://localhost:54321', serviceKey: 'test-key', anonKey: 'test-anon', userId: 'b7e8f9c2-4d6a-4c8b-9e2d-1a3b5c7d9e1f' },
  security: { encryptionKey: '00'.repeat(32) },
  guardrails: guardrails as unknown as TradingEngineConfig['guardrails'],
};

function wireEngine() {
  const engine = new TradingEngine(engineConfig, logger);
  const e = engine as any;
  e.exchange = new EventEmitter();
  e.initializePaperSimulator();
  e.initializeOrderManager();
  e.initializePositionTracker();
  e.initializeRiskEngine();
  e.setupEventHandlers();
  e.isRunning = true;
  const quote = (bid: number, ask: number, last: number) => {
    e.marketPrices.set(BIP, last);
    e.paperSimulator.updateMarketQuote(BIP, { bid, ask, last });
    e.positionTracker.updateMarketPrice(BIP, last);
  };
  quote(77_715, 77_720, 77_717);
  return { engine, quote };
}

function teardown(engine: TradingEngine): void {
  const e = engine as any;
  e.riskEngine?.stop?.();
  e.positionTracker?.stopUpdateLoop?.();
  e.orderManager?.destroy?.();
}

describe('TradingEngine + CfmGuard (paper) — gate vetoes, kill code, flattenSymbols', () => {
  const previous = process.env.PAPER_DISABLE_SOFT_LAUNCH;
  let engine: TradingEngine;
  let quote: (bid: number, ask: number, last: number) => void;
  let guard: CfmGuard;
  let clock: { now: number };

  beforeEach(() => {
    process.env.PAPER_DISABLE_SOFT_LAUNCH = 'true';
    vi.clearAllMocks();
    ({ engine, quote } = wireEngine());
    clock = { now: T('2026-09-23T15:00:00Z').getTime() }; // Wednesday, open
    const risk = engine.getRiskEngineInstance()!;
    guard = new CfmGuard(
      { symbols: [BIP], maxLeverage: 2, hoursGap: LEADS, logger, now: () => clock.now },
      {
        getOpenPositions: () => engine.getOpenPositions().map((p) => ({ symbol: p.symbol, side: p.side, size: p.size, marketPrice: p.marketPrice })),
        getEquityUsd: () => risk.getAccountEquity(),
      },
    );
    risk.registerPreTradeGate(guard.preTradeGate());
    guard.on('cfm:leverage_breach', (s: CfmLeverageSnapshot) => risk.activateKillSwitch(`CFM leverage ${s.leverage.toFixed(2)}x > ${s.maxLeverage}x`, 'leverage_breach'));
  });

  afterEach(() => {
    teardown(engine);
    if (previous === undefined) delete process.env.PAPER_DISABLE_SOFT_LAUNCH;
    else process.env.PAPER_DISABLE_SOFT_LAUNCH = previous;
  });

  const entry = (size: string, price = '77700') => ({ product_id: BIP, side: 'buy' as const, type: 'limit' as const, size, price, post_only: true });
  const ctx = { strategy: 'system', metadata: { tag: 'entry', noChase: true } };

  it('a *-CDE entry in the flatten window is refused by the risk engine with CDE_HOURS_GAP; spot is unaffected', async () => {
    clock.now = T('2026-09-25T20:55:00Z').getTime();
    const order = await engine.createOrder(entry('0.02'), ctx);
    expect(order).toBeNull();
    expect(engine.getLastOrderRejection()).toMatchObject({ productId: BIP, source: 'risk_engine' });
    expect(engine.getLastOrderRejection()!.reason).toMatch(/^CDE_HOURS_GAP: CDE weekly break in \d+ min/);

    (engine as any).marketPrices.set('BTC-USD', 85_901);
    (engine as any).paperSimulator.updateMarketQuote('BTC-USD', { bid: 85_900, ask: 85_902, last: 85_901 });
    const spot = await engine.createOrder({ product_id: 'BTC-USD', side: 'buy', type: 'limit', size: '0.005', price: '85890', post_only: true }, ctx);
    expect(spot).not.toBeNull();
  });

  it('a *-CDE entry that would exceed 2× equity is refused with CFM_LEVERAGE_CAP (before any per-symbol limit)', async () => {
    // 0.3 BTC × 77,700 = 23,310 > 2 × 10,000
    const order = await engine.createOrder(entry('0.3'), ctx);
    expect(order).toBeNull();
    expect(engine.getLastOrderRejection()!.reason).toMatch(/^CFM_LEVERAGE_CAP: Charter leverage cap/);
    const check = await engine.getRiskEngineInstance()!.checkOrder({ ...entry('0.3'), client_oid: 'x' }, 77_717);
    expect(check.passed).toBe(false);
    expect(check.gateCode).toBe(CFM_LEVERAGE_CAP);
    expect(check.checks.venueGate).toBe(false);
  });

  it('flattenSymbols cancels resting *-CDE orders and market-closes *-CDE inventory tagged with the reason', async () => {
    const fills: Fill[] = [];
    engine.on('order:filled', (_o: ManagedOrder, f: Fill) => fills.push(f));

    // open inventory: passive post-only buy, then the proxy tick reaches it → maker fill → long 0.02
    const opened = await engine.createOrder(entry('0.02', '77710'), ctx);
    expect(opened).not.toBeNull();
    quote(77_705, 77_710, 77_708);
    await new Promise((r) => setTimeout(r, 20));
    expect(fills).toHaveLength(1);
    expect(engine.getOpenPositions().find((p) => p.symbol === BIP)).toMatchObject({ side: 'long', size: 0.02 });

    // a resting order that must be cancelled before the break
    const resting = await engine.createOrder(entry('0.01', '77600'), ctx);
    expect(resting).not.toBeNull();
    expect(engine.getActiveOrders().map((o) => o.id)).toContain(resting!.id);

    clock.now = T('2026-09-25T20:50:30Z').getTime(); // flatten window: exits must still pass the gate
    const result = await engine.flattenSymbols([BIP], { reason: 'cde_hours_gap' });
    await new Promise((r) => setTimeout(r, 20));

    expect(result).toMatchObject({ ordersCancelled: 1, positionsClosed: 1, failures: [] });
    expect(engine.getActiveOrders().find((o) => o.id === resting!.id)).toBeUndefined();
    expect(engine.getOpenPositions().find((p) => p.symbol === BIP && p.size > 0)).toBeUndefined();
    expect(fills).toHaveLength(2);
    expect(fills[1].side).toBe('sell');
    expect(fills[1].fee_side).toBe('taker'); // a forced flatten is a taker exit, attributed honestly
    const flattenOrder: ManagedOrder | undefined = (engine as any).orderManager.getOrderByExchangeOrderId(fills[1].order_id);
    expect(flattenOrder?.metadata).toMatchObject({ tag: 'flatten', reason: 'cde_hours_gap' });
    expect(flattenOrder?.strategy).toBe('system');
  });

  it('a leverage breach latches the kill switch with reasonCode leverage_breach (non-daily) and blocks new entries', async () => {
    const risk = engine.getRiskEngineInstance()!;
    // open 0.02 long, then mark it up so gross / equity > 2×
    const opened = await engine.createOrder(entry('0.02', '77710'), ctx);
    expect(opened).not.toBeNull();
    quote(77_705, 77_710, 77_708);
    await new Promise((r) => setTimeout(r, 20));
    quote(1_100_000, 1_100_010, 1_100_005); // 0.02 × 1.1M = 22,000 > 20,000

    const tick = guard.tick();
    expect(tick.leverage.breached).toBe(true);
    expect(tick.leverageBreachEmitted).toBe(true);
    expect(risk.canEnterTrades()).toBe(false);
    const status = (risk as any).riskStateMachine.getStatus();
    expect(status).toMatchObject({ tradingState: 'HALTED', reasonCode: 'leverage_breach', daily: false });

    const blocked = await engine.createOrder(entry('0.01', '1099000'), ctx);
    expect(blocked).toBeNull();
    expect(engine.getLastOrderRejection()!.reason).toMatch(/Kill switch is active/);

    // reduce-only exits still pass: flatten works while halted
    const result = await engine.flattenSymbols([BIP], { reason: 'leverage_breach' });
    expect(result.positionsClosed).toBe(1);
  });
});
