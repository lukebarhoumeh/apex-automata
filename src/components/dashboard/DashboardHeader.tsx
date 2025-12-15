import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Power, Pause, Play, AlertTriangle, Ban, Square, PlayCircle } from "lucide-react";
import { useAccountMetrics } from "@/hooks/useAccountMetrics";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { runtimeClient } from "@/services/runtimeClient";
import { useRuntimeStatus, useRuntimeHealth } from "@/hooks/useRuntimeStatus";
import { useToast } from "@/hooks/use-toast";
import { useState } from "react";

interface DashboardHeaderProps {
  botState: "paper" | "live" | "paused";
  onStateChange: (state: "paper" | "live" | "paused") => void;
}

export const DashboardHeader = ({ botState, onStateChange }: DashboardHeaderProps) => {
  const { toast } = useToast();
  const [isLoading, setIsLoading] = useState(false);
  const [startMode, setStartMode] = useState<'paper' | 'live'>('paper');
  const { data: metrics } = useAccountMetrics();
  const { data: runtimeStatus } = useRuntimeStatus();
  const { data: runtimeHealthy } = useRuntimeHealth();

  const formatCurrency = (val: number) => 
    new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0 }).format(val);

  const isPaused = runtimeStatus?.paused ?? false;
  const isLive = runtimeStatus?.mode === 'live';
  const killSwitchActive = runtimeStatus?.killSwitch?.active ?? false;
  const dailyStopHit = runtimeStatus?.dailyStopHit ?? false;
  const engineRunning = runtimeHealthy && (runtimeStatus?.engineRunning ?? false);

  const handleStartEngine = async () => {
    setIsLoading(true);
    try {
      await runtimeClient.startEngine(startMode);
      toast({
        title: "Engine Started",
        description: `Trading engine started in ${startMode.toUpperCase()} mode`,
      });
      onStateChange(startMode);
    } catch (error) {
      toast({
        title: "Failed to Start Engine",
        description: error instanceof Error ? error.message : 'Unknown error',
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleStopEngine = async () => {
    setIsLoading(true);
    try {
      await runtimeClient.stopEngine();
      toast({
        title: "Engine Stopped",
        description: "Trading engine stopped gracefully",
      });
      onStateChange('paused');
    } catch (error) {
      toast({
        title: "Failed to Stop Engine",
        description: error instanceof Error ? error.message : 'Unknown error',
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handlePauseResume = async () => {
    setIsLoading(true);
    try {
      if (isPaused) {
        await runtimeClient.resume();
        toast({
          title: "Engine Resumed",
          description: "Trading activity has resumed",
        });
      } else {
        await runtimeClient.pause();
        toast({
          title: "Engine Paused",
          description: "New entries are blocked. Existing positions remain open.",
        });
      }
    } catch (error) {
      toast({
        title: "Control Failed",
        description: error instanceof Error ? error.message : 'Unknown error',
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleKillSwitch = async () => {
    setIsLoading(true);
    try {
      await runtimeClient.killEngine();
      toast({
        title: "Kill Switch Activated",
        description: "All positions closed. Engine stopped.",
        variant: "destructive",
      });
      onStateChange('paused');
    } catch (error) {
      toast({
        title: "Failed to Activate Kill Switch",
        description: error instanceof Error ? error.message : 'Unknown error',
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <header className="border-b border-border bg-card/50 backdrop-blur supports-[backdrop-filter]:bg-card/30 sticky top-0 z-50">
      <div className="container mx-auto px-4 lg:px-6 py-3">
        {/* Critical Status Badges - Always Visible */}
        {(killSwitchActive || dailyStopHit || isPaused) && (
          <div className="flex flex-wrap items-center gap-2 mb-3 pb-3 border-b border-destructive/20">
            {killSwitchActive && (
              <Badge variant="destructive" className="animate-pulse">
                <Ban className="h-3 w-3 mr-1" />
                KILL-SWITCH: {runtimeStatus?.killSwitch?.reasons?.join(", ") || "Active"}
              </Badge>
            )}
            {dailyStopHit && (
              <Badge variant="outline" className="border-warning text-warning">
                <AlertTriangle className="h-3 w-3 mr-1" />
                DAILY STOP — New entries blocked
              </Badge>
            )}
            {isPaused && !killSwitchActive && (
              <Badge variant="secondary">
                <Pause className="h-3 w-3 mr-1" />
                PAUSED
              </Badge>
            )}
          </div>
        )}

        <div className="flex flex-col gap-4">
          {/* Top Row: Branding + Mode + Controls */}
          <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3">
            {/* Left: Branding + Mode Badge + Engine Status */}
            <div className="flex items-center gap-3">
              <h1 className="text-xl font-bold tracking-tight font-mono">AtlasBot v2</h1>
              {engineRunning ? (
                <Badge 
                  variant={isLive ? "destructive" : "default"}
                  className="font-mono"
                >
                  {isLive ? "LIVE" : "PAPER"}
                </Badge>
              ) : (
                <Badge variant="outline" className="font-mono text-muted-foreground">
                  STOPPED
                </Badge>
              )}
            </div>
            
            {/* Right: Controls */}
            <div className="flex flex-wrap items-center gap-2">
              {/* Engine Start/Stop */}
              {!engineRunning ? (
                <div className="flex items-center gap-2">
                  <Select value={startMode} onValueChange={(v) => setStartMode(v as 'paper' | 'live')}>
                    <SelectTrigger className="w-24 h-8 font-mono text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="paper">Paper</SelectItem>
                      <SelectItem value="live">Live</SelectItem>
                    </SelectContent>
                  </Select>
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button 
                        variant="default" 
                        size="sm"
                        disabled={isLoading}
                        className="gap-2 font-mono bg-success hover:bg-success/90"
                      >
                        <PlayCircle className="h-4 w-4" />
                        <span>Start Engine</span>
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Start Trading Engine</AlertDialogTitle>
                        <AlertDialogDescription className="space-y-2">
                          <p>You are about to start the trading engine in <strong className="text-foreground">{startMode.toUpperCase()}</strong> mode.</p>
                          {startMode === 'live' && (
                            <p className="text-warning font-semibold">
                              ⚠️ LIVE mode will execute real trades with real money!
                            </p>
                          )}
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction 
                          onClick={handleStartEngine}
                          disabled={isLoading}
                          className={startMode === 'live' ? 'bg-destructive' : 'bg-success'}
                        >
                          Start {startMode.toUpperCase()}
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </div>
              ) : (
                <>
                  {/* Pause/Resume when running */}
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handlePauseResume}
                    disabled={isLoading || killSwitchActive}
                    className="gap-2 font-mono"
                  >
                    {isPaused ? (
                      <>
                        <Play className="h-4 w-4" />
                        <span>Resume</span>
                      </>
                    ) : (
                      <>
                        <Pause className="h-4 w-4" />
                        <span>Pause</span>
                      </>
                    )}
                  </Button>

                  {/* Stop Engine */}
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button 
                        variant="outline" 
                        size="sm"
                        disabled={isLoading}
                        className="gap-2 font-mono"
                      >
                        <Square className="h-4 w-4" />
                        <span className="hidden sm:inline">Stop</span>
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Stop Trading Engine</AlertDialogTitle>
                        <AlertDialogDescription>
                          This will gracefully stop the trading engine. Open positions will be closed first.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction onClick={handleStopEngine} disabled={isLoading}>
                          Stop Engine
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>

                  {/* Kill Switch */}
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button 
                        variant="destructive" 
                        size="sm"
                        disabled={killSwitchActive}
                        className="gap-2 font-mono"
                      >
                        <Power className="h-4 w-4" />
                        <span className="hidden sm:inline">Kill</span>
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent className="border-destructive/50">
                      <AlertDialogHeader>
                        <AlertDialogTitle className="flex items-center gap-2 text-destructive">
                          <AlertTriangle className="h-5 w-5" />
                          Activate Emergency Kill Switch
                        </AlertDialogTitle>
                        <AlertDialogDescription className="space-y-2">
                          <p>This will immediately:</p>
                          <ul className="list-disc list-inside space-y-1 text-sm">
                            <li>Close all open positions at market</li>
                            <li>Cancel all pending orders</li>
                            <li>Halt all new trading activity</li>
                            <li>Lock the trading engine</li>
                          </ul>
                          <p className="font-semibold text-foreground mt-4">
                            This action cannot be undone. Are you absolutely sure?
                          </p>
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction 
                          onClick={handleKillSwitch}
                          disabled={isLoading}
                          className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                        >
                          Confirm Kill Switch
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </>
              )}
            </div>
          </div>

          {/* Bottom Row: Key Performance Indicators */}
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            {/* Equity */}
            <div className="space-y-1">
              <div className="text-xs text-muted-foreground font-mono">Equity</div>
              <div className="text-lg font-bold font-mono tabular-nums">
                {formatCurrency(metrics?.total_equity || 0)}
              </div>
            </div>

            {/* Daily P&L */}
            <div className="space-y-1">
              <div className="text-xs text-muted-foreground font-mono">Daily P&L</div>
              <div className={`text-lg font-bold font-mono tabular-nums ${
                (metrics?.daily_pnl || 0) >= 0 ? 'text-success profit-glow' : 'text-destructive loss-glow'
              }`}>
                {formatCurrency(metrics?.daily_pnl || 0)}
                <span className="text-xs ml-1">({(metrics?.daily_pnl_r || 0).toFixed(2)}R)</span>
              </div>
            </div>

            {/* Risk Heat */}
            <div className="space-y-1">
              <div className="text-xs text-muted-foreground font-mono">Risk Heat</div>
              <div className={`text-lg font-bold font-mono tabular-nums ${
                (metrics?.risk_heat || 0) > 70 ? 'text-destructive' : 
                (metrics?.risk_heat || 0) > 50 ? 'text-warning' : 'text-success'
              }`}>
                {(metrics?.risk_heat || 0).toFixed(0)}%
              </div>
            </div>

            {/* Spread Percentile */}
            <div className="space-y-1">
              <div className="text-xs text-muted-foreground font-mono">Spread %ile</div>
              <div className={`text-lg font-bold font-mono tabular-nums ${
                (runtimeStatus?.spreadPctile ?? 0) > 95 ? 'text-destructive' : 'text-foreground'
              }`}>
                {runtimeStatus?.spreadPctile ?? 0}%
              </div>
            </div>

            {/* Regime */}
            <div className="space-y-1">
              <div className="text-xs text-muted-foreground font-mono">Regime</div>
              <div className={`text-lg font-bold font-mono tabular-nums ${
                runtimeStatus?.regime === 'trend' ? 'text-success' : 'text-muted-foreground'
              }`}>
                {(runtimeStatus?.regime ?? 'chop').toUpperCase()}
              </div>
            </div>
          </div>
        </div>
      </div>
    </header>
  );
};
