import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

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

export const useAccountMetrics = () => {
  return useQuery({
    queryKey: ["account-metrics"],
    queryFn: async () => {
      const today = new Date().toISOString().split('T')[0];
      
      const { data, error } = await supabase
        .from("account_metrics")
        .select("*")
        .eq("date", today)
        .maybeSingle();

      if (error) {
        console.error('Error fetching account metrics:', error);
        // Return default metrics if no data exists
        return {
          total_equity: 52450.00,
          daily_pnl: 0,
          daily_pnl_r: 0,
          risk_heat: 0,
          spread_percentile: 0,
          open_positions_count: 0,
          wins_today: 0,
          losses_today: 0,
          date: today
        } as AccountMetrics;
      }
      
      return data as AccountMetrics || {
        total_equity: 52450.00,
        daily_pnl: 0,
        daily_pnl_r: 0,
        risk_heat: 0,
        spread_percentile: 0,
        open_positions_count: 0,
        wins_today: 0,
        losses_today: 0,
        date: today
      } as AccountMetrics;
    },
    refetchInterval: 3000,
  });
};
