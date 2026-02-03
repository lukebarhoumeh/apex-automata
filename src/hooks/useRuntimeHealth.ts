/**
 * Runtime Health Hook (Event-Driven)
 * 
 * Uses event bus for updates, minimal polling as fallback.
 */

import { useQuery } from '@tanstack/react-query';
import { useConnectivityBooleans } from '@/runtime/connectivity';

const RUNTIME_URL = import.meta.env.VITE_RUNTIME_API_URL || 'http://localhost:3001';

// Fallback poll interval when disconnected
const FALLBACK_POLL_INTERVAL = 10000;

export function useRuntimeHealth() {
  const { isConnected } = useConnectivityBooleans();
  
  return useQuery({
    queryKey: ['runtime-health'],
    queryFn: async () => {
      try {
        const res = await fetch(`${RUNTIME_URL}/health`);
        return res.ok;
      } catch {
        return false;
      }
    },
    // Only poll when disconnected - connectivity service handles this otherwise
    refetchInterval: isConnected ? false : FALLBACK_POLL_INTERVAL,
    retry: false,
    staleTime: isConnected ? 30000 : 4000,
  });
}

export function useRuntimeHealthDetails() {
  const { isConnected } = useConnectivityBooleans();
  
  return useQuery({
    queryKey: ['runtime-health-details'],
    queryFn: async () => {
      const res = await fetch(`${RUNTIME_URL}/health`);
      if (!res.ok) {
        throw new Error('Runtime unhealthy');
      }
      return res.json() as Promise<{
        status: string;
        uptime: number;
        timestamp: string;
        version?: string;
      }>;
    },
    refetchInterval: isConnected ? false : 15000,
    retry: 1,
    staleTime: isConnected ? 60000 : 5000,
  });
}
