/**
 * PAPER_RESET_RISK_STATE_ON_START is gated behind RISK_CLEAR=YES — Risk desk
 * pin for the 2026-09-22 stand-down.
 *
 * Drives TradingEngine.initializeRiskEngine() (the only place the flag is
 * read) with the same wiring paper-order-path.test.ts uses, and pins:
 *   - flag alone      -> RiskEngine gets ignorePersistedKillSwitch=false, a
 *                        latched risk_metrics row is RESTORED (no upsert, no
 *                        risk_events sweep), and the ignore is logged;
 *   - flag + RISK_CLEAR=YES -> honoured: latch cleared, persisted, swept;
 *   - RISK_CLEAR alone -> nothing is reset;
 *   - a live engine never consults the paper gate.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import { TradingEngine, TradingEngineConfig } from '../trading/trading-engine';
import type { RiskEngine, RiskEngineConfig } from '../trading/risk-engine';
import type { Logger } from '../core/logger';

vi.mock('../config/secrets');
vi.mock('../exchanges/coinbase');

interface RecordedCall {
  table: string;
  op: 'select' | 'insert' | 'upsert' | 'update' | 'delete';
  payload?: unknown;
  filters: Array<[string, ...unknown[]]>;
}
type MockResponse = { data?: unknown; error?: { code?: string; message?: string } | null };

const harness = vi.hoisted(() => ({
  calls: [] as RecordedCall[],
  responders: new Map<string, (call: RecordedCall) => MockResponse>(),
  reset() {
    this.calls.length = 0;
    this.responders.clear();
  },
  callsFor(table: string, op?: RecordedCall['op']) {
    return this.calls.filter((c) => c.table === table && (op ? c.op === op : true));
  },
}));

vi.mock('@supabase/supabase-js', () => {
  const FILTER_METHODS = ['eq', 'neq', 'is', 'in', 'gte', 'lte', 'gt', 'lt', 'order', 'limit'];
  const OP_METHODS: RecordedCall['op'][] = ['select', 'insert', 'upsert', 'update', 'delete'];
  function makeBuilder(table: string) {
    const call: RecordedCall = { table, op: 'select', filters: [] };
    const builder: Record<string, unknown> = {};
    const resolve = (): MockResponse => {
      harness.calls.push(call);
      const responder = harness.responders.get(`${table}.${call.op}`);
      const response = responder ? responder(call) : {};
      return { data: response.data ?? null, error: response.error ?? null };
    };
    for (const name of FILTER_METHODS) {
      builder[name] = (...args: unknown[]) => {
        call.filters.push([name, ...args]);
        return builder;
      };
    }
    for (const op of OP_METHODS) {
      builder[op] = (payload?: unknown) => {
        call.op = op;
        call.payload = payload;
        return builder;
      };
    }
    builder.maybeSingle = () => Promise.resolve(resolve());
    builder.single = () => Promise.resolve(resolve());
    builder.then = (onFulfilled?: (v: MockResponse) => unknown, onRejected?: (e: unknown) => unknown) =>
      Promise.resolve(resolve()).then(onFulfilled, onRejected);
    return builder;
  }
  return { createClient: () => ({ from: (table: string) => makeBuilder(table) }) };
});

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
const USER_ID = 'b7e8f9c2-4d6a-4c8b-9e2d-1a3b5c7d9e1f';

const guardrails = {
  disabled_strategies: ['vwap_mr', 'breakout', 'momentum'],
  account: { equity_usd: 10000, risk_per_trade: 0.005, max_open_positions: 4, max_account_leverage: 3.0, min_notional_buffer: 1.1 },
  fees: {
    coinbase: { spot: { maker_bps: 25, taker_bps: 40 }, perps_intx: { maker_bps: 0, taker_bps: 5 } },
    hyperliquid: { perps: { maker_bps: -1.5, taker_bps: 4.5 } },
  },
  risk: { daily_loss_limit: -0.02, weekly_loss_limit: -0.05, max_drawdown_limit: -0.15, max_position_exposure_pct: 0.3, funding_cost_tolerance_bps: 20, slippage_estimate_bps: 3, min_ev_threshold: 0 },
  per_symbol: { 'ETH-USD': { max_notional_usd: 3000, max_daily_loss_usd: 200 } },
  strategy: { mode: 'momentum_futures', donchian_len: 20, ema_len_1h: 100, atr_len_15m: 20, atr_entry_band: [0.0005, 0.05], stop_init_atr: 1.5, stop_trail_atr: 1.0, time_stop_bars: 96, allow_short: true, trade_cooldown_min: 15 },
  execution: { order_type: 'marketable_limit', price_offset_ticks: 2, max_slippage_bps: 5, order_timeout_sec: 5, retry_backoff_ms: [100, 500, 1000, 5000, 30000] },
  circuit_breakers: { rapid_loss_trigger: -0.02, fill_rate_collapse: 0.1, adverse_selection_spike: 0.6, correlation_spike: 0.8, vol_spike_atr: 0.03, data_gap_sec: 30 },
  filters: { atr_volatility_min: 0.005, atr_volatility_max: 0.05, funding_bias_enabled: true, time_filter_enabled: false, allowed_hours_utc: [0] },
  compliance: { tax_method: 'FIFO', export_frequency_days: 7, log_level: 'INFO', audit_trail_enabled: true, flatten_on_shutdown: false },
  ui: { heartbeat_sec: 15, show_pnl_per_symbol: true, show_risk_status: true, kill_switch_button: true, alert_channels: ['telegram'] },
  go_live_criteria: { paper_parity_max_diff_bps: 20, min_profitable_days: 3, max_error_count_per_day: 0, manual_approval_required: true },
};

const config: TradingEngineConfig = {
  mode: 'paper',
  exchange: { name: 'coinbase', environment: 'production' },
  products: ['ETH-USD'],
  supabase: { url: 'http://localhost:54321', serviceKey: 'test-key', anonKey: 'test-anon', userId: USER_ID },
  security: { encryptionKey: '00'.repeat(32) },
  guardrails: guardrails as unknown as TradingEngineConfig['guardrails'],
};

const latchedRow = () => ({
  user_id: USER_ID,
  daily_pnl: -410,
  max_drawdown: 4.1,
  consecutive_losses: 12,
  error_rate: 0,
  kill_switch_active: true,
  exposure_usd: 0,
  updated_at: new Date().toISOString(),
  execution_mode: 'paper',
});

const ENV_KEYS = ['PAPER_RESET_RISK_STATE_ON_START', 'RISK_CLEAR'] as const;
const previousEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

function setEnv(values: Partial<Record<(typeof ENV_KEYS)[number], string>>) {
  for (const key of ENV_KEYS) {
    if (values[key] === undefined) delete process.env[key];
    else process.env[key] = values[key];
  }
}

/** The private TradingEngine members this test drives directly (start() is bypassed). */
interface EngineInternals {
  exchange: unknown;
  initializePaperSimulator(): void;
  initializeOrderManager(): void;
  initializePositionTracker(): void;
  initializeRiskEngine(): void;
  riskEngine?: RiskEngine;
  positionTracker?: { stopUpdateLoop(): void };
  orderManager?: { destroy(): void };
}

