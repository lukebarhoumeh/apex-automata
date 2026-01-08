/**
 * Hook for fetching real-time regime detection state
 */

import { useQuery } from '@tanstack/react-query';

export interface RegimeState {
  regime: 'strong_trend' | 'weak_trend' | 'ranging' | 'choppy';
  confidence: number;
  trendDirection: 'up' | 'down' | 'neutral';
  adx: number;
  plusDI: number;
  minusDI: number;
  atrPercent: number;
  bbWidth: number;
  choppiness: number;
  directionConsistency: number;
  mtfAlignment: number;
  lastUpdated: string;
  regimeSince: string;
}

export interface RegimeStatesResponse {
  states: Record<string, RegimeState>;
  summary: {
    trending: string[];
    ranging: string[];
  };
}

export interface RegimeFilterStats {
  enabled: boolean;
  config: {
    minCompatibilityScore: number;
    counterRegimeStrengthBoost: number;
    maxPositionMultiplier: number;
    minPositionMultiplier: number;
    minRegimeConfidence: number;
    alwaysAllowStrategies: string[];
    requireMTFAlignment: boolean;
    mtfAlignmentThreshold: number;
  };
  strategyTypes: Record<string, string>;
  compatibilityMatrix: Record<string, Record<string, number>>;
}

const API_BASE = 'http://localhost:3001';

async function fetchRegimeStates(): Promise<RegimeStatesResponse> {
  const response = await fetch(`${API_BASE}/api/regime/status`);
  if (!response.ok) {
    throw new Error('Failed to fetch regime states');
  }
  return response.json();
}

async function fetchRegimeFilterStats(): Promise<RegimeFilterStats> {
  const response = await fetch(`${API_BASE}/api/regime/filter/stats`);
  if (!response.ok) {
    throw new Error('Failed to fetch regime filter stats');
  }
  return response.json();
}

export function useRegimeStates() {
  return useQuery({
    queryKey: ['regime-states'],
    queryFn: fetchRegimeStates,
    refetchInterval: 2000, // Update every 2 seconds
    staleTime: 1000,
  });
}

export function useRegimeFilterStats() {
  return useQuery({
    queryKey: ['regime-filter-stats'],
    queryFn: fetchRegimeFilterStats,
    refetchInterval: 5000, // Less frequent updates
    staleTime: 3000,
  });
}

// Helper functions for regime display
export function getRegimeColor(regime: RegimeState['regime']): string {
  switch (regime) {
    case 'strong_trend':
      return '#10b981'; // Emerald/green
    case 'weak_trend':
      return '#84cc16'; // Lime
    case 'ranging':
      return '#f59e0b'; // Amber
    case 'choppy':
      return '#ef4444'; // Red
    default:
      return '#6b7280'; // Gray
  }
}

export function getRegimeLabel(regime: RegimeState['regime']): string {
  switch (regime) {
    case 'strong_trend':
      return 'Strong Trend';
    case 'weak_trend':
      return 'Weak Trend';
    case 'ranging':
      return 'Ranging';
    case 'choppy':
      return 'Choppy';
    default:
      return 'Unknown';
  }
}

export function getRegimeIcon(regime: RegimeState['regime']): string {
  switch (regime) {
    case 'strong_trend':
      return '📈'; // Strong up
    case 'weak_trend':
      return '↗️'; // Mild up
    case 'ranging':
      return '↔️'; // Sideways
    case 'choppy':
      return '⚠️'; // Warning
    default:
      return '❓';
  }
}

export function getTrendDirectionIcon(direction: RegimeState['trendDirection']): string {
  switch (direction) {
    case 'up':
      return '▲';
    case 'down':
      return '▼';
    default:
      return '●';
  }
}

