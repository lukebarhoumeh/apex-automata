import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { AlertTriangle, RefreshCw, Clock, Loader2 } from "lucide-react";
import { useRuntimeStatus } from "@/hooks/useRuntimeStatus";

interface StaleDataWarningProps {
  lastUpdate: Date | null;
  onRefresh?: () => void;
  staleThresholdMs?: number;
}

export const StaleDataWarning = ({
  lastUpdate,
  onRefresh,
  staleThresholdMs = 15000,
}: StaleDataWarningProps) => {
  const { data: status } = useRuntimeStatus();
  
  const isStale = lastUpdate
    ? Date.now() - lastUpdate.getTime() > staleThresholdMs
    : false;

  const warmupComplete = status?.warmupComplete ?? true;
  const activeSymbols = status?.activeSymbols ?? status?.symbols ?? [];
  const candlesBuffered = status?.candlesBuffered;
  const requiredWarmup = status?.requiredWarmup ?? 200;

  // Calculate warmup progress
  let warmupProgress = 0;
  if (typeof candlesBuffered === 'object' && candlesBuffered !== null && activeSymbols.length > 0) {
    const totalBuffered = Object.values(candlesBuffered).reduce((sum: number, v: unknown) => sum + (typeof v === 'number' ? v : 0), 0);
    const totalRequired = activeSymbols.length * requiredWarmup;
    warmupProgress = totalRequired > 0 ? Math.round((totalBuffered / totalRequired) * 100) : 0;
  }

  // Show warmup warning if not complete
  if (!warmupComplete && activeSymbols.length > 0) {
    return (
      <Alert variant="default" className="border-warning/50 bg-warning/5">
        <Loader2 className="h-4 w-4 animate-spin text-warning" />
        <AlertTitle className="text-warning font-mono">Warming Up Indicators</AlertTitle>
        <AlertDescription className="flex items-center justify-between">
          <span className="text-sm">
            Buffering historical data ({warmupProgress}% complete). Signals may be delayed until warmup completes.
          </span>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            {activeSymbols.slice(0, 2).map((s) => (
              <span key={s} className="font-mono">{s}</span>
            ))}
            {activeSymbols.length > 2 && <span>+{activeSymbols.length - 2}</span>}
          </div>
        </AlertDescription>
      </Alert>
    );
  }

  // Show stale data warning
  if (isStale) {
    const staleSeconds = lastUpdate
      ? Math.round((Date.now() - lastUpdate.getTime()) / 1000)
      : 0;

    return (
      <Alert variant="destructive" className="border-destructive/50 bg-destructive/5">
        <AlertTriangle className="h-4 w-4" />
        <AlertTitle className="font-mono">DATA STALE</AlertTitle>
        <AlertDescription className="flex items-center justify-between">
          <span className="flex items-center gap-2">
            <Clock className="h-3 w-3" />
            No updates for {staleSeconds}s — check runtime process
          </span>
          {onRefresh && (
            <Button
              variant="outline"
              size="sm"
              onClick={onRefresh}
              className="gap-2 text-xs"
            >
              <RefreshCw className="h-3 w-3" />
              Refresh
            </Button>
          )}
        </AlertDescription>
      </Alert>
    );
  }

  return null;
};
