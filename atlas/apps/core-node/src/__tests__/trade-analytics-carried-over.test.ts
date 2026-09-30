/**
 * Desk decision 2026-09-30 (Luke): positions carried over from a prior session
 * DO count in the new session's stats, "so we can collect data each time"
 * (PR #82 round-2 review finding 7).
 *
 * Before: a hydrated position never emits `position:opened` (finding-6 fix), so
 * TradeAnalytics had no entry for it, its close logged "Trade not found for
 * exit" and the round trip was missing from closedTrades / totalTrades /
 * trade_log / trading_sessions.total_trades.
 *
 * Drives the PRODUCTION path: TradingEngine's real PositionTracker, RiskEngine
 * and TradeAnalytics wired exactly like start() does (initializers, then
 * hydrateStateFromSupabase), with Supabase mocked per table. start() itself is
 * bypassed the same way paper-order-path.test.ts does.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { EventEmitter } from 'events';
import { TradingEngine, TradingEngineConfig } from '../trading/trading-engine';
import type { Fill } from '../exchanges/coinbase/types';
import type { Logger } from '../core/logger';
import { buildStrategySessionStats, strategyReportTradeInputs } from '../api/strategy-session-stats';

vi.mock('../config/secrets');
vi.mock('../exchanges/coinbase');

const db = vi.hoisted(() => ({
  positionsRows: [] as Array<Record<string, unknown>>,
  upserts: [] as Array<{ table: string; row: Record<string, unknown> }>,
}));

vi.mock('@supabase/supabase-js', () => {
  const FILTER_METHODS = ['eq', 'neq', 'is', 'in', 'gte', 'lte', 'gt', 'lt', 'order', 'limit'];
  function makeBuilder(table: string) {
    let op = 'select';
    const builder: Record<string, unknown> = {};
    const resolve = () => ({
      data: op === 'select' ? (table === 'positions' ? db.positionsRows : []) : null,
      error: null,
    });
    for (const name of FILTER_METHODS) builder[name] = () => builder;
    builder.select = () => builder;
    for (const name of ['insert', 'update', 'delete']) {
      builder[name] = () => {
        op = name;
        return builder;
      };
    }
    builder.upsert = (row: Record<string, unknown>) => {
      op = 'upsert';
      db.upserts.push({ table, row });
      return builder;
    };
    builder.maybeSingle = () => Promise.resolve(resolve());
    builder.single = () => Promise.resolve(resolve());
    builder.then = (onFulfilled?: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
      Promise.resolve(resolve()).then(onFulfilled, onRejected);
    return builder;
  }
  return { createClient: () => ({ from: (table: string) => makeBuilder(table) }) };
});

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;

const guardrails = {
  disabled_strategies: ['vwap_mr', 'breakout', 'momentum'],
  account: { equity_usd: 10000, risk_per_trade: 0.005, max_open_positions: 4, max_account_leverage: 3.0, min_notional_buffer: 1.1 },
  fees: {
    coinbase: { spot: { maker_bps: 25, taker_bps: 40 }, perps_intx: { maker_bps: 0, taker_bps: 5 } },
    hyperliquid: { perps: { maker_bps: -1.5, taker_bps: 4.5 } },
  },
  risk: { daily_loss_limit: -0.02, weekly_loss_limit: -0.05, max_drawdown_limit: -0.15, max_position_exposure_pct: 0.30, funding_cost_tolerance_bps: 20, slippage_estimate_bps: 3, min_ev_threshold: 0 },
  strategy: { mode: 'momentum_futures', donchian_len: 20, ema_len_1h: 100, atr_len_15m: 20, atr_entry_band: [0.0005, 0.05], stop_init_atr: 1.5, stop_trail_atr: 1.0, time_stop_bars: 96, allow_short: true, trade_cooldown_min: 15 },
  execution: { order_type: 'marketable_limit', price_offset_ticks: 2, max_slippage_bps: 5, order_timeout_sec: 5, retry_backoff_ms: [100, 500, 1000, 5000, 30000] },
  circuit_breakers: { rapid_loss_trigger: -0.02, fill_rate_collapse: 0.1, adverse_selection_spike: 0.6, correlation_spike: 0.8, vol_spike_atr: 0.03, data_gap_sec: 30 },
  filters: { atr_volatility_min: 0.005, atr_volatility_max: 0.05, funding_bias_enabled: true, time_filter_enabled: false, allowed_hours_utc: [0] },
  compliance: { tax_method: 'FIFO', export_frequency_days: 7, log_level: 'INFO', audit_trail_enabled: true, flatten_on_shutdown: false },
  ui: { heartbeat_sec: 15, show_pnl_per_symbol: true, show_risk_status: true, kill_switch_button: true, alert_channels: ['telegram'] },
  go_live_criteria: { paper_parity_max_diff_bps: 20, min_profitable_days: 3, max_error_count_per_day: 0, manual_approval_required: true },
};

const SESSION_ID = 'sess_1790000000000_carry1';
const USER_ID = 'b7e8f9c2-4d6a-4c8b-9e2d-1a3b5c7d9e1f';
const HYDRATED_ID = '0b8c1d2e-3f40-4a5b-8c6d-7e8f9a0b1c2d';
const TWO_HOURS_MS = 2 * 60 * 60 * 1000;

const config: TradingEngineConfig = {
  mode: 'paper',
  exchange: { name: 'coinbase', environment: 'production' },
  products: ['BTC-USD'],
  supabase: { url: 'http://localhost:54321', serviceKey: 'test-key', anonKey: 'test-anon', userId: USER_ID },
  security: { encryptionKey: '00'.repeat(32) },
  guardrails: guardrails as unknown as TradingEngineConfig['guardrails'],
  session: { sessionId: SESSION_ID, startedAt: Date.now() },
};

/** A `positions` row left open by a prior session (what hydrate reads). */
function priorSessionRow(openedAtMs: number): Record<string, unknown> {
  return {
    id: HYDRATED_ID,
    symbol: 'BTC-USD',
    side: 'long',
    qty_open: 0.1,
    entry_price: 50000,
    opened_at: new Date(openedAtMs).toISOString(),
    stop_price_at_entry: 48000,
    take_profit_price: 56000,
    strategy: 'trend_follow',
    realized_pnl_usd: 0,
    exit_reason: null,
    execution_mode: 'paper',
  };
}

