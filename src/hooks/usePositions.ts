/**
 * Positions Hook (Event-Driven)
 * 
 * Uses event bus for real-time updates, fallback polling when disconnected.
 */

import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { FIXED_USER_ID } from "@/contexts/AuthContext";
import { useConnectivityBooleans } from "@/runtime/connectivity";

// Fallback poll interval when disconnected
const FALLBACK_POLL_INTERVAL = 10000;

export interface Position {
  id: string;
  user_id: string;
  symbol: string;
  strategy: string;
  side: "long" | "short";
  qty_open: number;
  entry_price: number;
  stop_price_at_entry: number;
  take_profit_price: number | null;
  opened_at: string;
  closed_at: string | null;
  exit_price: number | null;
  exit_reason: string | null;
  realized_pnl_usd: number | null;
  realized_r: number | null;
  created_at: string;
}

export const usePositions = () => {
  const { isConnected } = useConnectivityBooleans();
  
  return useQuery({
    queryKey: ["positions", FIXED_USER_ID],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("positions")
        .select("*")
        .eq("user_id", FIXED_USER_ID)
        .is("closed_at", null)
        .order("opened_at", { ascending: false });

      if (error) throw error;
      return data;
    },
    // Only poll when disconnected - Supabase realtime + WS events handle updates
    refetchInterval: isConnected ? false : FALLBACK_POLL_INTERVAL,
    staleTime: isConnected ? 60000 : 2000,
  });
};

export const useClosedPositions = (limit = 50) => {
  const { isConnected } = useConnectivityBooleans();
  
  return useQuery({
    queryKey: ["closed-positions", FIXED_USER_ID, limit],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("positions")
        .select("*")
        .eq("user_id", FIXED_USER_ID)
        .not("closed_at", "is", null)
        .order("closed_at", { ascending: false })
        .limit(limit);

      if (error) throw error;
      return data as Position[];
    },
    refetchInterval: isConnected ? false : FALLBACK_POLL_INTERVAL,
    staleTime: isConnected ? 60000 : 5000,
  });
};
