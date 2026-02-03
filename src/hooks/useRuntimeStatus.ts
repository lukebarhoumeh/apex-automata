/**
 * Runtime Status Hook (Event-Driven)
 * 
 * Uses event bus for real-time updates, fallback polling when disconnected.
 */

import { useQuery } from "@tanstack/react-query";
import { runtimeClient, RuntimeStatus } from "@/services/runtimeClient";
import { useConnectivityBooleans } from "@/runtime/connectivity";

// Fallback poll interval when disconnected (ms)
const FALLBACK_POLL_INTERVAL = 5000;

export const useRuntimeStatus = () => {
  const { isConnected } = useConnectivityBooleans();
  
  return useQuery({
    queryKey: ["runtime-status"],
    queryFn: () => runtimeClient.getStatus(),
    // Only poll when disconnected/stale - events handle updates when connected
    refetchInterval: isConnected ? false : FALLBACK_POLL_INTERVAL,
    retry: 1,
    // Keep data fresh for longer when event-driven
    staleTime: isConnected ? 30000 : 1000,
  });
};
