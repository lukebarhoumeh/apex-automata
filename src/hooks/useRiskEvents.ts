import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { FIXED_USER_ID } from "@/contexts/AuthContext";
import { useEffect, useState } from "react";
import type { Tables } from "@/integrations/supabase/types";

export type RiskEvent = Tables<"risk_events">;

export const useRiskEvents = () => {
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
    refetchInterval: 5000,
  });
};

export const useActiveRiskEvents = () => {
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
    refetchInterval: 3000,
  });
};

export const useRealtimeRiskEvents = (onNewEvent: (event: RiskEvent) => void) => {
  useEffect(() => {
    const channel = supabase
      .channel("risk-events-realtime")
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "risk_events",
        },
        (payload) => {
          if (payload.new) {
            onNewEvent(payload.new as RiskEvent);
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [onNewEvent]);
};
