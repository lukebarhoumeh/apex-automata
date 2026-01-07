/**
 * Hook for fetching and managing extended risk controls
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';

export interface RiskStatus {
  tradingAllowed: boolean;
  killSwitchActive: boolean;
  metrics: {
    currentExposure: number;
    dailyPnL: number;
    dailyLossPercentage: number;
    maxDrawdown: number;
    consecutiveLosses: number;
    openOrders: number;
    lastUpdated: string;
  };
  positions: {
    open: number;
    max: number;
  };
}

export interface RiskAnalytics {
  session: {
    trades: number;
    wins: number;
    losses: number;
    winRate: number;
    profitFactor: number;
  };
  equity: {
    current: number;
    dailyPnL: number;
    maxDrawdown: number;
  };
  streaks: {
    consecutiveWins: number;
    consecutiveLosses: number;
    maxConsecutiveLosses: number;
  };
  riskMetrics: Record<string, unknown>;
}

export interface BlockedEntities {
  blockedSymbols: string[];
  count: number;
}

export interface SoftLaunchStatus {
  active: boolean;
  tradesDone: number;
  maxTrades: number;
  config: {
    riskPerTradeMultiplier?: number;
    maxPositionSizeMultiplier?: number;
  } | null;
}

const API_BASE = 'http://localhost:3001';

async function fetchRiskStatus(): Promise<RiskStatus> {
  const response = await fetch(`${API_BASE}/api/risk/status`);
  if (!response.ok) {
    throw new Error('Failed to fetch risk status');
  }
  return response.json();
}

async function fetchRiskAnalytics(): Promise<RiskAnalytics> {
  const response = await fetch(`${API_BASE}/api/risk/analytics`);
  if (!response.ok) {
    throw new Error('Failed to fetch risk analytics');
  }
  return response.json();
}

async function fetchBlockedSymbols(): Promise<BlockedEntities> {
  const response = await fetch(`${API_BASE}/api/risk/blocked/symbols`);
  if (!response.ok) {
    throw new Error('Failed to fetch blocked symbols');
  }
  return response.json();
}

async function fetchSoftLaunchStatus(): Promise<SoftLaunchStatus> {
  const response = await fetch(`${API_BASE}/api/risk/soft-launch`);
  if (!response.ok) {
    throw new Error('Failed to fetch soft launch status');
  }
  return response.json();
}

async function toggleKillSwitch(active: boolean, reason?: string): Promise<void> {
  const response = await fetch(`${API_BASE}/api/risk/killswitch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ active, reason }),
  });
  if (!response.ok) {
    throw new Error('Failed to toggle kill switch');
  }
}

async function unblockSymbol(symbol: string): Promise<void> {
  const response = await fetch(`${API_BASE}/api/risk/unblock/symbol/${symbol}`, {
    method: 'POST',
  });
  if (!response.ok) {
    throw new Error(`Failed to unblock symbol: ${symbol}`);
  }
}

async function resetDailyTracking(): Promise<void> {
  const response = await fetch(`${API_BASE}/api/risk/reset/daily`, {
    method: 'POST',
  });
  if (!response.ok) {
    throw new Error('Failed to reset daily tracking');
  }
}

// Hooks

export function useRiskStatus() {
  return useQuery({
    queryKey: ['risk-status'],
    queryFn: fetchRiskStatus,
    refetchInterval: 3000,
    staleTime: 2000,
  });
}

export function useRiskAnalytics() {
  return useQuery({
    queryKey: ['risk-analytics'],
    queryFn: fetchRiskAnalytics,
    refetchInterval: 5000,
    staleTime: 3000,
  });
}

export function useBlockedSymbols() {
  return useQuery({
    queryKey: ['blocked-symbols'],
    queryFn: fetchBlockedSymbols,
    refetchInterval: 5000,
    staleTime: 3000,
  });
}

export function useSoftLaunchStatus() {
  return useQuery({
    queryKey: ['soft-launch-status'],
    queryFn: fetchSoftLaunchStatus,
    refetchInterval: 10000,
    staleTime: 5000,
  });
}

export function useToggleKillSwitch() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: ({ active, reason }: { active: boolean; reason?: string }) =>
      toggleKillSwitch(active, reason),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['risk-status'] });
    },
  });
}

export function useUnblockSymbol() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: unblockSymbol,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['blocked-symbols'] });
    },
  });
}

export function useResetDailyTracking() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: resetDailyTracking,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['risk-status'] });
      queryClient.invalidateQueries({ queryKey: ['risk-analytics'] });
      queryClient.invalidateQueries({ queryKey: ['blocked-symbols'] });
    },
  });
}

// Utility functions

export function getRiskLevelColor(pnl: number, maxLoss: number): string {
  const ratio = Math.abs(pnl) / Math.abs(maxLoss);
  if (pnl >= 0) return '#10b981'; // Green - profit
  if (ratio < 0.5) return '#f59e0b'; // Yellow - caution
  if (ratio < 0.8) return '#f97316'; // Orange - warning
  return '#ef4444'; // Red - danger
}

export function formatPnL(value: number): string {
  const sign = value >= 0 ? '+' : '';
  return `${sign}$${Math.abs(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function formatPercent(value: number): string {
  const sign = value >= 0 ? '+' : '';
  return `${sign}${(value * 100).toFixed(2)}%`;
}

