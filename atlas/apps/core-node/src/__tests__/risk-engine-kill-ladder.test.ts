/**
 * RiskEngine x graduated paper kill ladder L1–L6 (Risk desk SoT 2026-09-22).
 *
 * Integration pins (mocked Supabase, real RiskEngine + PositionTracker events):
 *
 *   - Paper execution mode + `paper_kill_ladder.enabled` builds the ladder; live
 *     never does, even with the block enabled (CONFIRM_LIVE path untouched).
 *   - L1/L2: closed-trade streaks and dailyR (realized + unrealized) arm the size
 *     caps; `applyPaperKillLadderSizing` caps the router multiplier with min();
 *     one `risk_events` row per rung (event_type = size_down_consec /
 *     size_down_daily_r), the previous size row retired on escalation; the kill
 *     switch is NOT latched and entries stay allowed.
 *   - L3: 4 consecutive losses in ONE strategy -> strategy_freeze row + entry gate
 *     blocks that strategy only.
 *   - L4: 2 losing stop-outs of trend_follow in weak_trend -> regime_pause row +
 *     entry gate blocks (trend_follow, weak_trend) only; expiry on the tick
 *     retires exactly that row.
 *   - L6: dailyR <= -4 -> daily_stop; consec >= 12 AND dailyR <= -2 ->
 *     consecutive_losses; both latch kill_switch_active with ladderLevel 6 and
 *     never `unknown` (#67). The legacy paper daily stop (R + USD) and the
 *     CONSECUTIVE_LOSS_LIMIT (8) kill are superseded while L6 is enabled; every
 *     other existing halt is unchanged.
 *   - Resets: operator resume (CLEAR) releases every rung; risk-day reset lifts
 *     the size cap but keeps the session freeze.
 *   - Restore: `loadPersistedState` never restores a soft ladder row as a halt.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { RiskEngine, RiskEngineConfig } from '../trading/risk-engine';
import { Position, PositionTracker, PositionTrackerConfig } from '../trading/position-tracker';
import { GuardrailConfig, GuardrailsSchema, PaperKillLadderConfig } from '../config/loadGuardrails';
import type { LadderTransition } from '../trading/risk/paper-kill-ladder';

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
const HOUR = 60 * 60 * 1000;

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

/** Desk SoT ladder block (as shipped in guardrails.yaml). */
const deskLadder = GuardrailsSchema.shape.paper_kill_ladder.parse({
  enabled: true,
  l1_size_down: { enabled: true, consecutive_losses: 3, daily_r: -1.0, position_multiplier: 0.5 },
  l2_size_down: { enabled: true, consecutive_losses: 5, daily_r: -2.0, position_multiplier: 0.25 },
  l3_strategy_freeze: { enabled: true, consecutive_losses: 4 },
  l4_regime_pause: { enabled: true, strategies: ['trend_follow'], regimes: ['weak_trend', 'choppy'], stop_outs: 2, pause_hours: 4 },
  l5_sleeve_halt: { enabled: false },
  l6_hard_kill: { enabled: true, daily_r: -4.0, consecutive_losses: 12, consecutive_losses_daily_r: -2.0 },
}) as PaperKillLadderConfig;

/**
 * Fixture: $10k equity, 1% risk per trade => 1R = $100. Legacy daily stop is
 * 2% = $200 = -2R, legacy streak kill = 8 (CONSECUTIVE_LOSS_LIMIT default).
 */
const baseGuardrails = {
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

const ladderGuardrails: GuardrailConfig = { ...baseGuardrails, paper_kill_ladder: deskLadder };

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
  guardrails: ladderGuardrails,
  accountEquity: 10000,
};

const todayIso = () => new Date().toISOString();

/** Wait until the constructor's fire-and-forget loaders have settled. */
async function waitForLoaders(engine: RiskEngine) {
  await vi.waitFor(() => {
    expect(harness.callsFor('risk_metrics', 'select').length).toBeGreaterThan(0);
  });
  await new Promise((r) => setTimeout(r, 0));
  return engine;
}

/** Settle the fire-and-forget risk_events writes queued by a transition. */
const flush = async (rounds = 3) => {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0));
};

function closedPosition(overrides: Partial<Position> = {}): Position {
  const now = new Date();
  return {
    id: `pos-${Math.random().toString(36).slice(2)}`,
    symbol: 'ETH-USD',
    strategy: 'trend_follow',
    side: 'long',
    size: 0,
    averagePrice: 2000,
    marketPrice: 1990,
    unrealizedPnL: 0,
    realizedPnL: -10,
    totalPnL: -10,
    openTime: now,
    closedAt: now,
    exitPrice: 1990,
    lastUpdateTime: now,
    trades: [],
    maxSize: 1,
    maxDrawdown: 0,
    exitReason: 'signal_exit',
    metadata: {},
    ...overrides,
  };
}

