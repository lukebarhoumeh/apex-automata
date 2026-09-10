/**
 * TASK_014 P5 (risk side) — execution_mode isolation of persisted risk state.
 *
 * Paper and live share one Supabase project and one USER_ID. Before this
 * change `RiskEngine.loadRiskState()` restored the newest `risk_metrics`
 * row for the user regardless of which mode wrote it, so a paper kill
 * switch / loss streak halted the next live boot (and a paper reset cleared
 * live halts). Every boot-time restore must now filter
 * `execution_mode = <session mode>` and every matching persist must stamp
 * the mode (TASK_014 acceptance #4: "risk state restore ignores paper rows
 * in live — mock Supabase returns both").
 *
 * The `execution_mode` columns ship in a staged migration applied
 * separately from the deploy, so the same paths must degrade to the legacy
 * unscoped shape when the column is missing, and pick the scoped shape
 * back up if the migration lands under a running process.
 *
 * The Supabase mock below is a tiny in-memory table store: `select`
 * responders apply the recorded `eq` filters to fixture rows (so a
 * `.eq('execution_mode', …)` filter actually removes the other mode's rows,
 * exactly like Postgres would), and can be switched into "legacy schema"
 * mode where any reference to `execution_mode` errors the way PostgREST does.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { RiskEngine, RiskEngineConfig } from '../trading/risk-engine';
import { RiskStateMachine } from '../trading/risk-state';
import { PositionTracker, PositionTrackerConfig } from '../trading/position-tracker';
import { GuardrailConfig } from '../config/loadGuardrails';

interface RecordedCall {
  table: string;
  op: 'select' | 'insert' | 'upsert' | 'update' | 'delete';
  payload?: Record<string, unknown>;
  options?: Record<string, unknown>;
  filters: Array<[string, ...unknown[]]>;
  single: boolean;
}

type MockError = { code?: string; message?: string; details?: string };
type MockResponse = { data?: unknown; error?: MockError | null };
type Responder = (call: RecordedCall) => MockResponse;
type Row = Record<string, unknown>;

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
    const call: RecordedCall = { table, op: 'select', filters: [], single: false };
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
      builder[op] = (payload?: Record<string, unknown>, options?: Record<string, unknown>) => {
        call.op = op;
        call.payload = payload;
        call.options = options;
        return builder;
      };
    }
    builder.maybeSingle = () => {
      call.single = true;
      return Promise.resolve(resolve());
    };
    builder.single = () => {
      call.single = true;
      return Promise.resolve(resolve());
    };
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
const MODE_COLUMN = 'execution_mode';

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

/**
 * TASK_011 (main): a live RiskEngine refuses to build without a Coinbase
 * account snapshot (`ACCOUNT_TRUTH_UNAVAILABLE`). These tests only exercise
 * persistence scoping, so a minimal fresh stub is enough.
 */
const LIVE_SNAPSHOT_EQUITY_USD = 1000;
const liveAccountTruthStub = {
  getSnapshot: () => ({ equityUsd: LIVE_SNAPSHOT_EQUITY_USD, fetchedAt: Date.now() }),
  isStale: () => false,
};
const liveConfig = (overrides: Partial<RiskEngineConfig> = {}): RiskEngineConfig => ({
  ...baseConfig,
  executionMode: 'live',
  liveAccountTruth: liveAccountTruthStub,
  ...overrides,
});

const todayIso = () => new Date().toISOString();
const todayDate = () => new Date().toISOString().split('T')[0];

/** A same-day risk_metrics row halted by a 10-loss paper streak. */
function paperHaltedRow(): Row {
  return {
    user_id: USER_ID,
    [MODE_COLUMN]: 'paper',
    daily_pnl: -450,
    max_drawdown: 4.5,
    consecutive_losses: 10,
    error_rate: 0,
    kill_switch_active: true,
    exposure_usd: 0,
    updated_at: todayIso(),
  };
}

/** A same-day, clean live risk_metrics row (2 losses, no halt). */
function liveCleanRow(): Row {
  return {
    user_id: USER_ID,
    [MODE_COLUMN]: 'live',
    daily_pnl: -12.5,
    max_drawdown: 0.3,
    consecutive_losses: 2,
    error_rate: 0,
    kill_switch_active: false,
    exposure_usd: 150,
    // Older than the paper row: an unscoped "newest row wins" restore
    // would pick the paper halt over this one.
    updated_at: new Date(Date.now() - 60_000).toISOString(),
  };
}

