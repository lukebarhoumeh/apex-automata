/**
 * Trading Engine Lifecycle Tests
 * 
 * Tests for idempotent start/stop, heartbeat, and kill switch behavior
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TradingEngine, TradingEngineConfig, EngineState } from '../trading/trading-engine';
import { Logger } from '../core/logger';

// Mock dependencies
vi.mock('../config/secrets');
vi.mock('../exchanges/coinbase');

// Mock logger
const mockLogger: Logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as any;

// Mock guardrails
const mockGuardrails = {
  account: {
    equity_usd: 10000,
    risk_per_trade: 0.01,
    max_account_leverage: 1,
    max_open_positions: 5,
    min_notional_buffer: 1.5,
  },
  risk: {
    max_position_exposure_pct: 0.2,
    daily_loss_limit: -0.02,
    weekly_loss_limit: -0.05,
    max_drawdown_limit: -0.1,
  },
  circuit_breakers: {
    data_gap_sec: 30,
    rapid_loss_trigger: -0.01,
  },
  execution: {
    order_timeout_sec: 5,
    order_type: 'market',
    price_offset_ticks: 0,
  },
  compliance: {
    flatten_on_shutdown: false,
  },
  strategy: {
    mode: ['breakout'],
    donchian_len: 20,
    atr_len_15m: 14,
    stop_init_atr: 1.5,
    allow_short: false,
  },
  filters: {
    time_filter_enabled: false,
    allowed_hours_utc: [],
    atr_volatility_min: 0,
    atr_volatility_max: 1,
    funding_bias_enabled: false,
  },
  ui: {
    alert_channels: [],
  },
};

// Mock config
const mockConfig: TradingEngineConfig = {
  mode: 'paper',
  exchange: {
    name: 'coinbase',
    environment: 'sandbox',
  },
  products: ['BTC-USD'],
  supabase: {
    url: 'https://test.supabase.co',
    serviceKey: 'test-key',
    anonKey: 'test-anon',
  },
  security: {
    encryptionKey: 'test-encryption-key',
  },
  guardrails: mockGuardrails as any,
};

describe('TradingEngine Lifecycle', () => {
  let engine: TradingEngine;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    
    engine = new TradingEngine(mockConfig, mockLogger);
  });

  afterEach(async () => {
    try {
      await engine.stop();
    } catch (e) {
      // Ignore stop errors in cleanup
    }
    vi.useRealTimers();
  });

  describe('Engine State', () => {
    it('should start in stopped state', () => {
      expect(engine.getEngineState()).toBe('stopped');
      expect(engine.engineRunning).toBe(false);
    });

    it('should track state changes', async () => {
      const stateChangedHandler = vi.fn();
      engine.on('engine:state_changed', stateChangedHandler);
      
      // State should change when we try to start (will fail due to mocks, but state changes first)
      try {
        await engine.start();
      } catch (e) {
        // Expected to fail due to mocked dependencies
      }
      
      // Should have emitted state_changed for 'starting'
      expect(stateChangedHandler).toHaveBeenCalledWith('starting', expect.any(String));
    });
  });

  describe('Idempotent Start', () => {
    it('should not start twice', async () => {
      // Manually set running state to simulate already running
      (engine as any).isRunning = true;
      (engine as any).engineState = 'running';
      
      await engine.start();
      
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Trading engine already running or starting',
        expect.any(Object)
      );
    });

    it('should not start while starting', async () => {
      // Set starting state
      (engine as any).engineState = 'starting';
      
      await engine.start();
      
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Trading engine already running or starting',
        expect.any(Object)
      );
    });
  });

  describe('Idempotent Stop', () => {
    it('should not stop if already stopped', async () => {
      await engine.stop();
      
      expect(mockLogger.warn).toHaveBeenCalledWith('Trading engine already stopped');
    });

    it('should not double-stop', async () => {
      // Set running then stopping state
      (engine as any).isRunning = true;
      (engine as any).engineState = 'stopping';
      
      await engine.stop();
      
      expect(mockLogger.warn).toHaveBeenCalledWith('Trading engine already stopping');
    });
  });

  describe('Heartbeat', () => {
    it('should emit heartbeat events', () => {
      const heartbeatHandler = vi.fn();
      engine.on('engine:heartbeat', heartbeatHandler);
      
      // Manually start heartbeat (normally done in start())
      (engine as any).startHeartbeat();
      
      // Initial heartbeat
      expect(heartbeatHandler).toHaveBeenCalledTimes(1);
      
      // Advance timer for next heartbeat
      vi.advanceTimersByTime(2000);
      expect(heartbeatHandler).toHaveBeenCalledTimes(2);
      
      // Stop heartbeat
      (engine as any).stopHeartbeat();
    });

    it('should track last heartbeat timestamp', () => {
      (engine as any).startHeartbeat();
      
      const lastHeartbeat = engine.getLastHeartbeatAt();
      expect(lastHeartbeat).toBeGreaterThan(0);
      
      (engine as any).stopHeartbeat();
    });
  });

  describe('Kill Switch Behavior', () => {
    it('should transition to halted state on kill switch', () => {
      const stateChangedHandler = vi.fn();
      engine.on('engine:state_changed', stateChangedHandler);
      
      // Simulate kill switch by calling setEngineState
      (engine as any).setEngineState('halted', 'kill_switch: daily_loss_limit');
      
      expect(engine.getEngineState()).toBe('halted');
      expect(stateChangedHandler).toHaveBeenCalledWith('halted', 'kill_switch: daily_loss_limit');
    });

    it('should not stop engine on kill switch', () => {
      // Set engine as running
      (engine as any).isRunning = true;
      (engine as any).engineState = 'running';
      
      // Simulate kill switch
      (engine as any).setEngineState('halted', 'kill_switch: test');
      
      // Engine should still be "running" (isRunning flag)
      // but state should be halted
      expect((engine as any).isRunning).toBe(true);
      expect(engine.getEngineState()).toBe('halted');
    });
  });

  describe('Fatal Error Handling', () => {
    it('should emit fatal event for supervisor', () => {
      const fatalHandler = vi.fn();
      engine.on('engine:fatal', fatalHandler);
      
      const testError = new Error('Test fatal error');
      engine.handleFatal(testError, 'test_context');
      
      expect(fatalHandler).toHaveBeenCalledWith(testError, 'test_context');
      expect(mockLogger.error).toHaveBeenCalledWith(
        'Fatal engine error',
        expect.objectContaining({
          context: 'test_context',
          error: 'Test fatal error',
        })
      );
    });

    it('should not emit fatal when kill switch is active', () => {
      // Mock risk engine with active kill switch
      const mockRiskEngine = {
        getMetrics: () => ({ killSwitchActive: true }),
      };
      (engine as any).riskEngine = mockRiskEngine;
      
      const fatalHandler = vi.fn();
      engine.on('engine:fatal', fatalHandler);
      
      engine.handleFatal(new Error('Test'), 'test');
      
      // Should not emit fatal event
      expect(fatalHandler).not.toHaveBeenCalled();
      expect(mockLogger.warn).toHaveBeenCalledWith('Kill switch active, not attempting recovery');
    });
  });

  describe('Health Info', () => {
    it('should return engine health info', () => {
      const health = engine.getHealthInfo();
      
      expect(health).toHaveProperty('engineState');
      expect(health).toHaveProperty('isRunning');
      expect(health).toHaveProperty('lastHeartbeatAt');
      expect(health).toHaveProperty('startCount');
      expect(health).toHaveProperty('stopCount');
      expect(health).toHaveProperty('activeSymbols');
    });

    it('should track start/stop counts', async () => {
      // Simulate a start (even if it fails)
      try {
        await engine.start('test');
      } catch (e) {
        // Expected
      }
      
      const health = engine.getHealthInfo();
      expect(health.startCount).toBe(1);
      expect(health.lastStartReason).toBe('test');
    });
  });

  describe('Exchange Access', () => {
    it('should provide exchange access for supervisor', () => {
      // Before initialization
      expect(engine.getExchange()).toBeNull();
      
      // After mock initialization
      (engine as any).exchange = { test: true };
      expect(engine.getExchange()).toEqual({ test: true });
    });
  });
});
