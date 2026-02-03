/**
 * Session Stats Hook (Event-Driven)
 * 
 * Derives from pnl:snapshot events when connected,
 * falls back to REST polling when disconnected.
 */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { useConnectivityBooleans } from "@/runtime/connectivity";
import { getEventBus } from "@/runtime/event-bus";

const API_URL = import.meta.env.VITE_RUNTIME_API_URL || 'http://localhost:3001';

// Fallback poll interval when disconnected
const FALLBACK_POLL_INTERVAL = 5000;

export interface SessionStats {
  sessionId: string;
  startTime: string;
  mode: 'paper' | 'live';
  
  // P&L metrics
  totalPnl: number;
  grossProfit: number;
  grossLoss: number;
  netProfit: number;
  
  // Trade counts
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  breakEvenTrades: number;
  
  // Ratios
  winRate: number;
  profitFactor: number;
  payoffRatio: number;
  expectancy: number;
  
  // Average metrics
  avgWin: number;
  avgLoss: number;
  avgTrade: number;
  avgDuration: number;
  avgSlippageBps: number;
  
  // Risk metrics
  maxDrawdown: number;
  maxDrawdownPct: number;
  sharpeEstimate: number;
  sortinoEstimate: number;
  calmarEstimate: number;
  
  // Execution quality
  avgFillRatio: number;
  avgOrderLatencyMs: number;
  
  highWaterMark: number;
}

export const useSessionStats = () => {
  const { isConnected } = useConnectivityBooleans();
  const queryClient = useQueryClient();
  
  // Listen to pnl:snapshot events to update session stats
  useEffect(() => {
    const bus = getEventBus();
    
    const unsubscribe = bus.on('pnl:snapshot', (event) => {
      // pnl:snapshot contains session info that maps to session stats
      // The applyEventToCache already invalidates session-stats
      // This is just for additional real-time updates if needed
    });
    
    return unsubscribe;
  }, [queryClient]);
  
  return useQuery({
    queryKey: ["session-stats"],
    queryFn: async (): Promise<SessionStats | null> => {
      try {
        const response = await fetch(`${API_URL}/api/analytics/session`);
        if (!response.ok) {
          if (response.status === 400) {
            // Engine not running
            return null;
          }
          throw new Error(`Failed to fetch session stats: ${response.statusText}`);
        }
        return response.json();
      } catch (error) {
        console.error('Session stats fetch error:', error);
        return null;
      }
    },
    // Only poll when disconnected - pnl:snapshot events handle updates when connected
    refetchInterval: isConnected ? false : FALLBACK_POLL_INTERVAL,
    staleTime: isConnected ? 30000 : 1000,
  });
};
