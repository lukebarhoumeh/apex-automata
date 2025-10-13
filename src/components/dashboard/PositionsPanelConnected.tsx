import { PositionsPanel } from "./PositionsPanel";
import { usePositions } from "@/hooks/usePositions";
import { SkeletonTable } from "@/components/ui/skeleton-card";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export const PositionsPanelConnected = () => {
  const { data: positions, isLoading } = usePositions();

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

  return <PositionsPanel positions={positions || []} />;
};
