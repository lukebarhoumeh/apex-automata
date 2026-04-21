import { useQuery } from "@tanstack/react-query";
import type { RiskData } from "@/types/risk";
import { RISK_SEED } from "./mock/seed-data";

export function useRiskData() {
  return useQuery<RiskData>({
    queryKey: ["apex", "risk-data"],
    queryFn: () => Promise.resolve(RISK_SEED),
    staleTime: 5_000,
  });
}