let seq = 0;
function fill(side: 'buy' | 'sell', size: string, price: string): Fill {
  seq += 1;
  return {
    trade_id: seq,
    product_id: 'BTC-USD',
    order_id: `ord-${seq}`,
    user_id: USER_ID,
    profile_id: 'paper',
    liquidity: 'T',
    price,
    size,
    fee: '0',
    created_at: new Date().toISOString(),
    side,
    settled: true,
    usd_volume: String(Number(size) * Number(price)),
  };
}

/** Private TradingEngine members this harness drives (start() is bypassed). */
interface EngineInternals {
  exchange: EventEmitter;
  isRunning: boolean;
  signalProcessor: unknown;
  initializePaperSimulator(): void;
  initializeOrderManager(): void;
  initializePositionTracker(): void;
  initializeRiskEngine(): void;
  initializeTradeAnalytics(): void;
  setupEventHandlers(): void;
  hydrateStateFromSupabase(): Promise<void>;
  riskEngine?: { stop?(): void; softLaunchEntryTrades: number; getMetrics(): { consecutiveLosses: number } };
  positionTracker?: {
    processFill(f: Fill, ctx?: Record<string, unknown>): Promise<void>;
    on(event: string, cb: (...args: unknown[]) => void): void;
    stopUpdateLoop?(): void;
  };
  orderManager?: { destroy?(): void };
  tradeAnalytics?: { stop?(): Promise<void> };
}

function internals(engine: TradingEngine): EngineInternals {
  return engine as unknown as EngineInternals;
}

/** Same initializer order as TradingEngine.start() (TradeAnalytics before hydrate). */
function wireEngine(): TradingEngine {
  const engine = new TradingEngine(config, logger);
  const e = internals(engine);
  e.exchange = new EventEmitter();
  e.initializePaperSimulator();
  e.initializeOrderManager();
  e.initializePositionTracker();
  e.initializeRiskEngine();
  e.initializeTradeAnalytics();
  e.setupEventHandlers();
  e.isRunning = true;
  return engine;
}

async function teardown(engine: TradingEngine): Promise<void> {
  const e = internals(engine);
  e.riskEngine?.stop?.();
  e.positionTracker?.stopUpdateLoop?.();
  e.orderManager?.destroy?.();
  await e.tradeAnalytics?.stop?.();
}

function tracker(engine: TradingEngine) {
  return internals(engine).positionTracker!;
}

function tradeNotFoundWarned(): boolean {
  return (logger.warn as ReturnType<typeof vi.fn>).mock.calls.some((c) => String(c[0]).includes('Trade not found for exit'));
}

function tradeLogRows(): Array<Record<string, unknown>> {
  return db.upserts.filter((u) => u.table === 'trade_log').map((u) => u.row);
}

