import { useQuery } from "@tanstack/react-query";
import type { SignalRecord } from "@/types/signals";
import type { StrategyConfig, MetaModelInfo } from "@/types/strategy";
import { SIGNAL_SEED, STRATEGY_CONFIG_SEED, META_MODEL_SEED } from "./mock/seed-data";

export function useSignalStream() {
  return useQuery<readonly SignalRecord[]>({
    queryKey: ["apex", "signal-stream"],
    queryFn: () => Promise.resolve(SIGNAL_SEED),
    staleTime: 1_000,
  });
}

export function useStrategyConfigs() {
  return useQuery<readonly StrategyConfig[]>({
    queryKey: ["apex", "strategy-configs"],
    queryFn: () => Promise.resolve(STRATEGY_CONFIG_SEED),
    staleTime: 5_000,
  });
}

export function useMetaModel() {
  return useQuery<MetaModelInfo>({
    queryKey: ["apex", "meta-model"],
    queryFn: () => Promise.resolve(META_MODEL_SEED),
    staleTime: 30_000,
  });
}
