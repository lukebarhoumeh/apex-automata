import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { TrendingUp, DollarSign, Activity, AlertCircle, Percent, Zap, ArrowUp, ArrowDown } from "lucide-react";
import { cn } from "@/lib/utils";

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

export const MetricsGrid = () => {
  return (
    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 animate-slide-up">
      <MetricCard
        title="Total Equity"
        value="$52,450"
        change="+2.3%"
        trend="up"
        subtitle="All-time high"
        icon={<DollarSign className="h-4 w-4" />}
        variant="success"
        animate
      />
      <MetricCard
        title="Daily P&L"
        value="+1.8R"
        change="$945.20"
        trend="up"
        subtitle="6 wins, 2 losses"
        icon={<TrendingUp className="h-4 w-4" />}
        variant="success"
      />
      <MetricCard
        title="Risk Heat"
        value="2.1%"
        subtitle="of 3% max limit"
        icon={<Activity className="h-4 w-4" />}
        variant="default"
      />
      <MetricCard
        title="Spread Percentile"
        value="42%"
        subtitle="Normal conditions"
        icon={<Percent className="h-4 w-4" />}
        variant="default"
      />
      <MetricCard
        title="Open Positions"
        value="2"
        subtitle="BTC, ETH active"
        icon={<Zap className="h-4 w-4" />}
        variant="default"
      />
      <MetricCard
        title="Daily Stop"
        value="-2R"
        subtitle="Not triggered"
        icon={<AlertCircle className="h-4 w-4" />}
        variant="default"
      />
    </div>
  );
};