const missingModeColumnError = (table: string): MockError => ({
  code: '42703',
  message: `column ${table}.${MODE_COLUMN} does not exist`,
});
const missingModePayloadError = (table: string): MockError => ({
  code: 'PGRST204',
  message: `Could not find the '${MODE_COLUMN}' column of '${table}' in the schema cache`,
});
const noConflictTargetError = (): MockError => ({
  code: '42P10',
  message: 'there is no unique or exclusion constraint matching the ON CONFLICT specification',
});

function hasModeFilter(call: RecordedCall): unknown | undefined {
  const filter = call.filters.find(([method, column]) => method === 'eq' && column === MODE_COLUMN);
  return filter ? filter[2] : undefined;
}

/**
 * Table-store responder: applies every recorded `eq` filter to `rows`
 * (so the execution_mode filter really hides the other mode's rows), sorts
 * newest `updated_at` first, and honours `.maybeSingle()` vs list reads.
 * In `legacy` mode any reference to execution_mode fails like a database
 * without the column would.
 */
function tableSelect(rows: Row[], opts: { legacy?: boolean } = {}): Responder {
  return (call) => {
    if (opts.legacy && hasModeFilter(call) !== undefined) {
      return { error: missingModeColumnError(call.table) };
    }
    const matches = rows.filter((row) =>
      call.filters.every(([method, column, value]) => method !== 'eq' || row[column as string] === value)
    );
    matches.sort((a, b) => String(b.updated_at ?? '').localeCompare(String(a.updated_at ?? '')));
    return { data: call.single ? (matches[0] ?? null) : matches };
  };
}

/** Write responder that rejects mode-aware shapes the way a pre-migration DB does. */
function legacyWrite(): Responder {
  return (call) => {
    if (call.payload && MODE_COLUMN in call.payload) {
      return { error: missingModePayloadError(call.table) };
    }
    if (hasModeFilter(call) !== undefined) {
      return { error: missingModeColumnError(call.table) };
    }
    return {};
  };
}

/** Wait until the constructor's fire-and-forget loaders have settled. */
async function waitForLoaders(engine: RiskEngine) {
  await vi.waitFor(() => {
    expect(harness.callsFor('risk_metrics', 'select').length).toBeGreaterThan(0);
  });
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
  return engine;
}

