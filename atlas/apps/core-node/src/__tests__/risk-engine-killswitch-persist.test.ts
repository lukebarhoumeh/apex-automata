/**
 * RiskEngine kill-switch reset persistence.
 *
 * Pins the fix for the "phantom halt" bug documented in
 * docs/runbooks/paper-killswitch-reset.md:
 *
 *   1. `loadRiskState()` used to clear halt state in memory only, on both the
 *      day-boundary path and the `ignorePersistedKillSwitch`
 *      (`PAPER_RESET_RISK_STATE_ON_START=true`) path. The `risk_metrics` row
 *      kept `kill_switch_active=true` until the next 5s metrics tick — or
 *      forever, if the engine stopped first. Both paths must now eagerly
 *      upsert the cleared row and mark stale `risk_events` as cleared.
 *
 *   2. `deactivateKillSwitch()` used to flip the in-memory flag and return
 *      before anything was persisted, and never reset `consecutiveLosses`,
 *      so a streak-triggered halt re-tripped on the very next tick. It must
 *      now clear the streak counters, persist eagerly, and clear stale
 *      `risk_events` before resolving.
 *
 *   3. Restoring a same-day halt (no reset flag) is unchanged and must NOT
 *      write anything during load.
 *
 *   4. Schema tolerance: if `risk_events.active` does not exist the clear
 *      falls back to stamping `cleared_at` on rows where it is still NULL.
 *
 *   5. Persistence failures are logged and swallowed — a DB hiccup never
 *      turns a successful in-memory resume into a thrown error.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { RiskEngine, RiskEngineConfig } from '../trading/risk-engine';
import { PositionTracker, PositionTrackerConfig } from '../trading/position-tracker';
import { GuardrailConfig } from '../config/loadGuardrails';

/**
 * Recording Supabase mock. Every query builder chain is captured as a
 * `RecordedCall` when it is awaited (or `.maybeSingle()`/`.single()` is
 * invoked), regardless of the order the filter methods were chained in.
 * Responses are looked up by `${table}.${op}` and may inspect the call.
 */
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
const yesterdayIso = () => new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

/** A persisted risk_metrics row that says "halted by a 10-loss streak". */
function haltedRow(updatedAt: string) {
  return {
    user_id: USER_ID,
    daily_pnl: -450,
    max_drawdown: 4.5,
    consecutive_losses: 10,
    error_rate: 0,
    kill_switch_active: true,
    exposure_usd: 0,
    updated_at: updatedAt,
  };
}

function firstUpsert() {
  return harness.callsFor('risk_metrics', 'upsert')[0];
}

/**
 * RiskEngine's own stale-event clears. `RiskStateMachine.resume()` also
 * issues a `risk_events` update through the same (mocked) client, but that
 * one is scoped to a single `event_type`; RiskEngine's sweep never is.
 */
function riskEventClears() {
  return harness
    .callsFor('risk_events', 'update')
    .filter((c) => !c.filters.some(([method, column]) => method === 'eq' && column === 'event_type'));
}

/** The state machine's per-reason `cleared_at` stamp (pre-existing behaviour). */
function stateMachineClears() {
  return harness
    .callsFor('risk_events', 'update')
    .filter((c) => c.filters.some(([method, column]) => method === 'eq' && column === 'event_type'));
}

/** Wait until the constructor's fire-and-forget loaders have settled. */
async function waitForLoaders(engine: RiskEngine) {
  await vi.waitFor(() => {
    // loadRiskState always issues exactly one risk_metrics select; once it
    // has been recorded the reset branch (if any) has run to completion
    // because persistClearedRiskState is awaited inside loadRiskState.
    expect(harness.callsFor('risk_metrics', 'select').length).toBeGreaterThan(0);
  });
  // Let any trailing awaits (account_metrics lookups) flush.
  await new Promise((r) => setTimeout(r, 0));
  return engine;
}

