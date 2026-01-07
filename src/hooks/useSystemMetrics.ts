import { useQuery } from "@tanstack/react-query";

const API_URL = import.meta.env.VITE_RUNTIME_API_URL || 'http://localhost:3001';

export interface SystemMetrics {
  system: {
    uptimeSeconds: number;
    memoryUsedMB: number;
    memoryTotalMB: number;
    rssMB: number;
  };
  latency: {
    wsLatencyMs: number;
    restLatencyMs: number;
  };
  market: {
    spreadBps: number;
    spreadPctile: number;
    regime: 'trend' | 'chop';
    atr: number;
  };
  trading: {
    engineRunning: boolean;
    mode: 'paper' | 'live' | null;
    totalTrades: number;
    winRate: number;
    sessionPnl: number;
    maxDrawdown: number;
  };
  risk: {
    exposureUsd: number;
    dailyPnl: number;
    killSwitchActive: boolean;
    consecutiveLosses: number;
  };
}

export const useSystemMetrics = () => {
  return useQuery({
    queryKey: ["system-metrics"],
    queryFn: async (): Promise<SystemMetrics | null> => {
      try {
        const response = await fetch(`${API_URL}/api/analytics/system-metrics`);
        if (!response.ok) {
          throw new Error(`Failed to fetch system metrics: ${response.statusText}`);
        }
        return response.json();
      } catch (error) {
        console.error('System metrics fetch error:', error);
        return null;
      }
    },
    refetchInterval: 2000,
    staleTime: 1000,
  });
};

