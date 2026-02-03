/**
 * Supabase Realtime Bridge
 * 
 * Subscribes to Supabase Postgres changes and publishes to the Event Bus.
 * Provides a backup/catch-up mechanism when WS misses events.
 */

import { supabase } from '@/integrations/supabase/client';
import { getEventBus } from '../event-bus/EventBus';
import type { BusEvent, BusEventType } from '../event-bus/types';
import type { RealtimePostgresChangesPayload, RealtimeChannel } from '@supabase/supabase-js';

// Debug mode
const DEBUG = import.meta.env.VITE_DEBUG_EVENT_BUS === '1' || import.meta.env.VITE_DEBUG_REALTIME === '1';

// ============ Types ============

type TableName = 'positions' | 'orders' | 'fills' | 'signals' | 'risk_events' | 'alerts' | 'account_metrics';

interface RealtimeBridgeConfig {
  tables: TableName[];
  userId?: string;
}

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
function generateDedupeKey(table: TableName, record: Record<string, unknown>): string {
  const id = record.id as string;
  
  switch (table) {
    case 'orders':
      return `order:${id}:${record.updated_at}`;
    case 'positions':
      return `pos:${id}:${record.updated_at || record.closed_at || record.opened_at}`;
    case 'fills':
      return `fill:${id || record.trade_id || `${record.order_id}:${record.filled_at}`}`;
    case 'signals':
      return `sig:${id}:${record.created_at}`;
    case 'risk_events':
      return `risk:${id}:${record.updated_at || record.triggered_at}`;
    case 'alerts':
      return `alert:${id}:${record.created_at}`;
    case 'account_metrics':
      return `metrics:${id}:${record.updated_at}`;
    default:
      return `${table}:${id}:${Date.now()}`;
  }
}

/**
 * Map a table event to a canonical bus event type.
 */
function mapToCanonicalType(
  table: TableName,
  eventType: 'INSERT' | 'UPDATE' | 'DELETE',
  record: Record<string, unknown>
): BusEventType | null {
  switch (table) {
    case 'positions':
      if (eventType === 'INSERT') return 'position:opened';
      if (eventType === 'UPDATE') {
        // Check if position was closed
        if (record.closed_at) return 'position:closed';
        return 'position:updated';
      }
      return null;
      
    case 'orders':
      if (eventType === 'INSERT') return 'order:created';
      if (eventType === 'UPDATE') {
        // Check if order was filled
        if (record.status === 'filled') return 'order:filled';
        return 'order:updated';
      }
      return null;
      
    case 'fills':
      if (eventType === 'INSERT') return 'fill';
      return null;
      
    case 'signals':
      if (eventType === 'INSERT') return 'signal';
      return null;
      
    case 'risk_events':
      return 'risk:event';
      
    case 'alerts':
      if (eventType === 'INSERT') return 'alert:new';
      return 'db:alerts';
      
    case 'account_metrics':
      return 'db:account_metrics';
      
    default:
      return null;
  }
}

// ============ Bridge Class ============

class SupabaseRealtimeBridge {
  private channel: RealtimeChannel | null = null;
  private config: RealtimeBridgeConfig;
  private isSubscribed = false;
  
  constructor(config: RealtimeBridgeConfig) {
    this.config = config;
  }
  
  /**
   * Start subscribing to Supabase Realtime changes.
   */
  public start(): void {
    if (this.isSubscribed) {
      return;
    }
    
    const { tables, userId } = this.config;
    
    this.channel = supabase.channel('event-bus-bridge');
    
    // Subscribe to each table
    for (const table of tables) {
      this.channel.on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table,
          ...(userId ? { filter: `user_id=eq.${userId}` } : {}),
        },
        (payload: RealtimePostgresChangesPayload<Record<string, unknown>>) => {
          this.handleChange(table, payload);
        }
      );
    }
    
    this.channel.subscribe((status) => {
      if (DEBUG) {
        console.log('[RealtimeBridge] Subscription status:', status);
      }
      
      if (status === 'SUBSCRIBED') {
        this.isSubscribed = true;
      } else if (status === 'CLOSED' || status === 'CHANNEL_ERROR') {
        this.isSubscribed = false;
      }
    });
  }
  
  /**
   * Stop subscribing and clean up.
   */
  public stop(): void {
    if (this.channel) {
      supabase.removeChannel(this.channel);
      this.channel = null;
      this.isSubscribed = false;
    }
  }
  
  /**
   * Check if currently subscribed.
   */
  public getIsSubscribed(): boolean {
    return this.isSubscribed;
  }
  
  /**
   * Handle a Postgres change event.
   */
  private handleChange(
    table: TableName,
    payload: RealtimePostgresChangesPayload<Record<string, unknown>>
  ): void {
    const eventType = payload.eventType as 'INSERT' | 'UPDATE' | 'DELETE';
    const record = (payload.new || payload.old) as Record<string, unknown>;
    
    if (!record) {
      return;
    }
    
    // Map to canonical type
    const canonicalType = mapToCanonicalType(table, eventType, record);
    
    if (!canonicalType) {
      if (DEBUG) {
        console.log('[RealtimeBridge] No canonical type for:', table, eventType);
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
      console.log('[RealtimeBridge] Publishing:', busEvent.type, busEvent.dedupeKey);
    }
    
    // Publish to bus
    getEventBus().publish(busEvent);
  }
}

// ============ Singleton Management ============

let bridgeInstance: SupabaseRealtimeBridge | null = null;

/**
 * Get or create the Supabase Realtime bridge.
 */
export function getRealtimeBridge(config?: RealtimeBridgeConfig): SupabaseRealtimeBridge {
  if (!bridgeInstance && config) {
    bridgeInstance = new SupabaseRealtimeBridge(config);
  }
  
  if (!bridgeInstance) {
    // Default config
    bridgeInstance = new SupabaseRealtimeBridge({
      tables: ['positions', 'orders', 'fills', 'signals', 'risk_events', 'alerts'],
    });
  }
  
  return bridgeInstance;
}

/**
 * Start the Supabase Realtime bridge with user context.
 */
export function startRealtimeBridge(userId?: string): void {
  const bridge = getRealtimeBridge({
    tables: ['positions', 'orders', 'fills', 'signals', 'risk_events', 'alerts', 'account_metrics'],
    userId,
  });
  
  bridge.start();
}

/**
 * Stop and reset the bridge.
 */
export function stopRealtimeBridge(): void {
  if (bridgeInstance) {
    bridgeInstance.stop();
    bridgeInstance = null;
  }
}

export type { SupabaseRealtimeBridge };
