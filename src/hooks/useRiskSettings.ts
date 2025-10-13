import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "@/hooks/use-toast";

export interface RiskSettings {
  id: string;
  per_trade_risk: number;
  max_heat: number;
  daily_stop_r: number;
  kill_switch_enabled: boolean;
  spread_threshold: number;
  atr_burst_multiplier: number;
}

export const useRiskSettings = () => {
  return useQuery({
    queryKey: ["risk-settings"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("risk_settings")
        .select("*")
        .single();

      if (error && error.code !== 'PGRST116') throw error;
      return data as RiskSettings | null;
    },
  });
};

export const useUpdateRiskSettings = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (settings: Partial<RiskSettings>) => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error("Not authenticated");

      const { data, error } = await supabase
        .from("risk_settings")
        .update(settings)
        .eq("user_id", user.id)
        .select()
        .single();

      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["risk-settings"] });
      toast({
        title: "Settings Updated",
        description: "Risk management settings have been saved.",
      });
    },
    onError: (error) => {
      toast({
        title: "Update Failed",
        description: error.message,
        variant: "destructive",
      });
    },
  });
};
