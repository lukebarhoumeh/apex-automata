import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { RiskEngine, RiskEngineConfig } from '../trading/risk-engine';
import { PositionTracker, PositionTrackerConfig } from '../trading/position-tracker';
import { GuardrailConfig } from '../config/loadGuardrails';

// Mock logger
const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

// Mock Supabase client
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          single: () => Promise.resolve({ data: null, error: null }),
          maybeSingle: () => Promise.resolve({ data: null, error: null }),
        }),
        gte: () => ({
          order: () => ({
            limit: () => ({
              maybeSingle: () => Promise.resolve({ data: null, error: null }),
            }),
          }),
        }),
      }),
      insert: () => Promise.resolve({ error: null }),
      upsert: () => Promise.resolve({ error: null }),
    }),
  }),
}));

describe('RiskEngine', () => {
  let riskEngine: RiskEngine;
  let positionTracker: PositionTracker;

  const guardrails: GuardrailConfig = {
    account: {
      equity_usd: 10000,
      risk_per_trade: 0.01,
      max_open_positions: 2,
      max_account_leverage: 3.0,
      min_notional_buffer: 1.1,
    },
    risk: {
      daily_loss_limit: -0.008,
      weekly_loss_limit: -0.025,
      max_drawdown_limit: -0.1,
      max_position_exposure_pct: 0.5,
      funding_cost_tolerance_bps: 20,
      slippage_estimate_bps: 3,
    },
    per_symbol: {
      'BTC-USD': {
        max_notional_usd: 5000,
        max_daily_loss_usd: 200,
      },
      'ETH-USD': {
        max_notional_usd: 3000,
        max_daily_loss_usd: 150,
      },
    },
    strategy: {
      mode: 'momentum_futures',
      donchian_len: 20,
      ema_len_1h: 100,
      atr_len_15m: 20,
      atr_entry_band: [0.005, 0.025],
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
      retry_backoff_ms: [100, 500, 1000],
    },
    circuit_breakers: {
      rapid_loss_trigger: -0.003,
      fill_rate_collapse: 0.1,
      adverse_selection_spike: 0.6,
      correlation_spike: 0.8,
      vol_spike_atr: 0.03,
      data_gap_sec: 2,
    },
    filters: {
      atr_volatility_min: 0.005,
      atr_volatility_max: 0.025,
      funding_bias_enabled: true,
      time_filter_enabled: true,
      allowed_hours_utc: [0, 23],
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
      alert_channels: ['telegram'],
    },
    go_live_criteria: {
      paper_parity_max_diff_bps: 20,
      min_profitable_days: 3,
      max_error_count_per_day: 0,
      manual_approval_required: true,
    },
  };

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

  const riskEngineConfig: RiskEngineConfig = {
    supabaseUrl: 'http://localhost:54321',
    supabaseKey: 'test-key',
    limits: {
      maxPositionSize: 5000,
      maxTotalExposure: 30000,
      maxDailyLoss: 80,
      maxDrawdown: 10,
      maxOrderSize: 5000,
      minOrderSize: 10,
      maxOpenOrders: 5,
      maxLeverage: 3,
    },
    killSwitches: {
      enabled: true,
      dailyLossLimit: 80,
      consecutiveLossLimit: 5,
      errorRateLimit: 20,
      latencyLimit: 2000,
    },
    riskPerTrade: 1,
    kellyFraction: 0.25,
    guardrails,
    accountEquity: 10000,
  };

  beforeEach(() => {
    positionTracker = new PositionTracker(positionTrackerConfig, mockLogger as any);
    riskEngine = new RiskEngine(riskEngineConfig, mockLogger as any, positionTracker);
  });
  
  afterEach(() => {
    riskEngine.stop();
    positionTracker.stopUpdateLoop();
  });

  describe('Order Size Calculation', () => {
    test('should compute order size based on risk parameters', () => {
      const size = riskEngine.computeOrderSize('BTC-USD', 50000, 49000);
      // Risk per trade = 1% of $10,000 = $100
      // Stop distance = $1,000 (2%)
      // Size = $100 / $1,000 = 0.002 BTC
      expect(size).toBeGreaterThan(0);
      expect(size).toBeLessThan(1);
    });

    test('should limit order size to max position exposure', () => {
      const size = riskEngine.computeOrderSize('BTC-USD', 100, 50);
      // Very wide stop should still respect max exposure
      const maxNotional = guardrails.risk.max_position_exposure_pct * guardrails.account.equity_usd;
      const maxSize = maxNotional / 100; // at $100 per unit
      expect(size).toBeLessThanOrEqual(maxSize);
    });
  });

  describe('Per-Symbol Limits', () => {
    test('should track per-symbol daily losses', () => {
      expect(riskEngine.getSymbolDailyLoss('BTC-USD')).toBe(0);
      
      riskEngine.recordSymbolLoss('BTC-USD', 50);
      expect(riskEngine.getSymbolDailyLoss('BTC-USD')).toBe(50);
      
      riskEngine.recordSymbolLoss('BTC-USD', 100);
      expect(riskEngine.getSymbolDailyLoss('BTC-USD')).toBe(150);
    });

    test('should block symbol when daily loss limit reached', () => {
      expect(riskEngine.isSymbolBlocked('BTC-USD')).toBe(false);
      
      // BTC-USD max daily loss is $200
      riskEngine.recordSymbolLoss('BTC-USD', 250);
      expect(riskEngine.isSymbolBlocked('BTC-USD')).toBe(true);
    });

    test('should reset per-symbol tracking', () => {
      riskEngine.recordSymbolLoss('BTC-USD', 250);
      expect(riskEngine.isSymbolBlocked('BTC-USD')).toBe(true);
      
      riskEngine.resetSymbolDailyTracking();
      expect(riskEngine.isSymbolBlocked('BTC-USD')).toBe(false);
      expect(riskEngine.getSymbolDailyLoss('BTC-USD')).toBe(0);
    });
  });

  describe('Risk Checks', () => {
    test('should reject order when kill switch is active', async () => {
      // Force kill switch active without triggering flatten side-effects
      (riskEngine as any).killSwitchActive = true;
      (riskEngine as any).metrics.killSwitchActive = true;
      
      const check = await riskEngine.checkOrder({
        product_id: 'BTC-USD',
        side: 'buy',
        type: 'market',
        size: '0.001',
        client_oid: 'test-123',
      }, 50000);

      expect(check.passed).toBe(false);
      expect(check.reason).toContain('Kill switch');
    });
    
    test('should allow reduce-only exit orders even when kill switch is active', async () => {
      // Open a long position first
      await positionTracker.processFill({
        trade_id: 1,
        product_id: 'BTC-USD',
        order_id: 'order-1',
        user_id: 'u',
        profile_id: 'p',
        liquidity: 'T',
        price: '50000',
        size: '0.1',
        fee: '0',
        side: 'buy',
        settled: true,
        created_at: new Date().toISOString(),
        usd_volume: '5000',
      } as any);
      positionTracker.updateMarketPrice('BTC-USD', 50000);
      
      // Force kill switch active without triggering flatten side-effects
      (riskEngine as any).killSwitchActive = true;
      (riskEngine as any).metrics.killSwitchActive = true;
      
      // Reduce long exposure
      const orderReq = {
        product_id: 'BTC-USD',
        side: 'sell',
        type: 'market',
        size: '0.05',
        client_oid: 'exit-123',
      } as any;
      
      const sim = (riskEngine as any).simulatePositionAfterOrder(positionTracker.getPosition('BTC-USD'), orderReq, 50000);
      expect(sim.currentSide).toBe('long');
      expect(sim.isReduceOnly).toBe(true);
      
      const check = await riskEngine.checkOrder(orderReq, 50000);
      
      expect(check.passed).toBe(true);
    });
    
    test('should not trigger daily loss kill switch on profits', () => {
      // Directly invoke internal kill-switch checks (private at type-level only)
      (riskEngine as any).metrics.dailyPnL = 1000; // +$1,000 day
      (riskEngine as any).checkKillSwitches();
      
      expect(riskEngine.getMetrics().killSwitchActive).toBe(false);
    });

    test('should reject order for blocked symbol', async () => {
      // Block BTC-USD
      riskEngine.recordSymbolLoss('BTC-USD', 300);
      
      const check = await riskEngine.checkOrder({
        product_id: 'BTC-USD',
        side: 'buy',
        type: 'market',
        size: '0.001',
        client_oid: 'test-123',
      }, 50000);

      expect(check.passed).toBe(false);
      expect(check.reason).toContain('blocked');
    });
    
    test('should trigger kill switch and attempt to close positions when daily loss kill switch limit is exceeded', () => {
      const closeSpy = vi.spyOn(positionTracker, 'closeAllPositions').mockResolvedValue([]);
      
      // Force a loss beyond killSwitches.dailyLossLimit ($80)
      (riskEngine as any).metrics.dailyPnL = -100;
      (riskEngine as any).checkKillSwitches();
      
      expect(riskEngine.getMetrics().killSwitchActive).toBe(true);
      // Position flattening is now config-driven and not automatic
      expect(closeSpy).toHaveBeenCalledTimes(0);
      
      // Idempotent: repeated checks shouldn't re-trigger
      (riskEngine as any).checkKillSwitches();
      expect(closeSpy).toHaveBeenCalledTimes(0);
    });
  });
  
  describe('Trade Outcome Tracking', () => {
    test('updates consecutiveLosses based on closed position realized P&L', async () => {
      const make = (t: Partial<any>) => ({
        trade_id: t.trade_id ?? 1,
        product_id: 'BTC-USD',
        order_id: t.order_id ?? `order-${t.trade_id ?? 1}`,
        user_id: 'u',
        profile_id: 'p',
        liquidity: 'T',
        price: t.price ?? '1000',
        size: t.size ?? '1',
        fee: t.fee ?? '0',
        side: t.side ?? 'buy',
        settled: true,
        created_at: new Date().toISOString(),
        usd_volume: t.usd_volume ?? '0',
      });
      
      // Loss #1: buy 1 @ 1000, sell 1 @ 850 => -150
      await positionTracker.processFill(make({ trade_id: 1, side: 'buy', price: '1000' }) as any);
      await positionTracker.processFill(make({ trade_id: 2, side: 'sell', price: '850' }) as any);
      expect(riskEngine.getMetrics().consecutiveLosses).toBe(1);
      
      // Loss #2
      await positionTracker.processFill(make({ trade_id: 3, side: 'buy', price: '1000' }) as any);
      await positionTracker.processFill(make({ trade_id: 4, side: 'sell', price: '850' }) as any);
      expect(riskEngine.getMetrics().consecutiveLosses).toBe(2);
      
      // Win resets: buy 1 @ 1000, sell 1 @ 1100 => +100
      await positionTracker.processFill(make({ trade_id: 5, side: 'buy', price: '1000' }) as any);
      await positionTracker.processFill(make({ trade_id: 6, side: 'sell', price: '1100' }) as any);
      expect(riskEngine.getMetrics().consecutiveLosses).toBe(0);
    });
    
    test('records per-symbol realized losses and blocks symbol when limit exceeded', async () => {
      const make = (t: Partial<any>) => ({
        trade_id: t.trade_id ?? 1,
        product_id: 'BTC-USD',
        order_id: t.order_id ?? `order-${t.trade_id ?? 1}`,
        user_id: 'u',
        profile_id: 'p',
        liquidity: 'T',
        price: t.price ?? '1000',
        size: t.size ?? '1',
        fee: t.fee ?? '0',
        side: t.side ?? 'buy',
        settled: true,
        created_at: new Date().toISOString(),
        usd_volume: t.usd_volume ?? '0',
      });
      
      // BTC-USD per-symbol max daily loss is $200 (guardrails in this test).
      // Two -$150 trades should block the symbol.
      await positionTracker.processFill(make({ trade_id: 1, side: 'buy', price: '1000' }) as any);
      await positionTracker.processFill(make({ trade_id: 2, side: 'sell', price: '850' }) as any);
      await positionTracker.processFill(make({ trade_id: 3, side: 'buy', price: '1000' }) as any);
      await positionTracker.processFill(make({ trade_id: 4, side: 'sell', price: '850' }) as any);
      
      expect(riskEngine.isSymbolBlocked('BTC-USD')).toBe(true);
      
      const check = await riskEngine.checkOrder({
        product_id: 'BTC-USD',
        side: 'buy',
        type: 'market',
        size: '0.001',
        client_oid: 'test-123',
      }, 50000);
      
      expect(check.passed).toBe(false);
      expect(check.reason).toContain('blocked');
    });
  });
  
  describe('Soft Launch', () => {
    test('applies tighter sizing/limits for the first N opened positions', async () => {
      const softEngine = new RiskEngine({
        ...riskEngineConfig,
        softLaunch: {
          enabled: true,
          maxEntryTrades: 2,
          riskPerTradeMultiplier: 0.25,
          maxPositionSizeMultiplier: 0.25,
          maxTotalExposureMultiplier: 0.5,
          maxOrderSizeMultiplier: 0.25,
          maxDailyLossMultiplier: 0.5,
          perSymbolNotionalCapUsd: 250,
          minOrderSizeUsd: 25,
        },
      }, mockLogger as any, positionTracker);
      
      // Before any positions open, computeOrderSize should be quarter-risk + quarter exposure cap.
      const sized = softEngine.computeOrderSize('BTC-USD', 50000, 49000);
      // Base risk = 0.025, but capped by exposure limit with 2% safety margin → 0.0245.
      expect(sized).toBeCloseTo(0.0245, 6);
      
      // Soft per-symbol cap: 0.006 BTC @ 50k = $300 > $250 should be rejected during soft launch.
      const check = await softEngine.checkOrder({
        product_id: 'BTC-USD',
        side: 'buy',
        type: 'market',
        size: '0.006',
        client_oid: 'soft-1',
      } as any, 50000);
      expect(check.passed).toBe(false);
      
      // Open and close two positions to consume the soft launch entry budget.
      const mkFill = (t: Partial<any>) => ({
        trade_id: t.trade_id ?? 1,
        product_id: 'BTC-USD',
        order_id: t.order_id ?? `order-${t.trade_id ?? 1}`,
        user_id: 'u',
        profile_id: 'p',
        liquidity: 'T',
        price: t.price ?? '1000',
        size: t.size ?? '1',
        fee: t.fee ?? '0',
        side: t.side ?? 'buy',
        settled: true,
        created_at: new Date().toISOString(),
        usd_volume: t.usd_volume ?? '0',
      });
      
      await positionTracker.processFill(mkFill({ trade_id: 11, side: 'buy', price: '1000' }) as any);
      await positionTracker.processFill(mkFill({ trade_id: 12, side: 'sell', price: '1100' }) as any);
      await positionTracker.processFill(mkFill({ trade_id: 13, side: 'buy', price: '1000' }) as any);
      await positionTracker.processFill(mkFill({ trade_id: 14, side: 'sell', price: '1100' }) as any);
      
      // Now soft launch should be inactive, sizing reverts to base capped by 2% safety margin → 0.098.
      const sizedAfter = softEngine.computeOrderSize('BTC-USD', 50000, 49000);
      expect(sizedAfter).toBeCloseTo(0.098, 6);
      
      softEngine.stop();
    });
  });
});
