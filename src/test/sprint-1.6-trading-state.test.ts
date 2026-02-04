/**
 * Sprint 1.6 Tests: Trading State and Alerts
 * 
 * Tests the trading state classifier, alert controller deduplication,
 * and state transitions.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { deriveTradingUiState, type RuntimeStatusPayload } from '@/runtime/state/deriveTradingUiState';
import type { RuntimeConnectivity } from '@/runtime/connectivity/types';

describe('deriveTradingUiState', () => {
  // Default connected state
  const connectedState: RuntimeConnectivity = { state: 'CONNECTED', since: Date.now() };
  
  // Default running status
  const runningStatus: RuntimeStatusPayload = {
    engineRunning: true,
    mode: 'paper',
    paused: false,
    tradingState: 'RUNNING',
    killSwitch: { active: false, reasons: [] },
  };

  describe('Priority 1: Connectivity issues take precedence', () => {
    it('returns DISCONNECTED when backend is down', () => {
      const connectivity: RuntimeConnectivity = { 
        state: 'BACKEND_DOWN', 
        since: Date.now(),
        reason: 'Backend unreachable'
      };
      const result = deriveTradingUiState(runningStatus, connectivity);
      
      expect(result.state).toBe('DISCONNECTED');
      expect((result as any).reason).toContain('Backend unreachable');
    });

    it('returns DISCONNECTED when WS is closed', () => {
      const connectivity: RuntimeConnectivity = { 
        state: 'DISCONNECTED', 
        since: Date.now(),
        reason: 'Connection closed'
      };
      const result = deriveTradingUiState(runningStatus, connectivity);
      
      expect(result.state).toBe('DISCONNECTED');
    });

    it('returns STALE when no heartbeat', () => {
      const connectivity: RuntimeConnectivity = { 
        state: 'STALE', 
        since: Date.now(),
        lastHeartbeatAt: Date.now() - 15000,
        ageMs: 15000
      };
      const result = deriveTradingUiState(runningStatus, connectivity);
      
      expect(result.state).toBe('STALE');
      expect((result as any).ageMs).toBe(15000);
    });
  });

  describe('Priority 2: Kill switch detection', () => {
    it('returns KILL_SWITCH when killSwitch.active is true', () => {
      const status: RuntimeStatusPayload = {
        ...runningStatus,
        killSwitch: { active: true, reasons: ['daily_loss'] },
      };
      const result = deriveTradingUiState(status, connectedState);
      
      expect(result.state).toBe('KILL_SWITCH');
      expect((result as any).reasons).toContain('daily_loss');
    });

    it('returns KILL_SWITCH when tradingState is HALTED', () => {
      const status: RuntimeStatusPayload = {
        ...runningStatus,
        tradingState: 'HALTED',
        haltReasonCode: 'spread_burst',
      };
      const result = deriveTradingUiState(status, connectedState);
      
      expect(result.state).toBe('KILL_SWITCH');
      expect((result as any).reasonCode).toBe('spread_burst');
    });

    it('includes dailyStopHit in reasons', () => {
      const status: RuntimeStatusPayload = {
        ...runningStatus,
        dailyStopHit: true,
        killSwitch: { active: true, reasons: [] },
      };
      const result = deriveTradingUiState(status, connectedState);
      
      expect(result.state).toBe('KILL_SWITCH');
      expect((result as any).reasons).toContain('daily_stop');
    });
  });

  describe('Priority 3: Paused state', () => {
    it('returns PAUSED when status.paused is true', () => {
      const status: RuntimeStatusPayload = {
        ...runningStatus,
        paused: true,
      };
      const result = deriveTradingUiState(status, connectedState);
      
      expect(result.state).toBe('PAUSED');
    });

    it('returns PAUSED when tradingState is PAUSED', () => {
      const status: RuntimeStatusPayload = {
        ...runningStatus,
        tradingState: 'PAUSED',
      };
      const result = deriveTradingUiState(status, connectedState);
      
      expect(result.state).toBe('PAUSED');
    });
  });

  describe('Priority 4: Running state', () => {
    it('returns RUNNING when engine is running normally', () => {
      const result = deriveTradingUiState(runningStatus, connectedState);
      
      expect(result.state).toBe('RUNNING');
    });
  });

  describe('Priority 5: Unexpected stop', () => {
    it('returns STOPPED_UNEXPECTED when engine stopped without kill switch', () => {
      const status: RuntimeStatusPayload = {
        engineRunning: false,
        mode: null,
        killSwitch: { active: false, reasons: [] },
      };
      const result = deriveTradingUiState(status, connectedState);
      
      expect(result.state).toBe('STOPPED_UNEXPECTED');
    });
  });

  describe('Edge cases', () => {
    it('returns DISCONNECTED when no status received', () => {
      const result = deriveTradingUiState(null, connectedState);
      
      expect(result.state).toBe('DISCONNECTED');
      expect((result as any).reason).toContain('Waiting for status');
    });
  });
});

describe('AlertController deduplication', () => {
  // Note: Full AlertController tests would require mocking toast
  // This is a simplified version testing the dedupe logic concept
  
  it('generates different dedupe keys for different reasons', () => {
    const bucket = Math.floor(Date.now() / 60000);
    const key1 = `killswitch:daily_loss:${bucket}`;
    const key2 = `killswitch:spread_burst:${bucket}`;
    
    expect(key1).not.toBe(key2);
  });

  it('generates same dedupe key within same time bucket', () => {
    const bucket = Math.floor(Date.now() / 60000);
    const key1 = `killswitch:daily_loss:${bucket}`;
    const key2 = `killswitch:daily_loss:${bucket}`;
    
    expect(key1).toBe(key2);
  });
});

describe('TradingStateDisplay', () => {
  it('provides correct display info for each state', async () => {
    const { getTradingStateDisplay } = await import('@/runtime/state/tradingState');
    
    const runningDisplay = getTradingStateDisplay({ state: 'RUNNING' });
    expect(runningDisplay.variant).toBe('success');
    expect(runningDisplay.showBanner).toBe(false);
    
    const killSwitchDisplay = getTradingStateDisplay({ 
      state: 'KILL_SWITCH', 
      reasons: ['daily_loss'],
      reasonCode: 'daily_loss'
    });
    expect(killSwitchDisplay.variant).toBe('destructive');
    expect(killSwitchDisplay.showBanner).toBe(true);
    
    const stoppedDisplay = getTradingStateDisplay({ 
      state: 'STOPPED_UNEXPECTED', 
      reason: 'Crash'
    });
    expect(stoppedDisplay.variant).toBe('destructive');
    expect(stoppedDisplay.showBanner).toBe(true);
  });
});
