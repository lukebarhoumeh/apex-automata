import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { FIXED_USER_ID } from "@/contexts/AuthContext";
import { useSessionStats } from "./useSessionStats";
import { useRuntimeStatus } from "./useRuntimeStatus";
import type { Tables } from "@/integrations/supabase/types";

type Position = Tables<"positions">;

const API_URL = import.meta.env.VITE_RUNTIME_API_URL || 'http://localhost:3001';

// Configuration
const INITIAL_BALANCE = 50000;
const RISK_PER_TRADE = 0.01;

export const useCalculatedMetrics = () => {
  // Priority 1: Live session stats from backend /api/analytics/session
  const { data: sessionStats } = useSessionStats();
  // Priority 2: Runtime status from backend /api/status (for mode, engineRunning, risk data)
  const { data: runtimeStatus } = useRuntimeStatus();
  
  return useQuery({
    queryKey: ["calculated-metrics", sessionStats?.sessionId, runtimeStatus?.engineRunning],
    queryFn: async () => {
      const today = new Date().toISOString().split('T')[0];
      
      // PRIORITY 1: Use live session stats from backend for P&L metrics
      if (sessionStats) {
        const totalEquity = INITIAL_BALANCE + sessionStats.totalPnl;
        const dailyPnLR = sessionStats.totalPnl / (INITIAL_BALANCE * RISK_PER_TRADE);
        
        // Get risk heat from runtime status if available
        const riskHeat = runtimeStatus?.risk?.exposureUsd 
          ? (runtimeStatus.risk.exposureUsd / totalEquity) * 100 
          : 0;
        
        return {
          total_equity: totalEquity,
          daily_pnl: sessionStats.totalPnl,
          daily_pnl_r: dailyPnLR,
          risk_heat: riskHeat,
          spread_percentile: runtimeStatus?.spreadPctile || 0,
          open_positions_count: 0, // Updated separately from positions hook
          wins_today: sessionStats.winningTrades,
          losses_today: sessionStats.losingTrades,
          date: today,
          total_realized_pnl: sessionStats.totalPnl,
          total_unrealized_pnl: 0,
          win_rate: sessionStats.winRate * 100,
          total_trades_today: sessionStats.totalTrades,
          // Runtime status fields
          engine_running: runtimeStatus?.engineRunning ?? false,
          mode: runtimeStatus?.mode ?? null,
          paused: runtimeStatus?.paused ?? false,
          daily_stop_hit: runtimeStatus?.dailyStopHit ?? false,
        };
      }
      
      // PRIORITY 2: Use runtime status for risk data if session stats unavailable
      if (runtimeStatus?.risk) {
        return {
          total_equity: INITIAL_BALANCE + (runtimeStatus.risk.dailyPnLUsd || 0),
          daily_pnl: runtimeStatus.risk.dailyPnLUsd || 0,
          daily_pnl_r: (runtimeStatus.risk.dailyPnLUsd || 0) / (INITIAL_BALANCE * RISK_PER_TRADE),
          risk_heat: runtimeStatus.risk.exposureUsd 
            ? (runtimeStatus.risk.exposureUsd / INITIAL_BALANCE) * 100 
            : 0,
          spread_percentile: runtimeStatus.spreadPctile || 0,
          open_positions_count: 0,
          wins_today: 0,
          losses_today: 0,
          date: today,
          total_realized_pnl: runtimeStatus.risk.dailyPnLUsd || 0,
          total_unrealized_pnl: 0,
          win_rate: 0,
          total_trades_today: 0,
          // Runtime status fields
          engine_running: runtimeStatus.engineRunning,
          mode: runtimeStatus.mode,
          paused: runtimeStatus.paused,
          daily_stop_hit: runtimeStatus.dailyStopHit,
        };
      }
      
      // PRIORITY 3: Fallback to Supabase for historical data only
      const todayStart = new Date(today).toISOString();
      
      const { data: positions, error: posError } = await supabase
        .from("positions")
        .select("*")
        .eq("user_id", FIXED_USER_ID)
        .gte("opened_at", todayStart);
      
      if (posError) {
        console.error('Error fetching positions:', posError);
      }
      
      const openPositions = (positions || []).filter((p) => !p.closed_at);
      const closedPositions = (positions || []).filter((p) => p.closed_at);
      
      const totalRealizedPnL = closedPositions.reduce((sum, p) => 
        sum + (p.realized_pnl_usd || 0), 0
      );
      
      const wins = closedPositions.filter((p) => (p.realized_pnl_usd || 0) > 0).length;
      const losses = closedPositions.filter((p) => (p.realized_pnl_usd || 0) < 0).length;
      
      const totalEquity = INITIAL_BALANCE + totalRealizedPnL;
      
      const totalPositionValue = openPositions.reduce((sum, p) => 
        sum + Math.abs(p.qty_open * p.entry_price), 0
      );
      const riskHeat = totalEquity > 0 ? (totalPositionValue / totalEquity) * 100 : 0;
      
      const dailyPnLR = totalRealizedPnL / (INITIAL_BALANCE * RISK_PER_TRADE);
      
      return {
        total_equity: totalEquity,
        daily_pnl: totalRealizedPnL,
        daily_pnl_r: dailyPnLR,
        risk_heat: riskHeat,
        spread_percentile: 0,
        open_positions_count: openPositions.length,
        wins_today: wins,
        losses_today: losses,
        date: today,
        total_realized_pnl: totalRealizedPnL,
        total_unrealized_pnl: 0,
        win_rate: (wins + losses) > 0 ? (wins / (wins + losses)) * 100 : 0,
        total_trades_today: wins + losses,
        // Runtime status fields (fallback defaults)
        engine_running: false,
        mode: null as 'paper' | 'live' | null,
        paused: false,
        daily_stop_hit: false,
      };
    },
    refetchInterval: 2000, // Fast refresh for real-time data
    enabled: true,
  });
};
