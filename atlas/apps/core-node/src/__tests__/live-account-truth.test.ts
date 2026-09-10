/**
 * Live account truth — TASK_011 (Sprint 9 / Stage 0).
 *
 * Everything is mocked at the fetch layer (real `AdvancedTradeRestClient` + JWT on a
 * recorded fake fetch). No network, no real orders, no money. `POST /orders` is asserted
 * to NEVER be called — only `POST /orders/preview` (validation, no execution).
 *
 * Spec cases:
 *  1. USD 2.90 + USDC 500 ⇒ quoteAvailableUsd 502.90 (paginated /accounts, USDC 1:1)
 *  2. /transaction_summary 0.006/0.012 ⇒ FeeModel taker 120 bps; EV gate charges 2 × 120 bps
 *  3. Missing snapshot in live ⇒ engine start rejects with ACCOUNT_TRUTH_UNAVAILABLE (no yaml fallback)
 *  4. EV gate with no history uses Beta(12,18): 15m momentum @120 bps rejected in enforce, allowed+logged in shadow
 *  5. Preflight FAILs on can_transfer=true, on *-PERP-INTX, on preview error
 * plus staleness ⇒ ACCOUNT_TRUTH_STALE entry block, no 0.5–2× clamp in live, fee-tier
 * change events, post-fill refresh, FeeModel override immutability and log hygiene.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import crypto from 'node:crypto';
import { Logger } from '../core/logger';
import { FeeModel } from '../core/fee-model';
import type { FeesConfig, GuardrailConfig } from '../config/loadGuardrails';
import { resolveLiveConfig } from '../config/loadGuardrails';
import {
  AdvancedTradeRestClient,
  FetchLike,
  FetchRequestInit,
  AtProduct,
} from '../exchanges/coinbase/advanced-trade-client';
import {
  LiveAccountTruth,
  ACCOUNT_TRUTH_STALE,
  ACCOUNT_TRUTH_UNAVAILABLE,
  buildLiveFeeModel,
  toLiveFeeTier,
} from '../trading/account/live-account-truth';
import { buildPreviewBody, runLiveAccountPreflight, isIntxSymbol } from '../trading/account/live-preflight';
import { toLiveProductSpec } from '../trading/execution/coinbase-advanced-adapter';
import {
  evaluateEvGate,
  computeRealizedPayoffRatio,
  EV_GATE_SHADOW_ALLOW,
  LIVE_GEOMETRY_HAIRCUT,
  LIVE_WIN_RATE_PRIOR,
} from '../trading/risk/ev-gate';
import { RiskEngine, RiskEngineConfig } from '../trading/risk-engine';
import { PositionTracker, PositionTrackerConfig } from '../trading/position-tracker';
import { TradingEngine, TradingEngineConfig } from '../trading/trading-engine';

// TradingEngine / RiskEngine construct Supabase clients + secret manager; none may touch the network.
vi.mock('../config/secrets');
vi.mock('../exchanges/coinbase');
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          single: () => Promise.resolve({ data: null, error: null }),
          maybeSingle: () => Promise.resolve({ data: null, error: null }),
          is: () => ({
            gte: () => ({ order: () => ({ limit: () => Promise.resolve({ data: [], error: null }) }) }),
          }),
        }),
        gte: () => ({
          order: () => ({ limit: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }),
        }),
        order: () => ({ limit: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }),
      }),
      insert: () => Promise.resolve({ error: null }),
      upsert: () => Promise.resolve({ error: null }),
      update: () => ({ eq: () => ({ is: () => Promise.resolve({ error: null }), eq: () => ({ is: () => Promise.resolve({ error: null }) }) }) }),
    }),
  }),
}));

// ============================================================================
// Fixtures
// ============================================================================

const KEY_NAME = 'organizations/11111111-1111-1111-1111-111111111111/apiKeys/22222222-2222-2222-2222-222222222222';
const { privateKey: PRIVATE_KEY } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const PRIVATE_PEM = PRIVATE_KEY.export({ type: 'sec1', format: 'pem' }) as string;

const TEST_FEES: FeesConfig = {
  coinbase: {
    spot: { maker_bps: 25, taker_bps: 40 },
    perps_intx: { maker_bps: 0, taker_bps: 5 },
  },
  hyperliquid: { perps: { maker_bps: -1.5, taker_bps: 4.5 } },
};
const YAML_FEE_MODEL = new FeeModel(TEST_FEES);

const ETH_PRODUCT: AtProduct = {
  product_id: 'ETH-USD',
  price: '2500.00',
  base_currency_id: 'ETH',
  quote_currency_id: 'USD',
  base_increment: '0.00000001',
  quote_increment: '0.01',
  base_min_size: '0.00022',
  base_max_size: '2600',
  quote_min_size: '1',
  quote_max_size: '10000000',
  status: 'online',
  trading_disabled: false,
  cancel_only: false,
  limit_only: false,
  post_only: false,
  view_only: false,
  is_disabled: false,
  auction_mode: false,
  product_type: 'SPOT',
};

function account(currency: string, available: string, hold = '0') {
  return {
    uuid: `acct-${currency}`,
    name: `${currency} Wallet`,
    currency,
    available_balance: { value: available, currency },
    hold: { value: hold, currency },
    active: true,
    type: 'ACCOUNT_TYPE_CRYPTO',
    ready: true,
  };
}

/** Real account shape on 2026-09-10: $2.90 USD + $500 USDC (USDC treated 1:1), 0.1 ETH, some DOGE. */
const ACCOUNTS_PAGE_1 = [account('USD', '2.90'), account('BTC', '0')];
const ACCOUNTS_PAGE_2 = [account('USDC', '500', '10'), account('ETH', '0.1', '0.05'), account('DOGE', '1000')];

const INTRO_1_SUMMARY = {
  total_volume: 0,
  total_fees: 0,
  fee_tier: { pricing_tier: 'Intro 1', usd_from: '0', usd_to: '1000', taker_fee_rate: '0.012', maker_fee_rate: '0.006' },
  advanced_trade_only_volume: 0,
  advanced_trade_only_fees: 0,
};

