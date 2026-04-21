import { useQuery } from "@tanstack/react-query";
import type { ModelData } from "@/types/model";
import { MODEL_SEED } from "./mock/seed-data";

export function useModelData() {
  return useQuery<ModelData>({
    queryKey: ["apex", "model-data"],
    queryFn: () => Promise.resolve(MODEL_SEED),
    staleTime: 10_000,
  });
}
