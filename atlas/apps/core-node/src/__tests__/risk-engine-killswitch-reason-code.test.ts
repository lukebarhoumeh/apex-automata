/**
 * Kill switch reasonCode — P0 fix (DESK GO 2026-09-21).
 *
 * `RiskEngine.activateKillSwitch(reason)` used to call
 * `triggerKillSwitch(reason)` without a reason code, and `triggerKillSwitch`
 * defaulted to `'unknown'`. Every operator / market-data halt therefore
 * persisted as `risk_events.event_type = 'unknown'` — a flat 0 PnL / 0
 * consecutive-loss latch that the desk could not distinguish from a loss
 * stop. The API's own manual-kill row used yet another spelling
 * (`'kill_switch'`) that the restore path cast straight into a reason code.
 *
 * Pins:
 *   1. `activateKillSwitch(reason, code)` passes the code through verbatim —
 *      `manual_killswitch` for operator paths, `data_gap` for the all-stale
 *      market-data monitor — and both are non-daily (survive rollover).
 *   2. The automatic guardrails (daily / weekly / drawdown / streak /
 *      error-rate / latency / rapid-loss) still produce their own codes and
 *      none of them yields `unknown`.
 *   3. Restore: with a same-day latched `risk_metrics` row, `loadRiskState()`
 *      recovers the structured reason from today's still-open `risk_events`
 *      row (including the API's `manual_killswitch` row) so the status
 *      reports HALTED + reasonCode instead of RUNNING with entries blocked.
 *      Read-only; skipped on every reset path.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { RiskEngine, RiskEngineConfig } from '../trading/risk-engine';
import { isDailyHaltReason, RiskHaltReasonCode } from '../trading/risk-state';
import { PositionTracker, PositionTrackerConfig } from '../trading/position-tracker';
import { GuardrailConfig } from '../config/loadGuardrails';

interface RecordedCall {
  table: string;
  op: 'select' | 'insert' | 'upsert' | 'update' | 'delete';
  payload?: unknown;
  options?: unknown;
  filters: Array<[string, ...unknown[]]>;
}

type MockResponse = { data?: unknown; error?: { code?: string; message?: string; details?: string } | null };
type Responder = (call: RecordedCall) => MockResponse;

const harness = vi.hoisted(() => ({
  calls: [] as RecordedCall[],
  responders: new Map<string, Responder>(),
  reset() {
    this.calls.length = 0;
    this.responders.clear();
  },
  respond(key: string, responder: Responder) {
    this.responders.set(key, responder);
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
      builder[op] = (payload?: unknown, options?: unknown) => {
        call.op = op;
        call.payload = payload;
        call.options = options;
        return builder;
      };
    }
    builder.maybeSingle = () => Promise.resolve(resolve());
    builder.single = () => Promise.resolve(resolve());
    builder.then = (onFulfilled?: (v: MockResponse) => unknown, onRejected?: (e: unknown) => unknown) =>
      Promise.resolve(resolve()).then(onFulfilled, onRejected);
    return builder;
  }

  return {
    createClient: () => ({
      from: (table: string) => makeBuilder(table),
    }),
  };
});

const USER_ID = 'b7e8f9c2-4d6a-4c8b-9e2d-1a3b5c7d9e1f';

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

const guardrails = {
  disabled_strategies: [],
  account: {
    equity_usd: 10000,
    risk_per_trade: 0.01,
    max_open_positions: 2,
    max_account_leverage: 3.0,
    min_notional_buffer: 1.1,
  },
  risk: {
    daily_loss_limit: -0.02,
    weekly_loss_limit: -0.05,
    max_drawdown_limit: -0.15,
    max_position_exposure_pct: 0.5,
    funding_cost_tolerance_bps: 20,
    slippage_estimate_bps: 3,
    min_ev_threshold: 0,
  },
  fees: {
    coinbase: { spot: { maker_bps: 25, taker_bps: 40 }, perps_intx: { maker_bps: 0, taker_bps: 5 } },
    hyperliquid: { perps: { maker_bps: -1.5, taker_bps: 4.5 } },
  },
  strategy: {
    mode: 'momentum_futures',
    donchian_len: 20,
    ema_len_1h: 100,
    atr_len_15m: 20,
    atr_entry_band: [0.005, 0.025] as [number, number],
    stop_init_atr: 1.5,
    stop_trail_atr: 1.0,
    time_stop_bars: 96,
    allow_short: true,
    trade_cooldown_min: 15,
  },
  execution: {
    order_type: 'marketable_limit',
    price_offset_ticks: 2,
    max_slippage_bps: 5,
    order_timeout_sec: 5,
    retry_backoff_ms: [100, 500, 1000] as [number, ...number[]],
  },
  circuit_breakers: {
    rapid_loss_trigger: -0.02,
    fill_rate_collapse: 0.1,
    adverse_selection_spike: 0.6,
    correlation_spike: 0.8,
    vol_spike_atr: 0.03,
    data_gap_sec: 30,
  },
  filters: {
    atr_volatility_min: 0.005,
    atr_volatility_max: 0.05,
    funding_bias_enabled: true,
    time_filter_enabled: false,
    allowed_hours_utc: [0] as [number, ...number[]],
  },
  compliance: {
    tax_method: 'FIFO',
    export_frequency_days: 7,
    log_level: 'INFO',
    audit_trail_enabled: true,
    flatten_on_shutdown: true,
  },
  ui: {
    heartbeat_sec: 15,
    show_pnl_per_symbol: true,
    show_risk_status: true,
    kill_switch_button: true,
    alert_channels: ['telegram'] as [string, ...string[]],
  },
  go_live_criteria: {
    paper_parity_max_diff_bps: 20,
    min_profitable_days: 3,
    max_error_count_per_day: 0,
    manual_approval_required: true,
  },
} satisfies GuardrailConfig;

const positionTrackerConfig: PositionTrackerConfig = {
  supabaseUrl: 'http://localhost:54321',
  supabaseKey: 'test-key',
  updateInterval: 5000,
  pnlCalculationMethod: 'fifo',
  maxPositionValueUsd: 5000,
  maxUnrealizedLossUsd: 80,
  drawdownWarningPct: 5,
  drawdownCriticalPct: 10,
};

const baseConfig: RiskEngineConfig = {
  supabaseUrl: 'http://localhost:54321',
  supabaseKey: 'test-key',
  userId: USER_ID,
  limits: {
    maxPositionSize: 5000,
    maxTotalExposure: 30000,
    maxDailyLoss: 200,
    maxDrawdown: 15,
    maxOrderSize: 5000,
    minOrderSize: 10,
    maxOpenOrders: 5,
    maxLeverage: 3,
  },
  killSwitches: {
    enabled: true,
    dailyLossLimit: 200,
    consecutiveLossLimit: 8,
    errorRateLimit: 20,
    latencyLimit: 2000,
  },
  riskPerTrade: 1,
  kellyFraction: 0.25,
  guardrails,
  accountEquity: 10000,
};

const todayIso = () => new Date().toISOString();

/** A persisted risk_metrics row that says "kill switch latched, flat PnL, no streak". */
function latchedFlatRow() {
  return {
    user_id: USER_ID,
    daily_pnl: 0,
    max_drawdown: 0,
    consecutive_losses: 0,
    error_rate: 0,
    kill_switch_active: true,
    exposure_usd: 0,
    updated_at: todayIso(),
    execution_mode: 'paper',
  };
}

