import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Shield, TrendingDown, DollarSign, AlertTriangle, Activity } from "lucide-react";
import { useRuntimeStatus } from "@/hooks/useRuntimeStatus";
import { useAccountMetrics } from "@/hooks/useAccountMetrics";

export const RiskDashboard = () => {
  const { data: status } = useRuntimeStatus();
  const { data: metrics } = useAccountMetrics();

  // Get risk data from runtime status (real-time from backend)
  const riskData = status?.risk;
  const killSwitchActive = status?.killSwitch?.active ?? false;
  const dailyStopHit = status?.dailyStopHit ?? false;

  // Fallback to account metrics if runtime risk not available
  const dailyPnL = riskData?.dailyPnLUsd ?? metrics?.daily_pnl ?? 0;
  const exposureUsd = riskData?.exposureUsd ?? 0;
  const maxDrawdownPct = riskData?.maxDrawdownPct ?? 0;
  const riskHeat = metrics?.risk_heat ?? 0;

  const formatCurrency = (val: number) =>
    new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(val);

  const getPnLColor = (pnl: number) => {
    if (pnl > 0) return "text-success";
    if (pnl < 0) return "text-destructive";
    return "text-foreground";
  };

  const getDrawdownColor = (dd: number) => {
    if (dd < 2) return "text-success";
    if (dd < 5) return "text-warning";
    return "text-destructive";
  };

  const getHeatColor = (heat: number) => {
    if (heat < 50) return "bg-success";
    if (heat < 75) return "bg-warning";
    return "bg-destructive";
  };

  return (
    <Card className="card-glow border-primary/20">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Shield className="h-5 w-5 text-primary" />
            Risk Dashboard
          </div>
          {killSwitchActive && (
            <Badge variant="destructive" className="animate-pulse">
              <AlertTriangle className="h-3 w-3 mr-1" />
              KILL-SWITCH
            </Badge>
          )}
          {dailyStopHit && !killSwitchActive && (
            <Badge variant="outline" className="border-warning text-warning">
              DAILY STOP
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Daily P&L */}
        <div className="flex items-center justify-between p-3 rounded-lg bg-muted/30">
          <div className="flex items-center gap-2">
            <DollarSign className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-medium">Daily P&L</span>
          </div>
          <div className="text-right">
            <span className={`text-lg font-bold font-mono tabular-nums ${getPnLColor(dailyPnL)}`}>
              {dailyPnL >= 0 ? "+" : ""}
              {formatCurrency(dailyPnL)}
            </span>
            {metrics?.daily_pnl_r !== undefined && (
              <span className={`text-xs ml-2 ${getPnLColor(metrics.daily_pnl_r)}`}>
                ({metrics.daily_pnl_r >= 0 ? "+" : ""}{metrics.daily_pnl_r.toFixed(2)}R)
              </span>
            )}
          </div>
        </div>

        {/* Exposure */}
        <div className="flex items-center justify-between p-3 rounded-lg bg-muted/30">
          <div className="flex items-center gap-2">
            <Activity className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-medium">Total Exposure</span>
          </div>
          <span className="text-lg font-bold font-mono tabular-nums">
            {formatCurrency(exposureUsd)}
          </span>
        </div>

        {/* Max Drawdown */}
        <div className="flex items-center justify-between p-3 rounded-lg bg-muted/30">
          <div className="flex items-center gap-2">
            <TrendingDown className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-medium">Max Drawdown</span>
          </div>
          <span className={`text-lg font-bold font-mono tabular-nums ${getDrawdownColor(maxDrawdownPct)}`}>
            -{maxDrawdownPct.toFixed(2)}%
          </span>
        </div>

        {/* Risk Heat Gauge */}
        <div className="space-y-2 pt-2">
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Risk Heat</span>
            <Badge
              variant="outline"
              className={`font-mono ${
                riskHeat > 75
                  ? "border-destructive text-destructive"
                  : riskHeat > 50
                  ? "border-warning text-warning"
                  : "border-success text-success"
              }`}
            >
              {riskHeat.toFixed(0)}%
            </Badge>
          </div>
          <div className="relative h-2 rounded-full bg-muted overflow-hidden">
            <div
              className={`h-full transition-all duration-500 ${getHeatColor(riskHeat)}`}
              style={{ width: `${Math.min(riskHeat, 100)}%` }}
            />
          </div>
          <div className="flex justify-between text-xs text-muted-foreground">
            <span>0%</span>
            <span>50%</span>
            <span>100%</span>
          </div>
        </div>

        {/* Win/Loss Today */}
        {metrics && (
          <div className="grid grid-cols-2 gap-3 pt-2">
            <div className="text-center p-2 rounded-lg bg-success/10 border border-success/20">
              <div className="text-xs text-muted-foreground">Wins Today</div>
              <div className="text-xl font-bold text-success font-mono">
                {metrics.wins_today ?? 0}
              </div>
            </div>
            <div className="text-center p-2 rounded-lg bg-destructive/10 border border-destructive/20">
              <div className="text-xs text-muted-foreground">Losses Today</div>
              <div className="text-xl font-bold text-destructive font-mono">
                {metrics.losses_today ?? 0}
              </div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
};
