/**
 * Live-tier EV gate fee plumbing — Risk-lane compatibility tests on top of
 * TASK_011 (`FeeModel.withRuntimeOverride` + `RiskEngine.setFeeModel`, both
 * on main).
 *
 * Risk Master / TM requirement: EV gates must be able to take LIVE-tier
 * fees (Coinbase Intro 1 = 60 bps maker / 120 bps taker on 2026-09-10).
 * Scoring a live path on the static YAML FeeModel alone when a live-tier
 * override is available is HALT-class.
 *
 * Pins, at the RiskEngine boundary:
 *   1. default: `evaluateSignalEv` prices with the YAML FeeModel from
 *      `RiskEngineConfig.feeModel` (paper / backtest behaviour unchanged);
 *   2. after `setFeeModel(base.withRuntimeOverride(Intro 1))` the SAME
 *      signal is charged 120 bps per leg and the gate verdict flips;
 *   3. the override never mutates guardrails / the base FeeModel, needs no
 *      CONFIRM_LIVE, and swapping the base back restores the YAML tier.
 *
 * No orders are placed anywhere in here; the engine only prices EV.
 * (TASK_011's own tests cover tier discovery, `buildLiveFeeModel`, the live
 * Beta prior / haircut and the enforce|shadow mode.)
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { RiskEngine, RiskEngineConfig } from '../trading/risk-engine';
import { PositionTracker, PositionTrackerConfig } from '../trading/position-tracker';
import { FeeModel } from '../core/fee-model';
import { GuardrailConfig } from '../config/loadGuardrails';

// The engine never talks to the DB in these tests (no userId), but the
// constructor still builds a client — stub the module.
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          single: () => Promise.resolve({ data: null, error: null }),
          maybeSingle: () => Promise.resolve({ data: null, error: null }),
        }),
      }),
      insert: () => Promise.resolve({ error: null }),
      upsert: () => Promise.resolve({ error: null }),
      update: () => Promise.resolve({ error: null }),
    }),
  }),
}));

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

/** Canonical YAML-shaped fixture: Coinbase spot 25/40, perps 0/5, HL -1.5/4.5. */
function buildGuardrails() {
  return {
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
}

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

/**
 * Marginal 3R spot signal: at the YAML 40 bps taker it is +EV ($12); at the
 * Intro-1 120 bps taker the round-trip fee triples ($8 → $24) and EV goes
 * negative (-$4). Exactly the under-charging the live tier must expose.
 *   notional   = 0.02 * 50_000 = $1,000
 *   gross win  = 0.5 * 3_000 * 0.02 = $30
 *   gross loss = 0.5 * 1_000 * 0.02 = $10
 */
const MARGINAL_SIGNAL = {
  symbol: 'BTC-USD',
  strategy: 'momentum',
  direction: 'buy' as const,
  entryPrice: 50_000,
  stopPrice: 49_000,
  takeProfit: 53_000,
  size: 0.02,
  winRate: 0.5,
};

const INTRO_1 = {
  venue: 'coinbase' as const,
  product: 'spot' as const,
  makerBps: 60,
  takerBps: 120,
  source: 'coinbase:Intro 1',
};

/** TASK_011: a live RiskEngine refuses to build without an account snapshot. */
const liveAccountTruthStub = {
  getSnapshot: () => ({ equityUsd: 1_000, fetchedAt: Date.now() }),
  isStale: () => false,
};

describe('RiskEngine live-tier EV gate fee plumbing', () => {
  let guardrails: ReturnType<typeof buildGuardrails>;
  let guardrailsSnapshot: string;
  let positionTracker: PositionTracker;
  let engine: RiskEngine;
  let yamlModel: FeeModel;
  const confirmLiveBefore = process.env.CONFIRM_LIVE;

  function buildEngine(overrides: Partial<RiskEngineConfig> = {}): RiskEngine {
    const config: RiskEngineConfig = {
      supabaseUrl: 'http://localhost:54321',
      supabaseKey: 'test-key',
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
      feeModel: yamlModel,
      ...overrides,
    };
    return new RiskEngine(config, mockLogger as any, positionTracker);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.CONFIRM_LIVE;
    guardrails = buildGuardrails();
    guardrailsSnapshot = JSON.stringify(guardrails);
    yamlModel = FeeModel.fromGuardrails(guardrails);
    positionTracker = new PositionTracker(positionTrackerConfig, mockLogger as any);
    engine = buildEngine();
  });

  afterEach(() => {
    engine.stop();
    positionTracker.stopUpdateLoop();
    if (confirmLiveBefore === undefined) delete process.env.CONFIRM_LIVE;
    else process.env.CONFIRM_LIVE = confirmLiveBefore;
  });

  test('(1) default: EV is priced on the YAML FeeModel — 40 bps per leg', () => {
    const result = engine.evaluateSignalEv(MARGINAL_SIGNAL);

    expect(result.allowed).toBe(true);
    expect(result.entryFeeRate).toBeCloseTo(0.004, 12);
    expect(result.exitFeeRate).toBeCloseTo(0.004, 12);
    expect(result.feeUsd).toBeCloseTo(8, 6);
    expect(result.ev).toBeCloseTo(12, 6);
    expect(engine.getFeeModel()).toBe(yamlModel);
    expect(engine.getFeeModel()?.hasRuntimeOverride('coinbase', 'spot')).toBe(false);
  });

  test('(2) after setFeeModel(yaml.withRuntimeOverride(Intro 1)) the same signal is charged 120 bps and rejected', () => {
    const live = yamlModel.withRuntimeOverride(INTRO_1);
    const replaced = engine.setFeeModel(live);

    expect(replaced).toBe(yamlModel);
    expect(engine.getFeeModel()).toBe(live);
    expect(engine.getFeeModel()?.getFeeBps('coinbase', 'spot', 'taker')).toBe(120);

    const result = engine.evaluateSignalEv(MARGINAL_SIGNAL);
    expect(result.entryFeeRate).toBeCloseTo(0.012, 12);
    expect(result.exitFeeRate).toBeCloseTo(0.012, 12);
    expect(result.feeUsd).toBeCloseTo(24, 6);
    expect(result.ev).toBeCloseTo(-4, 6);
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/EV \$-4\.00 < threshold \$0\.00/);
  });

  test('(2b) the live tier only re-prices its own bucket; perps signals keep the YAML tier', () => {
    engine.setFeeModel(yamlModel.withRuntimeOverride(INTRO_1));

    const perps = engine.evaluateSignalEv({ ...MARGINAL_SIGNAL, symbol: 'ETH-PERP-INTX' });
    expect(perps.exitFeeRate).toBeCloseTo(0.0005, 12);
    expect(perps.feeUsd).toBeCloseTo(1, 6); // 2 * 0.0005 * $1,000
    expect(perps.allowed).toBe(true);
  });

  test('(3) the override mutates neither guardrails nor the base FeeModel, and needs no CONFIRM_LIVE', () => {
    expect(process.env.CONFIRM_LIVE).toBeUndefined();

    engine.setFeeModel(yamlModel.withRuntimeOverride(INTRO_1));
    engine.evaluateSignalEv(MARGINAL_SIGNAL);

    // Canonical YAML config object is byte-identical.
    expect(JSON.stringify(guardrails)).toBe(guardrailsSnapshot);
    expect(guardrails.fees.coinbase.spot.taker_bps).toBe(40);
    // The base model handed in via config still prices YAML.
    expect(yamlModel.getFeeBps('coinbase', 'spot', 'taker')).toBe(40);
    expect(yamlModel.hasRuntimeOverride('coinbase', 'spot')).toBe(false);
    // A fresh model from the same guardrails is unaffected too.
    expect(FeeModel.fromGuardrails(guardrails).getFeeBps('coinbase', 'spot', 'taker')).toBe(40);
    // Nothing flipped a live flag.
    expect(process.env.CONFIRM_LIVE).toBeUndefined();
    expect(process.env.LIVE_STAGE0_COMPLETE).toBeUndefined();
  });

  test('(3b) swapping the YAML model back restores the 40 bps tier for subsequent signals', () => {
    const live = yamlModel.withRuntimeOverride(INTRO_1);
    engine.setFeeModel(live);
    expect(engine.evaluateSignalEv(MARGINAL_SIGNAL).allowed).toBe(false);

    const replaced = engine.setFeeModel(yamlModel);

    expect(replaced).toBe(live);
    const result = engine.evaluateSignalEv(MARGINAL_SIGNAL);
    expect(result.exitFeeRate).toBeCloseTo(0.004, 12);
    expect(result.feeUsd).toBeCloseTo(8, 6);
    expect(result.allowed).toBe(true);
  });

  test('re-applying a changed tier replaces the previous override (no stacking)', () => {
    engine.setFeeModel(yamlModel.withRuntimeOverride(INTRO_1));
    engine.setFeeModel(engine.getFeeModel()!.withRuntimeOverride({ ...INTRO_1, makerBps: 40, takerBps: 60, source: 'coinbase:Intro 2' }));

    const model = engine.getFeeModel()!;
    expect(model.getRuntimeOverrides()).toHaveLength(1);
    expect(model.getFeeBps('coinbase', 'spot', 'taker')).toBe(60);
    expect(engine.evaluateSignalEv(MARGINAL_SIGNAL).feeUsd).toBeCloseTo(12, 6); // 2 * 0.006 * $1,000
  });

  test('paper mode is unaffected by a live tier unless one is explicitly set (paper/backtest parity)', () => {
    engine.stop();
    engine = buildEngine({ executionMode: 'paper' });

    expect(engine.getExecutionMode()).toBe('paper');
    const result = engine.evaluateSignalEv(MARGINAL_SIGNAL);
    expect(result.exitFeeRate).toBeCloseTo(0.004, 12);
    expect(result.feeUsd).toBeCloseTo(8, 6);
    expect(process.env.CONFIRM_LIVE).toBeUndefined();
  });

  test('live mode: a live-tier model makes both fee legs 120 bps for the EV gate', () => {
    engine.stop();
    engine = buildEngine({
      executionMode: 'live',
      liveAccountTruth: liveAccountTruthStub,
      feeModel: yamlModel.withRuntimeOverride(INTRO_1),
    });

    expect(engine.getExecutionMode()).toBe('live');
    // Live semantics (TASK_011) shrink p toward the Beta prior and haircut the
    // TP geometry; the fee legs are what this plumbing owns.
    const result = engine.evaluateSignalEv({ ...MARGINAL_SIGNAL, sampleSize: 30 });
    expect(result.entryFeeRate).toBeCloseTo(0.012, 12);
    expect(result.exitFeeRate).toBeCloseTo(0.012, 12);
    expect(result.feeUsd).toBeCloseTo(24, 6);
    expect(process.env.CONFIRM_LIVE).toBeUndefined();
  });
});