describe('carried-over (hydrated) positions count in session stats — desk decision 2026-09-30', () => {
  let engine: TradingEngine;
  let openedAtMs: number;

  beforeEach(async () => {
    vi.clearAllMocks();
    db.upserts = [];
    openedAtMs = Date.now() - TWO_HOURS_MS;
    db.positionsRows = [priorSessionRow(openedAtMs)];
    engine = wireEngine();
    await internals(engine).hydrateStateFromSupabase();
  });

  afterEach(async () => {
    await teardown(engine);
  });

  it('seeds TradeAnalytics at hydrate: one open record, carriedOver, real open time, hydrated price/size/strategy', () => {
    const open = engine.getOpenTrades();
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({
      id: HYDRATED_ID,
      symbol: 'BTC-USD',
      side: 'long',
      entryPrice: 50000,
      size: 0.1,
      strategy: 'trend_follow',
      carriedOver: true,
    });
    expect(open[0].entryTime.getTime()).toBe(openedAtMs);
    expect(engine.getSessionStats()!.carriedOverOpen).toBe(1);
  });

  it('re-hydrate is idempotent (no duplicate open record)', async () => {
    await internals(engine).hydrateStateFromSupabase();
    expect(engine.getOpenTrades()).toHaveLength(1);
  });

  it('hydrated position closed → totalTrades 1, carriedOverClosed 1, no "Trade not found" warn, duration from the real open time', async () => {
    await tracker(engine).processFill(fill('sell', '0.1', '51000'), { tag: 'take_profit' });

    const stats = engine.getSessionStats()!;
    expect(stats.totalTrades).toBe(1);
    expect(stats.carriedOverClosed).toBe(1);
    expect(stats.carriedOverOpen).toBe(0);
    expect(stats.winningTrades).toBe(1);
    expect(tradeNotFoundWarned()).toBe(false);

    const [closed] = engine.getClosedTrades();
    expect(closed.carriedOver).toBe(true);
    expect(closed.duration).toBeGreaterThanOrEqual(TWO_HOURS_MS / 1000);
    expect(closed.duration).toBeLessThan(TWO_HOURS_MS / 1000 + 60);
    expect(closed.realizedPnl).toBeCloseTo(100, 6);
    expect(engine.getOpenTrades()).toHaveLength(0);

    // trade_log: written by the closing session, entry_time = the real open time.
    await new Promise((r) => setImmediate(r));
    const rows = tradeLogRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: HYDRATED_ID, session_id: SESSION_ID, entry_time: new Date(openedAtMs).toISOString() });
  });

  it('hydrated scale-in then close → same record (no position:opened, no second entry), counted once', async () => {
    const opened: unknown[] = [];
    tracker(engine).on('position:opened', (p) => opened.push(p));

    await tracker(engine).processFill(fill('buy', '0.1', '50500'), { strategy: 'trend_follow', tag: 'entry' });
    expect(opened).toHaveLength(0);
    expect(engine.getOpenTrades()).toHaveLength(1);
    expect(engine.getOpenTrades()[0]).toMatchObject({ id: HYDRATED_ID, carriedOver: true });

    await tracker(engine).processFill(fill('sell', '0.2', '49000'), { tag: 'stop_loss' });

    const stats = engine.getSessionStats()!;
    expect(stats.totalTrades).toBe(1);
    expect(stats.carriedOverClosed).toBe(1);
    expect(stats.losingTrades).toBe(1);
    expect(tradeNotFoundWarned()).toBe(false);
    expect(engine.getClosedTrades()[0].entryTime.getTime()).toBe(openedAtMs);
  });

  it('in-session trade is unaffected: counted, not carriedOver', async () => {
    // Close the hydrated one first so the symbol is free for a fresh position.
    await tracker(engine).processFill(fill('sell', '0.1', '50000'), { tag: 'signal_exit' });
    const before = Date.now();
    await tracker(engine).processFill(fill('buy', '0.02', '50000'), { strategy: 'trend_follow', tag: 'entry' });
    const inSession = engine.getOpenTrades();
    expect(inSession).toHaveLength(1);
    expect(inSession[0].carriedOver).toBeFalsy();
    expect(inSession[0].entryTime.getTime()).toBeGreaterThanOrEqual(before);

    await tracker(engine).processFill(fill('sell', '0.02', '51000'), { tag: 'take_profit' });
    const stats = engine.getSessionStats()!;
    expect(stats.totalTrades).toBe(2);
    expect(stats.carriedOverClosed).toBe(1);
    expect(engine.getClosedTrades()[1].carriedOver).toBeFalsy();
  });

  it('strategy report: open side not double counted (hydratedOpenCount is a subset of openTrades)', () => {
    const report = buildStrategySessionStats({
      ...strategyReportTradeInputs(engine, true),
      strategies: [{ id: 'trend_follow', name: 'Trend Follow', enabled: true }],
      session: { sessionId: SESSION_ID, sessionStartedAt: config.session!.startedAt, executionMode: 'paper' },
      engineRunning: true,
    });
    const tf = report.strategies.find((s) => s.strategyId === 'trend_follow')!;
    expect(tf.openTrades).toBe(1);
    expect(tf.hydratedOpenCount).toBe(1);
    expect(tf.carriedOverClosed).toBe(0);
    expect(report.totals.openTrades).toBe(1);
    expect(report.totals.hydratedOpenCount).toBe(1);
  });

  it('strategy report after the close: closedTrades 1, carriedOverClosed 1, nothing open', async () => {
    await tracker(engine).processFill(fill('sell', '0.1', '51000'), { tag: 'take_profit' });
    const report = buildStrategySessionStats({
      ...strategyReportTradeInputs(engine, true),
      strategies: [{ id: 'trend_follow', name: 'Trend Follow', enabled: true }],
      session: { sessionId: SESSION_ID, sessionStartedAt: config.session!.startedAt, executionMode: 'paper' },
      engineRunning: true,
    });
    expect(report.totals).toMatchObject({ closedTrades: 1, carriedOverClosed: 1, openTrades: 0, hydratedOpenCount: 0, wins: 1 });
  });
});

