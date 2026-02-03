/**
 * Signals Hook (Event-Driven)
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

export type Signal = Tables<"signals">;

export interface SignalFilters {
  symbol?: string;
  strategy?: string;
  dateFrom?: string;
  dateTo?: string;
  allowed?: boolean;
}

export const useSignals = (filters?: SignalFilters) => {
  const { isConnected } = useConnectivityBooleans();
  
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
    // Only poll when disconnected - event bus handles real-time updates
    refetchInterval: isConnected ? false : FALLBACK_POLL_INTERVAL,
    staleTime: isConnected ? 60000 : 2000,
  });
};

export const useRecentSignals = (limit = 10) => {
  const { isConnected } = useConnectivityBooleans();
  
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
    refetchInterval: isConnected ? false : FALLBACK_POLL_INTERVAL,
    staleTime: isConnected ? 30000 : 1000,
  });
};

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
