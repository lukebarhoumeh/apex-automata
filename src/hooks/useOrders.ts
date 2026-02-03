/**
 * Orders Hook (Event-Driven)
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

export type Order = Tables<"orders">;
export type Fill = Tables<"fills">;

export const useOrders = (limit = 50) => {
  const { isConnected } = useConnectivityBooleans();
  
  return useQuery({
    queryKey: ["orders", FIXED_USER_ID, limit],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("orders")
        .select("*")
        .eq("user_id", FIXED_USER_ID)
        .order("created_at", { ascending: false })
        .limit(limit);

      if (error) throw error;
      return data as Order[];
    },
    // Only poll when disconnected - event bus handles real-time updates
    refetchInterval: isConnected ? false : FALLBACK_POLL_INTERVAL,
    staleTime: isConnected ? 60000 : 2000,
  });
};

export const useFills = (orderId?: string) => {
  const { isConnected } = useConnectivityBooleans();
  
  return useQuery({
    queryKey: ["fills", FIXED_USER_ID, orderId],
    queryFn: async () => {
      let query = supabase
        .from("fills")
        .select("*")
        .eq("user_id", FIXED_USER_ID)
        .order("filled_at", { ascending: false });

      if (orderId) {
        query = query.eq("order_id", orderId);
      } else {
        query = query.limit(100);
      }

      const { data, error } = await query;
      if (error) throw error;
      return data as Fill[];
    },
    refetchInterval: isConnected ? false : FALLBACK_POLL_INTERVAL,
    staleTime: isConnected ? 60000 : 2000,
  });
};