describe('gate / risk inputs are unchanged by the carried-over seed (reporting only)', () => {
  let engine: TradingEngine;

  beforeEach(async () => {
    vi.clearAllMocks();
    db.upserts = [];
    db.positionsRows = [priorSessionRow(Date.now() - TWO_HOURS_MS)];
    engine = wireEngine();
    await internals(engine).hydrateStateFromSupabase();
  });

  afterEach(async () => {
    await teardown(engine);
  });

  it('seeding emits no position:opened, so the RiskEngine soft-launch entry counter stays 0', () => {
    expect(internals(engine).riskEngine!.softLaunchEntryTrades).toBe(0);
  });

  it('hydrated losing close feeds the meta-filter / EV-gate outcome path exactly once and the kill-ladder streak exactly once', async () => {
    const recordTradeOutcome = vi.fn();
    internals(engine).signalProcessor = { recordTradeOutcome };

    await tracker(engine).processFill(fill('sell', '0.1', '49000'), { tag: 'stop_loss' });

    expect(recordTradeOutcome).toHaveBeenCalledTimes(1);
    expect(recordTradeOutcome.mock.calls[0][0]).toMatchObject({ strategy: 'trend_follow', outcome: 'loss', pnl: -100 });
    expect(internals(engine).riskEngine!.getMetrics().consecutiveLosses).toBe(1);
  });

  it('no gate / risk module reads TradeAnalytics collections (source pin)', () => {
    const root = path.join(__dirname, '..');
    const gateSources = [
      'trading/risk-engine.ts',
      'trading/risk-controller.ts',
      'trading/risk/ev-gate.ts',
      'trading/risk/paper-kill-ladder.ts',
      'trading/risk/pre-trade-gate.ts',
      'trading/risk/evaluate-risk.ts',
      'trading/pnl/pnl-service.ts',
      'strategies/meta-filter.ts',
      'strategies/signal-processor.ts',
      'strategies/regime-gate.ts',
    ];
    for (const rel of gateSources) {
      const src = fs.readFileSync(path.join(root, rel), 'utf8');
      expect(src, rel).not.toMatch(/getSessionStats|getClosedTrades|getOpenTrades|getRecentTrades|trade:closed|trade:opened|carriedOver/);
    }
  });
});

describe('both server.ts strategy-report call sites use the shared trade inputs', () => {
  it('every buildStrategySessionStats call spreads strategyReportTradeInputs and none passes hydratedOpenPositions', () => {
    const server = fs.readFileSync(path.join(__dirname, '..', 'api', 'server.ts'), 'utf8');
    const calls = server.split('buildStrategySessionStats({').slice(1);
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.slice(0, 200)).toMatch(/^\s*\.\.\.strategyReportTradeInputs\(tradingEngine, engineRunning\),/);
    }
    expect(server).not.toMatch(/hydratedOpenPositions/);
  });
});
