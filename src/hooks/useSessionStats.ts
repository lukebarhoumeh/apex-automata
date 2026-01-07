import { useQuery } from "@tanstack/react-query";

const API_URL = import.meta.env.VITE_RUNTIME_API_URL || 'http://localhost:3001';

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
    refetchInterval: 2000,
    staleTime: 1000,
  });
};

