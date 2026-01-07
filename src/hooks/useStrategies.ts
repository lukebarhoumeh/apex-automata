/**
 * Hook for fetching and managing strategy plugins
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';

export interface StrategyConfig {
  [key: string]: unknown;
}

export interface StrategyInfo {
  id: string;
  name: string;
  description: string;
  version: string;
  category: string;
  tags: string[];
  enabled: boolean;
  config: StrategyConfig;
  stats?: {
    signalsGenerated: number;
    lastSignalTime?: string;
    signalsByDirection?: { buy: number; sell: number };
    avgSignalStrength?: number;
  };
}

export interface StrategyRegistryStats {
  total: number;
  enabled: number;
  byCategory: Record<string, number>;
  strategies: {
    id: string;
    name: string;
    enabled: boolean;
    category: string;
    errorCount: number;
    signalsGenerated: number;
  }[];
}

export interface ConfigParameter {
  key: string;
  name: string;
  description: string;
  type: 'number' | 'boolean' | 'string' | 'select' | 'range';
  default: number | boolean | string;
  min?: number;
  max?: number;
  step?: number;
  options?: { value: string | number; label: string }[];
}

export interface DetailedStrategyInfo extends StrategyInfo {
  author: string;
  configSchema: { parameters: ConfigParameter[] };
  requiredIndicators: { name: string; required: boolean; description?: string }[];
  regimeCompatibility: {
    regime: string;
    compatibility: string;
    positionMultiplier: number;
    notes?: string;
  }[];
  registration: {
    loadTime: string;
    enabled: boolean;
    errorCount: number;
    lastError?: { message: string; timestamp: string };
  };
  state: Record<string, unknown>;
}

const API_BASE = 'http://localhost:3001';

async function fetchStrategies(): Promise<{
  strategies: StrategyInfo[];
  total: number;
  enabled: number;
}> {
  const response = await fetch(`${API_BASE}/api/strategies`);
  if (!response.ok) {
    throw new Error('Failed to fetch strategies');
  }
  return response.json();
}

async function fetchStrategyStats(): Promise<StrategyRegistryStats> {
  const response = await fetch(`${API_BASE}/api/strategies/stats`);
  if (!response.ok) {
    throw new Error('Failed to fetch strategy stats');
  }
  return response.json();
}

async function fetchStrategyDetail(strategyId: string): Promise<DetailedStrategyInfo> {
  const response = await fetch(`${API_BASE}/api/strategies/${strategyId}`);
  if (!response.ok) {
    throw new Error(`Failed to fetch strategy: ${strategyId}`);
  }
  return response.json();
}

async function enableStrategy(strategyId: string): Promise<void> {
  const response = await fetch(`${API_BASE}/api/strategies/${strategyId}/enable`, {
    method: 'POST',
  });
  if (!response.ok) {
    throw new Error(`Failed to enable strategy: ${strategyId}`);
  }
}

async function disableStrategy(strategyId: string): Promise<void> {
  const response = await fetch(`${API_BASE}/api/strategies/${strategyId}/disable`, {
    method: 'POST',
  });
  if (!response.ok) {
    throw new Error(`Failed to disable strategy: ${strategyId}`);
  }
}

async function updateStrategyConfig(
  strategyId: string,
  config: StrategyConfig
): Promise<void> {
  const response = await fetch(`${API_BASE}/api/strategies/${strategyId}/config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  });
  if (!response.ok) {
    throw new Error(`Failed to update strategy config: ${strategyId}`);
  }
}

// Hooks

export function useStrategies() {
  return useQuery({
    queryKey: ['strategies'],
    queryFn: fetchStrategies,
    refetchInterval: 5000,
    staleTime: 3000,
  });
}

export function useStrategyStats() {
  return useQuery({
    queryKey: ['strategy-stats'],
    queryFn: fetchStrategyStats,
    refetchInterval: 5000,
    staleTime: 3000,
  });
}

export function useStrategyDetail(strategyId: string | null) {
  return useQuery({
    queryKey: ['strategy-detail', strategyId],
    queryFn: () => strategyId ? fetchStrategyDetail(strategyId) : null,
    enabled: !!strategyId,
    staleTime: 2000,
  });
}

export function useEnableStrategy() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: enableStrategy,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['strategies'] });
      queryClient.invalidateQueries({ queryKey: ['strategy-stats'] });
    },
  });
}

export function useDisableStrategy() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: disableStrategy,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['strategies'] });
      queryClient.invalidateQueries({ queryKey: ['strategy-stats'] });
    },
  });
}

export function useUpdateStrategyConfig() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: ({ strategyId, config }: { strategyId: string; config: StrategyConfig }) =>
      updateStrategyConfig(strategyId, config),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['strategies'] });
      queryClient.invalidateQueries({ queryKey: ['strategy-detail'] });
    },
  });
}

// Helper functions

export function getCategoryColor(category: string): string {
  switch (category) {
    case 'trend':
      return '#10b981';
    case 'mean-reversion':
      return '#6366f1';
    case 'momentum':
      return '#f59e0b';
    case 'volatility':
      return '#ef4444';
    case 'hybrid':
      return '#8b5cf6';
    default:
      return '#6b7280';
  }
}

export function getCompatibilityColor(compatibility: string): string {
  switch (compatibility) {
    case 'optimal':
      return '#10b981';
    case 'compatible':
      return '#84cc16';
    case 'neutral':
      return '#f59e0b';
    case 'incompatible':
      return '#ef4444';
    default:
      return '#6b7280';
  }
}

