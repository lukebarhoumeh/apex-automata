import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "@/hooks/use-toast";

export interface Model {
  id: string;
  name: string;
  version: string;
  path: string;
  sha256: string | null;
  active: boolean;
  metrics: {
    roc_auc?: number;
    precision?: number;
    recall?: number;
    f1?: number;
    calibration?: Array<{ predicted: number; actual: number }>;
  } | null;
  input_schema: any;
  created_at: string;
  user_id: string;
}

export const useActiveModel = () => {
  return useQuery({
    queryKey: ["active-model"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("models")
        .select("*")
        .eq("active", true)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (error) throw error;
      return data as Model | null;
    },
  });
};

export const useSignalAcceptanceStats = () => {
  return useQuery({
    queryKey: ["signal-acceptance-stats"],
    queryFn: async () => {
      // Get signals from last 7 days
      const sevenDaysAgo = new Date();
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

      const { data, error } = await supabase
        .from("signals")
        .select("allowed, meta_prob")
        .gte("created_at", sevenDaysAgo.toISOString())
        .order("created_at", { ascending: false });

      if (error) throw error;

      const total = data.length;
      const allowed = data.filter((s) => s.allowed).length;
      const rejected = total - allowed;
      const acceptanceRate = total > 0 ? (allowed / total) * 100 : 0;

      // Calculate average meta_prob for allowed vs rejected
      const allowedProbs = data.filter((s) => s.allowed && s.meta_prob).map((s) => s.meta_prob);
      const rejectedProbs = data.filter((s) => !s.allowed && s.meta_prob).map((s) => s.meta_prob);
      
      const avgAllowedProb = allowedProbs.length > 0 
        ? allowedProbs.reduce((a, b) => a + b, 0) / allowedProbs.length 
        : 0;
      
      const avgRejectedProb = rejectedProbs.length > 0
        ? rejectedProbs.reduce((a, b) => a + b, 0) / rejectedProbs.length
        : 0;

      return {
        total,
        allowed,
        rejected,
        acceptanceRate,
        avgAllowedProb,
        avgRejectedProb,
      };
    },
    refetchInterval: 30000, // Refresh every 30s
  });
};

export const useUpdateModelThreshold = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (threshold: number) => {
      const { runtimeClient } = await import("@/services/runtimeClient");
      
      // Update runtime config
      await runtimeClient.updateSignalsConfig({
        meta: {
          enabled: true,
          threshold,
        },
      });

      // Also update in strategy_signals table
      const { data: { user } } = await supabase.auth.getUser();
      if (user) {
        const { data: existing } = await supabase
          .from("strategy_signals")
          .select("id, params")
          .eq("name", "meta")
          .maybeSingle();

        if (existing) {
          const currentParams = (existing.params as Record<string, any>) || {};
          await supabase
            .from("strategy_signals")
            .update({
              params: { ...currentParams, threshold },
            })
            .eq("id", existing.id);
        }
      }

      return { threshold };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["strategy_signals"] });
      toast({
        title: "Threshold Updated",
        description: "ML model threshold has been applied to the runtime",
      });
    },
    onError: (error) => {
      toast({
        title: "Update Failed",
        description: error instanceof Error ? error.message : "Failed to update threshold",
        variant: "destructive",
      });
    },
  });
};
