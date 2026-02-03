/**
 * Trading Engine Hook
 * 
 * Provides connection state and engine status using the unified RuntimeWs pipeline.
 */

import { useEffect, useState, useCallback } from 'react';
import { useRuntimeWs, useRuntimeWsState } from '@/runtime/ws';
import { runtimeClient } from '@/services/runtimeClient';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { 
  StatusPayload, 
  TickerPayload, 
  SignalPayload, 
  OrderPayload, 
  PositionPayload 
} from '@/runtime/ws/types';

export interface TradingEngineState {
  isConnected: boolean;
  engineRunning: boolean;
  mode: 'paper' | 'live' | null;
  paused: boolean;
  dailyStopHit: boolean;
  killSwitch: {
    active: boolean;
    reasons: string[];
  };
  tradingState?: 'RUNNING' | 'PAUSED' | 'HALTED';
  lastTicker: TickerPayload | null;
  lastSignal: SignalPayload | null;
  lastOrder: OrderPayload | null;
  lastPosition: PositionPayload | null;
  backendAvailable: boolean;
  lastUpdate: Date | null;
  isReconnecting: boolean;
}

export const useTradingEngine = () => {
  const queryClient = useQueryClient();
  const wsState = useRuntimeWsState();
  const { on } = useRuntimeWs();
  
  const [state, setState] = useState<TradingEngineState>({
    isConnected: false,
    engineRunning: false,
    mode: null,
    paused: false,
    dailyStopHit: false,
    killSwitch: { active: false, reasons: [] },
    tradingState: undefined,
    lastTicker: null,
    lastSignal: null,
    lastOrder: null,
    lastPosition: null,
    backendAvailable: false,
    lastUpdate: null,
    isReconnecting: false,
  });

  // Check backend availability via REST (fallback for when WS is down)
  const { data: runtimeStatus } = useQuery({
    queryKey: ['runtime-status'],
    queryFn: () => runtimeClient.getStatus(),
    refetchInterval: 5000,
    retry: 1,
    staleTime: 2000,
  });

  // Sync WS connection state
  useEffect(() => {
    setState(prev => ({
      ...prev,
      isConnected: wsState.connected,
      isReconnecting: wsState.reconnectAttempts > 0 && !wsState.connected,
      lastUpdate: wsState.lastEventAt ? new Date(wsState.lastEventAt) : prev.lastUpdate,
    }));
  }, [wsState.connected, wsState.reconnectAttempts, wsState.lastEventAt]);

  // Sync REST status (for backend availability and initial state)
  useEffect(() => {
    if (runtimeStatus) {
      setState(prev => ({
        ...prev,
        backendAvailable: true,
        engineRunning: runtimeStatus.engineRunning,
        mode: runtimeStatus.mode,
        paused: runtimeStatus.paused ?? false,
        dailyStopHit: runtimeStatus.dailyStopHit ?? false,
        killSwitch: runtimeStatus.killSwitch ?? { active: false, reasons: [] },
        tradingState: runtimeStatus.tradingState,
      }));
    }
  }, [runtimeStatus]);

  // Subscribe to WS events for real-time updates
  useEffect(() => {
    const unsubscribers: (() => void)[] = [];

    // Status updates
    unsubscribers.push(
      on('status', (event) => {
        const status = event.payload as StatusPayload;
        setState(prev => ({
          ...prev,
          engineRunning: status.engineRunning,
          mode: status.mode,
          paused: status.paused,
          dailyStopHit: status.dailyStopHit,
          killSwitch: status.killSwitch,
          tradingState: status.tradingState,
          lastUpdate: new Date(),
        }));
        // Invalidate status query to keep REST in sync
        queryClient.invalidateQueries({ queryKey: ['runtime-status'] });
      })
    );

    // Ticker updates (debounced internally by WS client)
    unsubscribers.push(
      on('market:ticker', (event) => {
        setState(prev => ({
          ...prev,
          lastTicker: event.payload as TickerPayload,
          lastUpdate: new Date(),
        }));
      })
    );

    // Signal updates
    unsubscribers.push(
      on('signal', (event) => {
        setState(prev => ({
          ...prev,
          lastSignal: event.payload as SignalPayload,
          lastUpdate: new Date(),
        }));
      })
    );

    // Order updates
    unsubscribers.push(
      on('order:created', (event) => {
        setState(prev => ({
          ...prev,
          lastOrder: event.payload as OrderPayload,
          lastUpdate: new Date(),
        }));
      })
    );

    unsubscribers.push(
      on('order:updated', (event) => {
        setState(prev => ({
          ...prev,
          lastOrder: event.payload as OrderPayload,
          lastUpdate: new Date(),
        }));
      })
    );

    // Position updates
    unsubscribers.push(
      on('position:opened', (event) => {
        setState(prev => ({
          ...prev,
          lastPosition: event.payload as PositionPayload,
          lastUpdate: new Date(),
        }));
      })
    );

    unsubscribers.push(
      on('position:closed', (event) => {
        setState(prev => ({
          ...prev,
          lastPosition: event.payload as PositionPayload,
          lastUpdate: new Date(),
        }));
      })
    );

    return () => {
      unsubscribers.forEach(unsub => unsub());
    };
  }, [on, queryClient]);

  return state;
};
