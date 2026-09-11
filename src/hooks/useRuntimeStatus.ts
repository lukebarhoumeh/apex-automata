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

/**
 * Slow REST cadence while the WS is healthy. The 1.5s StatusUpdate keeps the
 * hot fields (engineRunning, mode, killSwitch, sessionId, pnl, latencies)
 * fresh via cache merge; this refetch only exists to refresh the REST-only
 * exchange health blocks (`ws`, `rest`, `exchangeHealth`) the footer reads.
 * 4 req/min vs the ~50 req/min the per-event invalidation used to generate.
 */
const CONNECTED_REFRESH_INTERVAL = 15_000;

export const useRuntimeStatus = () => {
  const { isConnected } = useConnectivityBooleans();
  
  return useQuery<RuntimeStatus>({
    queryKey: ["runtime-status"],
    queryFn: () => runtimeClient.getStatus(),
    refetchInterval: isConnected ? CONNECTED_REFRESH_INTERVAL : FALLBACK_POLL_INTERVAL,
    retry: 1,
    // Keep data fresh for longer when event-driven
    staleTime: isConnected ? 30000 : 1000,
  });
};
