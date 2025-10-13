import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export interface Position {
  id: string;
  symbol: string;
  side: "long" | "short";
  entry_price: number;
  current_price: number;
  size: number;
  pnl: number;
  pnl_r: number;
  meta_prob: number | null;
  strategy: string;
  stop_loss: number;
  take_profit: number;
  risk_progress: number;
  time_opened: string;
  status: "open" | "closed";
}

export const usePositions = () => {
  return useQuery({
    queryKey: ["positions"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("positions")
        .select("*")
        .eq("status", "open")
        .order("time_opened", { ascending: false });

      if (error) throw error;
      return data as Position[];
    },
    refetchInterval: 5000, // Refresh every 5 seconds
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
