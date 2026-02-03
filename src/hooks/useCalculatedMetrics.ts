/**
 * Calculated Metrics Hook (Event-Driven, Sprint 1.4)
 * 
 * Derives ALL metrics from the canonical pnl:snapshot.
 * NO local equity calculations. NO hardcoded INITIAL_BALANCE.
 * 
 * This hook combines P&L snapshot with session stats and runtime status
 * to provide a unified metrics object for the dashboard.
 */

import { useQuery } from "@tanstack/react-query";
import { usePnLSnapshot } from "./usePnLSnapshot";
import { useSessionStats } from "./useSessionStats";
import { useRuntimeStatus } from "./useRuntimeStatus";
import { useConnectivityBooleans } from "@/runtime/connectivity";

// Fallback poll interval when disconnected (only for win/loss counts)
const FALLBACK_POLL_INTERVAL = 10000;

export interface CalculatedMetrics {
  // P&L (from pnl:snapshot - canonical source)
  total_equity: number;
  daily_pnl: number;
  daily_pnl_r: number;
  total_realized_pnl: number;
  total_unrealized_pnl: number;
  
  // Risk (from pnl:snapshot)
  risk_heat: number;
  exposure_usd: number;
  open_positions_count: number;
  
  // Session stats (from /api/analytics/session)
  wins_today: number;
  losses_today: number;
  win_rate: number;
  total_trades_today: number;
  
  // Market conditions (from /api/status)
  spread_percentile: number;
  
  // Engine state (from /api/status)
  engine_running: boolean;
  mode: 'paper' | 'live' | null;
  paused: boolean;
  daily_stop_hit: boolean;
  
  // Meta
  date: string;
  source: 'pnl_snapshot' | 'session_stats' | 'runtime' | 'fallback';
  isStale: boolean;
}

export const useCalculatedMetrics = () => {
  const { isConnected } = useConnectivityBooleans();
  
  // PRIMARY SOURCE: PnL Snapshot (canonical for all P&L/equity)
  const { snapshot, isStale: pnlIsStale, source: pnlSource } = usePnLSnapshot();
  
  // SECONDARY: Session stats (for trade counts, win rate, NOT for P&L)
  const { data: sessionStats } = useSessionStats();
  
  // TERTIARY: Runtime status (for engine state, spread, NOT for P&L)
  const { data: runtimeStatus } = useRuntimeStatus();
  
  return useQuery({
    queryKey: [
      "calculated-metrics", 
      snapshot?.ts, 
      sessionStats?.sessionId, 
      runtimeStatus?.engineRunning
    ],
    queryFn: async (): Promise<CalculatedMetrics> => {
      const today = new Date().toISOString().split('T')[0];
      
      // ============ P&L FROM SNAPSHOT (CANONICAL) ============
      // These values come ONLY from pnl:snapshot - never calculated locally
      const total_equity = snapshot?.totalEquityUsd ?? 0;
      const daily_pnl = snapshot?.dailyPnlUsd ?? 0;
      const daily_pnl_r = snapshot?.dailyPnlR ?? 0;
      const total_realized_pnl = snapshot?.realizedPnlUsd ?? 0;
      const total_unrealized_pnl = snapshot?.unrealizedPnlUsd ?? 0;
      const exposure_usd = snapshot?.exposureUsd ?? 0;
      const open_positions_count = snapshot?.openPositionsCount ?? 0;
      
      // Risk heat: exposure / equity (from snapshot)
      // If snapshot not available, show 0 rather than fake data
      const risk_heat = total_equity > 0 
        ? (exposure_usd / total_equity) * 100 
        : 0;
      
      // ============ SESSION STATS (TRADE COUNTS ONLY) ============
      // These do NOT affect P&L display
      const wins_today = sessionStats?.winningTrades ?? 0;
      const losses_today = sessionStats?.losingTrades ?? 0;
      const total_trades_today = sessionStats?.totalTrades ?? 0;
      const win_rate = sessionStats ? sessionStats.winRate * 100 : 0;
      
      // ============ RUNTIME STATUS (ENGINE STATE ONLY) ============
      const spread_percentile = runtimeStatus?.spreadPctile ?? 0;
      const engine_running = runtimeStatus?.engineRunning ?? false;
      const mode = runtimeStatus?.mode ?? null;
      const paused = runtimeStatus?.paused ?? false;
      const daily_stop_hit = runtimeStatus?.dailyStopHit ?? false;
      
      // Determine source for debugging
      let source: 'pnl_snapshot' | 'session_stats' | 'runtime' | 'fallback' = 'fallback';
      if (pnlSource === 'ws' || pnlSource === 'rest') {
        source = 'pnl_snapshot';
      } else if (sessionStats) {
        source = 'session_stats';
      } else if (runtimeStatus) {
        source = 'runtime';
      }
      
      return {
        // P&L (canonical from snapshot)
        total_equity,
        daily_pnl,
        daily_pnl_r,
        total_realized_pnl,
        total_unrealized_pnl,
        
        // Risk (from snapshot)
        risk_heat,
        exposure_usd,
        open_positions_count,
        
        // Session stats
        wins_today,
        losses_today,
        win_rate,
        total_trades_today,
        
        // Market conditions
        spread_percentile,
        
        // Engine state
        engine_running,
        mode,
        paused,
        daily_stop_hit,
        
        // Meta
        date: today,
        source,
        isStale: pnlIsStale,
      };
    },
    // Only poll when disconnected (for session stats refresh)
    refetchInterval: isConnected ? false : FALLBACK_POLL_INTERVAL,
    enabled: true,
    staleTime: isConnected ? 30000 : 1000,
  });
};
