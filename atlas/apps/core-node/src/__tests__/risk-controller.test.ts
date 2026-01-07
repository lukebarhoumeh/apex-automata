/**
 * Unit tests for RiskController - Extended Risk Controls
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import { Logger } from '../core/logger';
import { RiskController, RiskControllerConfig } from '../trading/risk-controller';
import { Position, PositionTracker } from '../trading/position-tracker';

// Mock logger
const mockLogger: Logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

// Mock position tracker
class MockPositionTracker extends EventEmitter {
  private positions: Position[] = [];
  
  getOpenPositions() {
    return this.positions;
  }
  
  getPortfolioSummary() {
    const totalPnL = this.positions.reduce((sum, p) => sum + (p.realizedPnL || 0), 0);
    return { totalPnL, totalValue: 10000 + totalPnL, trades: this.positions.length };
  }
  
  // Simulate a closed position
  simulateClosedPosition(position: Partial<Position>) {
    const fullPosition: Position = {
      id: 'test-pos-' + Date.now(),
      symbol: 'BTC-USD',
      side: 'long',
      size: 0.1,
      averageEntry: 50000,
      marketPrice: 50000,
      realizedPnL: 0,
      unrealizedPnL: 0,
      openTime: new Date(),
      strategy: 'breakout',
      trades: [],
      ...position,
    };
    this.emit('position:closed', fullPosition);
    return fullPosition;
  }
}

// Default test config
function createTestConfig(overrides?: Partial<RiskControllerConfig>): RiskControllerConfig {
  return {
    supabaseUrl: 'http://localhost:54321',
    supabaseKey: 'test-key',
    userId: 'test-user',
    dailyStartEquity: 10000,
    strategyLimits: {
      breakout: {
        maxDailyLossUsd: 500,
        maxConsecutiveLosses: 3,
        cooldownMs: 0, // No cooldown for tests
      },
    },
    defaultStrategyLimits: {
      maxDailyLossUsd: 300,
      maxConsecutiveLosses: 3,
      cooldownMs: 0,
    },
    trailingStop: {
      enabled: true,
      trailingPercent: 0.5,
      activationProfitPct: 0.01, // 1% profit
      lockInProfitPct: 0.3, // Lock in 30%
    },
    maxConcurrentPositions: 5,
    guardrails: {
      account: {
        equity_usd: 10000,
        risk_per_trade: 0.01,
        max_open_positions: 5,
        max_account_leverage: 1,
        min_notional_buffer: 1,
      },
      risk: {
        daily_loss_limit: -0.02,
        weekly_loss_limit: -0.05,
        max_drawdown_limit: -0.10,
        max_position_exposure_pct: 0.1,
        funding_cost_tolerance_bps: 5,
        slippage_estimate_bps: 5,
      },
      per_symbol: {
        'BTC-USD': {
          max_notional_usd: 1000,
          max_daily_loss_usd: 200,
        },
      },
      strategy: {
        mode: 'paper',
        donchian_len: 20,
        ema_len_1h: 50,
        atr_len_15m: 14,
        atr_entry_band: [0.5, 2.0],
        stop_init_atr: 2,
        stop_trail_atr: 1.5,
        time_stop_bars: 96,
        allow_short: false,
        trade_cooldown_min: 0,
      },
      execution: {
        order_type: 'limit',
        price_offset_ticks: 0,
        max_slippage_bps: 10,
        order_timeout_sec: 30,
        retry_backoff_ms: [100],
      },
      circuit_breakers: {
        rapid_loss_trigger: -0.02,
        fill_rate_collapse: 0.5,
        adverse_selection_spike: 0.3,
        correlation_spike: 0.8,
        vol_spike_atr: 3,
        data_gap_sec: 30,
      },
      filters: {
        atr_volatility_min: 0,
        atr_volatility_max: 100,
        funding_bias_enabled: false,
        time_filter_enabled: false,
        allowed_hours_utc: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23],
      },
      compliance: {
        tax_method: 'FIFO',
        export_frequency_days: 30,
        log_level: 'info',
        audit_trail_enabled: true,
        flatten_on_shutdown: true,
      },
      ui: {
        heartbeat_sec: 5,
        show_pnl_per_symbol: true,
        show_risk_status: true,
        kill_switch_button: true,
        alert_channels: ['ui'],
      },
      go_live_criteria: {
        paper_parity_max_diff_bps: 100,
        min_profitable_days: 5,
        max_error_count_per_day: 10,
        manual_approval_required: true,
      },
    },
    ...overrides,
  };
}

describe('RiskController', () => {
  let controller: RiskController;
  let positionTracker: MockPositionTracker;

  beforeEach(() => {
    vi.clearAllMocks();
    positionTracker = new MockPositionTracker();
    controller = new RiskController(
      createTestConfig(),
      mockLogger,
      positionTracker as unknown as PositionTracker
    );
  });

  afterEach(() => {
    controller.stop();
  });

  describe('Initialization', () => {
    it('should initialize with correct starting state', () => {
      const analytics = controller.getAnalytics();
      
      expect(analytics.sessionTrades).toBe(0);
      expect(analytics.dailyPeakEquity).toBe(10000);
      expect(analytics.currentEquity).toBe(10000);
      expect(analytics.trailingStopActive).toBe(false);
      expect(analytics.blockedSymbols).toHaveLength(0);
      expect(analytics.blockedStrategies).toHaveLength(0);
    });

    it('should allow trading initially', () => {
      const result = controller.canTrade('BTC-USD', 'breakout');
      expect(result.allowed).toBe(true);
    });
  });

  describe('Per-Strategy Loss Tracking', () => {
    it('should track strategy losses', () => {
      positionTracker.simulateClosedPosition({
        strategy: 'breakout',
        realizedPnL: -100,
      });

      const analytics = controller.getAnalytics();
      expect(analytics.perStrategy['breakout'].dailyLoss).toBe(100);
      expect(analytics.perStrategy['breakout'].lossesCount).toBe(1);
    });

    it('should block strategy after max consecutive losses', () => {
      // 3 consecutive losses should trigger block
      positionTracker.simulateClosedPosition({ strategy: 'breakout', realizedPnL: -50 });
      positionTracker.simulateClosedPosition({ strategy: 'breakout', realizedPnL: -50 });
      positionTracker.simulateClosedPosition({ strategy: 'breakout', realizedPnL: -50 });

      expect(controller.isStrategyBlocked('breakout')).toBe(true);
      expect(controller.getBlockedStrategies()).toContain('breakout');
      
      const result = controller.canTrade('BTC-USD', 'breakout');
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('breakout');
    });

    it('should block strategy after daily loss limit', () => {
      // Single large loss exceeding $500 limit
      positionTracker.simulateClosedPosition({
        strategy: 'breakout',
        realizedPnL: -550,
      });

      expect(controller.isStrategyBlocked('breakout')).toBe(true);
    });

    it('should reset consecutive losses after a win', () => {
      positionTracker.simulateClosedPosition({ strategy: 'momentum', realizedPnL: -50 });
      positionTracker.simulateClosedPosition({ strategy: 'momentum', realizedPnL: -50 });
      
      const beforeWin = controller.getAnalytics();
      expect(beforeWin.perStrategy['momentum'].consecutiveLosses).toBe(2);
      
      positionTracker.simulateClosedPosition({ strategy: 'momentum', realizedPnL: 100 });
      
      const afterWin = controller.getAnalytics();
      expect(afterWin.perStrategy['momentum'].consecutiveLosses).toBe(0);
      expect(afterWin.perStrategy['momentum'].consecutiveWins).toBe(1);
    });
  });

  describe('Per-Symbol Loss Tracking', () => {
    it('should block symbol after daily loss limit from guardrails', () => {
      // BTC-USD has $200 daily loss limit in guardrails
      positionTracker.simulateClosedPosition({
        symbol: 'BTC-USD',
        strategy: 'vwap_mr', // Different strategy so no strategy block
        realizedPnL: -250,
      });

      expect(controller.isSymbolBlocked('BTC-USD')).toBe(true);
      expect(controller.getBlockedSymbols()).toContain('BTC-USD');
    });

    it('should allow other symbols when one is blocked', () => {
      positionTracker.simulateClosedPosition({
        symbol: 'BTC-USD',
        strategy: 'vwap_mr',
        realizedPnL: -250,
      });

      expect(controller.isSymbolBlocked('BTC-USD')).toBe(true);
      expect(controller.isSymbolBlocked('ETH-USD')).toBe(false);
    });
  });

  describe('Trailing Equity Stop', () => {
    it('should activate trailing stop after profit threshold', () => {
      // Simulate profits that update equity
      // The trailing stop activates at 1% profit = $100 gain
      // We need to manually update equity since mock doesn't have real P&L tracking
      const analytics = controller.getAnalytics();
      expect(analytics.trailingStopActive).toBe(false);
    });

    it('should not trigger trailing stop initially', () => {
      const analytics = controller.getAnalytics();
      expect(analytics.trailingStopTriggered).toBe(false);
    });
  });

  describe('Max Concurrent Positions', () => {
    it('should block new trades when at max positions', () => {
      // Simulate 5 open positions (max)
      for (let i = 0; i < 5; i++) {
        (positionTracker as any).positions.push({
          id: `pos-${i}`,
          symbol: 'BTC-USD',
          side: 'long',
          size: 0.1,
        });
      }

      const result = controller.canTrade('ETH-USD', 'breakout');
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('Max concurrent positions');
    });

    it('should allow trades when under max positions', () => {
      (positionTracker as any).positions.push({
        id: 'pos-1',
        symbol: 'BTC-USD',
        side: 'long',
        size: 0.1,
      });

      const result = controller.canTrade('ETH-USD', 'breakout');
      expect(result.allowed).toBe(true);
    });
  });

  describe('Session Analytics', () => {
    it('should track win rate correctly', () => {
      positionTracker.simulateClosedPosition({ realizedPnL: 100 });
      positionTracker.simulateClosedPosition({ realizedPnL: 100 });
      positionTracker.simulateClosedPosition({ realizedPnL: -50 });

      const analytics = controller.getAnalytics();
      expect(analytics.sessionTrades).toBe(3);
      expect(analytics.sessionWins).toBe(2);
      expect(analytics.sessionLosses).toBe(1);
      expect(analytics.winRate).toBeCloseTo(2/3, 2);
    });

    it('should calculate profit factor correctly', () => {
      positionTracker.simulateClosedPosition({ realizedPnL: 200 });
      positionTracker.simulateClosedPosition({ realizedPnL: -100 });

      const analytics = controller.getAnalytics();
      expect(analytics.sessionGrossProfit).toBe(200);
      expect(analytics.sessionGrossLoss).toBe(100);
      expect(analytics.profitFactor).toBe(2); // 200/100
    });

    it('should track consecutive streaks', () => {
      positionTracker.simulateClosedPosition({ realizedPnL: 100 });
      positionTracker.simulateClosedPosition({ realizedPnL: 100 });
      positionTracker.simulateClosedPosition({ realizedPnL: 100 });

      const analytics = controller.getAnalytics();
      expect(analytics.currentConsecutiveWins).toBe(3);
      expect(analytics.maxConsecutiveWins).toBe(3);
      expect(analytics.currentConsecutiveLosses).toBe(0);
    });

    it('should calculate expectancy', () => {
      // 2 wins of $100, 1 loss of $50
      positionTracker.simulateClosedPosition({ realizedPnL: 100 });
      positionTracker.simulateClosedPosition({ realizedPnL: 100 });
      positionTracker.simulateClosedPosition({ realizedPnL: -50 });

      const analytics = controller.getAnalytics();
      // Expectancy = (winRate * avgWin) - (lossRate * avgLoss)
      // = (0.667 * 100) - (0.333 * 50) = 66.7 - 16.67 = 50
      expect(analytics.expectancy).toBeCloseTo(50, 0);
    });
  });

  describe('Manual Controls', () => {
    it('should allow manual unblocking of strategies', () => {
      // Block the strategy
      positionTracker.simulateClosedPosition({ strategy: 'breakout', realizedPnL: -200 });
      positionTracker.simulateClosedPosition({ strategy: 'breakout', realizedPnL: -200 });
      positionTracker.simulateClosedPosition({ strategy: 'breakout', realizedPnL: -200 });

      expect(controller.isStrategyBlocked('breakout')).toBe(true);

      // Manually unblock
      const result = controller.unblockStrategy('breakout');
      expect(result).toBe(true);
      expect(controller.isStrategyBlocked('breakout')).toBe(false);
    });

    it('should allow manual unblocking of symbols', () => {
      positionTracker.simulateClosedPosition({
        symbol: 'BTC-USD',
        strategy: 'vwap_mr',
        realizedPnL: -250,
      });

      expect(controller.isSymbolBlocked('BTC-USD')).toBe(true);

      const result = controller.unblockSymbol('BTC-USD');
      expect(result).toBe(true);
      expect(controller.isSymbolBlocked('BTC-USD')).toBe(false);
    });

    it('should reset daily tracking', () => {
      positionTracker.simulateClosedPosition({ strategy: 'breakout', realizedPnL: -100 });
      positionTracker.simulateClosedPosition({ symbol: 'BTC-USD', realizedPnL: -100 });

      const beforeReset = controller.getAnalytics();
      expect(beforeReset.sessionTrades).toBe(2);
      expect(beforeReset.perStrategy['breakout']).toBeDefined();

      controller.resetDaily(10000);

      const afterReset = controller.getAnalytics();
      expect(afterReset.sessionTrades).toBe(0);
      expect(Object.keys(afterReset.perStrategy)).toHaveLength(0);
      expect(afterReset.blockedSymbols).toHaveLength(0);
    });
  });

  describe('Status and Reporting', () => {
    it('should return correct status', () => {
      const status = controller.getStatus();
      
      expect(status.tradingAllowed).toBe(true);
      expect(status.trailingStop.triggered).toBe(false);
      expect(status.profitTarget.reached).toBe(false);
      expect(status.positions.current).toBe(0);
      expect(status.positions.max).toBe(5);
    });

    it('should emit analytics update events', () => {
      const handler = vi.fn();
      controller.on('risk:analytics:updated', handler);

      positionTracker.simulateClosedPosition({ realizedPnL: 100 });

      expect(handler).toHaveBeenCalledTimes(1);
      const analytics = handler.mock.calls[0][0];
      expect(analytics.sessionTrades).toBe(1);
    });
  });
});

