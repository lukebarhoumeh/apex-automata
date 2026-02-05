/**
 * Supabase Latency Debug Tab
 * 
 * Shows Supabase realtime connection status and latency metrics.
 */

import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useUnifiedEvents } from '@/runtime/event-bus/UnifiedEventProvider';
import { Database, RefreshCw, CheckCircle, XCircle, Clock } from 'lucide-react';
import type { RealtimeLatencyStats, RealtimeTableName } from '@/runtime/realtime/types';

interface SupabaseDebugTabProps {
  stats: RealtimeLatencyStats;
}

export function SupabaseDebugTab({ stats }: SupabaseDebugTabProps) {
  const { forceCatchUp } = useUnifiedEvents();
  const [health, setHealth] = useState<{ ok: boolean; dbOk: boolean; ts: string; error?: string } | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [healthLoading, setHealthLoading] = useState(false);
  const [healthCheckedAt, setHealthCheckedAt] = useState<number | null>(null);
  const functionUrl = import.meta.env.VITE_SUPABASE_URL
    ? `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/runtime-health`
    : null;
  
  const formatLatency = (ms: number | null): string => {
    if (ms === null) return '---';
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  };
  
  const formatFreshness = (ts: number | null): string => {
    if (ts === null) return 'Never';
    const ageMs = Date.now() - ts;
    if (ageMs < 1000) return 'Just now';
    if (ageMs < 60000) return `${Math.floor(ageMs / 1000)}s ago`;
    return `${Math.floor(ageMs / 60000)}m ago`;
  };
  
  const getStatusColor = (status: string): string => {
    switch (status) {
      case 'connected': return 'text-success';
      case 'connecting': return 'text-warning';
      case 'disconnected': return 'text-muted-foreground';
      case 'error': return 'text-destructive';
      default: return 'text-muted-foreground';
    }
  };
  
  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'connected': return <CheckCircle className="h-3 w-3 text-success" />;
      case 'connecting': return <Clock className="h-3 w-3 text-warning animate-pulse" />;
      default: return <XCircle className="h-3 w-3 text-destructive" />;
    }
  };
  
  // Filter to only show tables with events
  const activeTables = Object.entries(stats.eventCounts)
    .filter(([_, count]) => count > 0)
    .sort((a, b) => b[1] - a[1]) as [RealtimeTableName, number][];
  
  const totalEvents = Object.values(stats.eventCounts).reduce((a, b) => a + b, 0);

  const refreshHealth = async () => {
    if (!functionUrl) {
      setHealthError('Missing VITE_SUPABASE_URL');
      return;
    }

    setHealthLoading(true);
    try {
      const res = await fetch(functionUrl, { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data?.error || res.statusText);
      }
      setHealth(data);
      setHealthError(null);
    } catch (error) {
      setHealthError(error instanceof Error ? error.message : 'Unknown error');
    } finally {
      setHealthLoading(false);
      setHealthCheckedAt(Date.now());
    }
  };

  useEffect(() => {
    refreshHealth();
    const interval = setInterval(refreshHealth, 15000);
    return () => clearInterval(interval);
  }, [functionUrl]);
  
  return (
    <div className="space-y-3">
      {/* Connection Status */}
      <div className="grid grid-cols-2 gap-2 text-xs">
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground">Status:</span>
          <div className="flex items-center gap-1">
            {getStatusIcon(stats.connectionStatus)}
            <span className={getStatusColor(stats.connectionStatus)}>
              {stats.connectionStatus.charAt(0).toUpperCase() + stats.connectionStatus.slice(1)}
            </span>
          </div>
        </div>
        <div>
          <span className="text-muted-foreground">Total Events:</span>
          <span className="ml-2 font-mono">{totalEvents}</span>
        </div>
      </div>
      
      {/* Latency Metrics */}
      <div className="grid grid-cols-2 gap-2 text-xs">
        <div>
          <span className="text-muted-foreground">Last Event:</span>
          <span className="ml-2">{formatFreshness(stats.lastEventTs)}</span>
        </div>
        <div>
          <span className="text-muted-foreground">Ingestion Latency:</span>
          <span className={`ml-2 font-mono ${
            stats.lastEventLatencyMs !== null && stats.lastEventLatencyMs > 2000 
              ? 'text-warning' 
              : 'text-success'
          }`}>
            {formatLatency(stats.lastEventLatencyMs)}
          </span>
        </div>
      </div>
      
      {/* Last Event Table */}
      {stats.lastEventTable && (
        <div className="text-xs">
          <span className="text-muted-foreground">Last Table:</span>
          <Badge variant="outline" className="ml-2 text-xs">
            <Database className="h-3 w-3 mr-1" />
            {stats.lastEventTable}
          </Badge>
        </div>
      )}
      
      {/* Event Counts by Table */}
      {activeTables.length > 0 && (
        <div className="text-xs">
          <div className="text-muted-foreground mb-1">Events by Table:</div>
          <div className="flex flex-wrap gap-1">
            {activeTables.map(([table, count]) => (
              <Badge key={table} variant="secondary" className="text-[10px]">
                {table}: {count}
              </Badge>
            ))}
          </div>
        </div>
      )}
      
      {/* Actions */}
      <div className="flex gap-2 pt-1">
        <Button 
          variant="outline" 
          size="sm" 
          onClick={() => forceCatchUp()}
        >
          <RefreshCw className="h-3 w-3 mr-1" />
          Force Catch-Up
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => refreshHealth()}
          disabled={healthLoading}
        >
          <RefreshCw className={`h-3 w-3 mr-1 ${healthLoading ? 'animate-spin' : ''}`} />
          Refresh Health
        </Button>
      </div>

      {/* Function Health */}
      <div className="text-xs">
        <div className="text-muted-foreground mb-1">Function Health:</div>
        <div className="flex items-center gap-2">
          {healthLoading ? (
            <span className="text-muted-foreground">Checking...</span>
          ) : healthError ? (
            <span className="text-destructive">{healthError}</span>
          ) : health ? (
            <>
              <Badge variant="outline" className={health.dbOk ? 'text-success' : 'text-warning'}>
                {health.dbOk ? 'DB OK' : 'DB ERROR'}
              </Badge>
              <span className="text-muted-foreground">
                {health.ts}
              </span>
            </>
          ) : (
            <span className="text-muted-foreground">No data</span>
          )}
          {healthCheckedAt && (
            <span className="text-muted-foreground">
              · checked {formatFreshness(healthCheckedAt)}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
