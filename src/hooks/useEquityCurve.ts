import { useQuery } from "@tanstack/react-query";

const API_URL = import.meta.env.VITE_RUNTIME_API_URL || 'http://localhost:3001';

export interface EquityPoint {
  timestamp: number;
  equity: number;
  pnl: number;
  tradeId?: string;
}

export interface EquityCurveData {
  equityCurve: EquityPoint[];
  highWaterMark: number;
  currentEquity: number;
  maxDrawdown: number;
}

export const useEquityCurve = () => {
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
    refetchInterval: 5000,
    staleTime: 3000,
  });
};

