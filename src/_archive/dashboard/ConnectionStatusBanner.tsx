/**
 * Connection Status Banner
 * 
 * Shows accurate connection status based on the RuntimeConnectivity state machine.
 * No more "wsConnected || backendHealthy" false positives.
 */

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { WifiOff, Loader2, AlertTriangle, ServerOff, PauseCircle } from "lucide-react";
import { useConnectivity, getConnectivityDisplayInfo } from "@/runtime/connectivity";
import { HEARTBEAT_STALE_MS } from "@/runtime/connectivity/types";

export const ConnectionStatusBanner = () => {
  const connectivity = useConnectivity();
  
  // Don't show banner for connected state
  if (connectivity.state === 'CONNECTED') {
    return null;
  }
  
  // ENGINE_STOPPED and ENGINE_HALTED are handled by the header badges, not this banner
  // But we still want to show transport issues
  if (connectivity.state === 'ENGINE_STOPPED' || connectivity.state === 'ENGINE_HALTED') {
    return null;
  }
  
  const { description, variant } = getConnectivityDisplayInfo(connectivity);
  
  // Determine icon and styling based on state
  const getIcon = () => {
    switch (connectivity.state) {
      case 'STALE':
        return <AlertTriangle className="h-4 w-4" />;
      case 'DISCONNECTED':
        return <WifiOff className="h-4 w-4" />;
      case 'BACKEND_DOWN':
        return <ServerOff className="h-4 w-4" />;
      default:
        return <Loader2 className="h-4 w-4 animate-spin" />;
    }
  };
  
  const getTitle = () => {
    switch (connectivity.state) {
      case 'STALE':
        return 'Realtime Data Stale';
      case 'DISCONNECTED':
        return 'Disconnected';
      case 'BACKEND_DOWN':
        return 'Backend Unreachable';
      default:
        return 'Connection Issue';
    }
  };
  
  const getVariantClass = () => {
    switch (variant) {
      case 'error':
        return 'border-destructive/50 bg-destructive/10 text-destructive';
      case 'warning':
        return 'border-warning/50 bg-warning/10 text-warning-foreground';
      default:
        return 'border-muted/50 bg-muted/10';
    }
  };
  
  const isReconnecting = connectivity.state === 'DISCONNECTED';
  
  return (
    <Alert className={`mb-4 ${getVariantClass()}`}>
      <div className="flex items-center gap-2">
        {isReconnecting ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          getIcon()
        )}
        <AlertTitle className="mb-0">{getTitle()}</AlertTitle>
      </div>
      <AlertDescription className="mt-1">
        {description}
        {connectivity.state === 'STALE' && (
          <span className="ml-1 text-muted-foreground">
            (threshold: {HEARTBEAT_STALE_MS / 1000}s)
          </span>
        )}
      </AlertDescription>
    </Alert>
  );
};
