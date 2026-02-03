/**
 * React Hooks for Connectivity
 */

import { useState, useEffect, useCallback } from 'react';
import { getConnectivityService } from './RuntimeConnectivityService';
import type { RuntimeConnectivity, ConnectivityState } from './types';

/**
 * Hook to get the current connectivity state.
 * Subscribes to state changes and re-renders on transition.
 */
export function useConnectivity(): RuntimeConnectivity {
  const [connectivity, setConnectivity] = useState<RuntimeConnectivity>(
    () => getConnectivityService().getState()
  );

  useEffect(() => {
    const service = getConnectivityService();
    return service.subscribe(setConnectivity);
  }, []);

  return connectivity;
}

/**
 * Hook for simple boolean checks
 */
export function useConnectivityBooleans() {
  const connectivity = useConnectivity();
  
  return {
    isConnected: connectivity.state === 'CONNECTED',
    isStale: connectivity.state === 'STALE',
    isDisconnected: connectivity.state === 'DISCONNECTED',
    isBackendDown: connectivity.state === 'BACKEND_DOWN',
    isEngineStopped: connectivity.state === 'ENGINE_STOPPED',
    isEngineHalted: connectivity.state === 'ENGINE_HALTED',
    isEngineRunning: connectivity.state === 'CONNECTED', // Only CONNECTED means engine is truly running
    hasTransportIssue: ['DISCONNECTED', 'BACKEND_DOWN', 'STALE'].includes(connectivity.state),
    hasEngineIssue: ['ENGINE_STOPPED', 'ENGINE_HALTED'].includes(connectivity.state),
  };
}

/**
 * Utility to get display text for connectivity state
 */
export function getConnectivityDisplayInfo(connectivity: RuntimeConnectivity): {
  label: string;
  description: string;
  variant: 'success' | 'warning' | 'error' | 'info';
} {
  switch (connectivity.state) {
    case 'CONNECTED':
      return {
        label: 'Connected',
        description: 'Engine connected and receiving real-time data',
        variant: 'success',
      };
      
    case 'STALE':
      const ageSeconds = Math.round((connectivity.ageMs || 0) / 1000);
      return {
        label: 'Stale',
        description: `No heartbeat for ${ageSeconds}s — showing last known data`,
        variant: 'warning',
      };
      
    case 'DISCONNECTED':
      return {
        label: 'Disconnected',
        description: connectivity.reason || 'WebSocket disconnected — reconnecting...',
        variant: 'error',
      };
      
    case 'BACKEND_DOWN':
      return {
        label: 'Backend Unreachable',
        description: 'Cannot reach trading engine — check if runtime is running',
        variant: 'error',
      };
      
    case 'ENGINE_STOPPED':
      return {
        label: 'Engine Stopped',
        description: 'Trading engine is not running',
        variant: 'info',
      };
      
    case 'ENGINE_HALTED':
      const reason = connectivity.reasonCode || 'unknown';
      return {
        label: 'Engine Halted',
        description: `Trading halted: ${formatHaltReason(reason)}`,
        variant: 'warning',
      };
      
    default:
      return {
        label: 'Unknown',
        description: 'Unknown connection state',
        variant: 'error',
      };
  }
}

function formatHaltReason(code: string): string {
  const reasons: Record<string, string> = {
    daily_stop: 'Daily stop-loss reached',
    weekly_stop: 'Weekly stop-loss reached',
    max_drawdown: 'Maximum drawdown exceeded',
    consecutive_losses: 'Too many consecutive losses',
    error_rate: 'High error rate detected',
    manual_killswitch: 'Manual kill-switch activated',
    spread: 'Spread too wide',
    atr_burst: 'ATR burst detected',
    api_error: 'Exchange API errors',
  };
  return reasons[code] || code;
}
