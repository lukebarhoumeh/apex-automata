/**
 * MetricsGrid - Dashboard KPI Cards (Sprint 1.4)
 * 
 * Displays P&L metrics from the canonical pnl:snapshot source.
 * Shows "---" for unknown values rather than fake zeros.
 */

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { TrendingUp, DollarSign, Activity, AlertCircle, Percent, Zap, ArrowUp, ArrowDown } from "lucide-react";
import { cn, formatUsd, formatR, formatPercent } from "@/lib/utils";

interface MetricCardProps {
  title: string;
  value: string;
  subtitle?: string;
  change?: string;
  icon: React.ReactNode;
  trend?: "up" | "down" | "neutral";
  variant?: "default" | "success" | "destructive" | "warning" | "unknown";
  animate?: boolean;
}

const MetricCard = ({ 
  title, 
  value, 
  subtitle, 
  change,
  icon, 
  trend, 
  variant = "default",
  animate = false 
}: MetricCardProps) => {
  const getVariantClasses = () => {
    switch (variant) {
      case "success":
        return "border-success/30 bg-gradient-to-br from-success/5 to-transparent";
      case "destructive":
        return "border-destructive/30 bg-gradient-to-br from-destructive/5 to-transparent";
      case "warning":
        return "border-warning/30 bg-gradient-to-br from-warning/5 to-transparent";
      case "unknown":
        return "border-muted/30 bg-gradient-to-br from-muted/5 to-transparent opacity-60";
      default:
        return "border-border/50 bg-gradient-to-br from-card to-card/50";
    }
  };

  const getValueColor = () => {
    switch (variant) {
      case "success":
        return "text-success profit-glow";
      case "destructive":
        return "text-destructive loss-glow";
      case "warning":
        return "text-warning";
      case "unknown":
        return "text-muted-foreground";
      default:
        return "text-foreground";
    }
  };

  const getIconColor = () => {
    switch (variant) {
      case "success":
        return "text-success";
      case "destructive":
        return "text-destructive";
      case "warning":
        return "text-warning";
      case "unknown":
        return "text-muted-foreground/50";
      default:
        return "text-muted-foreground";
    }
  };

  return (
    <Card 
      className={cn(
        "transition-all duration-300 hover:shadow-lg hover:scale-[1.02] card-glow",
        getVariantClasses(),
        animate && "animate-pulse-glow"
      )}
    >
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">
          {title}
        </CardTitle>
        <div className={getIconColor()}>{icon}</div>
      </CardHeader>
      <CardContent>
        <div className="space-y-1">
          <div className="flex items-baseline gap-2">
            <div className={cn("text-2xl font-bold tracking-tight", getValueColor())}>
              {value}
            </div>
            {change && (
              <div className={cn(
                "flex items-center text-xs font-medium",
                trend === "up" ? "text-success" : trend === "down" ? "text-destructive" : "text-muted-foreground"
              )}>
                {trend === "up" && <ArrowUp className="h-3 w-3" />}
                {trend === "down" && <ArrowDown className="h-3 w-3" />}
                {change}
              </div>
            )}
          </div>
          {subtitle && (
            <p className="text-xs text-muted-foreground">
              {subtitle}
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
};

interface MetricsGridProps {
  metrics?: {
    total_equity: number;
    daily_pnl: number;
    daily_pnl_r: number;
    total_realized_pnl?: number;
    total_unrealized_pnl?: number;
    risk_heat: number;
    spread_percentile: number;
    open_positions_count: number;
    wins_today: number;
    losses_today: number;
    isStale?: boolean;
    source?: string;
  };
}

export const MetricsGrid = ({ metrics }: MetricsGridProps) => {
  // If no metrics, show unknown state - don't fake data
  const hasData = metrics && metrics.total_equity !== 0;
  
  const equity = metrics?.total_equity ?? 0;
  const dailyPnl = metrics?.daily_pnl ?? 0;
  const dailyPnlR = metrics?.daily_pnl_r ?? 0;
  const realizedPnl = metrics?.total_realized_pnl ?? dailyPnl;
  const unrealizedPnl = metrics?.total_unrealized_pnl ?? 0;
  const riskHeat = metrics?.risk_heat ?? 0;
  const spreadPercentile = metrics?.spread_percentile ?? 0;
  const openPositions = metrics?.open_positions_count ?? 0;
  const wins = metrics?.wins_today ?? 0;
  const losses = metrics?.losses_today ?? 0;
  const isStale = metrics?.isStale ?? false;

  // Determine P&L variant based on value
  const getPnlVariant = (pnl: number) => {
    if (!hasData) return "unknown";
    if (pnl > 0) return "success";
    if (pnl < 0) return "destructive";
    return "default";
  };

  const dailyPnlVariant = getPnlVariant(dailyPnl);
  const dailyPnlTrend = dailyPnl > 0 ? "up" : dailyPnl < 0 ? "down" : "neutral";

  return (
    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 animate-slide-up">
      <MetricCard
        title="Total Equity"
        value={hasData ? formatUsd(equity) : "---"}
        change={hasData && dailyPnl !== 0 ? formatPercent(dailyPnl / Math.max(equity - dailyPnl, 1)) : undefined}
        trend={dailyPnl > 0 ? "up" : dailyPnl < 0 ? "down" : "neutral"}
        subtitle={isStale ? "Data stale" : hasData ? "Session equity" : "Waiting for data"}
        icon={<DollarSign className="h-4 w-4" />}
        variant={!hasData ? "unknown" : dailyPnl > 0 ? "success" : dailyPnl < 0 ? "destructive" : "default"}
      />
      <MetricCard
        title="Daily P&L"
        value={hasData ? formatR(dailyPnlR) : "---"}
        change={hasData ? formatUsd(dailyPnl) : undefined}
        trend={dailyPnlTrend}
        subtitle={hasData ? `${wins}W / ${losses}L` : "No trades"}
        icon={<TrendingUp className="h-4 w-4" />}
        variant={dailyPnlVariant}
      />
      <MetricCard
        title="Unrealized"
        value={hasData ? formatUsd(unrealizedPnl) : "---"}
        subtitle={hasData ? `${openPositions} open position${openPositions !== 1 ? 's' : ''}` : "No positions"}
        icon={<Activity className="h-4 w-4" />}
        variant={getPnlVariant(unrealizedPnl)}
      />
      <MetricCard
        title="Risk Heat"
        value={hasData ? formatPercent(riskHeat / 100) : "---"}
        subtitle={hasData ? "of 3% max limit" : "Unknown"}
        icon={<Percent className="h-4 w-4" />}
        variant={!hasData ? "unknown" : riskHeat > 2.5 ? "warning" : "default"}
      />
      <MetricCard
        title="Spread %ile"
        value={hasData ? `${spreadPercentile}%` : "---"}
        subtitle={hasData ? (spreadPercentile > 80 ? "High volatility" : "Normal") : "Unknown"}
        icon={<Zap className="h-4 w-4" />}
        variant={!hasData ? "unknown" : spreadPercentile > 90 ? "warning" : "default"}
      />
      <MetricCard
        title="Daily Stop"
        value={hasData ? (dailyPnlR < 0 ? formatR(dailyPnlR) : formatR(-2)) : "---"}
        subtitle={hasData ? (dailyPnlR <= -2 ? "TRIGGERED" : "Remaining") : "Unknown"}
        icon={<AlertCircle className="h-4 w-4" />}
        variant={!hasData ? "unknown" : dailyPnlR <= -2 ? "destructive" : "default"}
      />
    </div>
  );
};
