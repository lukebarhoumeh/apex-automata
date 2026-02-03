/**
 * WebSocket Debug Panel
 * 
 * Hidden debug panel for visualizing WS connection state and events.
 * Only visible when VITE_DEBUG_WS=1 is set.
 */

import { useState, useEffect } from 'react';
import { useRuntimeWs, useRuntimeWsState } from '@/runtime/ws';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { 
  ChevronDown, 
  ChevronUp, 
  RefreshCw, 
  Wifi, 
  WifiOff,
  AlertTriangle,
} from 'lucide-react';
import type { RuntimeEventEnvelope } from '@/runtime/ws/types';

const DEBUG_WS = import.meta.env.VITE_DEBUG_WS === '1' || import.meta.env.VITE_DEBUG_WS === 'true';

export function WsDebugPanel() {
  const [isExpanded, setIsExpanded] = useState(false);
  const [events, setEvents] = useState<RuntimeEventEnvelope[]>([]);
  const { state, getRecentEvents, getUnknownTypesInfo, reconnect, subscribe } = useRuntimeWs();
  
  // Refresh events periodically and on new events
  useEffect(() => {
    const refresh = () => setEvents(getRecentEvents());
    refresh();
    
    // Subscribe to all events to trigger refresh
    return subscribe('*', refresh);
  }, [getRecentEvents, subscribe]);
  
  if (!DEBUG_WS) {
    return null;
  }
  
  const unknownInfo = getUnknownTypesInfo();
  const timeSinceLastEvent = state.lastEventAt 
    ? Math.round((Date.now() - state.lastEventAt) / 1000) 
    : null;
  
  return (
    <div className="fixed bottom-4 right-4 z-50 max-w-md">
      <Card className="border-muted bg-background/95 backdrop-blur shadow-lg">
        <CardHeader 
          className="cursor-pointer py-2 px-4"
          onClick={() => setIsExpanded(!isExpanded)}
        >
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm flex items-center gap-2">
              {state.connected ? (
                <Wifi className="h-4 w-4 text-success" />
              ) : (
                <WifiOff className="h-4 w-4 text-destructive" />
              )}
              WS Debug
            </CardTitle>
            <div className="flex items-center gap-2">
              <Badge variant={state.connected ? 'default' : 'destructive'} className="text-xs">
                {state.connected ? 'Connected' : 'Disconnected'}
              </Badge>
              {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronUp className="h-4 w-4" />}
            </div>
          </div>
        </CardHeader>
        
        {isExpanded && (
          <CardContent className="py-2 px-4 space-y-4">
            {/* Connection Stats */}
            <div className="grid grid-cols-2 gap-2 text-xs">
              <div>
                <span className="text-muted-foreground">Last Event:</span>
                <span className="ml-2">
                  {timeSinceLastEvent !== null ? `${timeSinceLastEvent}s ago` : 'Never'}
                </span>
              </div>
              <div>
                <span className="text-muted-foreground">Reconnects:</span>
                <span className="ml-2">{state.reconnectAttempts}</span>
              </div>
              {state.error && (
                <div className="col-span-2 text-destructive">
                  <AlertTriangle className="h-3 w-3 inline mr-1" />
                  {state.error}
                </div>
              )}
            </div>
            
            {/* Unknown Types Warning */}
            {unknownInfo.count > 0 && (
              <div className="text-xs p-2 rounded bg-warning/10 border border-warning/30">
                <span className="font-medium text-warning">Unknown types: {unknownInfo.count}</span>
                <div className="text-muted-foreground mt-1">
                  {unknownInfo.types.slice(0, 5).join(', ')}
                  {unknownInfo.types.length > 5 && '...'}
                </div>
              </div>
            )}
            
            {/* Actions */}
            <div className="flex gap-2">
              <Button 
                variant="outline" 
                size="sm" 
                onClick={reconnect}
                disabled={state.connected}
              >
                <RefreshCw className="h-3 w-3 mr-1" />
                Reconnect
              </Button>
            </div>
            
            {/* Recent Events */}
            <div>
              <div className="text-xs font-medium mb-1">Recent Events ({events.length})</div>
              <ScrollArea className="h-48 rounded border">
                <div className="p-2 space-y-1">
                  {events.length === 0 ? (
                    <div className="text-xs text-muted-foreground text-center py-4">
                      No events yet
                    </div>
                  ) : (
                    [...events].reverse().map((event, i) => (
                      <div 
                        key={`${event.ts}-${i}`}
                        className="text-xs p-1.5 rounded bg-muted/50 font-mono"
                      >
                        <div className="flex items-center justify-between">
                          <Badge variant="outline" className="text-xs">
                            {event.type}
                          </Badge>
                          <span className="text-muted-foreground">
                            {new Date(event.ts).toLocaleTimeString()}
                          </span>
                        </div>
                        {event.rawType && (
                          <div className="text-muted-foreground text-[10px] mt-0.5">
                            raw: {event.rawType}
                          </div>
                        )}
                        <div className="text-[10px] text-muted-foreground mt-1 truncate">
                          {JSON.stringify(event.payload).slice(0, 80)}...
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </ScrollArea>
            </div>
          </CardContent>
        )}
      </Card>
    </div>
  );
}