describe('RiskEngine execution_mode isolation (TASK_014 P5)', () => {
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

  describe('risk_metrics restore', () => {
    test('live boot ignores a newer paper halt row and restores the live row (acceptance #4)', async () => {
      harness.respond('risk_metrics.select', tableSelect([paperHaltedRow(), liveCleanRow()]));

      engine = await waitForLoaders(
        new RiskEngine(liveConfig(), mockLogger as any, positionTracker)
      );

      const select = harness.callsFor('risk_metrics', 'select')[0];
      expect(hasModeFilter(select)).toBe('live');
      expect(select.filters).toEqual(expect.arrayContaining([['eq', 'user_id', USER_ID]]));

      expect(engine.getExecutionMode()).toBe('live');
      expect(engine.getMetrics().killSwitchActive).toBe(false);
      expect(engine.getMetrics().consecutiveLosses).toBe(2);
      expect(engine.getMetrics().dailyPnL).toBe(-12.5);
      expect(engine.canEnterTrades()).toBe(true);
      expect(mockLogger.warn).not.toHaveBeenCalledWith('Restored kill switch active state from previous session');
      // Nothing was reset, so nothing is written back at boot.
      expect(harness.callsFor('risk_metrics', 'upsert')).toHaveLength(0);
    });

    test('live boot with only a paper halt row starts clean instead of inheriting the halt', async () => {
      harness.respond('risk_metrics.select', tableSelect([paperHaltedRow()]));

      engine = await waitForLoaders(
        new RiskEngine(liveConfig(), mockLogger as any, positionTracker)
      );

      expect(engine.getMetrics().killSwitchActive).toBe(false);
      expect(engine.getMetrics().consecutiveLosses).toBe(0);
      expect(engine.canEnterTrades()).toBe(true);
      expect(mockLogger.info).not.toHaveBeenCalledWith('Restored risk state from database', expect.anything());
    });

    test('paper boot ignores a live halt row', async () => {
      const liveHalted = { ...liveCleanRow(), kill_switch_active: true, consecutive_losses: 9, updated_at: todayIso() };
      const paperClean = { ...paperHaltedRow(), kill_switch_active: false, consecutive_losses: 1, daily_pnl: 20 };
      harness.respond('risk_metrics.select', tableSelect([liveHalted, paperClean]));

      engine = await waitForLoaders(
        new RiskEngine({ ...baseConfig, executionMode: 'paper' }, mockLogger as any, positionTracker)
      );

      expect(hasModeFilter(harness.callsFor('risk_metrics', 'select')[0])).toBe('paper');
      expect(engine.getMetrics().killSwitchActive).toBe(false);
      expect(engine.getMetrics().consecutiveLosses).toBe(1);
      expect(engine.getMetrics().dailyPnL).toBe(20);
    });

    test('same-mode halt is still restored (isolation does not weaken the kill switch)', async () => {
      harness.respond('risk_metrics.select', tableSelect([paperHaltedRow(), liveCleanRow()]));

      engine = await waitForLoaders(
        new RiskEngine({ ...baseConfig, executionMode: 'paper' }, mockLogger as any, positionTracker)
      );

      expect(engine.getMetrics().killSwitchActive).toBe(true);
      expect(engine.getMetrics().consecutiveLosses).toBe(10);
      expect(engine.canEnterTrades()).toBe(false);
    });

    test('executionMode defaults to paper when omitted (backward compatible)', async () => {
      harness.respond('risk_metrics.select', tableSelect([paperHaltedRow(), liveCleanRow()]));

      engine = await waitForLoaders(new RiskEngine(baseConfig, mockLogger as any, positionTracker));

      expect(engine.getExecutionMode()).toBe('paper');
      expect(hasModeFilter(harness.callsFor('risk_metrics', 'select')[0])).toBe('paper');
      expect(engine.getMetrics().killSwitchActive).toBe(true);
    });
  });

  describe('risk_metrics persist', () => {
    test('upsert is stamped with the mode and keyed on (user_id, execution_mode)', async () => {
      harness.respond('risk_metrics.select', tableSelect([]));
      engine = await waitForLoaders(
        new RiskEngine(liveConfig(), mockLogger as any, positionTracker)
      );
      harness.calls.length = 0;

      await (engine as any).persistMetrics();

      const upserts = harness.callsFor('risk_metrics', 'upsert');
      expect(upserts).toHaveLength(1);
      expect(upserts[0].payload).toMatchObject({ user_id: USER_ID, [MODE_COLUMN]: 'live', kill_switch_active: false });
      expect(upserts[0].options).toMatchObject({ onConflict: 'user_id,execution_mode' });
    });

    test('manual resume in live only clears live risk_events and writes a live-stamped row', async () => {
      harness.respond('risk_metrics.select', tableSelect([liveCleanRow()]));
      engine = await waitForLoaders(
        new RiskEngine(liveConfig(), mockLogger as any, positionTracker)
      );
      (engine as any).metrics.consecutiveLosses = 10;
      (engine as any).checkKillSwitches();
      expect(engine.canEnterTrades()).toBe(false);
      harness.calls.length = 0;

      await expect(engine.deactivateKillSwitch()).resolves.toBe(true);

      const upsert = harness.callsFor('risk_metrics', 'upsert')[0];
      expect(upsert.payload).toMatchObject({ [MODE_COLUMN]: 'live', kill_switch_active: false, consecutive_losses: 0 });

      // RiskEngine's sweep (no event_type filter) is scoped to live rows only.
      const sweep = harness
        .callsFor('risk_events', 'update')
        .filter((c) => !c.filters.some(([m, col]) => m === 'eq' && col === 'event_type'));
      expect(sweep).toHaveLength(1);
      expect(sweep[0].filters).toEqual(
        expect.arrayContaining([
          ['eq', 'user_id', USER_ID],
          ['eq', 'active', true],
          ['eq', MODE_COLUMN, 'live'],
        ])
      );
      // The state machine's per-reason cleared_at stamp is scoped too.
      const perReason = harness
        .callsFor('risk_events', 'update')
        .filter((c) => c.filters.some(([m, col]) => m === 'eq' && col === 'event_type'));
      expect(perReason).toHaveLength(1);
      expect(hasModeFilter(perReason[0])).toBe('live');
    });

    test('paper startup reset never touches live risk_events', async () => {
      harness.respond('risk_metrics.select', tableSelect([paperHaltedRow(), liveCleanRow()]));

      engine = await waitForLoaders(
        new RiskEngine(
          { ...baseConfig, executionMode: 'paper', ignorePersistedKillSwitch: true },
          mockLogger as any,
          positionTracker
        )
      );

      const clears = harness
        .callsFor('risk_events', 'update')
        .filter((c) => !c.filters.some(([m, col]) => m === 'eq' && col === 'event_type'));
      expect(clears).toHaveLength(1);
      expect(hasModeFilter(clears[0])).toBe('paper');
      expect(harness.callsFor('risk_metrics', 'upsert')[0].payload).toMatchObject({ [MODE_COLUMN]: 'paper' });
    });
  });

  describe('daily_equity anchors', () => {
    test('start-of-day equity is read and written per mode', async () => {
      harness.respond('risk_metrics.select', tableSelect([]));
      harness.respond(
        'daily_equity.select',
        tableSelect([
          { user_id: USER_ID, date: todayDate(), [MODE_COLUMN]: 'paper', start_equity: 10000 },
          { user_id: USER_ID, date: todayDate(), [MODE_COLUMN]: 'live', start_equity: 1250 },
        ])
      );

      engine = await waitForLoaders(
        new RiskEngine(liveConfig(), mockLogger as any, positionTracker)
      );

      const select = harness.callsFor('daily_equity', 'select')[0];
      expect(hasModeFilter(select)).toBe('live');
      expect((engine as any).dailyStartEquity).toBe(1250);
      // A row existed, so nothing was re-saved.
      expect(harness.callsFor('daily_equity', 'upsert')).toHaveLength(0);
    });

    test('first boot of the day saves a mode-stamped anchor keyed on (user_id, execution_mode, date)', async () => {
      harness.respond('risk_metrics.select', tableSelect([]));
      harness.respond('daily_equity.select', tableSelect([
        // Paper already has today's anchor; live does not.
        { user_id: USER_ID, date: todayDate(), [MODE_COLUMN]: 'paper', start_equity: 10000 },
      ]));

      engine = await waitForLoaders(
        new RiskEngine(liveConfig(), mockLogger as any, positionTracker)
      );

      const upserts = harness.callsFor('daily_equity', 'upsert');
      expect(upserts).toHaveLength(1);
      expect(upserts[0].payload).toMatchObject({ user_id: USER_ID, date: todayDate(), [MODE_COLUMN]: 'live' });
      expect(upserts[0].options).toMatchObject({ onConflict: 'user_id,execution_mode,date' });
    });
  });

  describe('account_metrics weekly anchor', () => {
    test('both account_metrics reads are scoped to the session mode', async () => {
      harness.respond('risk_metrics.select', tableSelect([liveCleanRow()]));
      harness.respond('account_metrics.select', tableSelect([
        { user_id: USER_ID, date: todayDate(), [MODE_COLUMN]: 'live', total_equity: 990 },
        { user_id: USER_ID, date: todayDate(), [MODE_COLUMN]: 'paper', total_equity: 10500 },
      ]));

      engine = await waitForLoaders(
        new RiskEngine(liveConfig(), mockLogger as any, positionTracker)
      );

      const reads = harness.callsFor('account_metrics', 'select');
      expect(reads.length).toBeGreaterThanOrEqual(1);
      for (const read of reads) {
        expect(hasModeFilter(read)).toBe('live');
      }
    });
  });

  describe('legacy schema (migration not applied yet)', () => {
    test('falls back to the unscoped shape, restores as before, and warns once per table', async () => {
      harness.respond('risk_metrics.select', tableSelect([paperHaltedRow()], { legacy: true }));
      harness.respond('risk_metrics.upsert', legacyWrite());
      harness.respond('daily_equity.select', tableSelect([], { legacy: true }));
      harness.respond('daily_equity.upsert', legacyWrite());
      harness.respond('risk_events.update', legacyWrite());

      engine = await waitForLoaders(
        new RiskEngine(
          { ...baseConfig, executionMode: 'paper', ignorePersistedKillSwitch: true },
          mockLogger as any,
          positionTracker
        )
      );

      // Read: scoped attempt failed, unscoped retry restored the (paper) row,
      // and the reset flag then cleared it — today's #36 behaviour intact.
      const selects = harness.callsFor('risk_metrics', 'select');
      expect(selects).toHaveLength(2);
      expect(hasModeFilter(selects[0])).toBe('paper');
      expect(hasModeFilter(selects[1])).toBeUndefined();
      expect(engine.getMetrics().killSwitchActive).toBe(false);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Resetting persisted risk state for clean session start',
        expect.anything()
      );

      // Write: the eager cleared-state upsert went straight to the legacy
      // shape (table already latched by the failed read) — one call, no
      // execution_mode, onConflict user_id.
      const upserts = harness.callsFor('risk_metrics', 'upsert');
      expect(upserts).toHaveLength(1);
      expect(upserts[0].payload).not.toHaveProperty(MODE_COLUMN);
      expect(upserts[0].options).toMatchObject({ onConflict: 'user_id' });

      // risk_events clear: scoped attempt, then unscoped legacy clear.
      const clears = harness
        .callsFor('risk_events', 'update')
        .filter((c) => !c.filters.some(([m, col]) => m === 'eq' && col === 'event_type'));
      expect(clears).toHaveLength(2);
      expect(hasModeFilter(clears[0])).toBe('paper');
      expect(hasModeFilter(clears[1])).toBeUndefined();
      expect(clears[1].payload).toMatchObject({ active: false });

      // daily_equity: scoped read failed, unscoped read empty, legacy save.
      const deUpserts = harness.callsFor('daily_equity', 'upsert');
      expect(deUpserts).toHaveLength(1);
      expect(deUpserts[0].payload).not.toHaveProperty(MODE_COLUMN);
      expect(deUpserts[0].options).toMatchObject({ onConflict: 'user_id,date' });

      // One warn per table, pointing at the migration.
      const fallbackWarns = mockLogger.warn.mock.calls.filter(([msg]) =>
        String(msg).includes('falling back to unscoped legacy persistence')
      );
      expect(fallbackWarns.map(([, ctx]) => (ctx as { table: string }).table).sort()).toEqual(
        ['daily_equity', 'risk_events', 'risk_metrics']
      );
      expect(fallbackWarns[0][1]).toMatchObject({
        remediation: expect.stringContaining('risk_state_execution_mode'),
      });
      // Nothing was escalated to error level.
      expect(mockLogger.error).not.toHaveBeenCalled();

      // Subsequent ticks do not re-probe: exactly one legacy upsert each.
      harness.calls.length = 0;
      await (engine as any).persistMetrics();
      expect(harness.callsFor('risk_metrics', 'upsert')).toHaveLength(1);
      expect(harness.callsFor('risk_metrics', 'upsert')[0].payload).not.toHaveProperty(MODE_COLUMN);
    });

    test('live boot on a legacy schema warns loudly that isolation is unavailable', async () => {
      harness.respond('risk_metrics.select', tableSelect([], { legacy: true }));

      engine = await waitForLoaders(
        new RiskEngine(liveConfig(), mockLogger as any, positionTracker)
      );

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Live risk state restored WITHOUT execution_mode isolation'),
        expect.objectContaining({ remediation: expect.stringContaining('risk_state_execution_mode') })
      );
    });

    test('a 42P10 on the legacy key (migration applied mid-process) switches back to the scoped shape', async () => {
      harness.respond('risk_metrics.select', tableSelect([], { legacy: true }));
      engine = await waitForLoaders(
        new RiskEngine(liveConfig(), mockLogger as any, positionTracker)
      );
      // Table is now latched legacy by the failed scoped read.
      let schemaMigrated = false;
      harness.respond('risk_metrics.upsert', (call) => {
        if (!schemaMigrated) return legacyWrite()(call);
        // Post-migration: legacy key gone, mode-aware key present.
        if (call.payload && MODE_COLUMN in call.payload) return {};
        return { error: noConflictTargetError() };
      });
      harness.calls.length = 0;

      await (engine as any).persistMetrics();
      expect(harness.callsFor('risk_metrics', 'upsert')).toHaveLength(1);
      expect(harness.callsFor('risk_metrics', 'upsert')[0].payload).not.toHaveProperty(MODE_COLUMN);

      // Migration lands between ticks.
      schemaMigrated = true;
      harness.calls.length = 0;
      await (engine as any).persistMetrics();
      const upserts = harness.callsFor('risk_metrics', 'upsert');
      expect(upserts).toHaveLength(2);
      expect(upserts[0].payload).not.toHaveProperty(MODE_COLUMN); // legacy attempt -> 42P10
      expect(upserts[1].payload).toMatchObject({ [MODE_COLUMN]: 'live' }); // scoped retry -> ok
      expect(mockLogger.error).not.toHaveBeenCalled();

      // From here on it goes mode-aware directly.
      harness.calls.length = 0;
      await (engine as any).persistMetrics();
      expect(harness.callsFor('risk_metrics', 'upsert')).toHaveLength(1);
      expect(harness.callsFor('risk_metrics', 'upsert')[0].payload).toMatchObject({ [MODE_COLUMN]: 'live' });
    });

    test('a genuine DB failure is still reported, not mistaken for a schema gap', async () => {
      harness.respond('risk_metrics.select', tableSelect([]));
      engine = await waitForLoaders(
        new RiskEngine(liveConfig(), mockLogger as any, positionTracker)
      );
      harness.respond('risk_metrics.upsert', () => ({ error: { code: '500', message: 'boom' } }));
      harness.calls.length = 0;

      await (engine as any).persistMetrics();

      expect(harness.callsFor('risk_metrics', 'upsert')).toHaveLength(1); // no legacy retry
      expect(mockLogger.error).toHaveBeenCalledWith(
        'Failed to persist risk metrics:',
        expect.objectContaining({ message: 'boom' })
      );
    });
  });
});

