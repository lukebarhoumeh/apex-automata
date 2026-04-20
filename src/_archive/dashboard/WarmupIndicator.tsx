import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { Loader2, CheckCircle2, Flame } from "lucide-react";
import { useRuntimeStatus } from "@/hooks/useRuntimeStatus";

interface SymbolWarmup {
  symbol: string;
  buffered: number;
  required: number;
  progress: number;
}

export const WarmupIndicator = () => {
  const { data: status } = useRuntimeStatus();

  // Extract warmup info from status
  const warmupComplete = status?.warmupComplete ?? false;
  const requiredWarmup = status?.requiredWarmup ?? 200;
  const activeSymbols = status?.activeSymbols ?? status?.symbols ?? [];
  
  // Handle both legacy (number) and new (per-symbol object) candlesBuffered formats
  const candlesBuffered = status?.candlesBuffered;
  
  // Build per-symbol warmup data
  const symbolWarmups: SymbolWarmup[] = activeSymbols.map((symbol: string) => {
    let buffered = 0;
    if (typeof candlesBuffered === 'object' && candlesBuffered !== null) {
      buffered = candlesBuffered[symbol] ?? 0;
    } else if (typeof candlesBuffered === 'number') {
      buffered = candlesBuffered;
    }
    const progress = requiredWarmup > 0 ? Math.min((buffered / requiredWarmup) * 100, 100) : 0;
    return { symbol, buffered, required: requiredWarmup, progress };
  });

  // Calculate overall progress
  const totalBuffered = symbolWarmups.reduce((sum, s) => sum + s.buffered, 0);
  const totalRequired = symbolWarmups.length * requiredWarmup;
  const overallProgress = totalRequired > 0 ? Math.min((totalBuffered / totalRequired) * 100, 100) : 0;

  if (warmupComplete) {
    return (
      <div className="flex items-center gap-2 text-sm">
        <CheckCircle2 className="h-4 w-4 text-success" />
        <span className="text-success font-mono">LIVE</span>
        {activeSymbols.length > 0 && (
          <Badge variant="outline" className="text-xs font-mono ml-2">
            {activeSymbols.length} symbol{activeSymbols.length !== 1 ? "s" : ""}
          </Badge>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Loader2 className="h-4 w-4 animate-spin text-warning" />
        <span className="text-sm font-mono text-warning">WARMING UP</span>
      </div>
      
      {/* Per-symbol progress */}
      {symbolWarmups.length > 0 ? (
        <div className="space-y-2">
          {symbolWarmups.map((sw) => (
            <div key={sw.symbol} className="space-y-1">
              <div className="flex items-center justify-between text-xs">
                <span className="font-mono text-muted-foreground">{sw.symbol}</span>
                <span className="font-mono tabular-nums text-muted-foreground">
                  {sw.buffered}/{sw.required}
                </span>
              </div>
              <Progress value={sw.progress} className="h-1" />
            </div>
          ))}
        </div>
      ) : (
        <div className="space-y-1">
          <Progress value={overallProgress} className="h-1.5" />
          <span className="text-xs text-muted-foreground font-mono">
            Waiting for symbol data...
          </span>
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
