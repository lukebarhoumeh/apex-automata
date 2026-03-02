/**
 * RiskDashboard - Risk Panel (Sprint 1.4)
 * 
 * Uses the canonical pnl:snapshot for P&L/equity display.
 * Uses runtime status for kill switch and engine state.
 */

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Shield, TrendingDown, DollarSign, AlertTriangle, Activity } from "lucide-react";
import { useRuntimeStatus } from "@/hooks/useRuntimeStatus";
import { usePnLSnapshot } from "@/hooks/usePnLSnapshot";

export const RiskDashboard = () => {
  const { data: status } = useRuntimeStatus();
  const { snapshot, isStale, source } = usePnLSnapshot();

  // Runtime state (not P&L)
  const killSwitchActive = status?.killSwitch?.active ?? false;
  const dailyStopHit = status?.dailyStopHit ?? false;

  // P&L from canonical snapshot - NOT from runtime status
  const dailyPnL = snapshot?.dailyPnlUsd ?? 0;
  const dailyPnLR = snapshot?.dailyPnlR ?? 0;
  const exposureUsd = snapshot?.exposureUsd ?? 0;
  const totalEquity = snapshot?.totalEquityUsd ?? 0;
  const unrealizedPnl = snapshot?.unrealizedPnlUsd ?? 0;
  const realizedPnl = snapshot?.realizedPnlUsd ?? 0;
  
  // Risk heat from snapshot (exposure / equity)
  const riskHeat = totalEquity > 0 ? (exposureUsd / totalEquity) * 100 : 0;
  
  // Max drawdown from snapshot (already in 0-100 percentage range)
  const maxDrawdownPct = (snapshot as any)?.maxDrawdownPct ?? (
    dailyPnL < 0 && totalEquity > 0
      ? Math.abs(dailyPnL / totalEquity) * 100
      : 0
  );

  const hasData = snapshot !== null && source !== 'none';

  const formatCurrency = (val: number) =>
    new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(val);

  const getPnLColor = (pnl: number) => {
    if (!hasData) return "text-muted-foreground";
    if (pnl > 0) return "text-success";
    if (pnl < 0) return "text-destructive";
    return "text-foreground";
  };

  const getDrawdownColor = (dd: number) => {
    if (!hasData) return "text-muted-foreground";
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
            {isStale && (
              <Badge variant="outline" className="text-xs text-warning border-warning/50">
                STALE
              </Badge>
            )}
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
        {/* Daily P&L - from pnl:snapshot */}
        <div className="flex items-center justify-between p-3 rounded-lg bg-muted/30">
          <div className="flex items-center gap-2">
            <DollarSign className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-medium">Daily P&L</span>
          </div>
          <div className="text-right">
            <span className={`text-lg font-bold font-mono tabular-nums ${getPnLColor(dailyPnL)}`}>
              {hasData ? (
                <>
                  {dailyPnL >= 0 ? "+" : ""}
                  {formatCurrency(dailyPnL)}
                </>
              ) : "---"}
            </span>
            {hasData && (
              <span className={`text-xs ml-2 ${getPnLColor(dailyPnLR)}`}>
                ({dailyPnLR >= 0 ? "+" : ""}{dailyPnLR.toFixed(2)}R)
              </span>
            )}
          </div>
        </div>

        {/* Realized vs Unrealized breakdown */}
        <div className="grid grid-cols-2 gap-3">
          <div className="p-2 rounded-lg bg-muted/20">
            <div className="text-xs text-muted-foreground">Realized</div>
            <div className={`text-sm font-bold font-mono ${getPnLColor(realizedPnl)}`}>
              {hasData ? formatCurrency(realizedPnl) : "---"}
            </div>
          </div>
          <div className="p-2 rounded-lg bg-muted/20">
            <div className="text-xs text-muted-foreground">Unrealized</div>
            <div className={`text-sm font-bold font-mono ${getPnLColor(unrealizedPnl)}`}>
              {hasData ? formatCurrency(unrealizedPnl) : "---"}
            </div>
          </div>
        </div>

        {/* Exposure */}
        <div className="flex items-center justify-between p-3 rounded-lg bg-muted/30">
          <div className="flex items-center gap-2">
            <Activity className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-medium">Total Exposure</span>
          </div>
          <span className="text-lg font-bold font-mono tabular-nums">
            {hasData ? formatCurrency(exposureUsd) : "---"}
          </span>
        </div>

        {/* Max Drawdown */}
        <div className="flex items-center justify-between p-3 rounded-lg bg-muted/30">
          <div className="flex items-center gap-2">
            <TrendingDown className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-medium">Session Drawdown</span>
          </div>
          <span className={`text-lg font-bold font-mono tabular-nums ${getDrawdownColor(maxDrawdownPct)}`}>
            {hasData ? `-${maxDrawdownPct.toFixed(2)}%` : "---"}
          </span>
        </div>

        {/* Risk Heat Gauge */}
        <div className="space-y-2 pt-2">
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Risk Heat</span>
            <Badge
              variant="outline"
              className={`font-mono ${
                !hasData 
                  ? "border-muted-foreground/30 text-muted-foreground"
                  : riskHeat > 75
                  ? "border-destructive text-destructive"
                  : riskHeat > 50
                  ? "border-warning text-warning"
                  : "border-success text-success"
              }`}
            >
              {hasData ? `${riskHeat.toFixed(0)}%` : "---"}
            </Badge>
          </div>
          <div className="relative h-2 rounded-full bg-muted overflow-hidden">
            <div
              className={`h-full transition-all duration-500 ${hasData ? getHeatColor(riskHeat) : 'bg-muted-foreground/30'}`}
              style={{ width: hasData ? `${Math.min(riskHeat, 100)}%` : '0%' }}
            />
          </div>
          <div className="flex justify-between text-xs text-muted-foreground">
            <span>0%</span>
            <span>50%</span>
            <span>100%</span>
          </div>
        </div>
      </CardContent>
    </Card>
  );
};
