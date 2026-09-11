/**
 * Runtime WebSocket React Provider
 * 
 * Provides a single WS connection to all components.
 * Handles React Query cache invalidation on events.
 * Also wires REST health polling to the connectivity service.
 */

import React, { createContext, useContext, useEffect, useState, useCallback, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { getRuntimeWsClient, RuntimeWsClient } from './RuntimeWsClient';
import { getConnectivityService } from '../connectivity/RuntimeConnectivityService';
import { runtimeClient } from '@/services/runtimeClient';
import { useToast } from '@/hooks/use-toast';
import type { 
  CanonicalEventType, 
  RuntimeEventEnvelope, 
  RuntimeWsConnectionState,
  SignalPayload,
  OrderPayload,
  PositionPayload,
  RegimePayload,
  PnLSnapshotPayload,
} from './types';
import { REST_PROBE_INTERVAL_MS } from '../connectivity/types';

// ============ Context Types ============

type SubscribeFn = (
  typesOrHandler: CanonicalEventType[] | '*' | ((event: RuntimeEventEnvelope) => void),
  handler?: (event: RuntimeEventEnvelope) => void
) => () => void;

type OnFn = <T extends CanonicalEventType>(
  type: T,
  handler: (event: RuntimeEventEnvelope<T>) => void
) => () => void;

interface RuntimeWsContextValue {
  state: RuntimeWsConnectionState;
  subscribe: SubscribeFn;
  on: OnFn;
  getRecentEvents: () => RuntimeEventEnvelope[];
  getUnknownTypesInfo: () => { count: number; types: string[] };
  reconnect: () => void;
  disconnect: () => void;
}

const RuntimeWsContext = createContext<RuntimeWsContextValue | null>(null);

// ============ Provider Props ============

interface RuntimeWsProviderProps {
  children: React.ReactNode;
  showNotifications?: boolean;
}

// ============ Provider Component ============

export function RuntimeWsProvider({ 
  children, 
  showNotifications = true 
}: RuntimeWsProviderProps) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const clientRef = useRef<RuntimeWsClient | null>(null);
  const restProbeIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  
  const [state, setState] = useState<RuntimeWsConnectionState>({
    connected: false,
    lastMessageAt: null,
    lastEventAt: null,
    reconnectAttempts: 0,
    error: null,
  });
  
  // Initialize client once
  useEffect(() => {
    const client = getRuntimeWsClient();
    clientRef.current = client;
    
    // Sync initial state
    setState(client.getState());
    
    // Listen for state changes
    const unsubState = client.onStateChange(setState);
    
    // Subscribe to all events for cache invalidation
    const unsubEvents = client.subscribe('*', (event) => {
      handleEventForCacheInvalidation(event);
      if (showNotifications) {
        handleEventForNotifications(event);
      }
    });
    
    return () => {
      unsubState();
      unsubEvents();
    };
  }, [queryClient, showNotifications]);
  
  // REST health probing for connectivity fallback
  useEffect(() => {
    const connectivity = getConnectivityService();
    
    const probe = async () => {
      try {
        const healthy = await runtimeClient.checkHealth();
        if (healthy) {
          connectivity.ingestRestOk();
        } else {
          connectivity.ingestRestFail();
        }
      } catch {
        connectivity.ingestRestFail();
      }
    };
    
    // Initial probe
    probe();
    
    // Setup interval
    restProbeIntervalRef.current = setInterval(probe, REST_PROBE_INTERVAL_MS);
    
    return () => {
      if (restProbeIntervalRef.current) {
        clearInterval(restProbeIntervalRef.current);
      }
    };
  }, []);
  
  // ============ Cache Invalidation ============
  
  const handleEventForCacheInvalidation = useCallback((event: RuntimeEventEnvelope) => {
    switch (event.type) {
      case 'signal':
      case 'signal:filtered':
        queryClient.invalidateQueries({ queryKey: ['signals'] });
        break;
        
      case 'order:created':
      case 'order:updated':
        queryClient.invalidateQueries({ queryKey: ['orders'] });
        break;
        
      case 'order:filled':
        queryClient.invalidateQueries({ queryKey: ['orders'] });
        queryClient.invalidateQueries({ queryKey: ['fills'] });
        break;
        
      case 'fill':
        queryClient.invalidateQueries({ queryKey: ['fills'] });
        queryClient.invalidateQueries({ queryKey: ['positions'] });
        queryClient.invalidateQueries({ queryKey: ['calculated-metrics'] });
        break;
        
      case 'position:opened':
      case 'position:updated':
        queryClient.invalidateQueries({ queryKey: ['positions'] });
        queryClient.invalidateQueries({ queryKey: ['calculated-metrics'] });
        break;
        
      case 'position:closed':
        queryClient.invalidateQueries({ queryKey: ['positions'] });
        queryClient.invalidateQueries({ queryKey: ['calculated-metrics'] });
        queryClient.invalidateQueries({ queryKey: ['session-stats'] });
        queryClient.invalidateQueries({ queryKey: ['equity-curve'] });
        break;
        
      case 'status':
        // Intentionally no REST invalidation. The event bus merges the WS
        // status into ['runtime-status'] (applyEventToCache); refetching
        // /api/status on every 1.5s StatusUpdate was the U7 refetch storm.
        break;
        
      case 'pnl:snapshot':
        // PnL snapshot is authoritative - update metrics
        queryClient.invalidateQueries({ queryKey: ['calculated-metrics'] });
        queryClient.invalidateQueries({ queryKey: ['session-stats'] });
        queryClient.invalidateQueries({ queryKey: ['equity-curve'] });
        break;
        
      case 'risk:event':
        queryClient.invalidateQueries({ queryKey: ['risk-events'] });
        break;

      case 'risk:metrics':
        // Periodic (5s) metrics tick; the `risk` block rides on StatusUpdate.
        break;
        
      case 'regime:update':
      case 'regime:changed':
        queryClient.invalidateQueries({ queryKey: ['regime-state'] });
        break;
        
      case 'warmup':
        queryClient.invalidateQueries({ queryKey: ['runtime-status'] });
        break;
        
      case 'supervisor:health':
        queryClient.invalidateQueries({ queryKey: ['runtime-health'] });
        break;
    }
  }, [queryClient]);
  
  // ============ Notifications ============
  
  const handleEventForNotifications = useCallback((event: RuntimeEventEnvelope) => {
    switch (event.type) {
      case 'signal': {
        const signal = event.payload as SignalPayload;
        toast({
          title: `Signal: ${signal.symbol}`,
          description: `${signal.strategy} ${signal.side.toUpperCase()} - ${signal.allowed ? 'Allowed' : 'Blocked'}`,
          variant: signal.allowed ? 'default' : 'destructive',
        });
        break;
      }
        
      case 'order:created': {
        const order = event.payload as OrderPayload;
        toast({
          title: 'Order Placed',
          description: `${order.side.toUpperCase()} ${order.quantity} ${order.symbol} @ ${order.price || 'MKT'}`,
        });
        break;
      }
        
      case 'order:filled': {
        const order = event.payload as OrderPayload;
        toast({
          title: 'Order Filled',
          description: `${order.side.toUpperCase()} ${order.quantity} ${order.symbol}`,
        });
        break;
      }
        
      case 'position:opened': {
        const pos = event.payload as PositionPayload;
        toast({
          title: 'Position Opened',
          description: `${pos.side.toUpperCase()} ${pos.qty} ${pos.symbol} @ ${pos.entryPrice.toFixed(2)}`,
        });
        break;
      }
        
      case 'position:closed': {
        const pos = event.payload as PositionPayload;
        const pnl = pos.pnlUsd ?? pos.realizedPnlUsd ?? 0;
        const pnlR = pos.pnlR ?? pos.realizedR ?? 0;
        toast({
          title: 'Position Closed',
          description: `${pos.symbol}: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} (${pnlR.toFixed(2)}R)`,
          variant: pnl >= 0 ? 'default' : 'destructive',
        });
        break;
      }
        
      case 'regime:changed': {
        const regime = event.payload as RegimePayload;
        toast({
          title: `Regime Change: ${regime.symbol}`,
          description: `${regime.previous || '?'} → ${regime.regime} (${(regime.confidence * 100).toFixed(0)}% conf)`,
        });
        break;
      }
    }
  }, [toast]);
  
  // ============ Context Value ============
  
  const subscribeHandler = useCallback(
    (typesOrHandler: CanonicalEventType[] | '*' | ((event: RuntimeEventEnvelope) => void), handler?: (event: RuntimeEventEnvelope) => void) => {
      return clientRef.current?.subscribe(typesOrHandler, handler) ?? (() => {});
    }, 
    []
  );
  
  const onHandler = useCallback(
    <T extends CanonicalEventType>(type: T, handler: (event: RuntimeEventEnvelope<T>) => void) => {
      return clientRef.current?.on(type, handler) ?? (() => {});
    },
    []
  );
  
  const value: RuntimeWsContextValue = {
    state,
    subscribe: subscribeHandler,
    on: onHandler,
    getRecentEvents: useCallback(() => {
      return clientRef.current?.getRecentEvents() ?? [];
    }, []),
    getUnknownTypesInfo: useCallback(() => {
      return clientRef.current?.getUnknownTypesInfo() ?? { count: 0, types: [] };
    }, []),
    reconnect: useCallback(() => {
      clientRef.current?.connect();
    }, []),
    disconnect: useCallback(() => {
      clientRef.current?.disconnect();
    }, []),
  };
  
  return (
    <RuntimeWsContext.Provider value={value}>
      {children}
    </RuntimeWsContext.Provider>
  );
}

// ============ Hooks ============

export function useRuntimeWs(): RuntimeWsContextValue {
  const context = useContext(RuntimeWsContext);
  if (!context) {
    throw new Error('useRuntimeWs must be used within a RuntimeWsProvider');
  }
  return context;
}

/**
 * Hook to subscribe to specific event types.
 * Returns the most recent event of that type.
 */
export function useRuntimeWsEvent<T extends CanonicalEventType>(
  type: T
): RuntimeEventEnvelope<T> | null {
  const { on } = useRuntimeWs();
  const [event, setEvent] = useState<RuntimeEventEnvelope<T> | null>(null);
  
  useEffect(() => {
    return on(type, (e) => setEvent(e as RuntimeEventEnvelope<T>));
  }, [on, type]);
  
  return event;
}

/**
 * Hook for connection state only.
 */
export function useRuntimeWsState(): RuntimeWsConnectionState {
  const { state } = useRuntimeWs();
  return state;
}
