/**
 * Event Bus
 * 
 * Central event dispatcher that merges WS + Supabase Realtime events.
 * Handles deduplication and provides subscription API.
 */

import { LRUDedupeCache } from './LRUDedupeCache';
import type {
  BusEvent,
  BusEventHandler,
  BusEventType,
  EventBusStats,
  EventSource,
} from './types';

const DEBUG = import.meta.env.VITE_DEBUG_EVENT_BUS === '1' || import.meta.env.VITE_DEBUG_EVENT_BUS === 'true';

interface Subscriber {
  types: BusEventType[] | '*';
  handler: BusEventHandler;
}

class EventBusImpl {
  private subscribers: Set<Subscriber> = new Set();
  private dedupeCache = new LRUDedupeCache();
  
  private stats: EventBusStats = {
    totalEventsPublished: 0,
    eventsBySource: { ws: 0, supabase: 0, rest: 0 },
    eventsByType: {},
    dedupeHits: 0,
    lastEventAt: null,
  };
  
  private eventBuffer: BusEvent[] = [];
  private bufferSize = 100;
  
  /**
   * Publish an event to the bus.
   * Returns true if event was dispatched (not a duplicate).
   */
  public publish(event: BusEvent): boolean {
    // Check dedupe
    if (event.dedupeKey) {
      if (this.dedupeCache.isDuplicate(event.dedupeKey)) {
        this.stats.dedupeHits++;
        if (DEBUG) {
          console.log('[EventBus] Duplicate dropped:', event.dedupeKey);
        }
        return false;
      }
    }
    
    // Update stats
    this.stats.totalEventsPublished++;
    this.stats.eventsBySource[event.source]++;
    this.stats.eventsByType[event.type] = (this.stats.eventsByType[event.type] || 0) + 1;
    this.stats.lastEventAt = event.ts;
    
    // Add to buffer
    this.eventBuffer.push(event);
    if (this.eventBuffer.length > this.bufferSize) {
      this.eventBuffer.shift();
    }
    
    if (DEBUG) {
      console.log('[EventBus] Published:', event.type, event.source, event.dedupeKey);
    }
    
    // Dispatch to subscribers
    this.dispatch(event);
    
    return true;
  }
  
  /**
   * Subscribe to events.
   * @param typesOrHandler - Event types to subscribe to, '*' for all, or handler function
   * @param handler - Handler function (optional if first arg is handler)
   * @returns Unsubscribe function
   */
  public subscribe(
    typesOrHandler: BusEventType[] | '*' | BusEventHandler,
    handler?: BusEventHandler
  ): () => void {
    let subscriber: Subscriber;
    
    if (typeof typesOrHandler === 'function') {
      subscriber = { types: '*', handler: typesOrHandler };
    } else {
      subscriber = { types: typesOrHandler, handler: handler! };
    }
    
    this.subscribers.add(subscriber);
    
    return () => {
      this.subscribers.delete(subscriber);
    };
  }
  
  /**
   * Subscribe to a specific event type.
   */
  public on<T extends BusEventType>(
    type: T,
    handler: (event: BusEvent<T>) => void
  ): () => void {
    return this.subscribe([type], handler as BusEventHandler);
  }
  
  /**
   * Get bus statistics.
   */
  public getStats(): EventBusStats {
    return { ...this.stats };
  }
  
  /**
   * Get recent events buffer.
   */
  public getRecentEvents(): BusEvent[] {
    return [...this.eventBuffer];
  }
  
  /**
   * Get dedupe cache size.
   */
  public getDedupeCacheSize(): number {
    return this.dedupeCache.size;
  }
  
  /**
   * Clear dedupe cache entries older than given timestamp.
   * Useful after reconnect to allow re-fetched events.
   */
  public clearDedupeOlderThan(ts: number): void {
    this.dedupeCache.clearOlderThan(ts);
  }
  
  /**
   * Reset all stats and caches.
   */
  public reset(): void {
    this.stats = {
      totalEventsPublished: 0,
      eventsBySource: { ws: 0, supabase: 0, rest: 0 },
      eventsByType: {},
      dedupeHits: 0,
      lastEventAt: null,
    };
    this.eventBuffer = [];
    this.dedupeCache.clear();
    this.subscribers.clear();
  }
  
  /**
   * Dispatch event to matching subscribers.
   */
  private dispatch(event: BusEvent): void {
    for (const subscriber of this.subscribers) {
      const shouldReceive = 
        subscriber.types === '*' || 
        subscriber.types.includes(event.type as BusEventType);
      
      if (shouldReceive) {
        try {
          subscriber.handler(event);
        } catch (error) {
          console.error('[EventBus] Subscriber error:', error);
        }
      }
    }
  }
}

// Singleton instance
let busInstance: EventBusImpl | null = null;

export function getEventBus(): EventBusImpl {
  if (!busInstance) {
    busInstance = new EventBusImpl();
  }
  return busInstance;
}

export function resetEventBus(): void {
  if (busInstance) {
    busInstance.reset();
    busInstance = null;
  }
}

export type { EventBusImpl as EventBus };
