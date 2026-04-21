import { useQuery } from "@tanstack/react-query";
import type { BacktestData } from "@/types/backtest";
import { BACKTEST_SEED } from "./mock/seed-data";

export function useBacktestData() {
  return useQuery<BacktestData>({
    queryKey: ["apex", "backtest-data"],
    queryFn: () => Promise.resolve(BACKTEST_SEED),
    staleTime: 30_000,
  });
}
