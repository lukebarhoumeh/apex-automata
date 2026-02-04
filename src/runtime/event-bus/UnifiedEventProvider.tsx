/**
 * Unified Event Provider
 * 
 * Combines WS events, Supabase Realtime, and REST polling into
 * a single event stream via the Event Bus.
 * 
 * This is the single source of truth for all real-time updates.
 */

import React, { createContext, useContext, useEffect, useRef, useCallback, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { getRuntimeWsClient } from '../ws/RuntimeWsClient';
import { getEventBus } from '../event-bus/EventBus';
import { startRealtimeManager, stopRealtimeManager, getRealtimeManager } from '../realtime/SupabaseRealtimeManager';
import { performCatchUp, prepareCatchUp } from '../realtime/catchUp';
import { useConnectivity, useConnectivityBooleans } from '../connectivity';
import { runtimeClient } from '@/services/runtimeClient';
import { FIXED_USER_ID } from '@/contexts/AuthContext';
import type { BusEvent, EventBusStats } from '../event-bus/types';
import type { RuntimeEventEnvelope } from '../ws/types';
import type { RuntimeConnectivity } from '../connectivity/types';
import type { RealtimeLatencyStats } from '../realtime/types';

// Debug mode
const DEBUG = import.meta.env.VITE_DEBUG_EVENT_BUS === '1';

// ============ Config ============

/** Fallback polling interval when DISCONNECTED/STALE */
const FALLBACK_POLL_INTERVAL_MS = 5000;

/** Resync delay after reconnection */
const RESYNC_DELAY_MS = 500;

/** Time to wait before doing catch-up (let realtime settle) */
const CATCH_UP_DELAY_MS = 1000;

// ============ Context Types ============

interface UnifiedEventContextValue {
  /** Current connectivity state */
  connectivity: RuntimeConnectivity;
  /** Whether fallback polling is active */
  isFallbackPolling: boolean;
  /** Event bus stats */
  stats: EventBusStats;
  /** Supabase realtime latency stats */
  realtimeStats: RealtimeLatencyStats;
  /** Force a resync (one-shot fetch) */
  forceResync: () => void;
  /** Force a catch-up from Supabase */
  forceCatchUp: () => Promise<void>;
}

const UnifiedEventContext = createContext<UnifiedEventContextValue | null>(null);

// ============ Provider Props ============

interface UnifiedEventProviderProps {
  children: React.ReactNode;
}

// ============ WS to Bus Bridge ============

/**
 * Generate a dedupe key for a WS event.
 */
function generateWsDedupeKey(event: RuntimeEventEnvelope): string | undefined {
  const payload = event.payload as Record<string, unknown>;
  const id = payload?.id || payload?.orderId || payload?.positionId || payload?.signalId;
  const ts = payload?.updatedAt || payload?.closedAt || payload?.openedAt || payload?.ts || event.ts;
  
  if (!id) return undefined;
  
  return `${event.type}:${id}:${ts}`;
}

// ============ Provider Component ============

export function UnifiedEventProvider({ children }: UnifiedEventProviderProps) {
  const queryClient = useQueryClient();
  const connectivity = useConnectivity();
  const { isConnected, isStale, isDisconnected, isBackendDown } = useConnectivityBooleans();
  
  const [stats, setStats] = useState<EventBusStats>(() => getEventBus().getStats());
  const [realtimeStats, setRealtimeStats] = useState<RealtimeLatencyStats>(() => getRealtimeManager().getLatencyStats());
  const [isFallbackPolling, setIsFallbackPolling] = useState(false);
  
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastResyncRef = useRef<number>(0);
  const wasDisconnectedRef = useRef<boolean>(false);
  
  // ============ Wire WS events to Bus ============
  
  useEffect(() => {
    const wsClient = getRuntimeWsClient();
    const bus = getEventBus();
    
    const unsubscribe = wsClient.subscribe((event: RuntimeEventEnvelope) => {
      // Convert to bus event
      const busEvent: BusEvent = {
        type: event.type,
        payload: event.payload,
        ts: event.ts,
        source: 'ws',
        dedupeKey: generateWsDedupeKey(event),
      };
      
      bus.publish(busEvent);
    });
    
    return unsubscribe;
  }, []);
  
  // ============ Apply bus events to cache ============
  
  useEffect(() => {
    const bus = getEventBus();
    
    const unsubscribe = bus.subscribe((event) => {
      // Import dynamically to avoid circular deps
      import('../event-bus/applyEventToCache').then(({ applyEventToCache }) => {
        applyEventToCache(queryClient, event);
      });
      
      // Update stats
      setStats(bus.getStats());
      setRealtimeStats(getRealtimeManager().getLatencyStats());
    });
    
    return unsubscribe;
  }, [queryClient]);
  
  // ============ Start Supabase Realtime Manager ============
  
  useEffect(() => {
    startRealtimeManager(FIXED_USER_ID);
    
    return () => {
      stopRealtimeManager();
    };
  }, []);
  
  // ============ Fallback Polling ============
  
  useEffect(() => {
    const shouldPoll = isStale || isDisconnected || isBackendDown;
    
    setIsFallbackPolling(shouldPoll);
    
    if (shouldPoll) {
      if (DEBUG) {
        console.log('[UnifiedEventProvider] Starting fallback polling');
      }
      
      // Start fallback polling
      pollIntervalRef.current = setInterval(async () => {
        try {
          // Fetch critical data
          const status = await runtimeClient.getStatus();
          
          if (status) {
            // Publish as REST event
            const bus = getEventBus();
            bus.publish({
              type: 'status',
              payload: status,
              ts: Date.now(),
              source: 'rest',
            });
          }
        } catch (error) {
          if (DEBUG) {
            console.error('[UnifiedEventProvider] Fallback poll failed:', error);
          }
        }
      }, FALLBACK_POLL_INTERVAL_MS);
    } else {
      // Stop fallback polling
      if (pollIntervalRef.current) {
        if (DEBUG) {
          console.log('[UnifiedEventProvider] Stopping fallback polling');
        }
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
    }
    
    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
    };
  }, [isStale, isDisconnected, isBackendDown]);
  
  // ============ Catch-up on reconnection ============
  
  useEffect(() => {
    // Track disconnection state
    if (isDisconnected || isStale) {
      wasDisconnectedRef.current = true;
    }
    
    // When transitioning from disconnected to connected, do catch-up
    if (isConnected && wasDisconnectedRef.current) {
      const timeSinceLastResync = Date.now() - lastResyncRef.current;
      
      // Only resync if been disconnected long enough
      if (timeSinceLastResync > 10000) {
        setTimeout(() => {
          forceCatchUp();
        }, CATCH_UP_DELAY_MS);
      }
      
      wasDisconnectedRef.current = false;
    }
  }, [isConnected, isDisconnected, isStale]);
  
  // ============ Force Resync ============
  
  const forceResync = useCallback(async () => {
    if (DEBUG) {
      console.log('[UnifiedEventProvider] Force resync triggered');
    }
    
    // Clear old dedupe entries to allow re-fetched data
    const bus = getEventBus();
    bus.clearDedupeOlderThan(Date.now() - 60000);
    
    // Invalidate all critical queries to trigger refetch
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['positions'] }),
      queryClient.invalidateQueries({ queryKey: ['orders'] }),
      queryClient.invalidateQueries({ queryKey: ['fills'] }),
      queryClient.invalidateQueries({ queryKey: ['runtime-status'] }),
      queryClient.invalidateQueries({ queryKey: ['session-stats'] }),
      queryClient.invalidateQueries({ queryKey: ['equity-curve'] }),
      queryClient.invalidateQueries({ queryKey: ['pnl-snapshot'] }),
    ]);
    
    lastResyncRef.current = Date.now();
  }, [queryClient]);
  
  // ============ Force Catch-Up from Supabase ============
  
  const forceCatchUp = useCallback(async () => {
    if (DEBUG) {
      console.log('[UnifiedEventProvider] Force catch-up triggered');
    }
    
    prepareCatchUp();
    await performCatchUp(FIXED_USER_ID);
    lastResyncRef.current = Date.now();
  }, []);
  
  // ============ Periodic stats refresh ============
  
  useEffect(() => {
    const interval = setInterval(() => {
      setRealtimeStats(getRealtimeManager().getLatencyStats());
    }, 1000);
    
    return () => clearInterval(interval);
  }, []);
  
  // ============ Context Value ============
  
  const value: UnifiedEventContextValue = {
    connectivity,
    isFallbackPolling,
    stats,
    realtimeStats,
    forceResync,
    forceCatchUp,
  };
  
  return (
    <UnifiedEventContext.Provider value={value}>
      {children}
    </UnifiedEventContext.Provider>
  );
}

// ============ Hook ============

export function useUnifiedEvents(): UnifiedEventContextValue {
  const context = useContext(UnifiedEventContext);
  if (!context) {
    throw new Error('useUnifiedEvents must be used within UnifiedEventProvider');
  }
  return context;
}

/**
 * Hook to check if fallback polling should be enabled for a query.
 */
export function useShouldPoll(): boolean {
  const { isFallbackPolling } = useUnifiedEvents();
  return isFallbackPolling;
}
