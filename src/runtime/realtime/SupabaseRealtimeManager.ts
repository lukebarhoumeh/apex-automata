/**
 * Supabase Realtime Manager
 * 
 * Single owner for all Supabase realtime subscriptions.
 * Subscribes to tables with user filtering and publishes to the Event Bus.
 */

import { supabase } from '@/integrations/supabase/client';
import { getEventBus } from '../event-bus/EventBus';
import type { BusEvent, BusEventType } from '../event-bus/types';
import type { RealtimePostgresChangesPayload, RealtimeChannel } from '@supabase/supabase-js';
import type { RealtimeTableName, RealtimeLatencyStats, RealtimeSubscriptionConfig } from './types';
import { performCatchUp, prepareCatchUp } from './catchUp';

const DEBUG = import.meta.env.VITE_DEBUG_REALTIME === '1' || import.meta.env.VITE_DEBUG_EVENT_BUS === '1';

// ============ Payload Normalization ============

/**
 * Convert snake_case object to camelCase.
 */
function snakeToCamel(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  
  for (const [key, value] of Object.entries(obj)) {
    const camelKey = key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
    result[camelKey] = value;
  }
  
  return result;
}

/**
 * Generate a dedupe key for an event.
 */
function generateDedupeKey(table: RealtimeTableName, record: Record<string, unknown>): string {
  const id = record.id as string;
  
  switch (table) {
    case 'orders':
      return `order:${id}:${record.updated_at || record.created_at}`;
    case 'order_legs':
      return `leg:${id}:${record.updated_at}`;
    case 'positions':
      return `pos:${id}:${record.updated_at || record.closed_at || record.opened_at}`;
    case 'fills':
      return `fill:${id || record.trade_id || `${record.order_id}:${record.filled_at}`}`;
    case 'signals':
      return `sig:${id}:${record.created_at}`;
    case 'risk_events':
      return `riske:${id}:${record.updated_at || record.triggered_at}`;
    case 'risk_metrics':
      return `riskm:${record.user_id}:${record.updated_at}`;
    case 'alerts':
      return `alert:${id}:${record.created_at}`;
    case 'account_metrics':
      return `acct:${record.user_id}:${record.updated_at}`;
    case 'trading_sessions':
      return `session:${record.session_id}:${record.updated_at}`;
    default:
      return `${table}:${id}:${Date.now()}`;
  }
}

/**
 * Map a table event to a canonical bus event type.
 */
function mapToCanonicalType(
  table: RealtimeTableName,
  eventType: 'INSERT' | 'UPDATE' | 'DELETE',
  record: Record<string, unknown>
): BusEventType | null {
  switch (table) {
    case 'positions':
      if (eventType === 'INSERT') return 'position:opened';
      if (eventType === 'UPDATE') {
        if (record.closed_at) return 'position:closed';
        return 'position:updated';
      }
      return null;
      
    case 'orders':
      if (eventType === 'INSERT') return 'order:created';
      if (eventType === 'UPDATE') {
        if (record.status === 'filled') return 'order:filled';
        return 'order:updated';
      }
      return null;
      
    case 'order_legs':
      if (eventType === 'INSERT') return 'order:created';
      if (eventType === 'UPDATE') return 'order:updated';
      return null;
      
    case 'fills':
      if (eventType === 'INSERT') return 'fill';
      return null;
      
    case 'signals':
      if (eventType === 'INSERT') return 'signal';
      return null;
      
    case 'risk_events':
      return 'risk:event';
      
    case 'risk_metrics':
      return 'db:risk_metrics';
      
    case 'alerts':
      if (eventType === 'INSERT') return 'alert:new';
      return 'db:alerts';
      
    case 'account_metrics':
      return 'db:account_metrics';
      
    case 'trading_sessions':
      return 'db:trading_sessions';
      
    default:
      return null;
  }
}

/**
 * Calculate latency from row timestamp to now.
 */
function calculateLatencyMs(record: Record<string, unknown>): number {
  const ts = record.updated_at || record.created_at || record.triggered_at || record.filled_at;
  if (!ts) return 0;
  
  const recordTime = new Date(ts as string).getTime();
  return Date.now() - recordTime;
}

// ============ Manager Class ============

class SupabaseRealtimeManager {
  private channel: RealtimeChannel | null = null;
  private config: RealtimeSubscriptionConfig | null = null;
  private latencyStats: RealtimeLatencyStats;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectTimeoutId: ReturnType<typeof setTimeout> | null = null;
  
  constructor() {
    this.latencyStats = {
      lastEventTs: null,
      lastEventTable: null,
      lastEventLatencyMs: null,
      isSubscribed: false,
      eventCounts: {
        positions: 0,
        orders: 0,
        order_legs: 0,
        fills: 0,
        signals: 0,
        risk_events: 0,
        risk_metrics: 0,
        alerts: 0,
        account_metrics: 0,
        trading_sessions: 0,
      },
      connectionStatus: 'disconnected',
    };
  }
  
