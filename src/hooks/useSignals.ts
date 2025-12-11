import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { FIXED_USER_ID } from "@/contexts/AuthContext";
import { useEffect, useState, useCallback } from "react";
import type { Tables } from "@/integrations/supabase/types";

export type Signal = Tables<"signals">;

export interface SignalFilters {
  symbol?: string;
  strategy?: string;
  dateFrom?: string;
  dateTo?: string;
  allowed?: boolean;
}

export const useSignals = (filters?: SignalFilters) => {
  return useQuery({
    queryKey: ["signals", FIXED_USER_ID, filters],
    queryFn: async () => {
      let query = supabase
        .from("signals")
        .select("*")
        .eq("user_id", FIXED_USER_ID)
        .order("decided_at", { ascending: false })
        .limit(100);

      if (filters?.symbol) {
        query = query.eq("symbol", filters.symbol);
      }
      if (filters?.strategy) {
        query = query.eq("strategy", filters.strategy as any);
      }
      if (filters?.dateFrom) {
        query = query.gte("decided_at", filters.dateFrom);
      }
      if (filters?.dateTo) {
        query = query.lte("decided_at", filters.dateTo);
      }
      if (filters?.allowed !== undefined) {
        query = query.eq("allowed", filters.allowed);
      }

      const { data, error } = await query;
      if (error) throw error;
      return data as Signal[];
    },
    refetchInterval: 5000,
  });
};

export const useRecentSignals = (limit = 10) => {
  return useQuery({
    queryKey: ["recent-signals", FIXED_USER_ID, limit],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("signals")
        .select("*")
        .eq("user_id", FIXED_USER_ID)
        .order("decided_at", { ascending: false })
        .limit(limit);

      if (error) throw error;
      return data as Signal[];
    },
    refetchInterval: 3000,
  });
};

export const useRealtimeSignals = (onNewSignal: (signal: Signal) => void) => {
  useEffect(() => {
    const channel = supabase
      .channel("signals-realtime")
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "signals",
        },
        (payload) => {
          if (payload.new) {
            onNewSignal(payload.new as Signal);
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [onNewSignal]);
};

// Get related orders/positions for a signal
export const useSignalDetails = (signalId: string | null) => {
  return useQuery({
    queryKey: ["signal-details", signalId],
    queryFn: async () => {
      if (!signalId) return null;

      const [signalRes, ordersRes] = await Promise.all([
        supabase.from("signals").select("*").eq("id", signalId).single(),
        supabase.from("orders").select("*").eq("signal_id", signalId),
      ]);

      if (signalRes.error) throw signalRes.error;

      return {
        signal: signalRes.data as Signal,
        orders: ordersRes.data || [],
      };
    },
    enabled: !!signalId,
  });
};
