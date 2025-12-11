import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { FIXED_USER_ID } from "@/contexts/AuthContext";
import { useEffect } from "react";
import type { Tables } from "@/integrations/supabase/types";

export type Order = Tables<"orders">;
export type Fill = Tables<"fills">;

export const useOrders = (limit = 50) => {
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
    refetchInterval: 5000,
  });
};

export const useFills = (orderId?: string) => {
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
    refetchInterval: 5000,
  });
};

export const useRealtimeOrders = (onUpdate: (order: Order) => void) => {
  useEffect(() => {
    const channel = supabase
      .channel("orders-realtime")
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "orders",
        },
        (payload) => {
          if (payload.new) {
            onUpdate(payload.new as Order);
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [onUpdate]);
};

export const useRealtimeFills = (onFill: (fill: Fill) => void) => {
  useEffect(() => {
    const channel = supabase
      .channel("fills-realtime")
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "fills",
        },
        (payload) => {
          if (payload.new) {
            onFill(payload.new as Fill);
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [onFill]);
};