/** Wait until the constructor's fire-and-forget loaders have settled. */
async function waitForLoaders(engine: RiskEngine) {
  await vi.waitFor(() => {
    expect(harness.callsFor('risk_metrics', 'select').length).toBeGreaterThan(0);
  });
  await new Promise((r) => setTimeout(r, 0));
  return engine;
}

/**
 * The halt row the state machine persisted (first `risk_events` insert).
 * `RiskStateMachine.halt()` persists fire-and-forget, so the insert lands a
 * microtask after the synchronous halt.
 */
async function haltInsert() {
  await vi.waitFor(() => expect(harness.callsFor('risk_events', 'insert').length).toBeGreaterThan(0));
  return harness.callsFor('risk_events', 'insert')[0];
}

describe('RiskEngine kill switch reasonCode (P0: no more `unknown`)', () => {
  let positionTracker: PositionTracker;
  let engine: RiskEngine | null;

  beforeEach(() => {
    harness.reset();
    vi.clearAllMocks();
    positionTracker = new PositionTracker(positionTrackerConfig, mockLogger as any);
    engine = null;
  });

  afterEach(() => {
    vi.useRealTimers();
    engine?.stop();
    positionTracker.stopUpdateLoop();
  });

  async function freshEngine(overrides: Partial<RiskEngineConfig> = {}): Promise<RiskEngine> {
    const e = await waitForLoaders(new RiskEngine({ ...baseConfig, ...overrides }, mockLogger as any, positionTracker));
    harness.calls.length = 0;
    vi.clearAllMocks();
    return e;
  }

  describe('activateKillSwitch(reason, reasonCode)', () => {
    test('operator kill (POST /api/engine/kill, /api/risk/killswitch, emergencyStop) halts as manual_killswitch', async () => {
      engine = await freshEngine();

      engine.activateKillSwitch('User activated kill switch', 'manual_killswitch');

      expect(engine.getMetrics().killSwitchActive).toBe(true);
      expect(engine.canEnterTrades()).toBe(false);
      expect(engine.canExitTrades()).toBe(true);

      const status = engine.getRiskStatus();
      expect(status.tradingState).toBe('HALTED');
      expect(status.reasonCode).toBe('manual_killswitch');
      expect(status.reasonCode).not.toBe('unknown');
      // The caller's text is the halt text — no "Manual activation:" prefix.
      expect(status.reasonText).toBe('User activated kill switch');
      expect(status.daily).toBe(false);

      const insert = await haltInsert();
      expect(insert.payload).toMatchObject({
        user_id: USER_ID,
        event_type: 'manual_killswitch',
        execution_mode: 'paper',
        details: {
          eventType: 'halt',
          reasonCode: 'manual_killswitch',
          reasonText: 'User activated kill switch',
          daily: false,
        },
      });
      expect(mockLogger.error).toHaveBeenCalledWith('KILL SWITCH TRIGGERED: User activated kill switch');
    });

    test('market-data gap on all symbols halts as data_gap', async () => {
      engine = await freshEngine();

      engine.activateKillSwitch('Market data gap detected: BTC-USD(45s), ETH-USD(45s)', 'data_gap');

      const status = engine.getRiskStatus();
      expect(status.tradingState).toBe('HALTED');
      expect(status.reasonCode).toBe('data_gap');
      expect(status.reasonText).toBe('Market data gap detected: BTC-USD(45s), ETH-USD(45s)');
      expect(status.daily).toBe(false);
      expect(engine.canEnterTrades()).toBe(false);

      expect((await haltInsert()).payload).toMatchObject({
        event_type: 'data_gap',
        details: { reasonCode: 'data_gap', daily: false },
      });
    });

    test('is idempotent: a second activation does not overwrite the first reason', async () => {
      engine = await freshEngine();

      engine.activateKillSwitch('Market data gap detected: BTC-USD(45s)', 'data_gap');
      engine.activateKillSwitch('User activated kill switch', 'manual_killswitch');

      expect(engine.getRiskStatus().reasonCode).toBe('data_gap');
      await haltInsert();
      await new Promise((r) => setTimeout(r, 0));
      expect(harness.callsFor('risk_events', 'insert')).toHaveLength(1);
    });

    test.each<RiskHaltReasonCode>(['manual_killswitch', 'data_gap'])(
      '%s is non-daily: it survives the risk-day rollover until an operator resumes',
      async (code) => {
        engine = await freshEngine();
        engine.activateKillSwitch(`halt via ${code}`, code);
        expect(isDailyHaltReason(code)).toBe(false);

        // Only Date.* is mocked here (no fake timers), so the mocked Supabase
        // promise chains keep resolving normally.
        vi.setSystemTime(new Date(Date.now() + 24 * 60 * 60 * 1000));
        expect(engine.checkDayRollover()).toBe(true);

        const status = engine.getRiskStatus();
        expect(status.tradingState).toBe('HALTED');
        expect(status.reasonCode).toBe(code);
        expect(engine.canEnterTrades()).toBe(false);
        expect(harness.callsFor('risk_events', 'update')).toHaveLength(0);
      }
    );

    test('resume after an operator halt clears the manual_killswitch rows (API row shares the event_type)', async () => {
      engine = await freshEngine();
      engine.activateKillSwitch('User activated kill switch', 'manual_killswitch');
      harness.calls.length = 0;

      await expect(engine.deactivateKillSwitch()).resolves.toBe(true);

      expect(engine.canEnterTrades()).toBe(true);
      expect(engine.getRiskStatus().tradingState).toBe('RUNNING');

      const perReasonClear = harness
        .callsFor('risk_events', 'update')
        .find((c) => c.filters.some(([m, col]) => m === 'eq' && col === 'event_type'));
      expect(perReasonClear).toBeDefined();
      expect(perReasonClear!.filters).toEqual(
        expect.arrayContaining([
          ['eq', 'user_id', USER_ID],
          ['eq', 'event_type', 'manual_killswitch'],
          ['is', 'cleared_at', null],
          ['eq', 'execution_mode', 'paper'],
        ])
      );
    });
  });

  describe('automatic guardrails keep their own codes (unchanged)', () => {
    type Trip = { code: RiskHaltReasonCode; arm: (e: RiskEngine) => void };

    const viaCheckKillSwitches: Trip[] = [
      { code: 'consecutive_losses', arm: (e) => { (e as any).metrics.consecutiveLosses = 8; (e as any).checkKillSwitches(); } },
      { code: 'error_rate', arm: (e) => { (e as any).metrics.errorRate = 20; (e as any).checkKillSwitches(); } },
      { code: 'latency', arm: (e) => { (e as any).metrics.averageLatency = 2000; (e as any).checkKillSwitches(); } },
      { code: 'daily_stop', arm: (e) => { (e as any).metrics.dailyPnL = -200; (e as any).checkKillSwitches(); } },
    ];

    // Equity-based guardrails. Limits from the fixture: daily 2% = $200,
    // weekly 5% = $500, drawdown 15% = $1,500, rapid 2% = $200 in <10m.
    const viaLossGuardrails: Trip[] = [
      {
        code: 'daily_stop',
        arm: (e) => { (e as any).enforceLossGuardrails(9800); },
      },
      {
        code: 'weekly_stop',
        arm: (e) => {
          (e as any).dailyStartEquity = 10000;
          (e as any).weeklyStartEquity = 10600;
          (e as any).enforceLossGuardrails(9900); // daily -100 (ok), weekly -700 (trip)
        },
      },
      {
        code: 'max_drawdown',
        arm: (e) => {
          (e as any).dailyStartEquity = 8600;
          (e as any).weeklyStartEquity = 8600;
          (e as any).enforceLossGuardrails(8500); // daily/weekly -100 (ok), 10000 -> 8500 = -1500 (trip)
        },
      },
      {
        code: 'rapid_loss',
        arm: (e) => {
          (e as any).dailyStartEquity = 9700;
          (e as any).weeklyStartEquity = 9700;
          (e as any).enforceLossGuardrails(10000);
          (e as any).enforceLossGuardrails(9790); // -210 inside the 10m window (trip)
        },
      },
    ];

    test.each([...viaCheckKillSwitches, ...viaLossGuardrails])(
      '$code',
      async ({ code, arm }) => {
        engine = await freshEngine();

        arm(engine);

        const status = engine.getRiskStatus();
        expect(status.tradingState).toBe('HALTED');
        expect(status.reasonCode).toBe(code);
        expect(status.reasonCode).not.toBe('unknown');
        expect(status.daily).toBe(isDailyHaltReason(code));
        expect(engine.getMetrics().killSwitchActive).toBe(true);
        expect((await haltInsert()).payload).toMatchObject({ event_type: code, details: { reasonCode: code } });
      }
    );

    test('no guardrail path or caller ever produces an `unknown` halt', async () => {
      engine = await freshEngine();
      const codes = new Set<string>();
      engine.on('risk:state_changed', (ev: any) => {
        if (ev.newState.state === 'HALTED') codes.add(ev.newState.reasonCode);
      });

      for (const trip of [...viaCheckKillSwitches, ...viaLossGuardrails]) {
        trip.arm(engine);
        await engine.deactivateKillSwitch();
      }
      engine.activateKillSwitch('op', 'manual_killswitch');
      await engine.deactivateKillSwitch();
      engine.activateKillSwitch('gap', 'data_gap');
      await new Promise((r) => setTimeout(r, 0));

      expect(codes.size).toBeGreaterThan(0);
      expect(codes.has('unknown')).toBe(false);
      expect(harness.callsFor('risk_events', 'insert').length).toBeGreaterThanOrEqual(codes.size);
      for (const insert of harness.callsFor('risk_events', 'insert')) {
        expect((insert.payload as { event_type: string }).event_type).not.toBe('unknown');
      }
    });
  });

  describe('loadRiskState() restores the halt reason from open risk_events', () => {
    function openRow(event_type: string, details: Record<string, unknown>) {
      return {
        id: 'evt-1',
        user_id: USER_ID,
        event_type,
        details,
        active: true,
        triggered_at: todayIso(),
        cleared_at: null,
        execution_mode: 'paper',
      };
    }

    async function bootLatched(events: unknown[], overrides: Partial<RiskEngineConfig> = {}) {
      harness.respond('risk_metrics.select', () => ({ data: latchedFlatRow() }));
      harness.respond('risk_events.select', () => ({ data: events }));
      const e = await waitForLoaders(new RiskEngine({ ...baseConfig, ...overrides }, mockLogger as any, positionTracker));
      if (!overrides.ignorePersistedKillSwitch) {
        await vi.waitFor(() => expect(harness.callsFor('risk_events', 'select').length).toBeGreaterThan(0));
        await new Promise((r) => setTimeout(r, 0));
      }
      return e;
    }

    test("API's own manual_killswitch row (details.reason) is restored as HALTED/manual_killswitch, non-daily", async () => {
      engine = await bootLatched([openRow('manual_killswitch', { reason: 'User activated kill switch' })]);

      expect(engine.getMetrics().killSwitchActive).toBe(true);
      expect(engine.canEnterTrades()).toBe(false);

      const status = engine.getRiskStatus();
      expect(status.tradingState).toBe('HALTED');
      expect(status.reasonCode).toBe('manual_killswitch');
      expect(status.reasonText).toBe('User activated kill switch');
      expect(status.daily).toBe(false);

      const select = harness.callsFor('risk_events', 'select')[0];
      expect(select.filters).toEqual(
        expect.arrayContaining([
          ['eq', 'user_id', USER_ID],
          ['is', 'cleared_at', null],
          ['eq', 'execution_mode', 'paper'],
        ])
      );
      // Restore is read-only.
      expect(harness.callsFor('risk_metrics', 'upsert')).toHaveLength(0);
      expect(harness.callsFor('risk_events', 'update')).toHaveLength(0);
      expect(harness.callsFor('risk_events', 'insert')).toHaveLength(0);
    });

    test('state-machine row with persisted reasonText/daily is restored verbatim (data_gap)', async () => {
      engine = await bootLatched([
        openRow('data_gap', {
          eventType: 'halt',
          reasonCode: 'data_gap',
          reasonText: 'Market data gap detected: BTC-USD(45s)',
          daily: false,
        }),
      ]);

      const status = engine.getRiskStatus();
      expect(status.tradingState).toBe('HALTED');
      expect(status.reasonCode).toBe('data_gap');
      expect(status.reasonText).toBe('Market data gap detected: BTC-USD(45s)');
      expect(status.daily).toBe(false);
    });

    test('legacy row without daily/reasonText derives daily-ness from the code', async () => {
      engine = await bootLatched([openRow('daily_stop', { eventType: 'halt', reasonCode: 'daily_stop', dailyPnlUsd: -210 })]);

      const status = engine.getRiskStatus();
      expect(status.reasonCode).toBe('daily_stop');
      expect(status.daily).toBe(true);
      expect(status.reasonText).toBe('Restored: daily_stop');
    });

    test('restored non-daily halt does not auto-clear on rollover', async () => {
      engine = await bootLatched([openRow('manual_killswitch', { reason: 'User activated kill switch' })]);

      vi.setSystemTime(new Date(Date.now() + 24 * 60 * 60 * 1000));
      expect(engine.checkDayRollover()).toBe(true);

      expect(engine.getRiskStatus().tradingState).toBe('HALTED');
      expect(engine.getRiskStatus().reasonCode).toBe('manual_killswitch');
    });

    test('operator resume after a restored halt stamps cleared_at on the restored event_type', async () => {
      engine = await bootLatched([openRow('manual_killswitch', { reason: 'User activated kill switch' })]);
      harness.calls.length = 0;

      await expect(engine.deactivateKillSwitch()).resolves.toBe(true);

      expect(engine.getRiskStatus().tradingState).toBe('RUNNING');
      expect(engine.canEnterTrades()).toBe(true);
      const perReasonClear = harness
        .callsFor('risk_events', 'update')
        .find((c) => c.filters.some(([m, col, v]) => m === 'eq' && col === 'event_type' && v === 'manual_killswitch'));
      expect(perReasonClear).toBeDefined();
    });

    test('no open risk_events row: legacy flag-only restore is unchanged', async () => {
      engine = await bootLatched([]);

      expect(engine.getMetrics().killSwitchActive).toBe(true);
      expect(engine.canEnterTrades()).toBe(false);
      expect(engine.getRiskStatus().tradingState).toBe('RUNNING');
    });

    test('ignorePersistedKillSwitch (paper reset) never consults risk_events', async () => {
      engine = await bootLatched([openRow('manual_killswitch', { reason: 'stale' })], { ignorePersistedKillSwitch: true });

      expect(engine.getMetrics().killSwitchActive).toBe(false);
      expect(engine.canEnterTrades()).toBe(true);
      expect(engine.getRiskStatus().tradingState).toBe('RUNNING');
      expect(harness.callsFor('risk_events', 'select')).toHaveLength(0);
    });

    test('a clean risk_metrics row never consults risk_events', async () => {
      harness.respond('risk_metrics.select', () => ({ data: { ...latchedFlatRow(), kill_switch_active: false } }));
      harness.respond('risk_events.select', () => ({ data: [openRow('manual_killswitch', { reason: 'stale' })] }));

      engine = await waitForLoaders(new RiskEngine(baseConfig, mockLogger as any, positionTracker));

      expect(engine.canEnterTrades()).toBe(true);
      expect(harness.callsFor('risk_events', 'select')).toHaveLength(0);
    });
  });
});
