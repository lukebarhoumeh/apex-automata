/**
 * Use Trading State Hook
 * 
 * Sprint 1.6: Single hook for getting the canonical trading UI state.
 * Combines runtime status + connectivity into the unified TradingUiState.
 */

import { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import { useConnectivity } from '@/runtime/connectivity';
import { useRuntimeStatus } from '@/hooks/useRuntimeStatus';
import { useRuntimeWs } from '@/runtime/ws';
import { deriveTradingUiState, type RuntimeStatusPayload } from '@/runtime/state/deriveTradingUiState';
import { getAlertController, type AlertDefinition } from '@/runtime/alerts';
import type { TradingUiState } from '@/runtime/state/tradingState';
import type { StatusPayload, RiskEventPayload } from '@/runtime/ws/types';

export interface UseTradingStateResult {
  tradingState: TradingUiState;
  pendingAlert: AlertDefinition | null;
  dismissAlert: () => void;
}

export function useTradingState(): UseTradingStateResult {
  const connectivity = useConnectivity();
  const { data: runtimeStatus } = useRuntimeStatus();
  const { on } = useRuntimeWs();
  
  const [wsStatus, setWsStatus] = useState<RuntimeStatusPayload | null>(null);
  const [pendingAlert, setPendingAlert] = useState<AlertDefinition | null>(null);
  
  const alertController = getAlertController();
  const previousStateRef = useRef<TradingUiState | null>(null);

  // Register modal callback
  useEffect(() => {
    alertController.onModal((alert) => {
      setPendingAlert(alert);
    });
  }, [alertController]);

  // Subscribe to WS status events for real-time updates
  useEffect(() => {
    const unsubStatus = on('status', (event) => {
      const payload = event.payload as StatusPayload;
      setWsStatus({
        engineRunning: payload.engineRunning,
        mode: payload.mode,
        paused: payload.paused,
        tradingState: payload.tradingState,
        haltReasonCode: (payload as any).haltReasonCode,
        dailyStopHit: payload.dailyStopHit,
        killSwitch: payload.killSwitch,
      });
    });

    const unsubRisk = on('risk:event', (event) => {
      const payload = event.payload as RiskEventPayload;
      alertController.handleRiskEvent(payload);
    });

    return () => {
      unsubStatus();
      unsubRisk();
    };
  }, [on, alertController]);

  // Prefer WS status over REST for freshness
  const statusPayload: RuntimeStatusPayload | null = useMemo(() => {
    if (wsStatus) return wsStatus;
    if (runtimeStatus) {
      return {
        engineRunning: runtimeStatus.engineRunning,
        mode: runtimeStatus.mode,
        paused: runtimeStatus.paused,
        tradingState: runtimeStatus.tradingState,
        haltReasonCode: (runtimeStatus as any).haltReasonCode,
        dailyStopHit: runtimeStatus.dailyStopHit,
        killSwitch: runtimeStatus.killSwitch,
      };
    }
    return null;
  }, [wsStatus, runtimeStatus]);

  // Derive trading UI state
  const tradingState = useMemo(() => {
    return deriveTradingUiState(statusPayload, connectivity);
  }, [statusPayload, connectivity]);

  // Handle state transitions for alerts
  useEffect(() => {
    const previousState = previousStateRef.current;
    
    // Handle trading state changes
    alertController.handleTradingStateChange(tradingState, previousState);
    
    // Update ref
    previousStateRef.current = tradingState;
  }, [tradingState, alertController]);

  // Handle connectivity changes for alerts
  useEffect(() => {
    const previousConnectivity = alertController.getPreviousConnectivity();
    alertController.handleConnectivityChange(connectivity, previousConnectivity);
  }, [connectivity, alertController]);

  const dismissAlert = useCallback(() => {
    setPendingAlert(null);
  }, []);

  return {
    tradingState,
    pendingAlert,
    dismissAlert,
  };
}
