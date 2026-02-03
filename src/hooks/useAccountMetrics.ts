/**
 * Account Metrics Hook (Sprint 1.4 - Deprecated for P&L)
 * 
 * This hook now exists ONLY for backward compatibility with
 * Supabase account_metrics table queries.
 * 
 * For P&L display, use usePnLSnapshot() or useCalculatedMetrics().
 * This hook should NOT be used for equity/P&L in the main dashboard.
 */

import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { FIXED_USER_ID } from "@/contexts/AuthContext";

export interface AccountMetrics {
  total_equity: number;
  daily_pnl: number;
  daily_pnl_r: number;
  risk_heat: number;
  spread_percentile: number;
  open_positions_count: number;
  wins_today: number;
  losses_today: number;
  date: string;
}

/**
 * @deprecated Use usePnLSnapshot() for P&L display.
 * This hook is for Supabase account_metrics table only.
 */
export const useAccountMetrics = () => {
  return useQuery({
    queryKey: ["account-metrics"],
    queryFn: async () => {
      const today = new Date().toISOString().split('T')[0];
      
      const { data, error } = await supabase
        .from("account_metrics")
        .select("*")
        .eq("user_id", FIXED_USER_ID)
        .eq("date", today)
        .maybeSingle();

      if (error) {
        console.error('Error fetching account metrics:', error);
        // Return null - let consumers handle missing data
        return null;
      }
      
      return data as AccountMetrics | null;
    },
    // Low priority - not used for live P&L display
    refetchInterval: 30000,
    staleTime: 10000,
  });
};
