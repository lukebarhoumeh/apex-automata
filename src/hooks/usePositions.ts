import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { FIXED_USER_ID } from "@/contexts/AuthContext";

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
    refetchInterval: 5000,
  });
};

export const useRealtimePositions = (onUpdate: (position: Position) => void) => {
  const channel = supabase
    .channel("positions-changes")
    .on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: "positions",
      },
      (payload) => {
        console.log("Position update:", payload);
        if (payload.new) {
          onUpdate(payload.new as Position);
        }
      }
    )
    .subscribe();

  return () => {
    supabase.removeChannel(channel);
  };
};
