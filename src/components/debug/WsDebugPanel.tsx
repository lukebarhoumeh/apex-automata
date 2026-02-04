/**
 * WebSocket & Event Bus Debug Panel
 * 
 * Hidden debug panel for visualizing WS connection state, events, and bus statistics.
 * Only visible when VITE_DEBUG_WS=1 or VITE_DEBUG_EVENT_BUS=1 is set.
 */

import { useState, useEffect } from 'react';
import { useRuntimeWs, useRuntimeWsState } from '@/runtime/ws';
import { getEventBus } from '@/runtime/event-bus';
import { useConnectivity, getConnectivityDisplayInfo } from '@/runtime/connectivity';
import { useUnifiedEvents } from '@/runtime/event-bus/UnifiedEventProvider';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { SupabaseDebugTab } from './SupabaseDebugTab';
import { 
  ChevronDown, 
  ChevronUp, 
  RefreshCw, 
  Wifi, 
  WifiOff,
  AlertTriangle,
  Activity,
  Database,
  Radio,
} from 'lucide-react';
import type { RuntimeEventEnvelope } from '@/runtime/ws/types';
import type { BusEvent, EventBusStats } from '@/runtime/event-bus/types';

const DEBUG_WS = import.meta.env.VITE_DEBUG_WS === '1' || import.meta.env.VITE_DEBUG_WS === 'true';
const DEBUG_BUS = import.meta.env.VITE_DEBUG_EVENT_BUS === '1' || import.meta.env.VITE_DEBUG_EVENT_BUS === 'true';
const DEBUG_REALTIME = import.meta.env.VITE_DEBUG_REALTIME === '1' || import.meta.env.VITE_DEBUG_REALTIME === 'true';

