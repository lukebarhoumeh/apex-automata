import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Power, Pause, Play, AlertTriangle, Ban } from "lucide-react";
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
import { tradingApi } from "@/services/tradingApi";
import { useToast } from "@/hooks/use-toast";
import { useState, useEffect } from "react";

interface DashboardHeaderProps {
  botState: "paper" | "live" | "paused";
  onStateChange: (state: "paper" | "live" | "paused") => void;
}

export const DashboardHeader = ({ botState, onStateChange }: DashboardHeaderProps) => {
  const { toast } = useToast();
  const [isEngineRunning, setIsEngineRunning] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const { data: metrics } = useAccountMetrics();
  
  // Mock runtime status - will be replaced with real data from runtime API
  const runtimeStatus = {
    killSwitch: false,
    killSwitchReasons: [] as string[],
    dailyStopHit: false,
    spreadPctile: 45,
    regime: "trend" as "trend" | "chop",
  };

  const formatCurrency = (val: number) => 
    new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0 }).format(val);

  useEffect(() => {
    // Check initial engine status
    checkEngineStatus();

    // Listen for WebSocket status updates
    const unsubscribe = tradingApi.on('status', (data: any) => {
      setIsEngineRunning(data.engineRunning);
      if (data.mode) {
        onStateChange(data.engineRunning ? data.mode : 'paused');
      }
    });

    return () => {
      unsubscribe();
    };
  }, [onStateChange]);

  const checkEngineStatus = async () => {
    try {
      const status = await tradingApi.getStatus();
      setIsEngineRunning(status.engineRunning);
      if (status.mode) {
        onStateChange(status.engineRunning ? status.mode : 'paused');
      }
    } catch (error) {
      console.error('Failed to check engine status:', error);
    }
  };

  const handleStartEngine = async () => {
    setIsLoading(true);
    try {
      await tradingApi.startEngine('paper');
      toast({
        title: "Trading Engine Started",
        description: "Paper trading mode is now active",
      });
      onStateChange('paper');
      setIsEngineRunning(true);
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
      await tradingApi.stopEngine();
      toast({
        title: "Trading Engine Stopped",
        description: "All trading activity has been paused",
      });
      onStateChange('paused');
      setIsEngineRunning(false);
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

  const handleKillSwitch = async () => {
    setIsLoading(true);
    try {
      await tradingApi.activateKillSwitch();
      toast({
        title: "Kill Switch Activated",
        description: "All positions closed and trading halted",
        variant: "destructive",
      });
      onStateChange('paused');
      setIsEngineRunning(false);
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

  const getBotStateColor = () => {
    switch (botState) {
      case "live":
        return "bg-success text-success-foreground animate-pulse-glow";
      case "paper":
        return "bg-warning text-warning-foreground";
      case "paused":
        return "bg-muted text-muted-foreground";
    }
  };

  return (
    <header className="border-b border-border bg-card/50 backdrop-blur supports-[backdrop-filter]:bg-card/30 sticky top-0 z-50">
      <div className="container mx-auto px-4 lg:px-6 py-3">
        {/* Critical Status Badges - Always Visible */}
        {(runtimeStatus.killSwitch || runtimeStatus.dailyStopHit || !isEngineRunning) && (
          <div className="flex flex-wrap items-center gap-2 mb-3 pb-3 border-b border-destructive/20">
            {runtimeStatus.killSwitch && (
              <Badge variant="destructive" className="animate-pulse">
                <Ban className="h-3 w-3 mr-1" />
                KILL-SWITCH: {runtimeStatus.killSwitchReasons.join(", ") || "Active"}
              </Badge>
            )}
            {runtimeStatus.dailyStopHit && (
              <Badge variant="outline" className="border-warning text-warning">
                <AlertTriangle className="h-3 w-3 mr-1" />
                DAILY STOP — New entries blocked
              </Badge>
            )}
            {!isEngineRunning && !runtimeStatus.killSwitch && (
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
            {/* Left: Branding + Mode Badge */}
            <div className="flex items-center gap-3">
              <h1 className="text-xl font-bold tracking-tight font-mono">AtlasBot v2</h1>
              <Badge 
                variant={botState === "live" ? "destructive" : "default"}
                className="font-mono"
              >
                {botState.toUpperCase()}
              </Badge>
            </div>
            
            {/* Right: Controls */}
            <div className="flex flex-wrap items-center gap-2">
              {!isEngineRunning ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleStartEngine}
                  disabled={isLoading}
                  className="gap-2 font-mono"
                >
                  <Play className="h-4 w-4" />
                  <span>Start</span>
                </Button>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleStopEngine}
                  disabled={isLoading}
                  className="gap-2 font-mono"
                >
                  <Pause className="h-4 w-4" />
                  <span>Pause</span>
                </Button>
              )}

              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button 
                    variant="destructive" 
                    size="sm"
                    className="gap-2 font-mono"
                  >
                    <Power className="h-4 w-4" />
                    <span className="hidden sm:inline">Kill Switch</span>
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
                runtimeStatus.spreadPctile > 95 ? 'text-destructive' : 'text-foreground'
              }`}>
                {runtimeStatus.spreadPctile}%
              </div>
            </div>

            {/* Regime */}
            <div className="space-y-1">
              <div className="text-xs text-muted-foreground font-mono">Regime</div>
              <div className={`text-lg font-bold font-mono tabular-nums ${
                runtimeStatus.regime === 'trend' ? 'text-success' : 'text-muted-foreground'
              }`}>
                {runtimeStatus.regime.toUpperCase()}
              </div>
            </div>
          </div>
        </div>
      </div>
    </header>
  );
};