const PERMISSIONS_OK = {
  can_view: true,
  can_trade: true,
  can_transfer: false,
  portfolio_uuid: 'portfolio-123456',
  portfolio_type: 'DEFAULT',
};

function createLogger(): Logger & { all: () => string } {
  const info = vi.fn();
  const warn = vi.fn();
  const error = vi.fn();
  const debug = vi.fn();
  return {
    info,
    warn,
    error,
    debug,
    all: () => JSON.stringify([...info.mock.calls, ...warn.mock.calls, ...error.mock.calls, ...debug.mock.calls]),
  };
}

interface RecordedCall {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string>;
  body: unknown;
}

interface MockResponse {
  status: number;
  body?: unknown;
}

type Route = (call: RecordedCall) => MockResponse | Promise<MockResponse>;

/** Records every outbound request and lets tests route by method + path (GET prefix-matches). */
function createMockFetch() {
  const calls: RecordedCall[] = [];
  const routes: Array<{ match: (c: RecordedCall) => boolean; handler: Route }> = [];
  const fetchImpl: FetchLike = async (url: string, init: FetchRequestInit) => {
    const parsed = new URL(url);
    const call: RecordedCall = {
      method: init.method,
      path: parsed.pathname,
      query: parsed.searchParams,
      headers: init.headers,
      body: init.body ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const route = routes.find((r) => r.match(call));
    const mock = route
      ? await route.handler(call)
      : { status: 404, body: { error: 'NOT_FOUND', message: `no route for ${call.method} ${call.path}` } };
    return {
      status: mock.status,
      ok: mock.status >= 200 && mock.status < 300,
      headers: { get: () => null },
      text: async () => (mock.body === undefined ? '' : JSON.stringify(mock.body)),
    };
  };
  return {
    fetchImpl,
    calls,
    on(method: string, pathOrPrefix: string, handler: Route) {
      routes.unshift({
        match: (c) =>
          c.method === method && (c.path === pathOrPrefix || (method === 'GET' && c.path.startsWith(`${pathOrPrefix}/`))),
        handler,
      });
    },
    count(method: string, path: string) {
      return calls.filter((c) => c.method === method && c.path === path).length;
    },
  };
}

const BROKERAGE = '/api/v3/brokerage';

/** Wire the happy-path Coinbase routes. Individual tests override by registering later (unshift wins). */
function wireHappyRoutes(mock: ReturnType<typeof createMockFetch>) {
  mock.on('GET', `${BROKERAGE}/accounts`, (call) =>
    call.query.get('cursor') === 'p2'
      ? { status: 200, body: { accounts: ACCOUNTS_PAGE_2, has_next: false, cursor: '' } }
      : { status: 200, body: { accounts: ACCOUNTS_PAGE_1, has_next: true, cursor: 'p2' } },
  );
  mock.on('GET', `${BROKERAGE}/transaction_summary`, () => ({ status: 200, body: INTRO_1_SUMMARY }));
  mock.on('GET', `${BROKERAGE}/products`, (call) => {
    const id = call.path.split('/').pop();
    if (id === 'ETH-USD') return { status: 200, body: ETH_PRODUCT };
    return { status: 404, body: { error: 'NOT_FOUND', message: `product ${id} not found` } };
  });
  mock.on('GET', `${BROKERAGE}/time`, () => {
    const ms = Date.now();
    return { status: 200, body: { iso: new Date(ms).toISOString(), epochSeconds: String(Math.floor(ms / 1000)), epochMillis: String(ms) } };
  });
  mock.on('GET', `${BROKERAGE}/key_permissions`, () => ({ status: 200, body: PERMISSIONS_OK }));
  mock.on('POST', `${BROKERAGE}/orders/preview`, () => ({
    status: 200,
    body: { order_total: '1.06', commission_total: '0.01', errs: [], warning: [], quote_size: '1.05', base_size: '0.00042', best_bid: '2499.99', best_ask: '2500.01' },
  }));
}

function makeClient(mock: ReturnType<typeof createMockFetch>, logger: Logger) {
  return new AdvancedTradeRestClient(
    { apiKey: KEY_NAME, apiSecret: PRIVATE_PEM, environment: 'production', fetchImpl: mock.fetchImpl, maxRetries: 0 },
    logger,
  );
}

function makeTruth(
  client: AdvancedTradeRestClient,
  logger: Logger,
  overrides: Partial<ConstructorParameters<typeof LiveAccountTruth>[0]> = {},
) {
  return new LiveAccountTruth({ logger, client, symbols: ['ETH-USD'], refreshIntervalSec: 60, ...overrides });
}

// Minimal guardrails for RiskEngine / TradingEngine construction.
const GUARDRAILS = {
  account: { equity_usd: 10_000, risk_per_trade: 0.005, max_open_positions: 4, max_account_leverage: 3, min_notional_buffer: 1.1 },
  fees: TEST_FEES,
  risk: {
    daily_loss_limit: -0.02,
    weekly_loss_limit: -0.05,
    max_drawdown_limit: -0.15,
    max_position_exposure_pct: 0.3,
    funding_cost_tolerance_bps: 20,
    slippage_estimate_bps: 3,
    min_ev_threshold: 0,
  },
  per_symbol: { 'ETH-USD': { max_notional_usd: 3000, max_daily_loss_usd: 200 } },
  strategy: {
    mode: 'momentum_futures',
    donchian_len: 20,
    ema_len_1h: 100,
    atr_len_15m: 20,
    atr_entry_band: [0.0005, 0.05],
    stop_init_atr: 1.5,
    stop_trail_atr: 1.0,
    time_stop_bars: 96,
    allow_short: false,
    trade_cooldown_min: 15,
  },
  execution: { order_type: 'marketable_limit', price_offset_ticks: 2, max_slippage_bps: 5, order_timeout_sec: 5, retry_backoff_ms: [100] },
  circuit_breakers: { rapid_loss_trigger: -0.02, fill_rate_collapse: 0.1, adverse_selection_spike: 0.6, correlation_spike: 0.8, vol_spike_atr: 0.03, data_gap_sec: 30 },
  filters: { atr_volatility_min: 0.005, atr_volatility_max: 0.05, funding_bias_enabled: true, time_filter_enabled: false, allowed_hours_utc: [0] },
  compliance: { tax_method: 'FIFO', export_frequency_days: 7, log_level: 'INFO', audit_trail_enabled: true, flatten_on_shutdown: false },
  ui: { heartbeat_sec: 15, show_pnl_per_symbol: true, show_risk_status: true, kill_switch_button: true, alert_channels: ['telegram'] },
  go_live_criteria: { paper_parity_max_diff_bps: 20, min_profitable_days: 3, max_error_count_per_day: 0, manual_approval_required: true },
} as unknown as GuardrailConfig;

const TRACKER_CONFIG: PositionTrackerConfig = {
  supabaseUrl: 'http://localhost:54321',
  supabaseKey: 'test-key',
  updateInterval: 5000,
  pnlCalculationMethod: 'fifo',
  maxPositionValueUsd: 5000,
  maxUnrealizedLossUsd: 80,
  drawdownWarningPct: 5,
  drawdownCriticalPct: 10,
};

function riskConfig(overrides: Partial<RiskEngineConfig> = {}): RiskEngineConfig {
  return {
    supabaseUrl: 'http://localhost:54321',
    supabaseKey: 'test-key',
    ignorePersistedKillSwitch: true,
    limits: { maxPositionSize: 5000, maxTotalExposure: 30000, maxDailyLoss: 80, maxDrawdown: 10, maxOrderSize: 5000, minOrderSize: 1, maxOpenOrders: 5, maxLeverage: 3 },
    killSwitches: { enabled: true, dailyLossLimit: 80, consecutiveLossLimit: 8, errorRateLimit: 20, latencyLimit: 30_000 },
    riskPerTrade: 0.5,
    kellyFraction: 0.25,
    guardrails: GUARDRAILS,
    accountEquity: 10_000,
    feeModel: YAML_FEE_MODEL,
    ...overrides,
  };
}

/** Stub truth for RiskEngine tests (structural `LiveAccountTruthSource`). */
function stubTruth(equityUsd: number | null, stale = false) {
  return {
    getSnapshot: () => (equityUsd === null ? null : { equityUsd, fetchedAt: Date.now() }),
    isStale: () => stale,
  };
}

/** 15m momentum setup on ETH: ATR $10 → stop 2.0 ATR below, TP 5.0 ATR above, $250 notional. */
const MOMENTUM_15M = {
  symbol: 'ETH-USD',
  strategy: 'momentum',
  direction: 'buy' as const,
  entryPrice: 2500,
  stopPrice: 2480,
  takeProfit: 2550,
  size: 0.1,
  minEvThreshold: 0,
  venue: 'coinbase' as const,
};

// ============================================================================
// 1. Snapshot: USD + USDC quote, paginated accounts, equity marks
// ============================================================================

describe('LiveAccountTruth snapshot', () => {
  let mock: ReturnType<typeof createMockFetch>;
  let logger: ReturnType<typeof createLogger>;
  let client: AdvancedTradeRestClient;

  beforeEach(() => {
    mock = createMockFetch();
    wireHappyRoutes(mock);
    logger = createLogger();
    client = makeClient(mock, logger);
  });

  it('1. USD 2.90 + USDC 500 ⇒ quoteAvailableUsd 502.90 across paginated /accounts', async () => {
    const truth = makeTruth(client, logger);
    const snapshot = await truth.refresh();

    expect(snapshot.quoteAvailableUsd).toBe(502.9);
    expect(snapshot.quoteHoldUsd).toBe(10);
    // Both pages were read (cursor followed) with limit=250.
    expect(mock.count('GET', `${BROKERAGE}/accounts`)).toBe(2);
    expect(mock.calls.filter((c) => c.path === `${BROKERAGE}/accounts`).every((c) => c.query.get('limit') === '250')).toBe(true);
    // Bases reported; DOGE is not a live base so it is NOT valued.
    expect(snapshot.baseBalances.ETH).toEqual({ available: 0.1, hold: 0.05 });
    expect(snapshot.baseBalances.DOGE).toEqual({ available: 1000, hold: 0 });
    expect(snapshot.baseBalances.BTC).toBeUndefined(); // zero balance dropped
    // Equity = quote available + hold + (ETH available+hold) × product last price (feed not warm yet).
    expect(snapshot.marks['ETH-USD']).toEqual({ price: 2500, source: 'product' });
    expect(snapshot.equityUsd).toBe(502.9 + 10 + 0.15 * 2500);
    expect(snapshot.products['ETH-USD']).toEqual(toLiveProductSpec(ETH_PRODUCT));
    expect(truth.isStale()).toBe(false);
    expect(truth.getHealth()).toMatchObject({ ok: true, degraded: false, reasonCodes: [] });
  });

  it('marks bases at the market-data mid once the feed is attached', async () => {
    const truth = makeTruth(client, logger, { priceSource: () => 3000 });
    const snapshot = await truth.refresh();
    expect(snapshot.marks['ETH-USD']).toEqual({ price: 3000, source: 'feed' });
    expect(snapshot.equityUsd).toBe(512.9 + 0.15 * 3000);
  });

  it('refuses (throws) when a live product is unknown — no partial snapshot', async () => {
    const truth = makeTruth(client, logger, { symbols: ['ETH-USD', 'SOL-USD'] });
    await expect(truth.refresh()).rejects.toThrow();
    expect(truth.getSnapshot()).toBeNull();
    expect(() => truth.requireSnapshot()).toThrow(ACCOUNT_TRUTH_UNAVAILABLE);
    expect(truth.getHealth().reasonCodes).toEqual([ACCOUNT_TRUTH_UNAVAILABLE]);
    expect(truth.getLastFailure()?.status).toBe(404);
  });

  it('refuses when the fee tier is unknown (transaction_summary without fee_tier)', async () => {
    mock.on('GET', `${BROKERAGE}/transaction_summary`, () => ({ status: 200, body: { total_volume: 0 } }));
    const truth = makeTruth(client, logger);
    await expect(truth.refresh()).rejects.toThrow(/fee_tier/);
    expect(truth.getSnapshot()).toBeNull();
  });

  it('keeps the previous snapshot on a failed refresh and goes stale after 3× the interval', async () => {
    let now = 1_000_000;
    const truth = makeTruth(client, logger, { now: () => now, refreshIntervalSec: 60 });
    const first = await truth.refresh();

    mock.on('GET', `${BROKERAGE}/accounts`, () => ({ status: 500, body: { error: 'INTERNAL', message: 'boom' } }));
    await expect(truth.refresh()).rejects.toThrow();
    expect(truth.getSnapshot()).toBe(first);
    expect(truth.getLastFailure()).toMatchObject({ status: 500, code: 'INTERNAL' });

    now += 3 * 60_000; // exactly 3× → not yet stale
    expect(truth.isStale()).toBe(false);
    now += 1;
    expect(truth.isStale()).toBe(true);
    expect(truth.getHealth().reasonCodes).toEqual([ACCOUNT_TRUTH_STALE]);
    expect(truth.getSummary()?.stale).toBe(true);
  });

  it('emits fee_tier_changed when Coinbase reports a new tier; refreshAfterFill triggers a refresh', async () => {
    const truth = makeTruth(client, logger);
    const changes: unknown[] = [];
    truth.on('fee_tier_changed', (c) => changes.push(c));
    await truth.refresh();

    mock.on('GET', `${BROKERAGE}/transaction_summary`, () => ({
      status: 200,
      body: { ...INTRO_1_SUMMARY, total_volume: 12_000, fee_tier: { pricing_tier: 'Advanced 1', taker_fee_rate: '0.004', maker_fee_rate: '0.0025' } },
    }));
    const before = mock.count('GET', `${BROKERAGE}/transaction_summary`);
    truth.refreshAfterFill();
    await vi.waitFor(() => expect(changes).toHaveLength(1));
    expect(mock.count('GET', `${BROKERAGE}/transaction_summary`)).toBe(before + 1);
    expect(changes[0]).toMatchObject({
      previous: { name: 'Intro 1', makerBps: 60, takerBps: 120 },
      next: { name: 'Advanced 1', makerBps: 25, takerBps: 40, volume30dUsd: 12_000 },
    });
    expect(logger.all()).toContain('FEE_TIER_CHANGED');
  });

  it('coalesces concurrent refreshes onto one in-flight request', async () => {
    const truth = makeTruth(client, logger);
    const [a, b] = await Promise.all([truth.refresh(), truth.refresh()]);
    expect(a).toBe(b);
    expect(mock.count('GET', `${BROKERAGE}/transaction_summary`)).toBe(1);
  });

  it('never logs Authorization headers or JWTs', async () => {
    mock.on('GET', `${BROKERAGE}/accounts`, () => ({ status: 401, body: { error: 'UNAUTHORIZED', message: 'bad jwt' } }));
    const truth = makeTruth(client, logger);
    await expect(truth.refresh()).rejects.toThrow();
    const logged = logger.all();
    expect(logged).not.toContain('Bearer ');
    expect(logged).not.toContain('eyJ');
    expect(logged).toContain('"status":401');
  });
});

// ============================================================================
// 2. Fee tier → FeeModel → EV gate fees
// ============================================================================

describe('Fee tier truth', () => {
  it('2. /transaction_summary 0.006/0.012 ⇒ FeeModel taker 120 bps; EV gate charges 2 × 120 bps', async () => {
    const mock = createMockFetch();
    wireHappyRoutes(mock);
    const logger = createLogger();
    const truth = makeTruth(makeClient(mock, logger), logger);
    const snapshot = await truth.refresh();

    expect(snapshot.feeTier).toEqual({ name: 'Intro 1', makerRate: 0.006, takerRate: 0.012, makerBps: 60, takerBps: 120, volume30dUsd: 0 });

    const live = buildLiveFeeModel(YAML_FEE_MODEL, snapshot.feeTier);
    expect(live.getFeeBps('coinbase', 'spot', 'taker')).toBe(120);
    expect(live.getFeeBps('coinbase', 'spot', 'maker')).toBe(60);
    expect(live.hasRuntimeOverride('coinbase', 'spot')).toBe(true);
    // Immutable: the yaml model is untouched, perps bucket untouched.
    expect(YAML_FEE_MODEL.getFeeBps('coinbase', 'spot', 'taker')).toBe(40);
    expect(YAML_FEE_MODEL.hasRuntimeOverride('coinbase', 'spot')).toBe(false);
    expect(live.getFeeBps('coinbase', 'perps', 'taker')).toBe(5);

    // EV gate: taker both legs ⇒ 2 × 120 bps × $250 notional = $6.00.
    const taker = evaluateEvGate({ ...MOMENTUM_15M, winRate: 0.5, feeModel: live }, createLogger());
    expect(taker.feeUsd).toBeCloseTo(2 * 0.012 * 250, 10);
    expect(taker.entryFeeRate).toBe(0.012);
    expect(taker.exitFeeRate).toBe(0.012);

    // Post-only entry ⇒ maker in (60 bps) / taker out (120 bps) = $4.50.
    const maker = evaluateEvGate({ ...MOMENTUM_15M, winRate: 0.5, feeModel: live, entryLiquidity: 'maker' }, createLogger());
    expect(maker.feeUsd).toBeCloseTo((0.006 + 0.012) * 250, 10);
  });

  it('withRuntimeOverride rejects unknown buckets and non-finite rates', () => {
    expect(() => YAML_FEE_MODEL.withRuntimeOverride({ venue: 'hyperliquid', product: 'spot', makerBps: 1, takerBps: 2 })).toThrow(/no fee configuration/);
    expect(() => YAML_FEE_MODEL.withRuntimeOverride({ venue: 'coinbase', product: 'spot', makerBps: Number.NaN, takerBps: 2 })).toThrow(/invalid rates/);
    expect(() => YAML_FEE_MODEL.withRuntimeOverride({ venue: 'coinbase', product: 'spot', makerBps: 1, takerBps: -1 })).toThrow(/invalid rates/);
  });

  it('toLiveFeeTier derives bps with exact decimal arithmetic', () => {
    const tier = toLiveFeeTier({ ...INTRO_1_SUMMARY, fee_tier: { pricing_tier: 'X', taker_fee_rate: '0.0075', maker_fee_rate: '0.0035' }, raw: null });
    expect(tier.takerBps).toBe(75);
    expect(tier.makerBps).toBe(35);
  });
});

// ============================================================================
// 3. Live start refuses without a snapshot
// ============================================================================

describe('Live start fails closed without account truth', () => {
  const engineConfig = (extra: Partial<TradingEngineConfig> = {}): TradingEngineConfig => ({
    mode: 'live',
    exchange: { name: 'coinbase', environment: 'production' },
    products: ['ETH-USD'],
    supabase: { url: 'https://test.supabase.co', serviceKey: 'test-key', anonKey: 'test-anon' },
    security: { encryptionKey: 'test-encryption-key' },
    guardrails: GUARDRAILS,
    ...extra,
  });

  it('3. missing snapshot in live ⇒ engine start rejects with ACCOUNT_TRUTH_UNAVAILABLE (no yaml fallback)', async () => {
    const logger = createLogger();
    const engine = new TradingEngine(engineConfig(), logger);
    await expect(engine.start('test')).rejects.toThrow(ACCOUNT_TRUTH_UNAVAILABLE);
    expect(engine.engineRunning).toBe(false);
    expect(engine.getEngineState()).toBe('stopped');
    // The yaml equity was never used to build a risk engine.
    expect(engine.getRiskEngineInstance()).toBeNull();
  });

  it('a truth that never refreshed is not enough either', async () => {
    const logger = createLogger();
    const mock = createMockFetch(); // no routes ⇒ every call 404s
    const truth = makeTruth(makeClient(mock, logger), logger);
    const engine = new TradingEngine(engineConfig({ liveAccountTruth: truth }), logger);
    await expect(engine.start('test')).rejects.toThrow(ACCOUNT_TRUTH_UNAVAILABLE);
    expect(engine.getRiskEngineInstance()).toBeNull();
  });

  it('paper mode ignores liveAccountTruth entirely (unchanged path)', () => {
    const logger = createLogger();
    const mock = createMockFetch();
    const truth = makeTruth(makeClient(mock, logger), logger);
    const engine = new TradingEngine(engineConfig({ mode: 'paper', liveAccountTruth: truth }), logger);
    expect(engine.getLiveAccountTruth()).toBeNull();
  });

  it('RiskEngine refuses to build in live mode without a snapshot', () => {
    const tracker = new PositionTracker(TRACKER_CONFIG, createLogger());
    expect(() => new RiskEngine(riskConfig({ executionMode: 'live' }), createLogger(), tracker)).toThrow(ACCOUNT_TRUTH_UNAVAILABLE);
    expect(() => new RiskEngine(riskConfig({ executionMode: 'live', liveAccountTruth: stubTruth(null) }), createLogger(), tracker)).toThrow(
      ACCOUNT_TRUTH_UNAVAILABLE,
    );
    tracker.stopUpdateLoop();
  });
});

// ============================================================================
// Live sizing: snapshot equity, no clamp, stale ⇒ entries blocked
// ============================================================================

describe('RiskEngine live equity', () => {
  it('sizes from the snapshot equity with no 0.5–2× clamp; paper keeps the clamp', () => {
    const tracker = new PositionTracker(TRACKER_CONFIG, createLogger());
    const truth = { equity: 502.9, stale: false };
    const live = new RiskEngine(
      riskConfig({
        executionMode: 'live',
        liveAccountTruth: { getSnapshot: () => ({ equityUsd: truth.equity, fetchedAt: Date.now() }), isStale: () => truth.stale },
      }),
      createLogger(),
      tracker,
    );
    // Configured yaml equity ($10,000) is ignored: the anchor is the exchange snapshot.
    expect(live.getAccountEquity()).toBe(502.9);
    expect(live.getCurrentEquityForSizing()).toBe(502.9);
    // Snapshot moves ⇒ sizing follows it directly (no clamp to [0.5×, 2×] of the anchor).
    truth.equity = 5_000;
    expect(live.getCurrentEquityForSizing()).toBe(5_000);
    truth.equity = 100;
    expect(live.getCurrentEquityForSizing()).toBe(100);
    live.stop();

    const paper = new RiskEngine(riskConfig(), createLogger(), tracker);
    expect(paper.getAccountEquity()).toBe(10_000);
    expect(paper.getCurrentEquityForSizing()).toBe(10_000); // dailyStartEquity + 0 PnL, within the clamp
    paper.stop();
    tracker.stopUpdateLoop();
  });

  it('stale snapshot ⇒ checkOrder blocks new entries with ACCOUNT_TRUTH_STALE', async () => {
    const tracker = new PositionTracker(TRACKER_CONFIG, createLogger());
    const state = { stale: false };
    const live = new RiskEngine(
      riskConfig({
        executionMode: 'live',
        liveAccountTruth: { getSnapshot: () => ({ equityUsd: 1_000, fetchedAt: Date.now() - 400_000 }), isStale: () => state.stale },
      }),
      createLogger(),
      tracker,
    );
    const failures: string[] = [];
    live.on('risk:check:failed', (_id: string, reason: string) => failures.push(reason));

    const entry = { product_id: 'ETH-USD', side: 'buy' as const, type: 'limit' as const, size: '0.01', price: '2500' };
    const fresh = await live.checkOrder(entry, 2500);
    expect(fresh.passed).toBe(true);

    state.stale = true;
    const blocked = await live.checkOrder(entry, 2500);
    expect(blocked.passed).toBe(false);
    expect(blocked.reason).toContain(ACCOUNT_TRUTH_STALE);
    expect(failures.some((r) => r.includes(ACCOUNT_TRUTH_STALE))).toBe(true);
    expect(live.isAccountTruthStale()).toBe(true);
    live.stop();
    tracker.stopUpdateLoop();
  });
});

// ============================================================================
// 4. EV gate live semantics: Beta(12,18) prior, haircut, enforce vs shadow
// ============================================================================

describe('EV gate live semantics', () => {
  const liveFeeModel = buildLiveFeeModel(YAML_FEE_MODEL, toLiveFeeTier({ ...INTRO_1_SUMMARY, raw: null }));

  it('4. no history ⇒ Beta(12,18) prior (p0=0.40, n0=30): 15m momentum @120 bps rejected in enforce', () => {
    expect(LIVE_WIN_RATE_PRIOR).toEqual({ p0: 0.4, n0: 30 }); // Beta(12, 18)
    const logger = createLogger();
    const result = evaluateEvGate(
      {
        ...MOMENTUM_15M,
        winRate: null,
        feeModel: liveFeeModel,
        winRatePrior: LIVE_WIN_RATE_PRIOR,
        geometryHaircut: LIVE_GEOMETRY_HAIRCUT,
        mode: 'enforce',
      },
      logger,
    );
    // L = $20 × 0.1 = $2; W = 0.6 × $50 × 0.1 = $3; fees = 0.024 × $250 = $6
    // EV = 0.4 × 3 − 0.6 × 2 − 6 = −$6.00
    expect(result.allowed).toBe(false);
    expect(result.p).toBe(0.4);
    expect(result.pSource).toBe('prior');
    expect(result.payoffSource).toBe('geometry_haircut');
    expect(result.expectedWinUsd).toBeCloseTo(3, 10);
    expect(result.expectedLossUsd).toBeCloseTo(2, 10);
    expect(result.feeUsd).toBeCloseTo(6, 10);
    expect(result.ev).toBeCloseTo(-6, 10);
    expect(result.reason).toMatch(/EV \$-6\.00 < threshold \$0\.00/);
    // No default-allow warn was emitted — the prior is a decision, not a fallback.
    expect(logger.warn).not.toHaveBeenCalledWith(expect.stringContaining('default-allow'), expect.anything());
  });

  it('4b. same setup in shadow mode is allowed AND logged as EV_GATE_SHADOW_ALLOW', () => {
    const logger = createLogger();
    const result = evaluateEvGate(
      {
        ...MOMENTUM_15M,
        winRate: null,
        feeModel: liveFeeModel,
        winRatePrior: LIVE_WIN_RATE_PRIOR,
        geometryHaircut: LIVE_GEOMETRY_HAIRCUT,
        mode: 'shadow',
      },
      logger,
    );
    expect(result.allowed).toBe(true);
    expect(result.shadowed).toBe(true);
    expect(result.ev).toBeCloseTo(-6, 10);
    expect(result.reason).toMatch(new RegExp(`^${EV_GATE_SHADOW_ALLOW}`));
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining(EV_GATE_SHADOW_ALLOW),
      expect.objectContaining({ symbol: 'ETH-USD', strategy: 'momentum', p: 0.4 }),
    );
  });

  it('shrinks an observed win rate toward the prior with pseudo-count n0; zero samples ⇒ prior', () => {
    const shrunk = evaluateEvGate(
      { ...MOMENTUM_15M, winRate: 1.0, sampleSize: 10, feeModel: liveFeeModel, winRatePrior: LIVE_WIN_RATE_PRIOR },
      createLogger(),
    );
    expect(shrunk.p).toBeCloseTo((0.4 * 30 + 1.0 * 10) / 40, 10); // 0.55
    expect(shrunk.pSource).toBe('shrunk');

    // MetaFilter initialises perf rows with winRate 0 / totalTrades 0 — that is "no history".
    const zero = evaluateEvGate(
      { ...MOMENTUM_15M, winRate: 0, sampleSize: 0, feeModel: liveFeeModel, winRatePrior: LIVE_WIN_RATE_PRIOR },
      createLogger(),
    );
    expect(zero.p).toBe(0.4);
    expect(zero.pSource).toBe('prior');
  });

  it('uses realized payoff (avg win / avg loss) when available, TP geometry × haircut otherwise', () => {
    // 12 closed trades: wins avg $30, losses avg $10 ⇒ payoff 3.0
    const pnls = [30, -10, 30, -10, 30, -10, 30, -10, 30, -10, 30, -10];
    expect(computeRealizedPayoffRatio(pnls)).toBe(3);
    expect(computeRealizedPayoffRatio(pnls.slice(0, 6))).toBeNull(); // < 10 trades
    expect(computeRealizedPayoffRatio(new Array(12).fill(5))).toBeNull(); // no losses

    const realized = evaluateEvGate(
      { ...MOMENTUM_15M, winRate: 0.5, feeModel: liveFeeModel, winRatePrior: LIVE_WIN_RATE_PRIOR, sampleSize: 30, realizedPayoffRatio: 3 },
      createLogger(),
    );
    expect(realized.payoffSource).toBe('realized');
    expect(realized.expectedWinUsd).toBeCloseTo(3 * 2, 10); // 3 × L($2)
  });

  it('legacy (paper) inputs are unchanged: missing win rate default-allows, taker both legs, no haircut', () => {
    const logger = createLogger();
    const legacy = evaluateEvGate({ ...MOMENTUM_15M, winRate: null, feeModel: YAML_FEE_MODEL }, logger);
    expect(legacy.allowed).toBe(true);
    expect(legacy.reason).toBe('missing_win_rate_default_allow');
    expect(legacy.feeUsd).toBeCloseTo(2 * 0.004 * 250, 10);

    const priced = evaluateEvGate({ ...MOMENTUM_15M, winRate: 0.5, feeModel: YAML_FEE_MODEL }, logger);
    // W = $50 × 0.1 = $5 (no haircut), L = $2, fees = $2 ⇒ EV = 2.5 − 1 − 2 = −$0.50
    expect(priced.expectedWinUsd).toBeCloseTo(5, 10);
    expect(priced.payoffSource).toBe('geometry');
    expect(priced.ev).toBeCloseTo(-0.5, 10);
  });

  it('RiskEngine.evaluateSignalEv applies the live semantics only in live mode and honours ev_gate_mode', () => {
    const tracker = new PositionTracker(TRACKER_CONFIG, createLogger());
    const truth = stubTruth(1_000);
    const args = { ...MOMENTUM_15M, winRate: null, sampleSize: 0 };

    const enforce = new RiskEngine(
      riskConfig({ executionMode: 'live', liveAccountTruth: truth, feeModel: liveFeeModel, evGateMode: 'enforce' }),
      createLogger(),
      tracker,
    );
    const rejected = enforce.evaluateSignalEv(args);
    expect(rejected.allowed).toBe(false);
    expect(rejected.pSource).toBe('prior');
    expect(enforce.getEvGateMode()).toBe('enforce');
    enforce.stop();

    const shadowLogger = createLogger();
    const shadow = new RiskEngine(
      riskConfig({ executionMode: 'live', liveAccountTruth: truth, feeModel: liveFeeModel, evGateMode: 'shadow' }),
      shadowLogger,
      tracker,
    );
    const allowed = shadow.evaluateSignalEv(args);
    expect(allowed.allowed).toBe(true);
    expect(allowed.shadowed).toBe(true);
    expect(shadowLogger.all()).toContain(EV_GATE_SHADOW_ALLOW);
    shadow.stop();

    // Paper: legacy default-allow; a passed evGateMode:'shadow' is ignored.
    const paper = new RiskEngine(riskConfig({ evGateMode: 'shadow' }), createLogger(), tracker);
    const paperResult = paper.evaluateSignalEv(args);
    expect(paperResult.allowed).toBe(true);
    expect(paperResult.reason).toBe('missing_win_rate_default_allow');
    expect(paper.getEvGateMode()).toBe('enforce');
    paper.stop();
    tracker.stopUpdateLoop();
  });

  it('RiskEngine.setFeeModel swaps the model behind the EV gate (fee tier transition)', () => {
    const tracker = new PositionTracker(TRACKER_CONFIG, createLogger());
    const engine = new RiskEngine(riskConfig({ executionMode: 'live', liveAccountTruth: stubTruth(1_000), feeModel: YAML_FEE_MODEL }), createLogger(), tracker);
    const before = engine.evaluateSignalEv({ ...MOMENTUM_15M, winRate: 0.5, sampleSize: 30 });
    expect(before.feeUsd).toBeCloseTo(2 * 0.004 * 250, 10);
    const replaced = engine.setFeeModel(liveFeeModel);
    expect(replaced).toBe(YAML_FEE_MODEL);
    const after = engine.evaluateSignalEv({ ...MOMENTUM_15M, winRate: 0.5, sampleSize: 30 });
    expect(after.feeUsd).toBeCloseTo(2 * 0.012 * 250, 10);
    engine.stop();
    tracker.stopUpdateLoop();
  });
});

