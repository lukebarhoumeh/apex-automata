import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Activity, TrendingUp, BarChart3, Zap } from "lucide-react";
import { Progress } from "@/components/ui/progress";
import { useRuntimeStatus } from "@/hooks/useRuntimeStatus";
import { useRegimeStates } from "@/hooks/useRegimeState";

export const MarketConditions = () => {
  const { data: runtimeStatus } = useRuntimeStatus();
  const { data: regimeData } = useRegimeStates();

  // Extract regime info from backend or use defaults
  const regime = runtimeStatus?.regime || 'chop';
  const spreadPctile = runtimeStatus?.spreadPctile || 50;

  // Get primary symbol regime data (BTC-USD or first available)
  const primarySymbol = regimeData?.states?.['BTC-USD'] || regimeData?.states?.[Object.keys(regimeData?.states || {})[0]];
  const adx = primarySymbol?.adx || 0;
  const confidence = (primarySymbol?.confidence || 0.5) * 100;

  const getRegimeBadge = () => {
    switch (regime) {
      case 'trend':
      case 'strong_trend':
        return <Badge className="bg-success/20 text-success border-success/40">TRENDING</Badge>;
      case 'weak_trend':
        return <Badge className="bg-warning/20 text-warning border-warning/40">WEAK TREND</Badge>;
      case 'ranging':
        return <Badge className="bg-primary/20 text-primary border-primary/40">RANGING</Badge>;
      case 'choppy':
      case 'chop':
        return <Badge className="bg-muted text-muted-foreground border-muted">CHOPPY</Badge>;
      default:
        return <Badge className="bg-muted text-muted-foreground">UNKNOWN</Badge>;
    }
  };

  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
      <Card className="card-glow border-primary/20 bg-gradient-to-br from-card to-card/50">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <Activity className="h-4 w-4 text-primary" />
            Market Regime
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              {getRegimeBadge()}
              <span className="text-sm text-muted-foreground">ADX: {adx.toFixed(1)}</span>
            </div>
            <div className="space-y-1">
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground">Confidence</span>
                <span className={confidence > 70 ? 'text-success' : confidence > 50 ? 'text-warning' : 'text-muted-foreground'}>
                  {confidence.toFixed(0)}%
                </span>
              </div>
              <Progress value={confidence} className="h-1.5" />
            </div>
          </div>
        </CardContent>
      </Card>

      <Card className="card-glow border-warning/20 bg-gradient-to-br from-card to-card/50">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <Zap className="h-4 w-4 text-warning" />
            Spread Percentile
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className={`text-2xl font-bold ${spreadPctile > 90 ? 'text-destructive' : spreadPctile > 70 ? 'text-warning' : 'text-foreground'}`}>
                {spreadPctile}%
              </span>
              <Badge variant="outline" className="text-xs">
                {spreadPctile > 90 ? 'HIGH' : spreadPctile > 70 ? 'ELEVATED' : 'NORMAL'}
              </Badge>
            </div>
            <div className="space-y-1">
              <Progress 
                value={spreadPctile} 
                className={`h-1.5 ${spreadPctile > 90 ? '[&>div]:bg-destructive' : spreadPctile > 70 ? '[&>div]:bg-warning' : ''}`} 
              />
              <div className="text-xs text-muted-foreground">
                {spreadPctile > 95 ? 'Kill-switch threshold reached' : 'Market liquidity indicator'}
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card className="card-glow border-success/20 bg-gradient-to-br from-card to-card/50">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <TrendingUp className="h-4 w-4 text-success" />
            Engine Status
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-2xl font-bold text-success">
                {runtimeStatus?.engineRunning ? 'RUNNING' : 'STOPPED'}
              </span>
            </div>
            <div className="grid grid-cols-2 gap-2 text-xs">
              <div>
                <div className="text-muted-foreground">Mode</div>
                <div className="font-medium">{runtimeStatus?.mode?.toUpperCase() || 'N/A'}</div>
              </div>
              <div>
                <div className="text-muted-foreground">Symbols</div>
                <div className="font-medium">{runtimeStatus?.activeSymbols?.length || 0}</div>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card className="card-glow border-primary/20 bg-gradient-to-br from-card to-card/50">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <BarChart3 className="h-4 w-4 text-primary" />
            Warmup Status
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <Badge className={runtimeStatus?.warmupComplete ? "bg-success/20 text-success border-success/40" : "bg-warning/20 text-warning border-warning/40"}>
                {runtimeStatus?.warmupComplete ? 'READY' : 'WARMING UP'}
              </Badge>
            </div>
            <div className="space-y-1 text-xs">
              {runtimeStatus?.candlesBuffered && Object.entries(runtimeStatus.candlesBuffered).map(([symbol, count]) => (
                <div key={symbol} className="flex justify-between">
                  <span className="text-muted-foreground">{symbol.replace('-USD', '')}</span>
                  <span className="font-mono">{count as number} candles</span>
                </div>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
};
