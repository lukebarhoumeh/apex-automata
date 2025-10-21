import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { FIXED_USER_ID } from "@/contexts/AuthContext";
import { useAccountMetrics } from "./useAccountMetrics";

interface Position {
  id: string;
  product: string;
  side: string;
  qty_open: number;
  entry_price: number;
  realized_pnl_usd: number;
  unrealized_pnl_usd: number;
  closed_at: string | null;
}

interface Fill {
  id: string;
  order_id: string;
  price: number;
  quantity: number;
  fee_amount: number;
  filled_at: string;
}

export const useCalculatedMetrics = () => {
  const { data: baseMetrics } = useAccountMetrics();
  
  return useQuery({
    queryKey: ["calculated-metrics", FIXED_USER_ID],
    queryFn: async () => {
      const today = new Date().toISOString().split('T')[0];
      const todayStart = new Date(today).toISOString();
      
      // Fetch today's positions
      const { data: positions, error: posError } = await supabase
        .from("positions")
        .select("*")
        .eq("user_id", FIXED_USER_ID)
        .gte("opened_at", todayStart);
      
      if (posError) {
        console.error('Error fetching positions:', posError);
      }
      
      // Fetch today's fills
      const { data: fills, error: fillError } = await supabase
        .from("fills")
        .select("*")
        .eq("user_id", FIXED_USER_ID)
        .gte("filled_at", todayStart);
        
      if (fillError) {
        console.error('Error fetching fills:', fillError);
      }
      
      // Calculate metrics from positions
      const openPositions = (positions || []).filter((p: Position) => !p.closed_at);
      const closedPositions = (positions || []).filter((p: Position) => p.closed_at);
      
      const totalUnrealizedPnL = openPositions.reduce((sum: number, p: Position) => 
        sum + (p.unrealized_pnl_usd || 0), 0
      );
      
      const totalRealizedPnL = closedPositions.reduce((sum: number, p: Position) => 
        sum + (p.realized_pnl_usd || 0), 0
      );
      
      const dailyPnL = totalRealizedPnL + totalUnrealizedPnL;
      
      // Calculate wins/losses
      const wins = closedPositions.filter((p: Position) => p.realized_pnl_usd > 0).length;
      const losses = closedPositions.filter((p: Position) => p.realized_pnl_usd < 0).length;
      
      // Calculate total equity (initial + realized PnL)
      const initialBalance = baseMetrics?.total_equity || 50000;
      const totalEquity = initialBalance + totalRealizedPnL;
      
      // Calculate risk heat (percentage of equity at risk)
      const totalPositionValue = openPositions.reduce((sum: number, p: Position) => 
        sum + Math.abs(p.qty_open * p.entry_price), 0
      );
      const riskHeat = totalEquity > 0 ? (totalPositionValue / totalEquity) * 100 : 0;
      
      // Calculate daily PnL in R (risk units)
      const riskPerTrade = 0.01; // 1% risk per trade
      const dailyPnLR = dailyPnL / (initialBalance * riskPerTrade);
      
      return {
        total_equity: totalEquity,
        daily_pnl: dailyPnL,
        daily_pnl_r: dailyPnLR,
        risk_heat: riskHeat,
        spread_percentile: baseMetrics?.spread_percentile || 0,
        open_positions_count: openPositions.length,
        wins_today: wins,
        losses_today: losses,
        date: today,
        // Additional metrics
        total_realized_pnl: totalRealizedPnL,
        total_unrealized_pnl: totalUnrealizedPnL,
        win_rate: (wins + losses) > 0 ? (wins / (wins + losses)) * 100 : 0,
        total_trades_today: wins + losses,
      };
    },
    refetchInterval: 5000, // Refresh every 5 seconds
    enabled: !!baseMetrics, // Only run if base metrics are loaded
  });
};
