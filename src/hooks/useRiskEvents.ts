/**
 * Risk Events Hook (Event-Driven)
 * 
 * Uses event bus for real-time updates, fallback polling when disconnected.
 */

import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { FIXED_USER_ID } from "@/contexts/AuthContext";
import { useConnectivityBooleans } from "@/runtime/connectivity";
import type { Tables } from "@/integrations/supabase/types";

// Fallback poll interval when disconnected
const FALLBACK_POLL_INTERVAL = 10000;

export type RiskEvent = Tables<"risk_events">;

export const useRiskEvents = () => {
  const { isConnected } = useConnectivityBooleans();
  
  return useQuery({
    queryKey: ["risk-events", FIXED_USER_ID],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("risk_events")
        .select("*")
        .eq("user_id", FIXED_USER_ID)
        .order("triggered_at", { ascending: false })
        .limit(50);

      if (error) throw error;
      return data as RiskEvent[];
    },
    // Only poll when disconnected - event bus handles real-time updates
    refetchInterval: isConnected ? false : FALLBACK_POLL_INTERVAL,
    staleTime: isConnected ? 60000 : 2000,
  });
};

export const useActiveRiskEvents = () => {
  const { isConnected } = useConnectivityBooleans();
  
  return useQuery({
    queryKey: ["active-risk-events", FIXED_USER_ID],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("risk_events")
        .select("*")
        .eq("user_id", FIXED_USER_ID)
        .eq("active", true)
        .order("triggered_at", { ascending: false });

      if (error) throw error;
      return data as RiskEvent[];
    },
    refetchInterval: isConnected ? false : FALLBACK_POLL_INTERVAL,
    staleTime: isConnected ? 30000 : 1000,
  });
};
