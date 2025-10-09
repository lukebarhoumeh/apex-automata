import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { TrendingUp, DollarSign, Activity, AlertCircle, Percent, Zap } from "lucide-react";
import { cn } from "@/lib/utils";

interface MetricCardProps {
  title: string;
  value: string;
  subtitle?: string;
  icon: React.ReactNode;
  trend?: "up" | "down" | "neutral";
  variant?: "default" | "success" | "destructive" | "warning";
}

const MetricCard = ({ title, value, subtitle, icon, trend, variant = "default" }: MetricCardProps) => {
  const getVariantClasses = () => {
    switch (variant) {
      case "success":
        return "border-success/50 bg-success/5";
      case "destructive":
        return "border-destructive/50 bg-destructive/5";
      case "warning":
        return "border-warning/50 bg-warning/5";
      default:
        return "";
    }
  };

  const getValueColor = () => {
    switch (variant) {
      case "success":
        return "text-success";
      case "destructive":
        return "text-destructive";
      case "warning":
        return "text-warning";
      default:
        return "text-foreground";
    }
  };

  return (
    <Card className={cn("transition-all hover:shadow-md", getVariantClasses())}>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">
          {title}
        </CardTitle>
        <div className="text-muted-foreground">{icon}</div>
      </CardHeader>
      <CardContent>
        <div className={cn("text-2xl font-bold", getValueColor())}>
          {value}
        </div>
        {subtitle && (
          <p className="text-xs text-muted-foreground mt-1">
            {subtitle}
          </p>
        )}
      </CardContent>
    </Card>
  );
};

export const MetricsGrid = () => {
  return (
    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
      <MetricCard
        title="Equity"
        value="$52,450"
        subtitle="+2.3% today"
        icon={<DollarSign className="h-4 w-4" />}
        variant="success"
      />
      <MetricCard
        title="Daily P&L"
        value="+1.8R"
        subtitle="$945.20"
        icon={<TrendingUp className="h-4 w-4" />}
        variant="success"
      />
      <MetricCard
        title="Risk Heat"
        value="2.1%"
        subtitle="of 3% max"
        icon={<Activity className="h-4 w-4" />}
        variant="default"
      />
      <MetricCard
        title="Spread %ile"
        value="42%"
        subtitle="Normal"
        icon={<Percent className="h-4 w-4" />}
        variant="default"
      />
      <MetricCard
        title="Open Positions"
        value="2"
        subtitle="BTC, ETH"
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
