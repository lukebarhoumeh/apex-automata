import { DollarSign, TrendingUp, Activity, AlertCircle, Percent, Zap } from "lucide-react";
import { MetricsGrid } from "./MetricsGrid";
import { useAccountMetrics } from "@/hooks/useAccountMetrics";
import { SkeletonCard } from "@/components/ui/skeleton-card";

export const MetricsGridConnected = () => {
  const { data: metrics, isLoading } = useAccountMetrics();

  if (isLoading) {
    return (
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        {Array.from({ length: 6 }).map((_, i) => (
          <SkeletonCard key={i} />
        ))}
      </div>
    );
  }

  // Use real data if available, otherwise fall back to MetricsGrid defaults
  if (!metrics) {
    return <MetricsGrid />;
  }

  return <MetricsGrid metrics={metrics} />;
};
