import { useQuery } from "@tanstack/react-query";
import type { AlertRule, AlertFiredEvent } from "@/types/alerts";
import { ALERT_RULES_SEED, ALERT_FIRED_SEED } from "./mock/seed-data";

export function useAlertRules() {
  return useQuery<readonly AlertRule[]>({
    queryKey: ["apex", "alert-rules"],
    queryFn: () => Promise.resolve(ALERT_RULES_SEED),
    staleTime: 10_000,
  });
}

export function useAlertFired() {
  return useQuery<readonly AlertFiredEvent[]>({
    queryKey: ["apex", "alert-fired"],
    queryFn: () => Promise.resolve(ALERT_FIRED_SEED),
    staleTime: 5_000,
  });
}
