import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { OrderRecord, FillRecord, OrderStats } from "@/types/orders";
import { ORDERS_SEED, FILLS_SEED } from "./mock/seed-data";

export function useOrders() {
  return useQuery<readonly OrderRecord[]>({
    queryKey: ["apex", "orders"],
    queryFn: () => Promise.resolve(ORDERS_SEED),
    staleTime: 1_000,
  });
}

export function useFills() {
  return useQuery<readonly FillRecord[]>({
    queryKey: ["apex", "fills"],
    queryFn: () => Promise.resolve(FILLS_SEED),
    staleTime: 1_000,
  });
}

export function useOrderStats(orders: readonly OrderRecord[] | undefined): OrderStats {
  return useMemo(() => {
    const total = orders?.length ?? 0;
    const filled = orders?.filter((o) => o.status === "FILLED").length ?? 0;
    const pending = orders?.filter((o) => o.status === "PENDING" || o.status === "WORKING" || o.status === "PARTIAL").length ?? 0;
    const cancelled = orders?.filter((o) => o.status === "CANCELLED").length ?? 0;
    const rejected = orders?.filter((o) => o.status === "REJECTED").length ?? 0;
    return {
      total,
      filled,
      pending,
      cancelled,
      rejected,
      fillRate: total > 0 ? filled / total : 0,
    };
  }, [orders]);
}