const internals = (engine: TradingEngine): EngineInternals => engine as unknown as EngineInternals;
const riskConfigOf = (riskEngine: RiskEngine): RiskEngineConfig => (riskEngine as unknown as { config: RiskEngineConfig }).config;

function wireRiskEngine(): { engine: TradingEngine; riskEngine: RiskEngine } {
  const engine = new TradingEngine(config, logger);
  const e = internals(engine);
  e.exchange = new EventEmitter();
  e.initializePaperSimulator();
  e.initializeOrderManager();
  e.initializePositionTracker();
  e.initializeRiskEngine();
  if (!e.riskEngine) throw new Error('initializeRiskEngine() did not build a RiskEngine');
  return { engine, riskEngine: e.riskEngine };
}

function teardown(engine: TradingEngine): void {
  const e = internals(engine);
  e.riskEngine?.stop();
  e.positionTracker?.stopUpdateLoop();
  e.orderManager?.destroy();
}

/** Wait for the RiskEngine constructor's fire-and-forget loadRiskState() to settle. */
async function settled(): Promise<void> {
  await vi.waitFor(() => expect(harness.callsFor('risk_metrics', 'select').length).toBeGreaterThan(0));
  await new Promise((r) => setTimeout(r, 0));
}

const sweeps = () =>
  harness.callsFor('risk_events', 'update').filter((c) => !c.filters.some(([m, col]) => m === 'eq' && col === 'event_type'));

