import { Alert, AlertDescription } from "@/components/ui/alert";
import { WifiOff, Loader2 } from "lucide-react";
import { useRuntimeWsState } from "@/runtime/ws";
import { useRuntimeHealth } from "@/hooks/useRuntimeStatus";

interface ConnectionStatusBannerProps {
  isConnected?: boolean;
  isReconnecting?: boolean;
}

export const ConnectionStatusBanner = ({ 
  isConnected: propIsConnected, 
  isReconnecting: propIsReconnecting 
}: ConnectionStatusBannerProps) => {
  // Use the unified WS state from RuntimeWsProvider
  const wsState = useRuntimeWsState();
  
  // Also check if backend health endpoint is reachable
  const { data: backendHealthy } = useRuntimeHealth();
  
  // Use props if provided, otherwise use WS state
  const isConnected = propIsConnected ?? wsState.connected;
  const isReconnecting = propIsReconnecting ?? (wsState.reconnectAttempts > 0 && !wsState.connected);
  
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
          <span>
            Reconnecting to trading engine... (attempt {wsState.reconnectAttempts})
          </span>
        ) : (
          <span>Disconnected from trading engine. Showing historical data only.</span>
        )}
      </AlertDescription>
    </Alert>
  );
};
