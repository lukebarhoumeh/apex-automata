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
        .single();

      if (error && error.code !== 'PGRST116') throw error;
      return data as AccountMetrics | null;
    },
    refetchInterval: 3000,
  });
};
