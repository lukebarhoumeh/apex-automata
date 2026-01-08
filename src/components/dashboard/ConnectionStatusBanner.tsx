import { Alert, AlertDescription } from "@/components/ui/alert";
import { WifiOff, Loader2 } from "lucide-react";
import { useRuntimeHealth } from "@/hooks/useRuntimeStatus";

interface ConnectionStatusBannerProps {
  isConnected: boolean;
  isReconnecting?: boolean;
}

export const ConnectionStatusBanner = ({ 
  isConnected, 
  isReconnecting = false 
}: ConnectionStatusBannerProps) => {
  // Also check if backend health endpoint is reachable
  const { data: backendHealthy } = useRuntimeHealth();
  
  // Consider connected if either WebSocket is connected OR backend API is healthy
  const actuallyConnected = isConnected || backendHealthy;
  
  if (actuallyConnected) return null;

  return (
    <Alert variant="destructive" className="mb-4 border-warning/50 bg-warning/10">
      <div className="flex items-center gap-2">
        {isReconnecting ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <WifiOff className="h-4 w-4" />
        )}
      </div>
      <AlertDescription>
        {isReconnecting ? (
          <span>Reconnecting to trading engine...</span>
        ) : (
          <span>Disconnected from trading engine. Showing historical data only.</span>
        )}
      </AlertDescription>
    </Alert>
  );
};
