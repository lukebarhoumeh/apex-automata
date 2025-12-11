import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { Loader2, CheckCircle2, Flame } from "lucide-react";
import { useRuntimeStatus } from "@/hooks/useRuntimeStatus";

export const WarmupIndicator = () => {
  const { data: status } = useRuntimeStatus();

  // Extract warmup info from status
  const warmupComplete = status?.warmupComplete ?? false;
  const candlesBuffered = status?.candlesBuffered ?? 0;
  const requiredWarmup = status?.requiredWarmup ?? 50;
  const symbols = status?.symbols ?? [];

  const warmupProgress = requiredWarmup > 0 
    ? Math.min((candlesBuffered / requiredWarmup) * 100, 100) 
    : 0;

  if (warmupComplete) {
    return (
      <div className="flex items-center gap-2 text-sm">
        <CheckCircle2 className="h-4 w-4 text-success" />
        <span className="text-success font-mono">LIVE</span>
        {symbols.length > 0 && (
          <Badge variant="outline" className="text-xs font-mono ml-2">
            {symbols.length} symbol{symbols.length !== 1 ? "s" : ""}
          </Badge>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Loader2 className="h-4 w-4 animate-spin text-warning" />
        <span className="text-sm font-mono text-warning">WARMING UP</span>
        <span className="text-xs text-muted-foreground font-mono tabular-nums">
          {candlesBuffered}/{requiredWarmup} bars
        </span>
      </div>
      <Progress value={warmupProgress} className="h-1.5" />
      {symbols.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-1">
          {symbols.slice(0, 3).map((symbol: string) => (
            <Badge key={symbol} variant="outline" className="text-xs font-mono">
              {symbol}
            </Badge>
          ))}
          {symbols.length > 3 && (
            <Badge variant="outline" className="text-xs font-mono">
              +{symbols.length - 3} more
            </Badge>
          )}
        </div>
      )}
    </div>
  );
};

export const EngineStateIndicator = () => {
  const { data: status } = useRuntimeStatus();

  const mode = status?.mode ?? "paper";
  const paused = status?.paused ?? false;
  const killSwitch = status?.killSwitch;
  const dailyStopHit = status?.dailyStopHit ?? false;

  // Determine primary state
  if (killSwitch?.active) {
    return (
      <div className="flex items-center gap-2">
        <span className="relative flex h-3 w-3">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-destructive opacity-75"></span>
          <span className="relative inline-flex rounded-full h-3 w-3 bg-destructive"></span>
        </span>
        <Badge variant="destructive" className="font-mono">
          KILL-SWITCH
        </Badge>
        {killSwitch.reasons && killSwitch.reasons.length > 0 && (
          <span className="text-xs text-destructive">
            {killSwitch.reasons.join(", ")}
          </span>
        )}
      </div>
    );
  }

  if (dailyStopHit) {
    return (
      <div className="flex items-center gap-2">
        <Flame className="h-4 w-4 text-warning" />
        <Badge className="bg-warning text-warning-foreground font-mono">
          DAILY STOP
        </Badge>
        <span className="text-xs text-muted-foreground">New entries blocked</span>
      </div>
    );
  }

  if (paused) {
    return (
      <div className="flex items-center gap-2">
        <span className="flex h-3 w-3 rounded-full bg-muted"></span>
        <Badge variant="secondary" className="font-mono">
          PAUSED
        </Badge>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <span className="relative flex h-3 w-3">
        <span className="animate-pulse absolute inline-flex h-full w-full rounded-full bg-success opacity-75"></span>
        <span className="relative inline-flex rounded-full h-3 w-3 bg-success"></span>
      </span>
      <Badge 
        variant="outline" 
        className={`font-mono ${mode === "live" ? "border-success text-success" : "border-primary text-primary"}`}
      >
        {mode.toUpperCase()}
      </Badge>
    </div>
  );
};
