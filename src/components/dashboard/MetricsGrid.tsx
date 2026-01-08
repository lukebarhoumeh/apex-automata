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
  variant?: "default" | "success" | "destructive" | "warning";
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
    risk_heat: number;
    spread_percentile: number;
    open_positions_count: number;
    wins_today: number;
    losses_today: number;
  };
}

export const MetricsGrid = ({ metrics }: MetricsGridProps) => {
  // Use actual values only - no fake defaults
  const equity = metrics?.total_equity ?? 50000; // Initial balance if no data
  const dailyPnl = metrics?.daily_pnl ?? 0;
  const dailyPnlR = metrics?.daily_pnl_r ?? 0;
  const riskHeat = metrics?.risk_heat ?? 0;
  const spreadPercentile = metrics?.spread_percentile ?? 50;
  const openPositions = metrics?.open_positions_count ?? 0;
  const wins = metrics?.wins_today ?? 0;
  const losses = metrics?.losses_today ?? 0;

  const dailyPnlVariant = dailyPnl > 0 ? "success" : dailyPnl < 0 ? "destructive" : "default";
  const dailyPnlTrend = dailyPnl > 0 ? "up" : dailyPnl < 0 ? "down" : "neutral";

  return (
    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 animate-slide-up">
      <MetricCard
        title="Total Equity"
        value={formatUsd(equity)}
        change={dailyPnl !== 0 ? formatPercent(dailyPnl / (equity - dailyPnl)) : undefined}
        trend={dailyPnl > 0 ? "up" : dailyPnl < 0 ? "down" : "neutral"}
        subtitle={dailyPnl > 0 ? "All-time high" : "Session equity"}
        icon={<DollarSign className="h-4 w-4" />}
        variant={dailyPnl > 0 ? "success" : dailyPnl < 0 ? "destructive" : "default"}
      />
      <MetricCard
        title="Daily P&L"
        value={formatR(dailyPnlR)}
        change={formatUsd(dailyPnl)}
        trend={dailyPnlTrend}
        subtitle={`${wins}W / ${losses}L`}
        icon={<TrendingUp className="h-4 w-4" />}
        variant={dailyPnlVariant}
      />
      <MetricCard
        title="Risk Heat"
        value={formatPercent(riskHeat / 100)}
        subtitle="of 3% max limit"
        icon={<Activity className="h-4 w-4" />}
        variant={riskHeat > 2.5 ? "warning" : "default"}
      />
      <MetricCard
        title="Spread %tile"
        value={`${spreadPercentile}%`}
        subtitle={spreadPercentile > 80 ? "High volatility" : "Normal"}
        icon={<Percent className="h-4 w-4" />}
        variant={spreadPercentile > 90 ? "warning" : "default"}
      />
      <MetricCard
        title="Open Positions"
        value={openPositions.toString()}
        subtitle={openPositions > 0 ? "Active trades" : "No positions"}
        icon={<Zap className="h-4 w-4" />}
        variant="default"
      />
      <MetricCard
        title="Daily Stop"
        value={dailyPnlR < 0 ? formatR(dailyPnlR) : formatR(-2)}
        subtitle={dailyPnlR <= -2 ? "TRIGGERED" : "Remaining"}
        icon={<AlertCircle className="h-4 w-4" />}
        variant={dailyPnlR <= -2 ? "destructive" : "default"}
      />
    </div>
  );
};
