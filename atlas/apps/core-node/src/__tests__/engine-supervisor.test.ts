/**
 * Engine Supervisor Tests
 * 
 * Tests for 24/7 resilience: watchdog, recovery, and state management
 */

import { vi, describe, it, expect, beforeEach, afterEach, type Mock } from 'vitest';
import { EngineSupervisor, DEFAULT_SUPERVISOR_CONFIG, RestartReason } from '../runtime/engine-supervisor';
import { Logger } from '../core/logger';

// Mock logger
const mockLogger: Logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as any;

describe('EngineSupervisor', () => {
  let supervisor: EngineSupervisor;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    
    supervisor = new EngineSupervisor({
      engineHeartbeatStaleMs: 5000,
      marketDataStaleMs: 3000,
      statusHeartbeatMs: 1000,
      restartCooldownMs: 2000,
      tickIntervalMs: 1000,
      maxConsecutiveRestarts: 3,
      restartWindowMs: 60000,
    }, mockLogger);
  });

  afterEach(() => {
    supervisor.stop();
    vi.useRealTimers();
  });

  describe('Initialization', () => {
    it('should initialize with default state', () => {
      const state = supervisor.getState();
      
      expect(state.runtimeAlive).toBe(true);
      expect(state.engineState).toBe('stopped');
      expect(state.engineDesiredState).toBe('stopped');
      expect(state.killSwitch.active).toBe(false);
      expect(state.restartCount).toBe(0);
    });

    it('should start and stop watchdog', () => {
      supervisor.start();
      expect(mockLogger.info).toHaveBeenCalledWith('Starting EngineSupervisor watchdog');
      
      supervisor.stop();
      expect(mockLogger.info).toHaveBeenCalledWith('EngineSupervisor stopped');
    });
  });

  describe('Heartbeat Tracking', () => {
    it('should record engine heartbeat', () => {
      const before = supervisor.getState().lastEngineHeartbeatAt;
      
      vi.advanceTimersByTime(1000);
      supervisor.recordEngineHeartbeat();
      
      const after = supervisor.getState().lastEngineHeartbeatAt;
      expect(after).toBeGreaterThan(before);
    });

    it('should record market data', () => {
      const before = supervisor.getState().lastMarketDataAt;
      
      vi.advanceTimersByTime(1000);
      supervisor.recordMarketData();
      
      const after = supervisor.getState().lastMarketDataAt;
      expect(after).toBeGreaterThan(before);
    });
  });

  describe('State Management', () => {
    it('should update desired state', () => {
      supervisor.setDesiredState('running', 'paper');
      
      const state = supervisor.getState();
      expect(state.engineDesiredState).toBe('running');
      expect(state.tradingMode).toBe('paper');
    });

    it('should update actual state and emit event', () => {
      const stateChangedHandler = vi.fn();
      supervisor.on('supervisor:state_changed', stateChangedHandler);
      
      supervisor.setActualState('running', 'test_reason');
      
      expect(stateChangedHandler).toHaveBeenCalledWith('stopped', 'running', 'test_reason');
      expect(supervisor.getState().engineState).toBe('running');
    });
  });

  describe('Kill Switch', () => {
    it('should activate kill switch', () => {
      const killSwitchHandler = vi.fn();
      supervisor.on('supervisor:killswitch_activated', killSwitchHandler);
      
      supervisor.activateKillSwitch(['test_reason']);
      
      const state = supervisor.getState();
      expect(state.killSwitch.active).toBe(true);
      expect(state.killSwitch.reasons).toContain('test_reason');
      expect(state.killSwitch.since).toBeDefined();
      expect(state.engineState).toBe('halted');
      expect(killSwitchHandler).toHaveBeenCalledWith(['test_reason']);
    });

    it('should accumulate kill switch reasons', () => {
      supervisor.activateKillSwitch(['reason1']);
      supervisor.activateKillSwitch(['reason2']);
      
      const state = supervisor.getState();
      expect(state.killSwitch.reasons).toContain('reason1');
      expect(state.killSwitch.reasons).toContain('reason2');
    });

    it('should deactivate kill switch', () => {
      const deactivatedHandler = vi.fn();
      supervisor.on('supervisor:killswitch_deactivated', deactivatedHandler);
      
      supervisor.setDesiredState('running');
      supervisor.activateKillSwitch(['test']);
      expect(supervisor.isKillSwitchActive()).toBe(true);
      
      supervisor.deactivateKillSwitch();
      
      expect(supervisor.isKillSwitchActive()).toBe(false);
      expect(supervisor.getState().engineState).toBe('running');
      expect(deactivatedHandler).toHaveBeenCalled();
    });
  });

  describe('Watchdog Recovery', () => {
    let restartCallback: Mock;
    let reconnectCallback: Mock;

    beforeEach(() => {
      restartCallback = vi.fn().mockResolvedValue(true);
      reconnectCallback = vi.fn().mockResolvedValue(true);
      
      supervisor.setRestartEngineCallback(restartCallback);
      supervisor.setReconnectExchangeCallback(reconnectCallback);
      supervisor.start();
      supervisor.setDesiredState('running');
    });

    it('should trigger restart on stale engine heartbeat', async () => {
      supervisor.setActualState('running');
      
      // Don't record heartbeat, let it go stale
      await vi.advanceTimersByTimeAsync(6000); // > engineHeartbeatStaleMs
      
      expect(restartCallback).toHaveBeenCalledWith('engine_heartbeat_stale');
    });

    it('should trigger exchange reconnect on stale market data', async () => {
      supervisor.setActualState('running');
      
      // Record heartbeat but not market data
      supervisor.recordEngineHeartbeat();
      
      await vi.advanceTimersByTimeAsync(4000); // > marketDataStaleMs
      
      expect(reconnectCallback).toHaveBeenCalled();
    });

    it('should respect restart cooldown', async () => {
      supervisor.setActualState('running');
      
      // Trigger first restart
      await vi.advanceTimersByTimeAsync(6000);
      
      expect(restartCallback).toHaveBeenCalledTimes(1);
      
      // Force heartbeat stale (bypass the reset that happens after successful restart)
      // so the next tick detects stale within the cooldown window
      (supervisor as any).lastEngineHeartbeatAt = 0;
      
      // Advance 1s — heartbeat is stale but within cooldown (2000ms)
      await vi.advanceTimersByTimeAsync(1000);
      
      // Should be blocked by cooldown
      expect(restartCallback).toHaveBeenCalledTimes(1);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Restart blocked by cooldown',
        expect.any(Object)
      );
    });

    it('should not restart when kill switch is active', async () => {
      supervisor.setActualState('running');
      supervisor.activateKillSwitch(['test']);
      
      // Let heartbeat go stale
      await vi.advanceTimersByTimeAsync(6000);
      
      // Should not have tried to restart
      expect(restartCallback).not.toHaveBeenCalled();
    });

    it('should limit consecutive restarts', async () => {
      supervisor.setActualState('running');
      
      // Trigger 4 restart cycles: 3 succeed, 4th is blocked by maxConsecutiveRestarts
      for (let i = 0; i < 4; i++) {
        await vi.advanceTimersByTimeAsync(6000); // > stale threshold (5000) and > cooldown (2000)
      }
      
      // Only 3 restarts should have succeeded (maxConsecutiveRestarts = 3)
      expect(restartCallback).toHaveBeenCalledTimes(3);
      
      // After max restarts, should log error
      expect(mockLogger.error).toHaveBeenCalledWith(
        'Max consecutive restarts reached',
        expect.any(Object)
      );
    });
  });

  describe('Restart Tracking', () => {
    it('should track restart count', async () => {
      const restartCallback = vi.fn().mockResolvedValue(true);
      supervisor.setRestartEngineCallback(restartCallback);
      supervisor.start();
      supervisor.setDesiredState('running');
      supervisor.setActualState('running');
      
      // Trigger restart
      await vi.advanceTimersByTimeAsync(6000);
      
      const state = supervisor.getState();
      expect(state.restartCount).toBe(1);
      expect(state.lastRestartReason).toBe('engine_heartbeat_stale');
      expect(state.lastRestartAt).toBeDefined();
    });

    it('should reset restart tracking', () => {
      supervisor.resetRestartTracking();
      
      expect(mockLogger.info).toHaveBeenCalledWith('Supervisor restart tracking reset');
    });
  });

  describe('Status Heartbeat', () => {
    it('should emit status heartbeat on interval', () => {
      const heartbeatHandler = vi.fn();
      supervisor.on('supervisor:status_heartbeat', heartbeatHandler);
      
      supervisor.start();
      
      // Initial heartbeat
      expect(heartbeatHandler).toHaveBeenCalledTimes(1);
      
      // After interval
      vi.advanceTimersByTime(1000);
      expect(heartbeatHandler).toHaveBeenCalledTimes(2);
      
      vi.advanceTimersByTime(1000);
      expect(heartbeatHandler).toHaveBeenCalledTimes(3);
    });
  });
});
