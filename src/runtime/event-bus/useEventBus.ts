/**
 * React Hooks for Event Bus
 * 
 * Provides React integration for the event bus.
 */

import { useEffect, useState, useCallback, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { getEventBus } from './EventBus';
import { applyEventToCache } from './applyEventToCache';
import type { BusEvent, BusEventType, EventBusStats } from './types';

/**
 * Hook to subscribe to bus events and auto-apply to React Query cache.
 */
export function useEventBusCache(): void {
  const queryClient = useQueryClient();
  
  useEffect(() => {
    const bus = getEventBus();
    
    // Subscribe to all events and apply to cache
    const unsubscribe = bus.subscribe((event) => {
      applyEventToCache(queryClient, event);
    });
    
    return unsubscribe;
  }, [queryClient]);
}

/**
 * Hook to subscribe to specific event types.
 */
export function useEventBusSubscription<T extends BusEventType>(
  types: T[],
  handler: (event: BusEvent<T>) => void
): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  
  useEffect(() => {
    const bus = getEventBus();
    
    return bus.subscribe(types, (event) => {
      handlerRef.current(event as BusEvent<T>);
    });
  }, [types.join(',')]); // Only re-subscribe if types change
}

/**
 * Hook to get bus statistics.
 */
export function useEventBusStats(): EventBusStats {
  const [stats, setStats] = useState<EventBusStats>(() => getEventBus().getStats());
  
  useEffect(() => {
    const bus = getEventBus();
    
    // Update stats on any event
    const unsubscribe = bus.subscribe(() => {
      setStats(bus.getStats());
    });
    
    // Also poll occasionally for non-event updates
    const interval = setInterval(() => {
      setStats(bus.getStats());
    }, 5000);
    
    return () => {
      unsubscribe();
      clearInterval(interval);
    };
  }, []);
  
  return stats;
}

/**
 * Hook to get recent events from the buffer.
 */
export function useRecentBusEvents(limit = 50): BusEvent[] {
  const [events, setEvents] = useState<BusEvent[]>([]);
  
  useEffect(() => {
    const bus = getEventBus();
    
    // Update on any event
    const unsubscribe = bus.subscribe(() => {
      setEvents(bus.getRecentEvents().slice(-limit));
    });
    
    // Initial load
    setEvents(bus.getRecentEvents().slice(-limit));
    
    return unsubscribe;
  }, [limit]);
  
  return events;
}

/**
 * Hook to publish events to the bus.
 */
export function useEventBusPublish() {
  const publish = useCallback((event: BusEvent) => {
    return getEventBus().publish(event);
  }, []);
  
  return publish;
}
