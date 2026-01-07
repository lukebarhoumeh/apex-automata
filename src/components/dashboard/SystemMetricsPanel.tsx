import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { 
  Cpu, 
  Activity, 
  Wifi, 
  Clock, 
  Database,
  TrendingUp,
  AlertTriangle,
  CheckCircle2
} from "lucide-react";
import { useSystemMetrics } from "@/hooks/useSystemMetrics";

export const SystemMetricsPanel = () => {
  const { data: metrics, isLoading, isError } = useSystemMetrics();

  if (isLoading) {
    return (
      <Card>
        <CardContent className="p-4 flex items-center justify-center h-[180px] text-muted-foreground">
          Loading system metrics...
        </CardContent>
      </Card>
    );
  }

  if (isError || !metrics) {
    return (
      <Card>
        <CardContent className="p-4 flex items-center justify-center h-[180px] text-muted-foreground">
          <div className="text-center">
            <AlertTriangle className="h-8 w-8 mx-auto mb-2 opacity-50" />
            <p>Unable to fetch system metrics</p>
          </div>
        </CardContent>
      </Card>
    );
  }

  const formatUptime = (seconds: number) => {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return `${hours}h ${minutes}m`;
  };

  const memoryUsagePct = (metrics.system.memoryUsedMB / metrics.system.memoryTotalMB) * 100;
  const memoryColor = 
    memoryUsagePct > 90 ? 'text-destructive' :
    memoryUsagePct > 70 ? 'text-warning' : 'text-success';

  const wsLatencyColor =
    metrics.latency.wsLatencyMs > 500 ? 'text-destructive' :
    metrics.latency.wsLatencyMs > 100 ? 'text-warning' : 'text-success';

  const regimeColor = metrics.market.regime === 'trend' ? 'text-success' : 'text-muted-foreground';

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base font-mono">
          <Cpu className="h-4 w-4" />
          System Health
          <Badge 
            variant={metrics.trading.engineRunning ? "default" : "secondary"}
            className={`ml-auto text-xs ${metrics.trading.engineRunning ? 'bg-success' : ''}`}
          >
            {metrics.trading.engineRunning ? (
              <>
                <CheckCircle2 className="h-3 w-3 mr-1" />
                RUNNING
              </>
            ) : (
              'STOPPED'
            )}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Memory Usage */}
        <div className="space-y-1">
          <div className="flex justify-between text-sm font-mono">
            <span className="flex items-center gap-1 text-muted-foreground">
              <Database className="h-3 w-3" />
              Memory
            </span>
            <span className={memoryColor}>
              {metrics.system.memoryUsedMB}MB / {metrics.system.memoryTotalMB}MB
            </span>
          </div>
          <Progress value={memoryUsagePct} className="h-1.5" />
        </div>

        {/* Latency & Uptime */}
        <div className="grid grid-cols-2 gap-3 text-sm font-mono">
          <div className="flex justify-between">
            <span className="text-muted-foreground flex items-center gap-1">
              <Wifi className="h-3 w-3" />
              WS Latency
            </span>
            <span className={wsLatencyColor}>
              {metrics.latency.wsLatencyMs}ms
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground flex items-center gap-1">
              <Activity className="h-3 w-3" />
              REST Latency
            </span>
            <span>
              {metrics.latency.restLatencyMs}ms
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground flex items-center gap-1">
              <Clock className="h-3 w-3" />
              Uptime
            </span>
            <span>
              {formatUptime(metrics.system.uptimeSeconds)}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground flex items-center gap-1">
              <TrendingUp className="h-3 w-3" />
              Regime
            </span>
            <span className={regimeColor}>
              {metrics.market.regime.toUpperCase()}
            </span>
          </div>
        </div>

        {/* Market Metrics */}
        <div className="pt-2 border-t">
          <div className="grid grid-cols-3 gap-2 text-center">
            <div>
              <div className="text-lg font-bold font-mono">{metrics.market.spreadBps.toFixed(1)}</div>
              <div className="text-xs text-muted-foreground">Spread (bps)</div>
            </div>
            <div>
              <div className={`text-lg font-bold font-mono ${metrics.market.spreadPctile > 90 ? 'text-warning' : ''}`}>
                {metrics.market.spreadPctile}%
              </div>
              <div className="text-xs text-muted-foreground">Spread %ile</div>
            </div>
            <div>
              <div className="text-lg font-bold font-mono">{metrics.market.atr.toFixed(2)}</div>
              <div className="text-xs text-muted-foreground">ATR</div>
            </div>
          </div>
        </div>

        {/* Risk Status */}
        {metrics.trading.engineRunning && (
          <div className="pt-2 border-t">
            <div className="flex justify-between text-sm font-mono">
              <span className="text-muted-foreground">Exposure</span>
              <span>${metrics.risk.exposureUsd.toLocaleString()}</span>
            </div>
            <div className="flex justify-between text-sm font-mono">
              <span className="text-muted-foreground">Consec. Losses</span>
              <span className={metrics.risk.consecutiveLosses >= 3 ? 'text-warning' : ''}>
                {metrics.risk.consecutiveLosses}
              </span>
            </div>
            {metrics.risk.killSwitchActive && (
              <div className="mt-2">
                <Badge variant="destructive" className="w-full justify-center">
                  <AlertTriangle className="h-3 w-3 mr-1" />
                  KILL SWITCH ACTIVE
                </Badge>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
};

