import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "@/hooks/use-toast";
import { useUserId } from "@/contexts/AuthContext";
import { invokeFunction } from "@/services/supabaseFunctions";

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
  const userId = useUserId();

  return useQuery({
    queryKey: ["risk-settings", userId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("risk_settings")
        .select("*")
        .eq("user_id", userId)
        .maybeSingle();

      if (error) throw error;
      return data as RiskSettings | null;
    },
  });
};

export const useUpdateRiskSettings = () => {
  const queryClient = useQueryClient();
  const userId = useUserId();

  return useMutation({
    mutationFn: async (settings: Partial<RiskSettings>) => {
      const result = await invokeFunction<
        Partial<RiskSettings> & { user_id: string },
        { ok: boolean; id: string }
      >("risk-settings-update", { user_id: userId, ...settings });

      return result;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["risk-settings", userId] });
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