  /**
   * Start subscribing to Supabase Realtime changes.
   */
  public async start(config: RealtimeSubscriptionConfig): Promise<void> {
    if (this.channel) {
      await this.stop();
    }
    
    this.config = config;
    this.latencyStats.connectionStatus = 'connecting';
    
    const { tables, userId } = config;
    
    if (DEBUG) {
      console.log('[SupabaseRealtimeManager] Starting with config:', { tables, userId });
    }
    
    this.channel = supabase.channel('unified-realtime', {
      config: {
        broadcast: { self: false },
      },
    });
    
    // Subscribe to each table with user_id filter
    for (const table of tables) {
      this.channel.on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table,
          filter: `user_id=eq.${userId}`,
        },
        (payload: RealtimePostgresChangesPayload<Record<string, unknown>>) => {
          this.handleChange(table, payload);
        }
      );
    }
    
    // Subscribe to channel
    this.channel.subscribe((status) => {
      if (DEBUG) {
        console.log('[SupabaseRealtimeManager] Subscription status:', status);
      }
      
      if (status === 'SUBSCRIBED') {
        this.latencyStats.isSubscribed = true;
        this.latencyStats.connectionStatus = 'connected';
        this.reconnectAttempts = 0;
        
        // Perform catch-up on successful subscription
        this.performCatchUp();
      } else if (status === 'CLOSED') {
        this.latencyStats.isSubscribed = false;
        this.latencyStats.connectionStatus = 'disconnected';
        this.scheduleReconnect();
      } else if (status === 'CHANNEL_ERROR') {
        this.latencyStats.isSubscribed = false;
        this.latencyStats.connectionStatus = 'error';
        this.scheduleReconnect();
      }
    });
  }
  
  /**
   * Stop subscribing and clean up.
   */
  public async stop(): Promise<void> {
    if (this.reconnectTimeoutId) {
      clearTimeout(this.reconnectTimeoutId);
      this.reconnectTimeoutId = null;
    }
    
    if (this.channel) {
      await supabase.removeChannel(this.channel);
      this.channel = null;
      this.latencyStats.isSubscribed = false;
      this.latencyStats.connectionStatus = 'disconnected';
    }
  }
  
  /**
   * Get current latency stats.
   */
  public getLatencyStats(): RealtimeLatencyStats {
    return { ...this.latencyStats };
  }
  
  /**
   * Perform catch-up fetch.
   */
  private async performCatchUp(): Promise<void> {
    if (!this.config) return;
    
    prepareCatchUp();
    await performCatchUp(this.config.userId);
  }
  
  /**
   * Schedule a reconnection attempt.
   */
  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('[SupabaseRealtimeManager] Max reconnect attempts reached');
      return;
    }
    
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
    this.reconnectAttempts++;
    
    if (DEBUG) {
      console.log(`[SupabaseRealtimeManager] Scheduling reconnect in ${delay}ms (attempt ${this.reconnectAttempts})`);
    }
    
    this.reconnectTimeoutId = setTimeout(() => {
      if (this.config) {
        this.start(this.config);
      }
    }, delay);
  }
  
  /**
   * Handle a Postgres change event.
   */
  private handleChange(
    table: RealtimeTableName,
    payload: RealtimePostgresChangesPayload<Record<string, unknown>>
  ): void {
    const eventType = payload.eventType as 'INSERT' | 'UPDATE' | 'DELETE';
    const record = (payload.new || payload.old) as Record<string, unknown>;
    
    if (!record) {
      return;
    }
    
    // Update stats
    this.latencyStats.lastEventTs = Date.now();
    this.latencyStats.lastEventTable = table;
    this.latencyStats.lastEventLatencyMs = calculateLatencyMs(record);
    this.latencyStats.eventCounts[table]++;
    
    // Map to canonical type
    const canonicalType = mapToCanonicalType(table, eventType, record);
    
    if (!canonicalType) {
      if (DEBUG) {
        console.log('[SupabaseRealtimeManager] No canonical type for:', table, eventType);
      }
      return;
    }
    
    // Generate dedupe key
    const dedupeKey = generateDedupeKey(table, record);
    
    // Normalize payload to camelCase
    const normalizedPayload = snakeToCamel(record);
    
    // Create bus event
    const busEvent: BusEvent = {
      type: canonicalType,
      payload: normalizedPayload,
      ts: Date.now(),
      source: 'supabase',
      dedupeKey,
    };
    
    if (DEBUG) {
      console.log('[SupabaseRealtimeManager] Publishing:', busEvent.type, busEvent.dedupeKey, 
        `latency: ${this.latencyStats.lastEventLatencyMs}ms`);
    }
    
    // Publish to bus
    getEventBus().publish(busEvent);
  }
}

// ============ Singleton Management ============

let managerInstance: SupabaseRealtimeManager | null = null;

/**
 * Get the Supabase Realtime manager singleton.
 */
export function getRealtimeManager(): SupabaseRealtimeManager {
  if (!managerInstance) {
    managerInstance = new SupabaseRealtimeManager();
  }
  return managerInstance;
}

/**
 * Start the Supabase Realtime manager with user context.
 */
export async function startRealtimeManager(userId: string): Promise<void> {
  const manager = getRealtimeManager();
  
  await manager.start({
    tables: [
      'positions',
      'orders',
      'order_legs',
      'fills',
      'signals',
      'risk_events',
      'risk_metrics',
      'alerts',
      'account_metrics',
      'trading_sessions',
    ],
    userId,
  });
}

/**
 * Stop and reset the manager.
 */
export async function stopRealtimeManager(): Promise<void> {
  if (managerInstance) {
    await managerInstance.stop();
    managerInstance = null;
  }
}

export type { SupabaseRealtimeManager };