describe('RiskEngine kill-switch reset persistence', () => {
  let positionTracker: PositionTracker;
  let engine: RiskEngine | null;

  beforeEach(() => {
    harness.reset();
    vi.clearAllMocks();
    positionTracker = new PositionTracker(positionTrackerConfig, mockLogger as any);
    engine = null;
  });

  afterEach(() => {
    engine?.stop();
    positionTracker.stopUpdateLoop();
  });

  describe('loadRiskState()', () => {
    test('ignorePersistedKillSwitch eagerly persists the cleared row and clears stale risk_events', async () => {
      harness.respond('risk_metrics.select', () => ({ data: haltedRow(todayIso()) }));

      engine = await waitForLoaders(
        new RiskEngine({ ...baseConfig, ignorePersistedKillSwitch: true }, mockLogger as any, positionTracker)
      );

      expect(engine.getMetrics().killSwitchActive).toBe(false);
      expect(engine.getMetrics().consecutiveLosses).toBe(0);
      expect(engine.canEnterTrades()).toBe(true);

      const upsert = firstUpsert();
      expect(upsert).toBeDefined();
      expect(upsert.payload).toMatchObject({
        user_id: USER_ID,
        kill_switch_active: false,
        consecutive_losses: 0,
        daily_pnl: 0,
        max_drawdown: 0,
        // TASK_014 P5: the row is keyed per execution mode (default paper).
        execution_mode: 'paper',
      });
      expect(upsert.options).toMatchObject({ onConflict: 'user_id,execution_mode' });

      const clears = riskEventClears();
      expect(clears).toHaveLength(1);
      expect(clears[0].payload).toMatchObject({ active: false });
      expect((clears[0].payload as { cleared_at: string }).cleared_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(clears[0].filters).toEqual(
        expect.arrayContaining([
          ['eq', 'user_id', USER_ID],
          ['eq', 'active', true],
          ['eq', 'execution_mode', 'paper'],
        ])
      );

      expect(mockLogger.info).toHaveBeenCalledWith(
        'Eagerly persisting cleared risk state',
        expect.objectContaining({ source: 'startup_reset', killSwitchActive: false, consecutiveLosses: 0 })
      );
    });

    test('day-boundary discard of a stale row is persisted, not memory-only', async () => {
      harness.respond('risk_metrics.select', () => ({ data: haltedRow(yesterdayIso()) }));

      engine = await waitForLoaders(new RiskEngine(baseConfig, mockLogger as any, positionTracker));

      expect(engine.getMetrics().killSwitchActive).toBe(false);
      expect(engine.getMetrics().consecutiveLosses).toBe(0);

      const upsert = firstUpsert();
      expect(upsert).toBeDefined();
      expect(upsert.payload).toMatchObject({ kill_switch_active: false, consecutive_losses: 0, daily_pnl: 0 });
      expect(riskEventClears()).toHaveLength(1);
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Eagerly persisting cleared risk state',
        expect.objectContaining({ source: 'day_boundary' })
      );
    });

    test('same-day halt without the reset flag is restored and nothing is written', async () => {
      harness.respond('risk_metrics.select', () => ({ data: haltedRow(todayIso()) }));

      engine = await waitForLoaders(new RiskEngine(baseConfig, mockLogger as any, positionTracker));

      expect(engine.getMetrics().killSwitchActive).toBe(true);
      expect(engine.getMetrics().consecutiveLosses).toBe(10);
      expect(engine.canEnterTrades()).toBe(false);
      expect(harness.callsFor('risk_metrics', 'upsert')).toHaveLength(0);
      expect(riskEventClears()).toHaveLength(0);
    });

    test('clean persisted row with the reset flag still clears stale risk_events (API-inserted halts)', async () => {
      harness.respond('risk_metrics.select', () => ({
        data: { ...haltedRow(todayIso()), kill_switch_active: false, consecutive_losses: 0, daily_pnl: 0, max_drawdown: 0 },
      }));

      engine = await waitForLoaders(
        new RiskEngine({ ...baseConfig, ignorePersistedKillSwitch: true }, mockLogger as any, positionTracker)
      );

      expect(riskEventClears()).toHaveLength(1);
      // No "Resetting persisted risk state" warn because there was nothing dirty to reset.
      expect(mockLogger.warn).not.toHaveBeenCalledWith(
        'Resetting persisted risk state for clean session start',
        expect.anything()
      );
    });

    test('no persisted row: nothing to reset, nothing written', async () => {
      engine = await waitForLoaders(
        new RiskEngine({ ...baseConfig, ignorePersistedKillSwitch: true }, mockLogger as any, positionTracker)
      );

      expect(harness.callsFor('risk_metrics', 'upsert')).toHaveLength(0);
      expect(riskEventClears()).toHaveLength(0);
    });
  });

  describe('deactivateKillSwitch()', () => {
    async function haltedEngine(): Promise<RiskEngine> {
      const e = await waitForLoaders(new RiskEngine(baseConfig, mockLogger as any, positionTracker));
      // Trip the switch the way a losing streak does, then forget the
      // constructor-time DB traffic so assertions only see the resume.
      (e as any).metrics.consecutiveLosses = 10;
      (e as any).checkKillSwitches();
      expect(e.getMetrics().killSwitchActive).toBe(true);
      expect(e.canEnterTrades()).toBe(false);
      harness.calls.length = 0;
      vi.clearAllMocks();
      return e;
    }

    test('clears the streak, persists eagerly, clears stale risk_events, and does not re-trip on the next tick', async () => {
      engine = await haltedEngine();

      const resumed = await engine.deactivateKillSwitch();

      expect(resumed).toBe(true);
      expect(engine.getMetrics().killSwitchActive).toBe(false);
      expect(engine.getMetrics().consecutiveLosses).toBe(0);
      expect(engine.canEnterTrades()).toBe(true);

      const upsert = firstUpsert();
      expect(upsert).toBeDefined();
      expect(upsert.payload).toMatchObject({
        user_id: USER_ID,
        kill_switch_active: false,
        consecutive_losses: 0,
      });

      const clears = riskEventClears();
      expect(clears).toHaveLength(1);
      expect(clears[0].payload).toMatchObject({ active: false });
      expect(clears[0].filters).toEqual(
        expect.arrayContaining([
          ['eq', 'user_id', USER_ID],
          ['eq', 'active', true],
        ])
      );
      // The state machine's own per-reason cleared_at stamp is unchanged.
      expect(stateMachineClears()).toHaveLength(1);
      expect(stateMachineClears()[0].filters).toEqual(
        expect.arrayContaining([['eq', 'event_type', 'consecutive_losses']])
      );

      // Regression guard: before the fix the untouched 10-loss streak made
      // the very next metrics tick re-halt trading.
      (engine as any).checkKillSwitches();
      expect(engine.getMetrics().killSwitchActive).toBe(false);
      expect(engine.canEnterTrades()).toBe(true);

      expect(mockLogger.info).toHaveBeenCalledWith(
        'Eagerly persisting cleared risk state',
        expect.objectContaining({ source: 'manual_resume' })
      );
    });

    test('persistence happens before the promise resolves', async () => {
      engine = await haltedEngine();

      let upsertSeen = false;
      harness.respond('risk_metrics.upsert', () => {
        upsertSeen = true;
        return {};
      });

      const pending = engine.deactivateKillSwitch();
      expect(upsertSeen).toBe(false);
      await pending;
      expect(upsertSeen).toBe(true);
      expect(riskEventClears()).toHaveLength(1);
    });

    test('falls back to cleared_at-only when risk_events.active does not exist', async () => {
      engine = await haltedEngine();
      harness.respond('risk_events.update', (call) => {
        const payload = call.payload as Record<string, unknown>;
        if ('active' in payload) {
          return { error: { code: 'PGRST204', message: "Could not find the 'active' column of 'risk_events' in the schema cache" } };
        }
        return {};
      });

      await engine.deactivateKillSwitch();

      const clears = riskEventClears();
      expect(clears).toHaveLength(2);
      expect(clears[0].payload).toMatchObject({ active: false });
      expect(clears[1].payload).not.toHaveProperty('active');
      expect(clears[1].payload).toHaveProperty('cleared_at');
      expect(clears[1].filters).toEqual(
        expect.arrayContaining([
          ['eq', 'user_id', USER_ID],
          ['is', 'cleared_at', null],
        ])
      );
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'risk_events.active column missing; clearing by cleared_at only',
        expect.objectContaining({ code: 'PGRST204' })
      );
      expect(mockLogger.error).not.toHaveBeenCalled();
    });

    test('treats Postgres 42703 undefined_column the same way', async () => {
      engine = await haltedEngine();
      harness.respond('risk_events.update', (call) =>
        'active' in (call.payload as Record<string, unknown>)
          ? { error: { code: '42703', message: 'column "active" of relation "risk_events" does not exist' } }
          : {}
      );

      await engine.deactivateKillSwitch();

      expect(riskEventClears()).toHaveLength(2);
      expect(riskEventClears()[1].payload).not.toHaveProperty('active');
    });

    test('DB failures are logged and swallowed; the in-memory resume still succeeds', async () => {
      engine = await haltedEngine();
      harness.respond('risk_metrics.upsert', () => ({ error: { code: '500', message: 'boom' } }));
      harness.respond('risk_events.update', () => ({ error: { code: '500', message: 'boom' } }));

      await expect(engine.deactivateKillSwitch()).resolves.toBe(true);

      expect(engine.getMetrics().killSwitchActive).toBe(false);
      expect(engine.canEnterTrades()).toBe(true);
      expect(mockLogger.error).toHaveBeenCalledWith('Failed to persist risk metrics:', expect.objectContaining({ message: 'boom' }));
      expect(mockLogger.error).toHaveBeenCalledWith('Failed to clear stale risk_events:', expect.objectContaining({ message: 'boom' }));
    });

    test('missing risk_events table is a debug, not an error', async () => {
      engine = await haltedEngine();
      harness.respond('risk_events.update', () => ({ error: { code: 'PGRST205', message: 'relation does not exist' } }));

      await engine.deactivateKillSwitch();

      expect(riskEventClears()).toHaveLength(1);
      expect(mockLogger.error).not.toHaveBeenCalled();
    });

    test('without a userId nothing is written but the resume still succeeds', async () => {
      const { userId: _omit, ...anonymous } = baseConfig;
      engine = new RiskEngine(anonymous, mockLogger as any, positionTracker);
      (engine as any).metrics.consecutiveLosses = 10;
      (engine as any).checkKillSwitches();
      expect(engine.getMetrics().killSwitchActive).toBe(true);
      harness.calls.length = 0;

      await expect(engine.deactivateKillSwitch()).resolves.toBe(true);

      expect(engine.getMetrics().killSwitchActive).toBe(false);
      expect(engine.getMetrics().consecutiveLosses).toBe(0);
      expect(harness.callsFor('risk_metrics', 'upsert')).toHaveLength(0);
      expect(riskEventClears()).toHaveLength(0);
    });

    test('is idempotent when trading is already RUNNING', async () => {
      engine = await waitForLoaders(new RiskEngine(baseConfig, mockLogger as any, positionTracker));
      harness.calls.length = 0;

      await expect(engine.deactivateKillSwitch()).resolves.toBe(true);
      expect(engine.canEnterTrades()).toBe(true);
      // Still persists so a RiskEngine flag restored from risk_metrics
      // (state machine RUNNING, engine flag true) gets written back as cleared.
      expect(firstUpsert()?.payload).toMatchObject({ kill_switch_active: false });
    });
  });
});
