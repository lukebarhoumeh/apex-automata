import { Alert, AlertDescription } from "@/components/ui/alert";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";

interface StaleDataWarningProps {
  lastUpdate: Date | null;
  onRefresh?: () => void;
}

export const StaleDataWarning = ({ lastUpdate, onRefresh }: StaleDataWarningProps) => {
  if (!lastUpdate) return null;
  
  const now = new Date();
  const diff = now.getTime() - lastUpdate.getTime();
  const isStale = diff > 15000; // 15 seconds

  if (!isStale) return null;

  return (
    <Alert variant="destructive" className="mb-4 border-danger/50 bg-danger/10">
      <AlertTriangle className="h-4 w-4" />
      <AlertDescription className="flex items-center justify-between">
        <span>
          <strong>DATA STALE</strong> — Last update {Math.floor(diff / 1000)}s ago. 
          Check runtime process.
        </span>
        {onRefresh && (
          <Button
            variant="outline"
            size="sm"
            onClick={onRefresh}
            className="ml-4 h-7 text-xs"
          >
            Refresh
          </Button>
        )}
      </AlertDescription>
    </Alert>
  );
};