describe('RiskStateMachine execution_mode scoping (risk_events)', () => {
  beforeEach(() => {
    harness.reset();
    vi.clearAllMocks();
  });

  function machine(executionMode: 'paper' | 'live') {
    return new RiskStateMachine({
      logger: mockLogger as any,
      supabaseUrl: 'http://localhost:54321',
      supabaseKey: 'test-key',
      userId: USER_ID,
      executionMode,
    });
  }

  test('halt events are stamped with the session mode', async () => {
    const sm = machine('live');
    sm.halt('consecutive_losses', 'streak', false, { consecutiveLosses: 8 });
    await vi.waitFor(() => expect(harness.callsFor('risk_events', 'insert')).toHaveLength(1));

    const insert = harness.callsFor('risk_events', 'insert')[0];
    expect(insert.payload).toMatchObject({
      user_id: USER_ID,
      event_type: 'consecutive_losses',
      [MODE_COLUMN]: 'live',
    });
  });

  test('halt events fall back to the unstamped shape on a legacy schema', async () => {
    harness.respond('risk_events.insert', legacyWrite());
    const sm = machine('live');
    sm.halt('daily_stop', 'daily', true);
    await vi.waitFor(() => expect(harness.callsFor('risk_events', 'insert')).toHaveLength(2));

    const inserts = harness.callsFor('risk_events', 'insert');
    expect(inserts[0].payload).toHaveProperty(MODE_COLUMN, 'live');
    expect(inserts[1].payload).not.toHaveProperty(MODE_COLUMN);
    expect(inserts[1].payload).toMatchObject({ event_type: 'daily_stop' });
  });

  test('loadPersistedState restores only a same-mode uncleared halt', async () => {
    const paperHalt = {
      user_id: USER_ID,
      [MODE_COLUMN]: 'paper',
      event_type: 'consecutive_losses',
      details: { reasonText: 'paper streak', daily: false },
      triggered_at: todayIso(),
      cleared_at: null,
      updated_at: todayIso(),
    };
    harness.respond('risk_events.select', tableSelect([paperHalt]));

    const live = machine('live');
    await live.loadPersistedState();
    expect(hasModeFilter(harness.callsFor('risk_events', 'select')[0])).toBe('live');
    expect(live.getState().state).toBe('RUNNING');

    harness.calls.length = 0;
    const paper = machine('paper');
    await paper.loadPersistedState();
    expect(hasModeFilter(harness.callsFor('risk_events', 'select')[0])).toBe('paper');
    expect(paper.getState().state).toBe('HALTED');
    expect(paper.getHaltReasonCode()).toBe('consecutive_losses');
  });

  test('resume stamps cleared_at only on same-mode rows', async () => {
    const sm = machine('paper');
    sm.halt('consecutive_losses', 'streak', false);
    harness.calls.length = 0;

    expect(sm.resume(true)).toBe(true);
    await vi.waitFor(() => expect(harness.callsFor('risk_events', 'update')).toHaveLength(1));

    const update = harness.callsFor('risk_events', 'update')[0];
    expect(update.payload).toHaveProperty('cleared_at');
    expect(update.filters).toEqual(
      expect.arrayContaining([
        ['eq', 'user_id', USER_ID],
        ['eq', 'event_type', 'consecutive_losses'],
        ['is', 'cleared_at', null],
        ['eq', MODE_COLUMN, 'paper'],
      ])
    );
  });
});
