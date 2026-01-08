/**
 * Hook for checking backend runtime health status
 */

import { useQuery } from '@tanstack/react-query';

const RUNTIME_URL = import.meta.env.VITE_RUNTIME_API_URL || 'http://localhost:3001';

export function useRuntimeHealth() {
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
    refetchInterval: 5000,
    retry: false,
    staleTime: 4000,
  });
}

export function useRuntimeHealthDetails() {
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
    refetchInterval: 10000,
    retry: 1,
  });
}
