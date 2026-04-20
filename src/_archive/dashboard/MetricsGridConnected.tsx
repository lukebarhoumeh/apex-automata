/**
 * MetricsGridConnected (Sprint 1.4)
 * 
 * Connects MetricsGrid to the canonical P&L source.
 * Uses useCalculatedMetrics which derives from pnl:snapshot.
 */

import { MetricsGrid } from "./MetricsGrid";
import { useCalculatedMetrics } from "@/hooks/useCalculatedMetrics";
import { SkeletonCard } from "@/components/ui/skeleton-card";

export const MetricsGridConnected = () => {
  const { data: metrics, isLoading } = useCalculatedMetrics();

  if (isLoading) {
    return (
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        {Array.from({ length: 6 }).map((_, i) => (
          <SkeletonCard key={i} />
        ))}
      </div>
    );
  }

  // Pass metrics including the new fields from Sprint 1.4
  return (
    <MetricsGrid 
      metrics={metrics ? {
        total_equity: metrics.total_equity,
        daily_pnl: metrics.daily_pnl,
        daily_pnl_r: metrics.daily_pnl_r,
        total_realized_pnl: metrics.total_realized_pnl,
        total_unrealized_pnl: metrics.total_unrealized_pnl,
        risk_heat: metrics.risk_heat,
        spread_percentile: metrics.spread_percentile,
        open_positions_count: metrics.open_positions_count,
        wins_today: metrics.wins_today,
        losses_today: metrics.losses_today,
        isStale: metrics.isStale,
        source: metrics.source,
      } : undefined} 
    />
  );
};
