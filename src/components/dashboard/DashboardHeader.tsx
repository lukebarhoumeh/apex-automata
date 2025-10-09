import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Power, Pause, Play, AlertTriangle, Settings, Bell } from "lucide-react";
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

interface DashboardHeaderProps {
  botState: "paper" | "live" | "paused";
  onStateChange: (state: "paper" | "live" | "paused") => void;
}

export const DashboardHeader = ({ botState, onStateChange }: DashboardHeaderProps) => {
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
            <Button
              variant="ghost"
              size="icon"
              className="relative"
            >
              <Bell className="h-4 w-4" />
              <span className="absolute top-1 right-1 h-2 w-2 rounded-full bg-destructive animate-pulse" />
            </Button>
            
            <Button
              variant="ghost"
              size="icon"
            >
              <Settings className="h-4 w-4" />
            </Button>

            {botState === "paused" ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => onStateChange("paper")}
                className="gap-2"
              >
                <Play className="h-4 w-4" />
                <span className="hidden sm:inline">Resume</span>
              </Button>
            ) : (
              <Button
                variant="outline"
                size="sm"
                onClick={() => onStateChange("paused")}
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
                  <AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
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