// ============================================================================
// 5. Preflight
// ============================================================================

describe('Live preflight', () => {
  let mock: ReturnType<typeof createMockFetch>;
  let logger: ReturnType<typeof createLogger>;
  let client: AdvancedTradeRestClient;

  const run = (overrides: Partial<Parameters<typeof runLiveAccountPreflight>[0]> = {}) =>
    runLiveAccountPreflight({
      logger,
      client,
      // Same symbol set as the session, exactly as server.ts wires it.
      truth: makeTruth(client, logger, { symbols: overrides.liveSymbols ?? ['ETH-USD'] }),
      liveSymbols: ['ETH-USD'],
      apiVersion: 'advanced',
      minQuoteUsd: 20,
      ...overrides,
    });

  const verdict = (report: Awaited<ReturnType<typeof runLiveAccountPreflight>>, name: string) =>
    report.checks.find((c) => c.name === name)?.verdict;

  beforeEach(() => {
    mock = createMockFetch();
    wireHappyRoutes(mock);
    logger = createLogger();
    client = makeClient(mock, logger);
  });

  it('passes on a healthy View+Trade key with funded quote and tradable products; never POSTs /orders', async () => {
    const report = await run();
    expect(report.ok).toBe(true);
    expect(report.error).toBeUndefined();
    expect(verdict(report, 'env.COINBASE_API_VERSION')).toBe('PASS');
    expect(verdict(report, 'products.intx')).toBe('PASS');
    expect(verdict(report, 'clock.skew')).toBe('PASS');
    expect(verdict(report, 'key.can_trade')).toBe('PASS');
    expect(verdict(report, 'key.can_transfer')).toBe('PASS');
    expect(verdict(report, 'account.truth')).toBe('PASS');
    expect(verdict(report, 'account.equity')).toBe('PASS');
    expect(verdict(report, 'fees.tier')).toBe('WARN'); // 120 bps taker ≥ 75 bps
    expect(verdict(report, 'product.ETH-USD')).toBe('PASS');
    expect(verdict(report, 'preview.ETH-USD')).toBe('PASS');
    // Snapshot summary rides along for the dashboard.
    expect(report.account).toMatchObject({
      equityUsd: 512.9 + 0.15 * 2500,
      quoteAvailableUsd: 502.9,
      feeTier: { name: 'Intro 1', makerBps: 60, takerBps: 120 },
      stale: false,
    });
    expect(report.account?.products['ETH-USD']).toMatchObject({ baseIncrement: '0.00000001', quoteMinSize: '1', tradable: true });
    // Only the preview endpoint was used — no order was ever placed.
    expect(mock.count('POST', `${BROKERAGE}/orders/preview`)).toBe(1);
    expect(mock.count('POST', `${BROKERAGE}/orders`)).toBe(0);
    expect(logger.all()).not.toContain('Bearer ');
  });

  it('5a. FAILs on can_transfer=true', async () => {
    mock.on('GET', `${BROKERAGE}/key_permissions`, () => ({ status: 200, body: { ...PERMISSIONS_OK, can_transfer: true } }));
    const report = await run();
    expect(report.ok).toBe(false);
    expect(verdict(report, 'key.can_transfer')).toBe('FAIL');
    expect(report.error).toMatch(/key\.can_transfer/);
  });

  it('5b. FAILs when a *-PERP-INTX symbol would be live', async () => {
    expect(isIntxSymbol('ETH-PERP-INTX')).toBe(true);
    expect(isIntxSymbol('ETH-USD')).toBe(false);
    const report = await run({ perpsSymbols: ['ETH-PERP-INTX'] });
    expect(report.ok).toBe(false);
    expect(verdict(report, 'products.intx')).toBe('FAIL');
    expect(report.error).toMatch(/ETH-PERP-INTX/);
    // Also when it sneaks into the spot list itself.
    const report2 = await run({ liveSymbols: ['ETH-USD', 'BTC-PERP-INTX'] });
    expect(verdict(report2, 'products.intx')).toBe('FAIL');
  });

  it('5c. FAILs on preview errors (errs[] and HTTP rejects)', async () => {
    mock.on('POST', `${BROKERAGE}/orders/preview`, () => ({
      status: 200,
      body: { order_total: '0', commission_total: '0', errs: ['PREVIEW_INSUFFICIENT_FUND'], warning: [] },
    }));
    const report = await run();
    expect(report.ok).toBe(false);
    expect(verdict(report, 'preview.ETH-USD')).toBe('FAIL');
    expect(report.error).toMatch(/PREVIEW_INSUFFICIENT_FUND/);

    mock.on('POST', `${BROKERAGE}/orders/preview`, () => ({ status: 400, body: { error: 'INVALID_ARGUMENT', message: 'bracket not allowed' } }));
    const report2 = await run();
    expect(verdict(report2, 'preview.ETH-USD')).toBe('FAIL');
    expect(report2.error).toMatch(/INVALID_ARGUMENT/);
  });

  it('FAILs on can_trade=false and on an unauthenticated key', async () => {
    mock.on('GET', `${BROKERAGE}/key_permissions`, () => ({ status: 200, body: { ...PERMISSIONS_OK, can_trade: false } }));
    expect(verdict(await run(), 'key.can_trade')).toBe('FAIL');

    mock.on('GET', `${BROKERAGE}/key_permissions`, () => ({ status: 401, body: { error: 'UNAUTHORIZED', message: 'invalid jwt' } }));
    const report = await run();
    expect(verdict(report, 'auth.jwt')).toBe('FAIL');
    expect(verdict(report, 'account.truth')).toBe('FAIL'); // skipped, still a FAIL
    expect(report.ok).toBe(false);
  });

  it('FAILs on COINBASE_API_VERSION≠advanced, clock skew > 30s and unreadable server time', async () => {
    expect(verdict(await run({ apiVersion: 'exchange' }), 'env.COINBASE_API_VERSION')).toBe('FAIL');

    mock.on('GET', `${BROKERAGE}/time`, () => ({ status: 200, body: { epochMillis: String(Date.now() - 45_000) } }));
    expect(verdict(await run(), 'clock.skew')).toBe('FAIL');

    mock.on('GET', `${BROKERAGE}/time`, () => ({ status: 200, body: {} }));
    expect(verdict(await run(), 'clock.skew')).toBe('FAIL');
  });

  it('FAILs on equity below live.min_quote_usd (USD only, no USDC)', async () => {
    mock.on('GET', `${BROKERAGE}/accounts`, () => ({ status: 200, body: { accounts: [account('USD', '2.90')], has_next: false, cursor: '' } }));
    const report = await run();
    expect(verdict(report, 'account.equity')).toBe('FAIL');
    expect(report.error).toMatch(/\$2\.90.*below live\.min_quote_usd \$20/);
    expect(report.account?.quoteAvailableUsd).toBe(2.9);
  });

  it('FAILs when the fee tier or a product is unknown, or a product is cancel_only', async () => {
    mock.on('GET', `${BROKERAGE}/transaction_summary`, () => ({ status: 200, body: {} }));
    const tier = await run();
    expect(verdict(tier, 'account.truth')).toBe('FAIL');
    expect(tier.error).toMatch(/fee_tier/);

    mock = createMockFetch();
    wireHappyRoutes(mock);
    client = makeClient(mock, logger);
    const missing = await run({ liveSymbols: ['ETH-USD', 'SOL-USD'] });
    expect(verdict(missing, 'account.truth')).toBe('FAIL');
    expect(missing.error).toMatch(/SOL-USD/);

    mock.on('GET', `${BROKERAGE}/products`, () => ({ status: 200, body: { ...ETH_PRODUCT, cancel_only: true } }));
    const cancelOnly = await run();
    expect(verdict(cancelOnly, 'product.ETH-USD')).toBe('FAIL');
    expect(cancelOnly.error).toMatch(/cancel_only/);
    expect(verdict(cancelOnly, 'preview.ETH-USD')).toBeUndefined(); // no preview for an untradable product
  });

  it('buildPreviewBody: min-size limit BUY + attached bracket, decimal strings, above quote_min_size', () => {
    const body = buildPreviewBody(toLiveProductSpec(ETH_PRODUCT), 2500);
    const limit = body.order_configuration.limit_limit_gtc!;
    const bracket = body.attached_order_configuration!.trigger_bracket_gtc!;
    expect(body.side).toBe('BUY');
    expect(body.product_id).toBe('ETH-USD');
    expect(limit.post_only).toBe(false);
    expect(limit.limit_price).toBe('2475.00'); // 1% below mark, quote_increment 0.01
    expect(typeof limit.base_size).toBe('string');
    expect(Number(limit.base_size)).toBeGreaterThanOrEqual(Number(ETH_PRODUCT.base_min_size));
    expect(Number(limit.base_size) * Number(limit.limit_price)).toBeGreaterThanOrEqual(Number(ETH_PRODUCT.quote_min_size));
    expect(bracket.base_size).toBeUndefined(); // attached configs must omit base_size
    expect(Number(bracket.limit_price)).toBeGreaterThan(Number(limit.limit_price));
    expect(Number(bracket.stop_trigger_price)).toBeLessThan(Number(limit.limit_price));
    expect(() => buildPreviewBody(toLiveProductSpec(ETH_PRODUCT), 0)).toThrow(/mark price/);
  });

  it('resolveLiveConfig yields fail-closed defaults when the yaml block is absent', () => {
    expect(resolveLiveConfig({})).toEqual({ account_refresh_sec: 60, min_quote_usd: 20, ev_gate_mode: 'enforce' });
    expect(resolveLiveConfig({ live: { account_refresh_sec: 30, min_quote_usd: 5, ev_gate_mode: 'shadow' } })).toEqual({
      account_refresh_sec: 30,
      min_quote_usd: 5,
      ev_gate_mode: 'shadow',
    });
  });
});
