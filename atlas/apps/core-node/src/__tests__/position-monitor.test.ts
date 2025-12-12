import { describe, test, expect, beforeEach, vi } from 'vitest';
import { PositionMonitor, PositionMonitorConfig, MonitoredPosition } from '../trading/position-monitor';
import { PositionTracker, PositionTrackerConfig, Position } from '../trading/position-tracker';
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
      }),
      insert: () => Promise.resolve({ error: null }),
      upsert: () => Promise.resolve({ error: null }),
    }),
  }),
}));

describe('PositionMonitor', () => {
  let positionMonitor: PositionMonitor;
  let positionTracker: PositionTracker;

  const guardrails: Partial<GuardrailConfig> = {
    strategy: {
      mode: 'momentum_futures',
      donchian_len: 20,
      ema_len_1h: 100,
      atr_len_15m: 20,
      atr_entry_band: [0.005, 0.025],
      stop_init_atr: 1.5,
      stop_trail_atr: 1.0,
      time_stop_bars: 10, // Low for testing
      allow_short: true,
      trade_cooldown_min: 15,
    },
  };

  const positionTrackerConfig: PositionTrackerConfig = {
    supabaseUrl: 'http://localhost:54321',
    supabaseKey: 'test-key',
    updateInterval: 5000,
    pnlCalculationMethod: 'fifo',
    maxPositionValueUsd: 5000,
    maxUnrealizedLossUsd: 500,
    drawdownWarningPct: 5,
    drawdownCriticalPct: 10,
  };

  const config: PositionMonitorConfig = {
    guardrails: guardrails as GuardrailConfig,
    checkIntervalMs: 100, // Fast for testing
  };

  beforeEach(() => {
    vi.clearAllMocks();
    positionTracker = new PositionTracker(positionTrackerConfig, mockLogger as any);
    positionMonitor = new PositionMonitor(config, mockLogger as any, positionTracker);
  });

  afterEach(() => {
    positionMonitor.stop();
    positionTracker.stopUpdateLoop();
  });

  describe('Position Registration', () => {
    test('should register position for monitoring', () => {
      const position: Position = {
        id: 'pos-1',
        symbol: 'BTC-USD',
        side: 'long',
        size: 0.1,
        averagePrice: 50000,
        marketPrice: 50000,
        unrealizedPnL: 0,
        realizedPnL: 0,
        totalPnL: 0,
        openTime: new Date(),
        lastUpdateTime: new Date(),
        trades: [],
        maxSize: 0.1,
        maxDrawdown: 0,
      };

      positionMonitor.registerPosition(position, 49000, 52000);
      
      const monitored = positionMonitor.getMonitoredPositions();
      expect(monitored).toHaveLength(1);
      expect(monitored[0].symbol).toBe('BTC-USD');
      expect(monitored[0].stopLoss).toBe(49000);
      expect(monitored[0].takeProfit).toBe(52000);
    });

    test('should not register flat positions', () => {
      const position: Position = {
        id: 'pos-1',
        symbol: 'BTC-USD',
        side: 'flat',
        size: 0,
        averagePrice: 0,
        marketPrice: 50000,
        unrealizedPnL: 0,
        realizedPnL: 0,
        totalPnL: 0,
        openTime: new Date(),
        lastUpdateTime: new Date(),
        trades: [],
        maxSize: 0,
        maxDrawdown: 0,
      };

      positionMonitor.registerPosition(position, 49000, 52000);
      
      const monitored = positionMonitor.getMonitoredPositions();
      expect(monitored).toHaveLength(0);
    });
  });

  describe('Stop Loss Detection', () => {
    test('should detect stop loss trigger for long position', async () => {
      const exitEvents: any[] = [];
      positionMonitor.on('exit:triggered', (cond) => exitEvents.push(cond));

      const position: Position = {
        id: 'pos-1',
        symbol: 'BTC-USD',
        side: 'long',
        size: 0.1,
        averagePrice: 50000,
        marketPrice: 50000,
        unrealizedPnL: 0,
        realizedPnL: 0,
        totalPnL: 0,
        openTime: new Date(),
        lastUpdateTime: new Date(),
        trades: [],
        maxSize: 0.1,
        maxDrawdown: 0,
      };

      // Mock getPosition to return our position
      vi.spyOn(positionTracker, 'getPosition').mockReturnValue(position);

      positionMonitor.registerPosition(position, 49000, 52000);
      positionMonitor.start();

      // Update price below stop loss
      positionMonitor.updatePrice('BTC-USD', 48500);

      // Wait for check interval
      await new Promise(r => setTimeout(r, 150));

      expect(exitEvents.length).toBeGreaterThan(0);
      expect(exitEvents[0].type).toBe('stop_loss');
    });

    test('should detect stop loss trigger for short position', async () => {
      const exitEvents: any[] = [];
      positionMonitor.on('exit:triggered', (cond) => exitEvents.push(cond));

      const position: Position = {
        id: 'pos-2',
        symbol: 'ETH-USD',
        side: 'short',
        size: 1,
        averagePrice: 3000,
        marketPrice: 3000,
        unrealizedPnL: 0,
        realizedPnL: 0,
        totalPnL: 0,
        openTime: new Date(),
        lastUpdateTime: new Date(),
        trades: [],
        maxSize: 1,
        maxDrawdown: 0,
      };

      vi.spyOn(positionTracker, 'getPosition').mockReturnValue(position);

      // For short, stop loss is above entry
      positionMonitor.registerPosition(position, 3100, 2800);
      positionMonitor.start();

      // Price goes above stop loss
      positionMonitor.updatePrice('ETH-USD', 3150);

      await new Promise(r => setTimeout(r, 150));

      expect(exitEvents.length).toBeGreaterThan(0);
      expect(exitEvents[0].type).toBe('stop_loss');
    });
  });

  describe('Take Profit Detection', () => {
    test('should detect take profit for long position', async () => {
      const exitEvents: any[] = [];
      positionMonitor.on('exit:triggered', (cond) => exitEvents.push(cond));

      const position: Position = {
        id: 'pos-3',
        symbol: 'BTC-USD',
        side: 'long',
        size: 0.1,
        averagePrice: 50000,
        marketPrice: 50000,
        unrealizedPnL: 0,
        realizedPnL: 0,
        totalPnL: 0,
        openTime: new Date(),
        lastUpdateTime: new Date(),
        trades: [],
        maxSize: 0.1,
        maxDrawdown: 0,
      };

      vi.spyOn(positionTracker, 'getPosition').mockReturnValue(position);

      positionMonitor.registerPosition(position, 49000, 52000);
      positionMonitor.start();

      // Update price above take profit
      positionMonitor.updatePrice('BTC-USD', 52500);

      await new Promise(r => setTimeout(r, 150));

      expect(exitEvents.length).toBeGreaterThan(0);
      expect(exitEvents[0].type).toBe('take_profit');
    });
  });

  describe('Time Stop Detection', () => {
    test('should detect time stop when bars exceed limit', async () => {
      const exitEvents: any[] = [];
      positionMonitor.on('exit:triggered', (cond) => exitEvents.push(cond));

      const position: Position = {
        id: 'pos-4',
        symbol: 'BTC-USD',
        side: 'long',
        size: 0.1,
        averagePrice: 50000,
        marketPrice: 50500,
        unrealizedPnL: 50,
        realizedPnL: 0,
        totalPnL: 50,
        openTime: new Date(),
        lastUpdateTime: new Date(),
        trades: [],
        maxSize: 0.1,
        maxDrawdown: 0,
      };

      vi.spyOn(positionTracker, 'getPosition').mockReturnValue(position);

      positionMonitor.registerPosition(position, 49000, 55000);
      positionMonitor.start();

      // Update price within stop/target range
      positionMonitor.updatePrice('BTC-USD', 50500);

      // Simulate 15 bars (exceeds time_stop_bars of 10)
      for (let i = 0; i < 15; i++) {
        positionMonitor.incrementBarCount('BTC-USD');
      }

      await new Promise(r => setTimeout(r, 150));

      expect(exitEvents.length).toBeGreaterThan(0);
      expect(exitEvents[0].type).toBe('time_stop');
    });
  });
});
