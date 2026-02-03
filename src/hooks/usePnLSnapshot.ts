/**
 * usePnLSnapshot - THE canonical hook for all P&L metrics
 * 
 * This is the ONLY approved way to get P&L data in the UI.
 * All components displaying equity, P&L, or R values MUST use this hook.
 * 
 * Sources (in priority order):
 * 1. WS bus event 'pnl:snapshot' (primary when CONNECTED)
 * 2. REST fetch to /api/pnl (fallback)
 * 3. Supabase (historical only, when realtime unavailable)
 * 
 * DO NOT use:
 * - INITIAL_BALANCE constants
 * - Local equity calculations
 * - Session stats totalPnl for equity display
 */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, useCallback } from "react";
import { useConnectivityBooleans } from "@/runtime/connectivity";
import { getEventBus } from "@/runtime/event-bus";
import type { BusEvent } from "@/runtime/event-bus/types";
import { 
  type PnLSnapshot, 
  type PnLSnapshotState,
  PNL_STALE_THRESHOLD_MS,
  isSnapshotStale 
} from "@/runtime/pnl/types";

const API_URL = import.meta.env.VITE_RUNTIME_API_URL || 'http://localhost:3001';

// Fallback poll interval when WS disconnected
const FALLBACK_POLL_INTERVAL = 5000;

/**
 * Normalize backend payload to PnLSnapshot
 * Backend may use different casing or field names
 */
function normalizeSnapshot(raw: unknown): PnLSnapshot | null {
  if (!raw || typeof raw !== 'object') return null;
  
  const data = raw as Record<string, unknown>;
  
  // Handle both camelCase and snake_case from backend
  return {
    ts: (data.ts as number) || Date.now(),
    userId: (data.userId || data.user_id || '') as string,
    sessionId: (data.sessionId || data.session_id || '') as string,
    executionMode: (data.executionMode || data.execution_mode || 'paper') as 'paper' | 'live',
    riskDay: (data.riskDay || data.risk_day || new Date().toISOString().split('T')[0]) as string,
    sessionStartEquityUsd: Number(data.sessionStartEquityUsd || data.session_start_equity_usd || 0),
    dayStartEquityUsd: Number(data.dayStartEquityUsd || data.day_start_equity_usd || 0),
    realizedPnlUsd: Number(data.realizedPnlUsd || data.realized_pnl_usd || 0),
    unrealizedPnlUsd: Number(data.unrealizedPnlUsd || data.unrealized_pnl_usd || 0),
    totalEquityUsd: Number(data.totalEquityUsd || data.total_equity_usd || 0),
    dailyPnlUsd: Number(data.dailyPnlUsd || data.daily_pnl_usd || 0),
    dailyPnlR: Number(data.dailyPnlR || data.daily_pnl_r || 0),
    riskUnitUsd: Number(data.riskUnitUsd || data.risk_unit_usd || 0),
    openPositionsCount: Number(data.openPositionsCount || data.open_positions_count || 0),
    exposureUsd: Number(data.exposureUsd || data.exposure_usd || 0),
    lastMarkPriceBySymbol: (data.lastMarkPriceBySymbol || data.last_mark_price_by_symbol || undefined) as Record<string, number> | undefined,
  };
}

/**
 * Primary P&L snapshot hook
 * 
 * Returns the current snapshot state with source tracking and staleness detection.
 */
export const usePnLSnapshot = (): PnLSnapshotState => {
  const { isConnected } = useConnectivityBooleans();
  const queryClient = useQueryClient();
  
  // Track the source of current data
  const [source, setSource] = useState<'ws' | 'rest' | 'supabase' | 'none'>('none');
  
  // Track last snapshot timestamp for freshness
  const lastSnapshotTsRef = useRef<number | null>(null);
  
  // Subscribe to WS pnl:snapshot events
  useEffect(() => {
    const bus = getEventBus();
    
    const unsubscribe = bus.on('pnl:snapshot', (event: BusEvent) => {
      const snapshot = normalizeSnapshot(event.payload);
      if (snapshot) {
        // Store directly in React Query cache
        queryClient.setQueryData(['pnl-snapshot'], snapshot);
        lastSnapshotTsRef.current = snapshot.ts;
        setSource('ws');
      }
    });
    
    return unsubscribe;
  }, [queryClient]);
  
  // REST fallback query
  const { data: snapshot, isLoading } = useQuery({
    queryKey: ['pnl-snapshot'],
    queryFn: async (): Promise<PnLSnapshot | null> => {
      try {
        // Try /api/pnl first (dedicated endpoint)
        let response = await fetch(`${API_URL}/api/pnl`);
        
        // Fall back to /api/status which may contain pnl data
        if (!response.ok) {
          response = await fetch(`${API_URL}/api/status`);
        }
        
        if (!response.ok) {
          return null;
        }
        
        const data = await response.json();
        // /api/status may have pnl nested
        const pnlData = data.pnl || data;
        const normalized = normalizeSnapshot(pnlData);
        
        if (normalized) {
          lastSnapshotTsRef.current = normalized.ts;
          if (source !== 'ws') {
            setSource('rest');
          }
        }
        
        return normalized;
      } catch (error) {
        console.error('PnL snapshot fetch error:', error);
        return null;
      }
    },
    // Only poll when WS disconnected
    refetchInterval: isConnected ? false : FALLBACK_POLL_INTERVAL,
    // Keep data fresh for longer when connected (WS handles updates)
    staleTime: isConnected ? 60_000 : 2_000,
    // Don't throw on error - we have fallback
    retry: 1,
  });
  
  // Calculate freshness
  const freshnessMs = snapshot?.ts ? Date.now() - snapshot.ts : null;
  const isStale = isSnapshotStale(snapshot);
  
  // Update source to 'none' if no data
  useEffect(() => {
    if (!snapshot && !isLoading) {
      setSource('none');
    }
  }, [snapshot, isLoading]);
  
  return {
    snapshot,
    freshnessMs,
    source,
    isStale,
    isLoading,
  };
};

/**
 * Convenience hook for just the snapshot (no metadata)
 */
export const usePnL = (): PnLSnapshot | null => {
  const { snapshot } = usePnLSnapshot();
  return snapshot;
};

/**
 * Hook for checking if P&L data is available and fresh
 */
export const useIsPnLAvailable = (): boolean => {
  const { snapshot, isStale } = usePnLSnapshot();
  return snapshot !== null && !isStale;
};
