import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Activity, Database, Wifi, WifiOff, Server, Coins } from "lucide-react";
import { useRuntimeStatus } from "@/hooks/useRuntimeStatus";
import { useRuntimeHealth } from "@/hooks/useRuntimeHealth";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { WarmupIndicator, EngineStateIndicator } from "./WarmupIndicator";
import { Separator } from "@/components/ui/separator";
import { useConnectivityBooleans } from "@/runtime/connectivity";

export const SystemHealthPanel = () => {
  const { data: runtimeStatus, isError: runtimeError } = useRuntimeStatus();
  const { data: runtimeHealthy } = useRuntimeHealth();
  const { isConnected } = useConnectivityBooleans();
  
  // Check Supabase connectivity
  const { data: dbHealthy, isError: dbError } = useQuery({
    queryKey: ["db-health"],
    queryFn: async () => {
      const { error } = await supabase.from("symbols").select("id").limit(1);
      return !error;
    },
    refetchInterval: isConnected ? false : 10000,
    retry: 1,
    staleTime: isConnected ? 60000 : 5000,
  });

  const formatLatency = (ms: number) => {
    if (ms < 100) return { text: `${ms}ms`, color: "text-success" };
    if (ms < 300) return { text: `${ms}ms`, color: "text-warning" };
    return { text: `${ms}ms`, color: "text-danger" };
  };

  const wsLatency = runtimeStatus?.wsLatencyMs 
    ? formatLatency(runtimeStatus.wsLatencyMs)
    : { text: "—", color: "text-muted-foreground" };

  const restLatency = runtimeStatus?.restLatencyMs
    ? formatLatency(runtimeStatus.restLatencyMs)
    : { text: "—", color: "text-muted-foreground" };

  const symbols = runtimeStatus?.symbols ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-mono flex items-center gap-2">
          <Activity className="h-4 w-4" />
          System Health
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Engine State */}
        <div className="pb-2">
          <EngineStateIndicator />
        </div>

        {/* Warmup Progress */}
        {runtimeHealthy && (
          <>
            <Separator />
            <WarmupIndicator />
          </>
        )}

        <Separator />

        {/* Runtime Backend */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Server className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm">Runtime</span>
          </div>
          {runtimeHealthy ? (
            <Badge variant="outline" className="bg-success/10 text-success border-success/20">
              Connected
            </Badge>
          ) : (
            <Badge variant="outline" className="bg-danger/10 text-danger border-danger/20">
              Offline
            </Badge>
          )}
        </div>

        {/* Database */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Database className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm">Database</span>
          </div>
          {dbHealthy ? (
            <Badge variant="outline" className="bg-success/10 text-success border-success/20">
              Connected
            </Badge>
          ) : (
            <Badge variant="outline" className="bg-danger/10 text-danger border-danger/20">
              Offline
            </Badge>
          )}
        </div>

        {/* Connected Symbols */}
        {symbols.length > 0 && (
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Coins className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm">Symbols</span>
            </div>
            <div className="flex gap-1 flex-wrap justify-end">
              {symbols.slice(0, 2).map((symbol: string) => (
                <Badge key={symbol} variant="outline" className="text-xs font-mono">
                  {symbol}
                </Badge>
              ))}
              {symbols.length > 2 && (
                <Badge variant="outline" className="text-xs font-mono">
                  +{symbols.length - 2}
                </Badge>
              )}
            </div>
          </div>
        )}

        {/* WebSocket Latency */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            {runtimeStatus?.wsLatencyMs ? (
              <Wifi className="h-4 w-4 text-muted-foreground" />
            ) : (
              <WifiOff className="h-4 w-4 text-muted-foreground" />
            )}
            <span className="text-sm">WS Latency</span>
          </div>
          <span className={`text-sm font-mono tabular-nums ${wsLatency.color}`}>
            {wsLatency.text}
          </span>
        </div>

        {/* REST Latency */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Activity className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm">REST Latency</span>
          </div>
          <span className={`text-sm font-mono tabular-nums ${restLatency.color}`}>
            {restLatency.text}
          </span>
        </div>
      </CardContent>
    </Card>
  );
};
