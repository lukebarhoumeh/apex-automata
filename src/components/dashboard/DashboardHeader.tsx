import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Power, Pause, Play, AlertTriangle } from "lucide-react";
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
import { useToast } from "@/components/ui/use-toast";
import { useState, useEffect } from "react";

interface DashboardHeaderProps {
  botState: "paper" | "live" | "paused";
  onStateChange: (state: "paper" | "live" | "paused") => void;
}

export const DashboardHeader = ({ botState, onStateChange }: DashboardHeaderProps) => {
  const { toast } = useToast();
  const [isEngineRunning, setIsEngineRunning] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

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
    <header className="border-b bg-card/95 backdrop-blur-sm sticky top-0 z-50 shadow-lg">
      <div className="container mx-auto px-4 lg:px-6 py-3 lg:py-4">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-lg bg-gradient-to-br from-primary to-accent flex items-center justify-center shadow-lg">
                <span className="text-xl font-bold text-white">A</span>
              </div>
              <div>
                <h1 className="text-xl lg:text-2xl font-bold tracking-tight bg-gradient-to-r from-primary to-accent bg-clip-text text-transparent">
                  AtlasBot
                </h1>
                <p className="text-xs text-muted-foreground">Automated Trading Terminal</p>
              </div>
            </div>
            <Badge className={getBotStateColor()}>
              {botState.toUpperCase()}
            </Badge>
          </div>

          <div className="flex items-center gap-2">
            {!isEngineRunning ? (
              <Button
                variant="outline"
                size="sm"
                onClick={handleStartEngine}
                disabled={isLoading}
                className="gap-2"
              >
                <Play className="h-4 w-4" />
                <span className="hidden sm:inline">Start</span>
              </Button>
            ) : (
              <Button
                variant="outline"
                size="sm"
                onClick={handleStopEngine}
                disabled={isLoading}
                className="gap-2"
              >
                <Pause className="h-4 w-4" />
                <span className="hidden sm:inline">Pause</span>
              </Button>
            )}

            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button 
                  variant="destructive" 
                  size="sm"
                  className="gap-2 shadow-lg shadow-destructive/20"
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
      </div>
    </header>
  );
};
