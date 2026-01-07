/**
 * Hook for fetching meta-filter (trade quality) statistics
 */

import { useQuery } from '@tanstack/react-query';

export interface StrategyPerformance {
  totalTrades: number;
  wins: number;
  losses: number;
  breakeven: number;
  winRate: number;
  avgWinPnl: number;
  avgLossPnl: number;
  profitFactor: number;
  consecutiveLosses: number;
  consecutiveWins: number;
  maxConsecutiveLosses: number;
  avgWinningStrength: number;
  strengthPercentile25: number;
  strengthPercentile50: number;
  lastTradeTime: string | null;
}

export interface MetaFilterStats {
  enabled: boolean;
  config: {
    coldStreakEnabled: boolean;
    coldStreakThreshold: number;
    coldStreakCooldownMs: number;
    strengthFilterEnabled: boolean;
    minStrengthPercentile: number;
    minAbsoluteStrength: number;
    volumeConfirmEnabled: boolean;
    minVolumeRatio: number;
    timeFilterEnabled: boolean;
    lowLiquidityHours: number[];
    preferredHours: number[];
    crossConfirmEnabled: boolean;
    minQualityScore: number;
  };
  strategies: Record<string, {
    totalTrades: number;
    winRate: number;
    consecutiveLosses: number;
    avgWinningStrength: number;
    profitFactor: number;
  }>;
  coldStreaks: Record<string, boolean>;
  decisionLogSize: number;
}

export interface FilterDecision {
  id: string;
  timestamp: string;
  signalId: string;
  symbol: string;
  strategy: string;
  direction: 'buy' | 'sell';
  signalStrength: number;
  volumeRatio?: number;
  regime?: string;
  hourOfDay: number;
  passed: boolean;
  metaScore: number;
  rulesEvaluated: {
    rule: string;
    passed: boolean;
    reason: string;
    weight: number;
  }[];
}

const API_BASE = 'http://localhost:3001';

async function fetchMetaFilterStats(): Promise<MetaFilterStats> {
  const response = await fetch(`${API_BASE}/api/metafilter/stats`);
  if (!response.ok) {
    throw new Error('Failed to fetch meta filter stats');
  }
  return response.json();
}

async function fetchStrategyPerformance(): Promise<{
  strategies: Record<string, StrategyPerformance>;
  totalStrategies: number;
}> {
  const response = await fetch(`${API_BASE}/api/metafilter/performance`);
  if (!response.ok) {
    throw new Error('Failed to fetch strategy performance');
  }
  return response.json();
}

async function fetchRecentDecisions(limit = 20): Promise<{
  decisions: FilterDecision[];
  count: number;
}> {
  const response = await fetch(`${API_BASE}/api/metafilter/decisions?limit=${limit}`);
  if (!response.ok) {
    throw new Error('Failed to fetch filter decisions');
  }
  return response.json();
}

export function useMetaFilterStats() {
  return useQuery({
    queryKey: ['metafilter-stats'],
    queryFn: fetchMetaFilterStats,
    refetchInterval: 3000,
    staleTime: 2000,
  });
}

export function useStrategyPerformance() {
  return useQuery({
    queryKey: ['strategy-performance'],
    queryFn: fetchStrategyPerformance,
    refetchInterval: 5000,
    staleTime: 3000,
  });
}

export function useRecentDecisions(limit = 20) {
  return useQuery({
    queryKey: ['filter-decisions', limit],
    queryFn: () => fetchRecentDecisions(limit),
    refetchInterval: 5000,
    staleTime: 2000,
  });
}

// Helper functions
export function getColdStreakColor(active: boolean): string {
  return active ? '#ef4444' : '#10b981';
}

export function getWinRateColor(winRate: number): string {
  if (winRate >= 0.6) return '#10b981';
  if (winRate >= 0.5) return '#84cc16';
  if (winRate >= 0.4) return '#f59e0b';
  return '#ef4444';
}

export function getQualityScoreColor(score: number): string {
  if (score >= 0.8) return '#10b981';
  if (score >= 0.6) return '#84cc16';
  if (score >= 0.5) return '#f59e0b';
  return '#ef4444';
}

