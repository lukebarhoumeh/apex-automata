/**
 * Hook for accessing Supabase Realtime latency stats.
 */

import { useState, useEffect } from 'react';
import { getRealtimeManager } from '@/runtime/realtime/SupabaseRealtimeManager';
import type { RealtimeLatencyStats } from '@/runtime/realtime/types';

const REFRESH_INTERVAL_MS = 1000;

export function useRealtimeLatency(): RealtimeLatencyStats & { freshnessMs: number | null } {
  const [stats, setStats] = useState<RealtimeLatencyStats>(() => getRealtimeManager().getLatencyStats());
  const [freshnessMs, setFreshnessMs] = useState<number | null>(null);
  
  useEffect(() => {
    const updateStats = () => {
      const latestStats = getRealtimeManager().getLatencyStats();
      setStats(latestStats);
      
      // Calculate freshness (time since last event)
      if (latestStats.lastEventTs) {
        setFreshnessMs(Date.now() - latestStats.lastEventTs);
      } else {
        setFreshnessMs(null);
      }
    };
    
    updateStats();
    const interval = setInterval(updateStats, REFRESH_INTERVAL_MS);
    
    return () => clearInterval(interval);
  }, []);
  
  return { ...stats, freshnessMs };
}
