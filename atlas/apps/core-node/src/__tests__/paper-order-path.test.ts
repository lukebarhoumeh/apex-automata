/**
 * Tier-A P0 (DESK GO 2026-09-21) — paper path: a router-approved entry becomes
 * a paper order, and an engine decline is attributable by the router.
 *
 * Drives TradingEngine.createOrder() in paper mode with the real RiskEngine,
 * PositionTracker, OrderManager and PaperTradingSimulator wired (the exchange
 * is a bare EventEmitter; Supabase is a recording mock; start() is bypassed
 * exactly like trading-engine-lifecycle.test.ts does).
 *
 * Pins:
 *   - the incident-sized ETH-USD / ETH-PERP-INTX entries (sess_1790007063812_cbimxk,
 *     sized by the router after the EV-gate fix) produce a ManagedOrder tagged
 *     with the signal id and emit order:created — i.e. the blotter row exists;
 *   - getLastOrderRejection() carries the engine's own reason when
 *     createOrder() returns null, and is cleared by the next accepted order,
 *     so the router can persist "risk_engine: <reason>" instead of a slug.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import { TradingEngine, TradingEngineConfig } from '../trading/trading-engine';
import type { ManagedOrder } from '../trading/order-manager';
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

// guardrails.yaml on 2026-09-21, reduced to what the engine reads here.
const guardrails = {
  disabled_strategies: ['vwap_mr', 'breakout', 'momentum'],
  account: { equity_usd: 10000, risk_per_trade: 0.005, max_open_positions: 4, max_account_leverage: 3.0, min_notional_buffer: 1.1 },
  fees: {
    coinbase: { spot: { maker_bps: 25, taker_bps: 40 }, perps_intx: { maker_bps: 0, taker_bps: 5 } },
    hyperliquid: { perps: { maker_bps: -1.5, taker_bps: 4.5 } },
  },
  risk: { daily_loss_limit: -0.02, weekly_loss_limit: -0.05, max_drawdown_limit: -0.15, max_position_exposure_pct: 0.30, funding_cost_tolerance_bps: 20, slippage_estimate_bps: 3, min_ev_threshold: 0 },
  per_symbol: { 'ETH-USD': { max_notional_usd: 3000, max_daily_loss_usd: 200 } },
  perps: { risk_per_trade: 0.015, default_leverage: 3, max_leverage: 10, liquidation_buffer_pct: 0.2, max_funding_rate_bps: 50, funding_check_interval_sec: 300, maker_fee: 0, taker_fee: 0.0003, nano_contract_size: 0.01 },
  perps_symbols: { 'ETH-PERP-INTX': { max_notional_usd: 5000, max_daily_loss_usd: 300, default_leverage: 3, max_leverage: 5 } },
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
  products: ['ETH-USD', 'ETH-PERP-INTX'],
  supabase: { url: 'http://localhost:54321', serviceKey: 'test-key', anonKey: 'test-anon', userId: 'b7e8f9c2-4d6a-4c8b-9e2d-1a3b5c7d9e1f' },
  security: { encryptionKey: '00'.repeat(32) },
  guardrails: guardrails as unknown as TradingEngineConfig['guardrails'],
};

// Incident signals (signals.features on sess_1790007063812_cbimxk), sized by the
// router with soft launch off: rawSize 1.068193 × positionMultiplier 0.451352.
const ETH_PRICE = 2752.31;
const ETH_SIZE = '0.482131';
const ETH_LIMIT = (ETH_PRICE * (1 + 2 / 10_000)).toFixed(2); // marketable_limit, +2 bps
const SIGNAL_ID = '6f1c2a3e-9b4d-4c8e-8f21-0a1b2c3d4e5f';

function wireEngine(): TradingEngine {
  const engine = new TradingEngine(config, logger);
  const e = engine as any;
  e.exchange = new EventEmitter();
  e.initializePaperSimulator();
  e.initializeOrderManager();
  e.initializePositionTracker();
  e.initializeRiskEngine();
  // Bridges orderManager 'order:created' → engine 'order:created' (the server's
  // syncOrderToSupabase hook); start() does this after the initializers.
  e.setupEventHandlers();
  e.isRunning = true;
  for (const symbol of config.products) {
    e.marketPrices.set(symbol, ETH_PRICE);
    e.paperSimulator.updateMarketPrice(symbol, ETH_PRICE);
  }
  return engine;
}

function teardown(engine: TradingEngine): void {
  const e = engine as any;
  e.riskEngine?.stop?.();
  e.positionTracker?.stopUpdateLoop?.();
  e.orderManager?.destroy?.();
}

function entryRequest(symbol: string) {
  return { product_id: symbol, side: 'buy' as const, type: 'limit' as const, size: ETH_SIZE, price: ETH_LIMIT, post_only: false };
}

const entryContext = {
  strategy: 'trend_follow',
  metadata: { tag: 'entry', signalId: SIGNAL_ID, stopPrice: 2740.29, takeProfit: 2781.16, intendedEntryPrice: ETH_PRICE },
};

describe('paper path — approved entry → paper order (PAPER_DISABLE_SOFT_LAUNCH=true, the profile the May orders ran under)', () => {
  const previous = process.env.PAPER_DISABLE_SOFT_LAUNCH;
  let engine: TradingEngine;

  beforeEach(() => {
    process.env.PAPER_DISABLE_SOFT_LAUNCH = 'true';
    vi.clearAllMocks();
    engine = wireEngine();
  });

  afterEach(() => {
    teardown(engine);
    if (previous === undefined) delete process.env.PAPER_DISABLE_SOFT_LAUNCH;
    else process.env.PAPER_DISABLE_SOFT_LAUNCH = previous;
  });

  it('ETH-USD incident-sized entry is accepted: ManagedOrder returned, order:created emitted with the signal id', async () => {
    const created: ManagedOrder[] = [];
    engine.on('order:created', (order) => created.push(order));

    const order = await engine.createOrder(entryRequest('ETH-USD'), entryContext);

    expect(order).not.toBeNull();
    expect(order!.productId).toBe('ETH-USD');
    expect(order!.side).toBe('buy');
    expect(order!.size).toBeCloseTo(0.482131, 6);
    expect(order!.strategy).toBe('trend_follow');
    expect(order!.metadata.signalId).toBe(SIGNAL_ID);
    expect(created).toHaveLength(1);
    expect(created[0].id).toBe(order!.id);
    expect(engine.getLastOrderRejection()).toBeNull();
    expect(logger.warn).not.toHaveBeenCalledWith(expect.stringContaining('Order rejected by risk engine'));
  });

  it('ETH-PERP-INTX entry is accepted on the same paper path (INTX has a paper venue — perps fee tier, USD collateral)', async () => {
    const order = await engine.createOrder(entryRequest('ETH-PERP-INTX'), entryContext);
    expect(order).not.toBeNull();
    expect(order!.productId).toBe('ETH-PERP-INTX');
    expect(engine.getLastOrderRejection()).toBeNull();
  });
});

describe('paper path — engine decline is attributable (default profile: soft launch ON)', () => {
  const previous = process.env.PAPER_DISABLE_SOFT_LAUNCH;
  let engine: TradingEngine;

  beforeEach(() => {
    delete process.env.PAPER_DISABLE_SOFT_LAUNCH;
    vi.clearAllMocks();
    engine = wireEngine();
  });

  afterEach(() => {
    teardown(engine);
    if (previous === undefined) delete process.env.PAPER_DISABLE_SOFT_LAUNCH;
    else process.env.PAPER_DISABLE_SOFT_LAUNCH = previous;
  });

  it('a $1.3k entry over the soft-launch caps returns null and getLastOrderRejection() carries the engine reason', async () => {
    const before = Date.now();
    const order = await engine.createOrder(entryRequest('ETH-USD'), entryContext);
    expect(order).toBeNull();

    const rejection = engine.getLastOrderRejection();
    expect(rejection).not.toBeNull();
    expect(rejection!.productId).toBe('ETH-USD');
    expect(rejection!.side).toBe('buy');
    expect(rejection!.source).toBe('risk_engine');
    // checkOrder evaluates every limit and keeps the LAST failing reason: here the
    // 0.25× soft-launch position cap ($3000 × 0.25 = $750); the $250 per-symbol
    // soft cap fails earlier in the same pass. Either names a soft-launch limit.
    expect(rejection!.reason).toMatch(
      /(Soft launch cap: position notional \$[\d.]+ exceeds per-symbol cap \$250|Position size would exceed limit: \$[\d.]+ > \$750)/,
    );
    expect(rejection!.at).toBeGreaterThanOrEqual(before);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Order rejected by risk engine'));
  });

  it('an entry that fits under the cap is accepted and clears the previous rejection', async () => {
    expect(await engine.createOrder(entryRequest('ETH-USD'), entryContext)).toBeNull();
    expect(engine.getLastOrderRejection()).not.toBeNull();

    // $200 notional: under the $250 soft cap and above the $25 soft min.
    const small = await engine.createOrder(
      { ...entryRequest('ETH-USD'), size: (200 / ETH_PRICE).toFixed(6) },
      entryContext,
    );
    expect(small).not.toBeNull();
    expect(engine.getLastOrderRejection()).toBeNull();
  });
});
