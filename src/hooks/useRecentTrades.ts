import { useQuery } from "@tanstack/react-query";

const API_URL = import.meta.env.VITE_RUNTIME_API_URL || 'http://localhost:3001';

export interface TradeRecord {
  id: string;
  symbol: string;
  side: 'long' | 'short';
  entryTime: string;
  exitTime?: string;
  entryPrice: number;
  exitPrice?: number;
  size: number;
  realizedPnl?: number;
  unrealizedPnl: number;
  fees: number;
  slippageBps?: number;
  duration?: number;
  outcome?: 'win' | 'loss' | 'breakeven';
  strategy?: string;
  signalId?: string;
  exitReason?: string;
  reasonCode?: string;
  maxFavorableExcursion?: number;
  maxAdverseExcursion?: number;
}

export const useRecentTrades = (limit: number = 20) => {
  return useQuery({
    queryKey: ["recent-trades", limit],
    queryFn: async (): Promise<TradeRecord[]> => {
      try {
        const response = await fetch(`${API_URL}/api/analytics/trades?limit=${limit}`);
        if (!response.ok) {
          if (response.status === 400) {
            return [];
          }
          throw new Error(`Failed to fetch trades: ${response.statusText}`);
        }
        const data = await response.json();
        return data.trades || [];
      } catch (error) {
        console.error('Trades fetch error:', error);
        return [];
      }
    },
    refetchInterval: 3000,
    staleTime: 2000,
  });
};