describe('PAPER_RESET_RISK_STATE_ON_START x RISK_CLEAR gate (TradingEngine.initializeRiskEngine)', () => {
  let engine: TradingEngine | null = null;

  beforeEach(() => {
    for (const key of ENV_KEYS) previousEnv[key] = process.env[key];
    harness.reset();
    vi.clearAllMocks();
    harness.responders.set('risk_metrics.select', () => ({ data: latchedRow() }));
  });

  afterEach(() => {
    if (engine) teardown(engine);
    engine = null;
    setEnv(previousEnv as Record<(typeof ENV_KEYS)[number], string>);
  });

  it('flag alone: NOT honoured — the latched row is restored, nothing is written, the ignore is logged', async () => {
    setEnv({ PAPER_RESET_RISK_STATE_ON_START: 'true' });
    const wired = wireRiskEngine();
    engine = wired.engine;
    await settled();

    expect(riskConfigOf(wired.riskEngine).ignorePersistedKillSwitch).toBe(false);
    expect(wired.riskEngine.getMetrics().killSwitchActive).toBe(true);
    expect(wired.riskEngine.getMetrics().consecutiveLosses).toBe(12);
    expect(wired.riskEngine.canEnterTrades()).toBe(false);
    expect(harness.callsFor('risk_metrics', 'upsert')).toHaveLength(0);
    expect(sweeps()).toHaveLength(0);

    expect(logger.warn).toHaveBeenCalledWith(
      'PAPER_RESET_RISK_STATE_ON_START requested but NOT honoured (no RISK_CLEAR=YES)',
      expect.objectContaining({ requested: true, riskClearAuthorized: false, reason: expect.stringContaining('RISK_CLEAR=YES is not set') }),
    );
    // The "overrides active" transparency log must not advertise a reset that is not happening.
    const overridesLog = vi.mocked(logger.warn).mock.calls.find(([msg]) => msg === 'Paper mode overrides active (divergence from live)');
    expect(overridesLog).toBeUndefined();
    expect(logger.info).toHaveBeenCalledWith('Paper mode running with full parity to live (no overrides)');
  });

  it('flag + RISK_CLEAR=YES: honoured — latch cleared, persisted eagerly, risk_events swept in full', async () => {
    setEnv({ PAPER_RESET_RISK_STATE_ON_START: 'true', RISK_CLEAR: 'YES' });
    const wired = wireRiskEngine();
    engine = wired.engine;
    await settled();

    expect(riskConfigOf(wired.riskEngine).ignorePersistedKillSwitch).toBe(true);
    expect(wired.riskEngine.getMetrics().killSwitchActive).toBe(false);
    expect(wired.riskEngine.getMetrics().consecutiveLosses).toBe(0);
    expect(wired.riskEngine.canEnterTrades()).toBe(true);
    expect(harness.callsFor('risk_metrics', 'upsert')[0]?.payload).toMatchObject({ kill_switch_active: false, consecutive_losses: 0 });
    expect(sweeps()).toHaveLength(1);
    expect(sweeps()[0].filters.some(([m, col]) => m === 'in' && col === 'event_type')).toBe(false);

    expect(logger.warn).toHaveBeenCalledWith('PAPER_RESET_RISK_STATE_ON_START honoured under RISK_CLEAR=YES (desk-authorised clean-slate paper boot)');
    expect(logger.warn).toHaveBeenCalledWith(
      'Paper mode overrides active (divergence from live)',
      expect.objectContaining({ activeOverrides: expect.arrayContaining(['resetRiskStateOnStart']) }),
    );
  });

  it('RISK_CLEAR=YES alone resets nothing (authorisation is not a request)', async () => {
    setEnv({ RISK_CLEAR: 'YES' });
    const wired = wireRiskEngine();
    engine = wired.engine;
    await settled();

    expect(riskConfigOf(wired.riskEngine).ignorePersistedKillSwitch).toBe(false);
    expect(wired.riskEngine.getMetrics().killSwitchActive).toBe(true);
    expect(harness.callsFor('risk_metrics', 'upsert')).toHaveLength(0);
    expect(sweeps()).toHaveLength(0);
  });

  it('default env (neither set) is the safe default', async () => {
    setEnv({});
    const wired = wireRiskEngine();
    engine = wired.engine;
    await settled();

    expect(riskConfigOf(wired.riskEngine).ignorePersistedKillSwitch).toBe(false);
    expect(wired.riskEngine.getMetrics().killSwitchActive).toBe(true);
    expect(logger.warn).not.toHaveBeenCalledWith(expect.stringContaining('PAPER_RESET_RISK_STATE_ON_START'), expect.anything());
  });
});
