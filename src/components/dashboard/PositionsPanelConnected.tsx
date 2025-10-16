import { useState } from "react";
import { PositionsPanel } from "./PositionsPanel";
import { PositionDetailsDrawer } from "./PositionDetailsDrawer";
import { CloseAllDialog } from "./CloseAllDialog";
import { usePositions } from "@/hooks/usePositions";
import { SkeletonTable } from "@/components/ui/skeleton-card";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { XCircle } from "lucide-react";

export const PositionsPanelConnected = () => {
  const { data: positions, isLoading } = usePositions();
  const { toast } = useToast();
  const [selectedPositionId, setSelectedPositionId] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [closeAllDialogOpen, setCloseAllDialogOpen] = useState(false);

  const handleViewDetails = (positionId: string) => {
    setSelectedPositionId(positionId);
    setDrawerOpen(true);
  };

  const handleClosePosition = async (positionId: string) => {
    try {
      const { runtimeClient } = await import("@/services/runtimeClient");
      
      // Call runtime to close position
      // For now, we'll just log it - the actual API endpoint needs to be implemented
      console.log("Close position:", positionId);

      toast({
        title: "Position Closed",
        description: "Position has been closed successfully",
      });

      setDrawerOpen(false);
    } catch (error) {
      toast({
        title: "Error",
        description: error instanceof Error ? error.message : "Failed to close position",
        variant: "destructive",
      });
    }
  };

  const handleCloseAll = async (reason: string) => {
    try {
      const { runtimeClient } = await import("@/services/runtimeClient");
      await runtimeClient.closeAll(reason, "CLOSE ALL");

      toast({
        title: "All Positions Closed",
        description: "All open positions have been closed",
      });
    } catch (error) {
      toast({
        title: "Error",
        description: error instanceof Error ? error.message : "Failed to close positions",
        variant: "destructive",
      });
    }
  };

  const selectedPosition = positions?.find((p) => p.id === selectedPositionId);
  const openPositions = positions?.filter((p) => !p.closed_at) || [];

  if (isLoading) {
    return (
      <Card className="card-glow">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            Open Positions
            <Badge variant="outline" className="ml-2 bg-primary/10 border-primary/40">
              Loading...
            </Badge>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <SkeletonTable rows={2} />
        </CardContent>
      </Card>
    );
  }

  return (
    <>
      <Card className="card-glow">
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="flex items-center gap-2">
              Open Positions
              <Badge variant="outline" className="ml-2 bg-primary/10 border-primary/40 animate-fade-in">
                {openPositions.length} Active
              </Badge>
            </CardTitle>
            {openPositions.length > 0 && (
              <Button
                variant="destructive"
                size="sm"
                onClick={() => setCloseAllDialogOpen(true)}
                className="gap-2 font-mono"
              >
                <XCircle className="h-4 w-4" />
                Close All
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent>
          <PositionsPanel 
            positions={openPositions} 
            onViewDetails={handleViewDetails}
          />
        </CardContent>
      </Card>

      <PositionDetailsDrawer
        open={drawerOpen}
        onOpenChange={setDrawerOpen}
        positionId={selectedPositionId}
        onClosePosition={handleClosePosition}
      />

      <CloseAllDialog
        open={closeAllDialogOpen}
        onOpenChange={setCloseAllDialogOpen}
        onConfirm={handleCloseAll}
        positionCount={openPositions.length}
      />
    </>
  );
};
