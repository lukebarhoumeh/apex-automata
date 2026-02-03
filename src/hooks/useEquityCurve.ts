/**
 * Equity Curve Hook (Event-Driven, Sprint 1.4)
 * 
 * Builds equity curve from pnl:snapshot events when connected.
 * Historical data fetched on initial load or reconnect.
 * 
 * The live series is built from the same pnl:snapshot that drives
 * the header/metrics, ensuring chart and KPIs never drift.
 */

import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useCallback, useState } from "react";
import { useConnectivityBooleans } from "@/runtime/connectivity";
import { getEventBus } from "@/runtime/event-bus";
import type { BusEvent } from "@/runtime/event-bus/types";
import type { PnLSnapshot } from "@/runtime/pnl/types";

const API_URL = import.meta.env.VITE_RUNTIME_API_URL || 'http://localhost:3001';

// Max points to keep in the live series
const MAX_EQUITY_POINTS = 3600;

// Fallback poll interval when disconnected
const FALLBACK_POLL_INTERVAL = 30000;

export interface EquityPoint {
  timestamp: number;
  equity: number;  // totalEquityUsd from snapshot
  pnl: number;     // realized + unrealized
  tradeId?: string;
}

export interface EquityCurveData {
  equityCurve: EquityPoint[];
  highWaterMark: number;
  currentEquity: number;
  maxDrawdown: number;
}

/**
 * Live equity series built from pnl:snapshot events.
 */
export const useLiveEquitySeries = () => {
  const [series, setSeries] = useState<EquityPoint[]>([]);
  const lastTsRef = useRef<number>(0);
  
  useEffect(() => {
    const bus = getEventBus();
    
    const unsubscribe = bus.on('pnl:snapshot', (event: BusEvent<'pnl:snapshot'>) => {
      // Type the payload as PnLSnapshot
      const payload = event.payload as Partial<PnLSnapshot> & {
        totalEquityUsd?: number;
        total_equity_usd?: number;
        realizedPnlUsd?: number;
        realized_pnl_usd?: number;
        unrealizedPnlUsd?: number;
        unrealized_pnl_usd?: number;
        ts?: number;
      };
      
      // Dedupe by timestamp
      if (event.ts <= lastTsRef.current) {
        return;
      }
      lastTsRef.current = event.ts;
      
      // Normalize field names (handle both camelCase and snake_case)
      const equity = payload.totalEquityUsd ?? payload.total_equity_usd ?? 0;
      const realized = payload.realizedPnlUsd ?? payload.realized_pnl_usd ?? 0;
      const unrealized = payload.unrealizedPnlUsd ?? payload.unrealized_pnl_usd ?? 0;
      
      const point: EquityPoint = {
        timestamp: event.ts,
        equity: equity,
        pnl: realized + unrealized,
      };
      
      setSeries(prev => {
        const newSeries = [...prev, point];
        // Trim to max size
        if (newSeries.length > MAX_EQUITY_POINTS) {
          return newSeries.slice(-MAX_EQUITY_POINTS);
        }
        return newSeries;
      });
    });
    
    return unsubscribe;
  }, []);
  
  const clearSeries = useCallback(() => {
    setSeries([]);
    lastTsRef.current = 0;
  }, []);
  
  return { series, clearSeries };
};

/**
 * Historical equity curve from backend.
 * Only fetched on initial load or manual refresh.
 */
export const useEquityCurve = () => {
  const { isConnected } = useConnectivityBooleans();
  
  return useQuery({
    queryKey: ["equity-curve"],
    queryFn: async (): Promise<EquityCurveData | null> => {
      try {
        const response = await fetch(`${API_URL}/api/analytics/equity-curve`);
        if (!response.ok) {
          if (response.status === 400) {
            return null;
          }
          throw new Error(`Failed to fetch equity curve: ${response.statusText}`);
        }
        return response.json();
      } catch (error) {
        console.error('Equity curve fetch error:', error);
        return null;
      }
    },
    // Only poll when disconnected - live series handles real-time updates
    refetchInterval: isConnected ? false : FALLBACK_POLL_INTERVAL,
    // Keep stale for longer - historical data doesn't change frequently
    staleTime: isConnected ? 5 * 60 * 1000 : 10000,
  });
};

/**
 * Combined hook that merges historical + live equity data.
 */
export const useCombinedEquityCurve = () => {
  const { data: historicalData, isLoading } = useEquityCurve();
  const { series: liveSeries, clearSeries } = useLiveEquitySeries();
  
  // Merge historical + live, avoiding duplicates
  const mergedCurve = useCallback((): EquityPoint[] => {
    if (!historicalData?.equityCurve) {
      return liveSeries;
    }
    
    const historical = historicalData.equityCurve;
    const lastHistoricalTs = historical.length > 0 
      ? historical[historical.length - 1].timestamp 
      : 0;
    
    // Only add live points that are newer than historical
    const newLivePoints = liveSeries.filter(p => p.timestamp > lastHistoricalTs);
    
    return [...historical, ...newLivePoints];
  }, [historicalData, liveSeries]);
  
  return {
    equityCurve: mergedCurve(),
    highWaterMark: historicalData?.highWaterMark || 0,
    currentEquity: historicalData?.currentEquity || 
      (liveSeries.length > 0 ? liveSeries[liveSeries.length - 1].equity : 0),
    maxDrawdown: historicalData?.maxDrawdown || 0,
    isLoading,
    clearLiveSeries: clearSeries,
  };
};