describe('RiskEngine x paper kill ladder (L1–L6)', () => {
  let positionTracker: PositionTracker;
  let engine: RiskEngine | null;
  /** Portfolio summary the engine sees; tests move realized/unrealized P&L here. */
  let portfolio: { totalUnrealizedPnL: number; totalRealizedPnL: number; totalPnL: number; positionCount: number; totalValue: number };

  beforeEach(() => {
    harness.reset();
    vi.clearAllMocks();
    vi.useRealTimers();
    positionTracker = new PositionTracker(positionTrackerConfig, mockLogger as any);
    portfolio = { totalUnrealizedPnL: 0, totalRealizedPnL: 0, totalPnL: 0, positionCount: 0, totalValue: 0 };
    engine = null;
  });

  afterEach(() => {
    vi.useRealTimers();
    engine?.stop();
    positionTracker.stopUpdateLoop();
  });

  async function freshEngine(overrides: Partial<RiskEngineConfig> = {}): Promise<RiskEngine> {
    const e = await waitForLoaders(new RiskEngine({ ...baseConfig, ...overrides }, mockLogger as any, positionTracker));
    vi.spyOn(positionTracker, 'getPortfolioSummary').mockImplementation(() => ({ ...portfolio }));
    harness.calls.length = 0;
    vi.clearAllMocks();
    return e;
  }

  /** Close a trade: book its P&L into the portfolio the engine reads, then emit `position:closed`. */
  function closeTrade(realizedPnL: number, overrides: Partial<Position> = {}) {
    portfolio.totalRealizedPnL += realizedPnL;
    portfolio.totalPnL = portfolio.totalRealizedPnL + portfolio.totalUnrealizedPnL;
    positionTracker.emit('position:closed', closedPosition({ realizedPnL, totalPnL: realizedPnL, ...overrides }));
  }

  const ladderInserts = () =>
    harness.callsFor('risk_events', 'insert').map((c) => c.payload as { event_type: string; details: Record<string, unknown>; execution_mode?: string });

  const haltedCodes = (e: RiskEngine) => {
    const codes: string[] = [];
    e.on('risk:state_changed', (ev: any) => {
      if (ev.newState.state === 'HALTED') codes.push(ev.newState.reasonCode);
    });
    return codes;
  };

  describe('construction / mode gating', () => {
    test('paper + enabled block builds the ladder and reports it in getRiskStatus()', async () => {
      engine = await freshEngine();
      expect(engine.getPaperKillLadder()).not.toBeNull();
      const status = engine.getRiskStatus();
      expect(status.paperKillLadder).toMatchObject({ enabled: true, sizeLevel: 0, positionMultiplierCap: 1, highestActiveLevel: 0 });
      // L6 owns the paper daily stop: -4R, not the legacy 2% / 1% = -2R.
      expect(status.thresholds.dailyStopR).toBe(-4);
      expect(engine.applyPaperKillLadderSizing(1)).toEqual({ multiplier: 1, cap: 1, sizeLevel: 0, capped: false });
      expect(engine.checkPaperKillLadderEntry({ strategy: 'trend_follow', regime: 'weak_trend' })).toMatchObject({ allowed: true });
    });

    test('paper with the block disabled (or absent) keeps today\'s behaviour exactly', async () => {
      for (const guardrails of [
        { ...baseGuardrails, paper_kill_ladder: { ...deskLadder, enabled: false } } as GuardrailConfig,
        baseGuardrails as GuardrailConfig,
      ]) {
        engine?.stop();
        engine = await freshEngine({ guardrails });
        expect(engine.getPaperKillLadder()).toBeNull();
        expect(engine.getPaperKillLadderStatus()).toEqual({ enabled: false });
        expect(engine.getRiskStatus().thresholds.dailyStopR).toBe(-2);
        expect(engine.applyPaperKillLadderSizing(0.7)).toEqual({ multiplier: 0.7, cap: 1, sizeLevel: 0, capped: false });
        expect(engine.checkPaperKillLadderEntry({ strategy: 'trend_follow' })).toBeNull();

        // Legacy streak kill (8) still fires without the ladder.
        for (let i = 0; i < 8; i++) closeTrade(-1);
        (engine as any).checkKillSwitches();
        expect(engine.getRiskStatus()).toMatchObject({ tradingState: 'HALTED', reasonCode: 'consecutive_losses' });
        expect(harness.callsFor('risk_events', 'insert').every((c) => (c.payload as any).event_type === 'consecutive_losses')).toBe(true);
        harness.calls.length = 0;
      }
    });

    test('live mode never builds the ladder even with the block enabled (CONFIRM_LIVE path untouched)', async () => {
      const liveTruth = { getSnapshot: () => ({ equityUsd: 10000, fetchedAt: Date.now() }), isStale: () => false };
      engine = await freshEngine({ executionMode: 'live', liveAccountTruth: liveTruth });
      expect(engine.getExecutionMode()).toBe('live');
      expect(engine.getPaperKillLadder()).toBeNull();
      expect(engine.getPaperKillLadderStatus()).toEqual({ enabled: false });
      expect(engine.getRiskStatus().thresholds.dailyStopR).toBe(-2);
      expect(engine.checkPaperKillLadderEntry({ strategy: 'trend_follow' })).toBeNull();

      // Live keeps its legacy consecutive-loss kill at 8.
      for (let i = 0; i < 8; i++) closeTrade(-1);
      (engine as any).checkKillSwitches();
      await flush();
      expect(engine.getRiskStatus()).toMatchObject({ tradingState: 'HALTED', reasonCode: 'consecutive_losses' });
      expect(ladderInserts()).toHaveLength(1);
      expect(ladderInserts()[0]).toMatchObject({ event_type: 'consecutive_losses', execution_mode: 'live' });
    });
  });

  describe('L1 / L2 size-down (portfolio streak OR dailyR) — no kill switch', () => {
    test('3 consecutive losing closes -> L1 size_down_consec: cap 0.5, risk_events row, entries still allowed', async () => {
      engine = await freshEngine();
      const transitions: LadderTransition[] = [];
      engine.on('risk:ladder:transition', (t: LadderTransition) => transitions.push(t));

      closeTrade(-10);
      closeTrade(-10);
      expect(engine.getMetrics().consecutiveLosses).toBe(2);
      expect(transitions).toEqual([]);
      expect(engine.applyPaperKillLadderSizing(1).multiplier).toBe(1);

      closeTrade(-10);
      await flush();

      expect(engine.getMetrics().consecutiveLosses).toBe(3);
      expect(transitions.map((t) => `${t.level}:${t.reasonCode}`)).toEqual(['1:size_down_consec']);

      // Soft rung: NOT a kill switch.
      expect(engine.getMetrics().killSwitchActive).toBe(false);
      expect(engine.canEnterTrades()).toBe(true);
      expect(engine.getRiskStatus().tradingState).toBe('RUNNING');
      expect(engine.getRiskStatus().paperKillLadder).toMatchObject({ sizeLevel: 1, positionMultiplierCap: 0.5, sizeReasonCode: 'size_down_consec' });

      // Router cap is min(), not a product.
      expect(engine.applyPaperKillLadderSizing(1)).toEqual({ multiplier: 0.5, cap: 0.5, sizeLevel: 1, capped: true });
      expect(engine.applyPaperKillLadderSizing(0.8)).toEqual({ multiplier: 0.5, cap: 0.5, sizeLevel: 1, capped: true });
      expect(engine.applyPaperKillLadderSizing(0.3)).toEqual({ multiplier: 0.3, cap: 0.5, sizeLevel: 1, capped: false });

      // Audit row, mode-stamped, with a soft code (never a halt code).
      expect(ladderInserts()).toHaveLength(1);
      expect(ladderInserts()[0]).toMatchObject({
        user_id: USER_ID,
        event_type: 'size_down_consec',
        execution_mode: 'paper',
        details: { eventType: 'ladder', ladderLevel: 1, reasonCode: 'size_down_consec', positionMultiplier: 0.5, consecutiveLosses: 3 },
      });
      expect(harness.callsFor('risk_metrics', 'upsert')).toHaveLength(0);
      expect(mockLogger.error).not.toHaveBeenCalledWith(expect.stringContaining('KILL SWITCH'));
    });

    test('dailyR <= -1 (realized + unrealized) arms L1 as size_down_daily_r on the tick, without a losing streak', async () => {
      engine = await freshEngine();
      // One losing close (streak 1) + open unrealized drawdown => -120 / 100 = -1.2R.
      closeTrade(-20);
      portfolio.totalUnrealizedPnL = -100;
      portfolio.totalPnL = -120;
      await flush();
      expect(ladderInserts()).toEqual([]);

      await (engine as any).updateMetrics();
      await flush();

      expect(engine.getRiskStatus().paperKillLadder).toMatchObject({ sizeLevel: 1, sizeReasonCode: 'size_down_daily_r', positionMultiplierCap: 0.5 });
      expect(ladderInserts().map((r) => r.event_type)).toEqual(['size_down_daily_r']);
      expect(ladderInserts()[0].details).toMatchObject({ ladderLevel: 1, dailyPnlR: -1.2, dailyRThreshold: -1 });
      expect(engine.getMetrics().killSwitchActive).toBe(false);
      expect(engine.canEnterTrades()).toBe(true);
    });

    test('5 consecutive losses escalate to L2 (cap 0.25) and retire the L1 row before inserting the L2 row', async () => {
      engine = await freshEngine();
      // Alternate strategies: the PORTFOLIO streak reaches 5 while no single
      // strategy streak reaches the L3 freeze (4).
      const strategyFor = (i: number) => (i % 2 === 0 ? 'trend_follow' : 'momentum');
      for (let i = 0; i < 4; i++) closeTrade(-10, { strategy: strategyFor(i) });
      await flush();
      expect(ladderInserts().map((r) => `${r.details.ladderLevel}:${r.event_type}`)).toEqual(['1:size_down_consec']);
      harness.calls.length = 0;

      closeTrade(-10, { strategy: strategyFor(4) });
      await flush();

      expect(engine.applyPaperKillLadderSizing(1)).toEqual({ multiplier: 0.25, cap: 0.25, sizeLevel: 2, capped: true });
      expect(engine.applyPaperKillLadderSizing(0.5).multiplier).toBe(0.25);
      expect(engine.getMetrics().killSwitchActive).toBe(false);
      expect(engine.canEnterTrades()).toBe(true);

      const retire = harness.callsFor('risk_events', 'update')[0];
      expect(retire).toBeDefined();
      expect(retire.payload).toMatchObject({ active: false });
      expect(retire.filters).toEqual(
        expect.arrayContaining([
          ['eq', 'user_id', USER_ID],
          ['eq', 'active', true],
          ['eq', 'execution_mode', 'paper'],
          ['in', 'event_type', ['size_down_consec', 'size_down_daily_r']],
        ])
      );
      expect(ladderInserts().map((r) => `${r.details.ladderLevel}:${r.event_type}`)).toEqual(['2:size_down_consec']);
      // Ordering: the L1 row is retired before the L2 row lands.
      const events = harness.callsFor('risk_events');
      expect(events.findIndex((c) => c.op === 'update')).toBeLessThan(events.findIndex((c) => c.op === 'insert'));
    });

    test('the cap ratchets: a win resets the streak but the L1 cap stays for the risk day', async () => {
      engine = await freshEngine();
      for (let i = 0; i < 3; i++) closeTrade(-10);
      closeTrade(+50);
      await flush();
      expect(engine.getMetrics().consecutiveLosses).toBe(0);
      expect(engine.applyPaperKillLadderSizing(1).multiplier).toBe(0.5);
      expect(ladderInserts()).toHaveLength(1);
    });
  });

  describe('L3 strategy freeze (per-strategy streak)', () => {
    test('4 consecutive trend_follow losses freeze trend_follow for the session; momentum is untouched', async () => {
      engine = await freshEngine();
      // Interleave a momentum loss so the PORTFOLIO streak differs from the per-strategy one.
      closeTrade(-10, { strategy: 'trend_follow' });
      closeTrade(-10, { strategy: 'trend_follow' });
      closeTrade(+5, { strategy: 'momentum' });
      closeTrade(-10, { strategy: 'trend_follow' });
      closeTrade(-10, { strategy: 'trend_follow' });
      await flush();

      expect(engine.getMetrics().consecutiveLosses).toBe(2); // portfolio streak (L1 not armed: 2 < 3 and -35/100 > -1R)
      expect(engine.applyPaperKillLadderSizing(1).multiplier).toBe(1);

      const freeze = ladderInserts().find((r) => r.event_type === 'strategy_freeze');
      expect(freeze).toMatchObject({
        execution_mode: 'paper',
        details: { eventType: 'ladder', ladderLevel: 3, strategy: 'trend_follow', consecutiveLosses: 4, threshold: 4 },
      });

      expect(engine.checkPaperKillLadderEntry({ strategy: 'trend_follow' })).toMatchObject({
        allowed: false,
        level: 3,
        reasonCode: 'strategy_freeze',
        strategy: 'trend_follow',
      });
      expect(engine.checkPaperKillLadderEntry({ strategy: 'momentum' })).toMatchObject({ allowed: true });
      expect(engine.getRiskStatus().paperKillLadder).toMatchObject({
        highestActiveLevel: 3,
        frozenStrategies: [{ strategy: 'trend_follow', consecutiveLosses: 4 }],
      });

      // Still not a kill switch.
      expect(engine.getMetrics().killSwitchActive).toBe(false);
      expect(engine.canEnterTrades()).toBe(true);
    });
  });

  describe('L4 regime pause (trend_follow x weak_trend / choppy stop-outs)', () => {
    test('two losing stop_loss exits opened in weak_trend pause (trend_follow, weak_trend) for 4h and expire on the tick', async () => {
      engine = await freshEngine();
      // Freeze the clock the ladder reads (RiskEngine passes Date.now() as `now`)
      // after the loaders settled, so the pause expiry is deterministic.
      const t0 = Date.UTC(2026, 8, 22, 12, 0, 0);
      const clock = vi.spyOn(Date, 'now').mockReturnValue(t0);

      const stopOut = { strategy: 'trend_follow', exitReason: 'stop_loss', metadata: { regime: 'weak_trend' } };
      closeTrade(-10, stopOut);
      closeTrade(-10, { ...stopOut, symbol: 'BTC-USD' });
      await flush();

      const pause = ladderInserts().find((r) => r.event_type === 'regime_pause');
      expect(pause).toMatchObject({
        execution_mode: 'paper',
        details: {
          ladderLevel: 4,
          strategy: 'trend_follow',
          regime: 'weak_trend',
          stopOuts: 2,
          threshold: 2,
          pauseHours: 4,
          until: new Date(t0 + 4 * HOUR).toISOString(),
        },
      });

      expect(engine.checkPaperKillLadderEntry({ strategy: 'trend_follow', regime: 'weak_trend' })).toMatchObject({
        allowed: false,
        level: 4,
        reasonCode: 'regime_pause',
        regime: 'weak_trend',
        until: t0 + 4 * HOUR,
      });
      expect(engine.checkPaperKillLadderEntry({ strategy: 'trend_follow', regime: 'strong_trend' })).toMatchObject({ allowed: true });
      expect(engine.checkPaperKillLadderEntry({ strategy: 'trend_follow', regime: 'choppy' })).toMatchObject({ allowed: true });
      expect(engine.checkPaperKillLadderEntry({ strategy: 'momentum', regime: 'weak_trend' })).toMatchObject({ allowed: true });
      expect(engine.getMetrics().killSwitchActive).toBe(false);

      // Expiry: the next tick releases the pause and retires exactly that row.
      harness.calls.length = 0;
      clock.mockReturnValue(t0 + 4 * HOUR + 1);
      (engine as any).checkKillSwitches();
      await flush();

      expect(engine.checkPaperKillLadderEntry({ strategy: 'trend_follow', regime: 'weak_trend' })).toMatchObject({ allowed: true });
      expect(engine.getRiskStatus().paperKillLadder).toMatchObject({ regimePauses: [] });
      const clear = harness.callsFor('risk_events', 'update')[0];
      expect(clear).toBeDefined();
      expect(clear.payload).toMatchObject({ active: false });
      expect(clear.filters).toEqual(
        expect.arrayContaining([
          ['eq', 'user_id', USER_ID],
          ['eq', 'active', true],
          ['eq', 'execution_mode', 'paper'],
          ['in', 'event_type', ['regime_pause']],
          ['eq', 'details->>strategy', 'trend_follow'],
          ['eq', 'details->>regime', 'weak_trend'],
        ])
      );
    });

    test('stop-outs opened in strong_trend, non-stop exits, or momentum do not pause anything', async () => {
      engine = await freshEngine();
      closeTrade(-10, { strategy: 'trend_follow', exitReason: 'stop_loss', metadata: { regime: 'strong_trend' } });
      closeTrade(-10, { strategy: 'trend_follow', exitReason: 'stop_loss', metadata: { regime: 'strong_trend' } });
      closeTrade(+1, { strategy: 'momentum' }); // break the portfolio streak so L1 stays quiet
      closeTrade(-10, { strategy: 'trend_follow', exitReason: 'signal_exit', metadata: { regime: 'weak_trend' } });
      closeTrade(-10, { strategy: 'momentum', exitReason: 'stop_loss', metadata: { regime: 'weak_trend' } });
      await flush();
      expect(ladderInserts().filter((r) => r.event_type === 'regime_pause')).toEqual([]);
      expect(engine.getRiskStatus().paperKillLadder).toMatchObject({ regimePauses: [] });
    });
  });

  describe('L6 hard kill (kill_switch_active, structured codes, never unknown)', () => {
    test('dailyR <= -4 on a losing close latches daily_stop with ladderLevel 6', async () => {
      engine = await freshEngine();
      const codes = haltedCodes(engine);

      closeTrade(-150); // -1.5R -> L1 by dailyR
      closeTrade(-150); // -3.0R -> L2 by dailyR
      expect(engine.getMetrics().killSwitchActive).toBe(false);
      closeTrade(-100); // -4.0R -> L6
      await flush();

      expect(engine.getMetrics().killSwitchActive).toBe(true);
      expect(engine.canEnterTrades()).toBe(false);
      expect(engine.canExitTrades()).toBe(true);
      const status = engine.getRiskStatus();
      expect(status).toMatchObject({ tradingState: 'HALTED', reasonCode: 'daily_stop', daily: true });
      expect(status.reasonText).toContain('L6 hard kill');
      expect(codes).toEqual(['daily_stop']);
      expect(mockLogger.error).toHaveBeenCalledWith(expect.stringContaining('KILL SWITCH TRIGGERED: L6 hard kill'));

      const halt = harness.callsFor('risk_events', 'insert').map((c) => c.payload as any).find((p) => p.event_type === 'daily_stop');
      expect(halt).toMatchObject({
        execution_mode: 'paper',
        details: { eventType: 'halt', reasonCode: 'daily_stop', daily: true, ladderLevel: 6, dailyPnlR: -4, thresholdR: -4 },
      });
      // Size rungs escalated on the way down (L1 then L2, both by dailyR) and
      // the halt row landed; none of the rows is `unknown`. Row order is not
      // asserted: a size row awaits its retire-update before inserting.
      const rows = ladderInserts().map((r) => `${r.details.ladderLevel}:${r.event_type}`).sort();
      expect(rows).toEqual(['1:size_down_daily_r', '2:size_down_daily_r', '6:daily_stop']);
      expect(ladderInserts().map((r) => r.event_type)).not.toContain('unknown');
    });

    test('consec >= 12 alone never kills; consec >= 12 AND dailyR <= -2 latches consecutive_losses', async () => {
      engine = await freshEngine();
      const codes = haltedCodes(engine);

      // 12 small losses: streak 12 but only -1.2R -> L1 (consec), L2 (consec) — no kill.
      for (let i = 0; i < 12; i++) closeTrade(-10);
      (engine as any).checkKillSwitches();
      await flush();
      expect(engine.getMetrics().consecutiveLosses).toBe(12);
      expect(engine.getMetrics().killSwitchActive).toBe(false);
      expect(engine.getRiskStatus().tradingState).toBe('RUNNING');
      expect(engine.applyPaperKillLadderSizing(1).multiplier).toBe(0.25);

      // 13th loss takes the day to -2.1R with the streak intact -> L6 consecutive_losses.
      closeTrade(-90);
      await flush();

      expect(engine.getMetrics().killSwitchActive).toBe(true);
      const status = engine.getRiskStatus();
      expect(status).toMatchObject({ tradingState: 'HALTED', reasonCode: 'consecutive_losses', daily: false });
      expect(codes).toEqual(['consecutive_losses']);
      const halt = harness.callsFor('risk_events', 'insert').map((c) => c.payload as any).find((p) => p.event_type === 'consecutive_losses');
      expect(halt.details).toMatchObject({ ladderLevel: 6, consecutiveLosses: 13, consecutiveLossesThreshold: 12, thresholdR: -2 });
      expect(halt.details.dailyPnlR).toBeCloseTo(-2.1, 5);
    });

    test('unrealized drawdown to -4R kills on the metrics tick (no close needed), as daily_stop', async () => {
      engine = await freshEngine();
      portfolio.totalUnrealizedPnL = -400;
      portfolio.totalPnL = -400;

      await (engine as any).updateMetrics();
      await flush();

      expect(engine.getMetrics().killSwitchActive).toBe(true);
      expect(engine.getRiskStatus()).toMatchObject({ tradingState: 'HALTED', reasonCode: 'daily_stop' });
      expect(engine.getRiskStatus().reasonText).toContain('L6 hard kill');
    });

    test('the legacy paper daily stop and CONSECUTIVE_LOSS_LIMIT (8) are superseded while L6 is enabled', async () => {
      engine = await freshEngine();

      // 8 tiny losses: legacy would halt on consecutive_losses; the ladder only sizes down.
      for (let i = 0; i < 8; i++) closeTrade(-1);
      (engine as any).checkKillSwitches();
      expect(engine.getMetrics().consecutiveLosses).toBe(8);
      expect(engine.getRiskStatus().tradingState).toBe('RUNNING');
      expect(engine.applyPaperKillLadderSizing(1).multiplier).toBe(0.25);

      // Legacy 2% USD daily guardrail (-$200 = -2R) no longer halts; -2R is L2, the kill is -4R.
      (engine as any).enforceLossGuardrails(9750);
      expect(engine.getRiskStatus().tradingState).toBe('RUNNING');
      // Legacy USD fallback in checkKillSwitches is skipped too.
      (engine as any).metrics.dailyPnL = -250;
      (engine as any).checkKillSwitches();
      expect(engine.getRiskStatus().tradingState).toBe('RUNNING');

      // Every other existing halt is unchanged: weekly stop still fires from the same path.
      (engine as any).dailyStartEquity = 10000;
      (engine as any).weeklyStartEquity = 10600;
      (engine as any).enforceLossGuardrails(9900);
      expect(engine.getRiskStatus()).toMatchObject({ tradingState: 'HALTED', reasonCode: 'weekly_stop' });
    });

    test('with L6 switched off the legacy daily stop and streak kill stay in force', async () => {
      engine = await freshEngine({
        guardrails: { ...baseGuardrails, paper_kill_ladder: { ...deskLadder, l6_hard_kill: { ...deskLadder.l6_hard_kill, enabled: false } } },
      });
      expect(engine.getPaperKillLadder()).not.toBeNull();
      expect(engine.getRiskStatus().thresholds.dailyStopR).toBe(-2);

      (engine as any).enforceLossGuardrails(9800);
      expect(engine.getRiskStatus()).toMatchObject({ tradingState: 'HALTED', reasonCode: 'daily_stop' });
      await engine.deactivateKillSwitch();

      for (let i = 0; i < 8; i++) closeTrade(-1);
      (engine as any).checkKillSwitches();
      expect(engine.getRiskStatus()).toMatchObject({ tradingState: 'HALTED', reasonCode: 'consecutive_losses' });
    });

    test('existing error_rate / latency / manual / data_gap halts still run alongside the ladder', async () => {
      engine = await freshEngine();
      const codes = haltedCodes(engine);

      (engine as any).metrics.errorRate = 20;
      (engine as any).checkKillSwitches();
      expect(engine.getRiskStatus().reasonCode).toBe('error_rate');
      await engine.deactivateKillSwitch();

      (engine as any).metrics.averageLatency = 2000;
      (engine as any).checkKillSwitches();
      expect(engine.getRiskStatus().reasonCode).toBe('latency');
      await engine.deactivateKillSwitch();

      engine.activateKillSwitch('op', 'manual_killswitch');
      await engine.deactivateKillSwitch();
      engine.activateKillSwitch('gap', 'data_gap');
      await flush();

      expect(codes).toEqual(['error_rate', 'latency', 'manual_killswitch', 'data_gap']);
      expect(codes).not.toContain('unknown');
      for (const insert of harness.callsFor('risk_events', 'insert')) {
        expect((insert.payload as { event_type: string }).event_type).not.toBe('unknown');
      }
    });
  });

  describe('resets', () => {
    test('operator resume (CLEAR) releases every rung and the sweep retires the ladder rows', async () => {
      engine = await freshEngine();
      for (let i = 0; i < 5; i++) closeTrade(-10, { strategy: 'trend_follow' });
      await flush();
      expect(engine.getRiskStatus().paperKillLadder).toMatchObject({ sizeLevel: 2, frozenStrategies: [{ strategy: 'trend_follow' }] });
      harness.calls.length = 0;

      await expect(engine.deactivateKillSwitch()).resolves.toBe(true);

      expect(engine.getMetrics().consecutiveLosses).toBe(0);
      expect(engine.getRiskStatus().paperKillLadder).toMatchObject({
        sizeLevel: 0,
        positionMultiplierCap: 1,
        highestActiveLevel: 0,
        frozenStrategies: [],
        regimePauses: [],
        perStrategyConsecutiveLosses: {},
      });
      expect(engine.applyPaperKillLadderSizing(1).multiplier).toBe(1);
      expect(engine.checkPaperKillLadderEntry({ strategy: 'trend_follow' })).toMatchObject({ allowed: true });

      const sweep = harness
        .callsFor('risk_events', 'update')
        .find((c) => !c.filters.some(([m, col]) => m === 'in' && col === 'event_type'));
      expect(sweep).toBeDefined();
      expect(sweep!.filters).toEqual(expect.arrayContaining([['eq', 'user_id', USER_ID], ['eq', 'active', true], ['eq', 'execution_mode', 'paper']]));

      // Rungs re-arm from scratch after the CLEAR.
      for (let i = 0; i < 3; i++) closeTrade(-10);
      expect(engine.applyPaperKillLadderSizing(1).multiplier).toBe(0.5);
    });

    test('risk-day reset lifts the size cap (and retires size rows) but keeps the session freeze', async () => {
      engine = await freshEngine();
      for (let i = 0; i < 5; i++) closeTrade(-10, { strategy: 'trend_follow' });
      await flush();
      harness.calls.length = 0;

      await engine.resetDailyMetrics();

      expect(engine.getRiskStatus().paperKillLadder).toMatchObject({
        sizeLevel: 0,
        positionMultiplierCap: 1,
        frozenStrategies: [{ strategy: 'trend_follow' }],
        perStrategyConsecutiveLosses: {},
      });
      expect(engine.checkPaperKillLadderEntry({ strategy: 'trend_follow' })).toMatchObject({ allowed: false, reasonCode: 'strategy_freeze' });
      const retire = harness.callsFor('risk_events', 'update').find((c) => c.filters.some(([m, col]) => m === 'in' && col === 'event_type'));
      expect(retire).toBeDefined();
      expect(retire!.filters).toEqual(expect.arrayContaining([['in', 'event_type', ['size_down_consec', 'size_down_daily_r']]]));
    });

    test('a clean session start after CLEAR (ignorePersistedKillSwitch) begins with every rung released', async () => {
      harness.respond('risk_metrics.select', () => ({
        data: { user_id: USER_ID, daily_pnl: -300, max_drawdown: 3, consecutive_losses: 7, error_rate: 0, kill_switch_active: true, exposure_usd: 0, updated_at: todayIso(), execution_mode: 'paper' },
      }));
      engine = await freshEngine({ ignorePersistedKillSwitch: true });

      expect(engine.getMetrics().consecutiveLosses).toBe(0);
      expect(engine.getMetrics().killSwitchActive).toBe(false);
      expect(engine.getRiskStatus().paperKillLadder).toMatchObject({ sizeLevel: 0, positionMultiplierCap: 1, highestActiveLevel: 0 });
      (engine as any).checkKillSwitches();
      expect(engine.getRiskStatus().tradingState).toBe('RUNNING');
      expect(engine.applyPaperKillLadderSizing(1).multiplier).toBe(1);
    });
  });

  describe('restore never treats a soft ladder row as a halt', () => {
    function openRow(event_type: string, details: Record<string, unknown>, triggered_at = todayIso()) {
      return { id: `evt-${event_type}`, user_id: USER_ID, event_type, details, active: true, triggered_at, cleared_at: null, execution_mode: 'paper' };
    }
    const latched = () => ({
      user_id: USER_ID, daily_pnl: -50, max_drawdown: 0, consecutive_losses: 3, error_rate: 0, kill_switch_active: true, exposure_usd: 0, updated_at: todayIso(), execution_mode: 'paper',
    });

    async function bootLatched(events: unknown[]) {
      harness.respond('risk_metrics.select', () => ({ data: latched() }));
      harness.respond('risk_events.select', () => ({ data: events }));
      const e = await waitForLoaders(new RiskEngine(baseConfig, mockLogger as any, positionTracker));
      await vi.waitFor(() => expect(harness.callsFor('risk_events', 'select').length).toBeGreaterThan(0));
      await flush();
      return e;
    }

    test('newest open row is size_down_consec, the halt underneath is manual_killswitch -> restores manual_killswitch', async () => {
      engine = await bootLatched([
        openRow('size_down_consec', { eventType: 'ladder', ladderLevel: 1, reasonCode: 'size_down_consec' }),
        openRow('manual_killswitch', { reason: 'User activated kill switch' }, new Date(Date.now() - 60_000).toISOString()),
      ]);
      const status = engine.getRiskStatus();
      expect(status.tradingState).toBe('HALTED');
      expect(status.reasonCode).toBe('manual_killswitch');
      expect(status.reasonText).toBe('User activated kill switch');
      const select = harness.callsFor('risk_events', 'select')[0];
      expect(select.filters).toEqual(expect.arrayContaining([['is', 'cleared_at', null], ['eq', 'execution_mode', 'paper']]));
    });

    test.each(['size_down_consec', 'size_down_daily_r', 'strategy_freeze', 'regime_pause', 'sleeve_halt'])(
      'only a %s row open -> flag-only restore (RUNNING state machine, entries blocked by the flag), never HALTED on a soft code',
      async (code) => {
        engine = await bootLatched([openRow(code, { eventType: 'ladder', reasonCode: code })]);
        expect(engine.getMetrics().killSwitchActive).toBe(true);
        expect(engine.canEnterTrades()).toBe(false);
        const status = engine.getRiskStatus();
        expect(status.tradingState).toBe('RUNNING');
        expect(status.reasonCode).toBeUndefined();
      }
    );

    test('a restart without CLEAR retires stale soft rows (the in-memory ladder starts empty) but leaves halts alone', async () => {
      harness.respond('risk_metrics.select', () => ({ data: { ...latched(), kill_switch_active: false, consecutive_losses: 4 } }));
      engine = await waitForLoaders(new RiskEngine(baseConfig, mockLogger as any, positionTracker));
      await flush();

      // Restored streak (4) re-derives the L1 cap on the first tick.
      expect(engine.getMetrics().consecutiveLosses).toBe(4);
      (engine as any).checkKillSwitches();
      expect(engine.applyPaperKillLadderSizing(1).multiplier).toBe(0.5);
      expect(engine.getRiskStatus()).toMatchObject({ tradingState: 'RUNNING', paperKillLadder: { frozenStrategies: [], regimePauses: [] } });

      const sweep = harness.callsFor('risk_events', 'update').find((c) => c.filters.some(([m, col]) => m === 'in' && col === 'event_type'));
      expect(sweep).toBeDefined();
      expect(sweep!.payload).toMatchObject({ active: false });
      expect(sweep!.filters).toEqual(
        expect.arrayContaining([
          ['eq', 'user_id', USER_ID],
          ['eq', 'active', true],
          ['eq', 'execution_mode', 'paper'],
          ['in', 'event_type', ['size_down_consec', 'size_down_daily_r', 'strategy_freeze', 'regime_pause', 'sleeve_halt']],
        ])
      );
      // Only soft codes are in scope — never an unscoped sweep that would retire a real halt row.
      for (const update of harness.callsFor('risk_events', 'update')) {
        expect(update.filters.some(([m, col]) => m === 'in' && col === 'event_type')).toBe(true);
      }
    });

    test('without the ladder a restart performs no risk_events writes (restore stays read-only)', async () => {
      harness.respond('risk_metrics.select', () => ({ data: { ...latched(), kill_switch_active: false } }));
      engine = await waitForLoaders(new RiskEngine({ ...baseConfig, guardrails: baseGuardrails }, mockLogger as any, positionTracker));
      await flush();
      expect(harness.callsFor('risk_events', 'update')).toHaveLength(0);
      expect(harness.callsFor('risk_events', 'insert')).toHaveLength(0);
    });
  });
});
