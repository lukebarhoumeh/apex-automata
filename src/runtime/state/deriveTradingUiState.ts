/**
 * Derive Trading UI State
 * 
 * Sprint 1.6: Pure function to classify trading state from runtime status + connectivity.
 * This prevents conflicting indicators (e.g., "connected" but engine stopped).
 */

import type { RuntimeConnectivity } from '@/runtime/connectivity/types';
import type { TradingUiState } from './tradingState';

// ============ Status Payload Shape ============

export interface RuntimeStatusPayload {
  engineRunning: boolean;
  mode: 'paper' | 'live' | null;
  paused?: boolean;
  tradingState?: 'RUNNING' | 'PAUSED' | 'HALTED';
  haltReasonCode?: string;
  dailyStopHit?: boolean;
  killSwitch?: {
    active: boolean;
    reasons: string[];
  };
}

// ============ State Derivation Function ============

/**
 * Derive the canonical TradingUiState from runtime status and connectivity.
 * Priority order ensures correct classification:
 * 1. Connectivity issues (BACKEND_DOWN, DISCONNECTED, STALE)
 * 2. Kill switch / HALTED
 * 3. Paused
 * 4. Running
 * 5. Unexpected stop
 */
export function deriveTradingUiState(
  status: RuntimeStatusPayload | null,
  connectivity: RuntimeConnectivity
): TradingUiState {
  // Priority 1: Backend unreachable
  if (connectivity.state === 'BACKEND_DOWN') {
    return {
      state: 'DISCONNECTED',
      reason: connectivity.reason || 'Backend unreachable',
    };
  }

  // Priority 2: WebSocket disconnected
  if (connectivity.state === 'DISCONNECTED') {
    return {
      state: 'DISCONNECTED',
      reason: connectivity.reason || 'Connection closed',
    };
  }

  // Priority 3: Stale (no heartbeat)
  if (connectivity.state === 'STALE') {
    return {
      state: 'STALE',
      ageMs: connectivity.ageMs,
    };
  }

  // No status received yet but connected
  if (!status) {
    return {
      state: 'DISCONNECTED',
      reason: 'Waiting for status...',
    };
  }

  // Priority 4: Kill switch active OR tradingState === HALTED
  if (status.killSwitch?.active || status.tradingState === 'HALTED') {
    const reasons = status.killSwitch?.reasons || [];
    const reasonCode = status.haltReasonCode || 
                       (status.dailyStopHit ? 'daily_stop' : undefined);
    
    // Add daily stop to reasons if not already present
    if (status.dailyStopHit && !reasons.includes('daily_stop')) {
      reasons.push('daily_stop');
    }
    
    return {
      state: 'KILL_SWITCH',
      reasons,
      reasonCode,
    };
  }

  // Priority 5: Paused
  if (status.paused || status.tradingState === 'PAUSED') {
    return {
      state: 'PAUSED',
      reason: 'Engine paused by user or system',
    };
  }

  // Priority 6: Running
  if (status.engineRunning) {
    return { state: 'RUNNING' };
  }

  // Priority 7: Engine not running but no kill switch (unexpected stop)
  if (!status.engineRunning) {
    return {
      state: 'STOPPED_UNEXPECTED',
      reason: 'Engine stopped. If you did not stop it manually, check backend logs.',
    };
  }

  // Fallback (should not reach here)
  return { state: 'RUNNING' };
}
