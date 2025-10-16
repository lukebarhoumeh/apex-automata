import { useQuery } from "@tanstack/react-query";
import { runtimeClient, RuntimeStatus } from "@/services/runtimeClient";

export const useRuntimeStatus = () => {
  return useQuery({
    queryKey: ["runtime-status"],
    queryFn: () => runtimeClient.getStatus(),
    refetchInterval: 2000, // Poll every 2 seconds
    retry: 1,
    staleTime: 1000,
  });
};

export const useRuntimeHealth = () => {
  return useQuery({
    queryKey: ["runtime-health"],
    queryFn: () => runtimeClient.checkHealth(),
    refetchInterval: 5000,
    retry: false,
  });
};
