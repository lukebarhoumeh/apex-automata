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

interface DashboardHeaderProps {
  botState: "paper" | "live" | "paused";
  onStateChange: (state: "paper" | "live" | "paused") => void;
}

export const DashboardHeader = ({ botState, onStateChange }: DashboardHeaderProps) => {
  const getBotStateColor = () => {
    switch (botState) {
      case "live":
        return "bg-success text-success-foreground";
      case "paper":
        return "bg-warning text-warning-foreground";
      case "paused":
        return "bg-muted text-muted-foreground";
    }
  };

  return (
    <header className="border-b bg-card">
      <div className="container mx-auto px-6 py-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <h1 className="text-2xl font-bold tracking-tight">AtlasBot</h1>
            <Badge className={getBotStateColor()}>
              {botState.toUpperCase()}
            </Badge>
          </div>

          <div className="flex items-center gap-2">
            {botState === "paused" ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => onStateChange("paper")}
              >
                <Play className="h-4 w-4 mr-2" />
                Resume
              </Button>
            ) : (
              <Button
                variant="outline"
                size="sm"
                onClick={() => onStateChange("paused")}
              >
                <Pause className="h-4 w-4 mr-2" />
                Pause
              </Button>
            )}

            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="destructive" size="sm">
                  <Power className="h-4 w-4 mr-2" />
                  Kill Switch
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle className="flex items-center gap-2">
                    <AlertTriangle className="h-5 w-5 text-destructive" />
                    Activate Kill Switch
                  </AlertDialogTitle>
                  <AlertDialogDescription>
                    This will immediately close all positions and halt all trading.
                    This action cannot be undone. Are you sure?
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
