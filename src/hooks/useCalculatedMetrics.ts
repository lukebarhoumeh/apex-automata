import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { FIXED_USER_ID } from "@/contexts/AuthContext";
import { useAccountMetrics } from "./useAccountMetrics";
import { useSessionStats } from "./useSessionStats";
import type { Tables } from "@/integrations/supabase/types";

type Position = Tables<"positions">;

const API_URL = import.meta.env.VITE_RUNTIME_API_URL || 'http://localhost:3001';

// Configuration
const INITIAL_BALANCE = 50000;
const RISK_PER_TRADE = 0.01;

export const useCalculatedMetrics = () => {
  const { data: baseMetrics } = useAccountMetrics();
  const { data: sessionStats } = useSessionStats();
  
  return useQuery({
    queryKey: ["calculated-metrics", FIXED_USER_ID, sessionStats?.sessionId],
    queryFn: async () => {
      const today = new Date().toISOString().split('T')[0];
      
      // If we have live session stats from backend, prioritize those
      if (sessionStats) {
        const totalEquity = INITIAL_BALANCE + sessionStats.totalPnl;
        const dailyPnLR = sessionStats.totalPnl / (INITIAL_BALANCE * RISK_PER_TRADE);
        
        return {
          total_equity: totalEquity,
          daily_pnl: sessionStats.totalPnl,
          daily_pnl_r: dailyPnLR,
          risk_heat: 0, // Would need current positions to calculate
          spread_percentile: baseMetrics?.spread_percentile || 0,
          open_positions_count: 0, // Updated from positions hook
          wins_today: sessionStats.winningTrades,
          losses_today: sessionStats.losingTrades,
          date: today,
          total_realized_pnl: sessionStats.totalPnl,
          total_unrealized_pnl: 0,
          win_rate: sessionStats.winRate * 100,
          total_trades_today: sessionStats.totalTrades,
        };
      }
      
      // Fallback to Supabase data
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
      
      // Calculate metrics from positions
      const openPositions = (positions || []).filter((p) => !p.closed_at);
      const closedPositions = (positions || []).filter((p) => p.closed_at);
      
      const totalRealizedPnL = closedPositions.reduce((sum, p) => 
        sum + (p.realized_pnl_usd || 0), 0
      );
      
      const dailyPnL = totalRealizedPnL;
      
      // Calculate wins/losses
      const wins = closedPositions.filter((p) => (p.realized_pnl_usd || 0) > 0).length;
      const losses = closedPositions.filter((p) => (p.realized_pnl_usd || 0) < 0).length;
      
      // Calculate total equity
      const initialBalance = baseMetrics?.total_equity || INITIAL_BALANCE;
      const totalEquity = initialBalance + totalRealizedPnL;
      
      // Calculate risk heat
      const totalPositionValue = openPositions.reduce((sum, p) => 
        sum + Math.abs(p.qty_open * p.entry_price), 0
      );
      const riskHeat = totalEquity > 0 ? (totalPositionValue / totalEquity) * 100 : 0;
      
      // Calculate daily PnL in R
      const dailyPnLR = dailyPnL / (initialBalance * RISK_PER_TRADE);
      
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
        total_realized_pnl: totalRealizedPnL,
        total_unrealized_pnl: 0,
        win_rate: (wins + losses) > 0 ? (wins / (wins + losses)) * 100 : 0,
        total_trades_today: wins + losses,
      };
    },
    refetchInterval: 3000,
    // Run even without base metrics - use fallbacks
    enabled: true,
  });
};