export function WsDebugPanel() {
  const [isExpanded, setIsExpanded] = useState(false);
  const [wsEvents, setWsEvents] = useState<RuntimeEventEnvelope[]>([]);
  const [busEvents, setBusEvents] = useState<BusEvent[]>([]);
  const [busStats, setBusStats] = useState<EventBusStats | null>(null);
  const { state, getRecentEvents, getUnknownTypesInfo, reconnect, subscribe } = useRuntimeWs();
  const connectivity = useConnectivity();
  const connectivityInfo = getConnectivityDisplayInfo(connectivity);
  
  // Get unified events context (includes realtime stats)
  let realtimeStats = null;
  try {
    const unified = useUnifiedEvents();
    realtimeStats = unified.realtimeStats;
  } catch {
    // Not within provider, use default
  }
  
  // Refresh WS events periodically and on new events
  useEffect(() => {
    const refresh = () => setWsEvents(getRecentEvents());
    refresh();
    
    // Subscribe to all events to trigger refresh
    return subscribe('*', refresh);
  }, [getRecentEvents, subscribe]);
  
  // Refresh bus events and stats
  useEffect(() => {
    const bus = getEventBus();
    
    const refresh = () => {
      setBusEvents(bus.getRecentEvents());
      setBusStats(bus.getStats());
    };
    
    refresh();
    
    // Subscribe to updates
    const unsubscribe = bus.subscribe(() => {
      refresh();
    });
    
    // Also poll occasionally
    const interval = setInterval(refresh, 2000);
    
    return () => {
      unsubscribe();
      clearInterval(interval);
    };
  }, []);
  
  if (!DEBUG_WS && !DEBUG_BUS && !DEBUG_REALTIME) {
    return null;
  }
  
  const unknownInfo = getUnknownTypesInfo();
  const timeSinceLastEvent = state.lastEventAt 
    ? Math.round((Date.now() - state.lastEventAt) / 1000) 
    : null;
  
  return (
    <div className="fixed bottom-4 right-4 z-50 max-w-lg w-full">
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
              Debug Panel
            </CardTitle>
            <div className="flex items-center gap-2">
              <Badge 
                variant="outline" 
                className={`text-xs ${
                  connectivityInfo.variant === 'success' ? 'bg-success/10 text-success' :
                  connectivityInfo.variant === 'warning' ? 'bg-warning/10 text-warning' :
                  connectivityInfo.variant === 'error' ? 'bg-destructive/10 text-destructive' :
                  'bg-info/10 text-info'
                }`}
              >
                {connectivityInfo.label}
              </Badge>
              {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronUp className="h-4 w-4" />}
            </div>
          </div>
        </CardHeader>
        
        {isExpanded && (
          <CardContent className="py-2 px-4 space-y-4">
            <Tabs defaultValue="connectivity" className="w-full">
              <TabsList className="w-full grid grid-cols-4">
                <TabsTrigger value="connectivity" className="text-xs">WS</TabsTrigger>
                <TabsTrigger value="supabase" className="text-xs">Supabase</TabsTrigger>
                <TabsTrigger value="bus" className="text-xs">Event Bus</TabsTrigger>
                <TabsTrigger value="events" className="text-xs">Events</TabsTrigger>
              </TabsList>
              
              {/* Connectivity Tab */}
              <TabsContent value="connectivity" className="space-y-3">
                {/* Connection Stats */}
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div>
                    <span className="text-muted-foreground">WS State:</span>
                    <Badge variant={state.connected ? 'default' : 'destructive'} className="ml-2 text-xs">
                      {state.connected ? 'Open' : 'Closed'}
                    </Badge>
                  </div>
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
                  <div>
                    <span className="text-muted-foreground">State:</span>
                    <span className="ml-2 font-mono">{connectivity.state}</span>
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
              </TabsContent>
              
              {/* Supabase Tab */}
              <TabsContent value="supabase" className="space-y-3">
                {realtimeStats ? (
                  <SupabaseDebugTab stats={realtimeStats} />
                ) : (
                  <div className="text-xs text-muted-foreground text-center py-4">
                    Supabase realtime stats not available
                  </div>
                )}
              </TabsContent>
              
              {/* Event Bus Tab */}
              <TabsContent value="bus" className="space-y-3">
                {busStats && (
                  <div className="space-y-2">
                    <div className="grid grid-cols-2 gap-2 text-xs">
                      <div>
                        <span className="text-muted-foreground">Total Published:</span>
                        <span className="ml-2 font-mono">{busStats.totalEventsPublished}</span>
                      </div>
                      <div>
                        <span className="text-muted-foreground">Dedupe Hits:</span>
                        <span className="ml-2 font-mono text-warning">{busStats.dedupeHits}</span>
                      </div>
                    </div>
                    
                    {/* Events by Source */}
                    <div className="text-xs">
                      <div className="text-muted-foreground mb-1">Events by Source:</div>
                      <div className="flex gap-2">
                        <Badge variant="outline" className="text-xs gap-1">
                          <Radio className="h-3 w-3" />
                          WS: {busStats.eventsBySource.ws}
                        </Badge>
                        <Badge variant="outline" className="text-xs gap-1">
                          <Database className="h-3 w-3" />
                          DB: {busStats.eventsBySource.supabase}
                        </Badge>
                        <Badge variant="outline" className="text-xs gap-1">
                          <Activity className="h-3 w-3" />
                          REST: {busStats.eventsBySource.rest}
                        </Badge>
                      </div>
                    </div>
                    
                    {/* Top Event Types */}
                    <div className="text-xs">
                      <div className="text-muted-foreground mb-1">Top Event Types:</div>
                      <div className="flex flex-wrap gap-1">
                        {Object.entries(busStats.eventsByType)
                          .sort((a, b) => b[1] - a[1])
                          .slice(0, 6)
                          .map(([type, count]) => (
                            <Badge key={type} variant="secondary" className="text-[10px]">
                              {type}: {count}
                            </Badge>
                          ))}
                      </div>
                    </div>
                  </div>
                )}
              </TabsContent>
              
              {/* Events Tab */}
              <TabsContent value="events">
                <div>
                  <div className="text-xs font-medium mb-1">Recent Bus Events ({busEvents.length})</div>
                  <ScrollArea className="h-48 rounded border">
                    <div className="p-2 space-y-1">
                      {busEvents.length === 0 ? (
                        <div className="text-xs text-muted-foreground text-center py-4">
                          No events yet
                        </div>
                      ) : (
                        [...busEvents].reverse().map((event, i) => (
                          <div 
                            key={`${event.ts}-${i}`}
                            className="text-xs p-1.5 rounded bg-muted/50 font-mono"
                          >
                            <div className="flex items-center justify-between">
                              <Badge variant="outline" className="text-xs">
                                {event.type}
                              </Badge>
                              <div className="flex items-center gap-2">
                                <Badge 
                                  variant="secondary" 
                                  className={`text-[10px] ${
                                    event.source === 'ws' ? 'bg-primary/20' : 
                                    event.source === 'supabase' ? 'bg-info/20' : 
                                    'bg-muted'
                                  }`}
                                >
                                  {event.source}
                                </Badge>
                                <span className="text-muted-foreground">
                                  {new Date(event.ts).toLocaleTimeString()}
                                </span>
                              </div>
                            </div>
                            {event.dedupeKey && (
                              <div className="text-muted-foreground text-[10px] mt-0.5">
                                key: {event.dedupeKey}
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
              </TabsContent>
            </Tabs>
          </CardContent>
        )}
      </Card>
    </div>
  );
}
