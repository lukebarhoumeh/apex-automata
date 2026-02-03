/**
 * Apply Event to React Query Cache
 * 
 * Deterministic cache updates from bus events.
 * Uses setQueryData for efficient patching, invalidateQueries as fallback.
 */

import type { QueryClient } from '@tanstack/react-query';
import type { BusEvent, BusEventType } from './types';

// Position type for cache operations
interface CachedPosition {
  id: string;
  symbol: string;
  side: string;
  qty_open: number;
  entry_price: number;
  opened_at: string;
  closed_at: string | null;
  updated_at?: string;
  [key: string]: unknown;
}

// Order type for cache operations
interface CachedOrder {
  id: string;
  symbol: string;
  status: string;
  updated_at: string;
  [key: string]: unknown;
}

// Fill type for cache operations
interface CachedFill {
  id: string;
  order_id: string;
  filled_at: string;
  [key: string]: unknown;
}

// Signal type for cache operations
interface CachedSignal {
  id: string;
  symbol: string;
  decided_at: string;
  [key: string]: unknown;
}

/**
 * Apply a bus event to the React Query cache.
 * Returns true if cache was updated, false if invalidation was used instead.
 */
export function applyEventToCache(
  queryClient: QueryClient,
  event: BusEvent
): boolean {
  const { type, payload, ts } = event;
  
  switch (type as BusEventType) {
    // ============ Positions ============
    case 'position:opened':
      return patchOrInvalidate(queryClient, ['positions'], (data: CachedPosition[] | undefined) => {
        if (!data || !payload) return undefined;
        const position = payload as CachedPosition;
        // Don't add if already exists
        if (data.some(p => p.id === position.id)) {
          return data.map(p => p.id === position.id ? { ...p, ...position } : p);
        }
        return [position, ...data];
      });
      
    case 'position:updated':
      return patchOrInvalidate(queryClient, ['positions'], (data: CachedPosition[] | undefined) => {
        if (!data || !payload) return undefined;
        const position = payload as CachedPosition;
        return data.map(p => {
          if (p.id === position.id) {
            // Only update if newer
            if (position.updated_at && p.updated_at && position.updated_at < p.updated_at) {
              return p;
            }
            return { ...p, ...position };
          }
          return p;
        });
      });
      
    case 'position:closed':
      return patchOrInvalidate(queryClient, ['positions'], (data: CachedPosition[] | undefined) => {
        if (!data || !payload) return undefined;
        const position = payload as CachedPosition;
        // Remove from open positions
        return data.filter(p => p.id !== position.id);
      });
      
    // ============ Orders ============
    case 'order:created':
      return patchOrInvalidate(queryClient, ['orders'], (data: CachedOrder[] | undefined) => {
        if (!data || !payload) return undefined;
        const order = payload as CachedOrder;
        if (data.some(o => o.id === order.id)) {
          return data.map(o => o.id === order.id ? { ...o, ...order } : o);
        }
        return [order, ...data];
      });
      
    case 'order:updated':
    case 'order:filled':
      return patchOrInvalidate(queryClient, ['orders'], (data: CachedOrder[] | undefined) => {
        if (!data || !payload) return undefined;
        const order = payload as CachedOrder;
        return data.map(o => {
          if (o.id === order.id) {
            // Only update if newer
            if (order.updated_at && o.updated_at && order.updated_at < o.updated_at) {
              return o;
            }
            return { ...o, ...order };
          }
          return o;
        });
      });
      
    // ============ Fills ============
    case 'fill':
      return patchOrInvalidate(queryClient, ['fills'], (data: CachedFill[] | undefined) => {
        if (!data || !payload) return undefined;
        const fill = payload as CachedFill;
        if (data.some(f => f.id === fill.id)) {
          return data; // Already exists
        }
        return [fill, ...data];
      });
      
    // ============ Signals ============
    case 'signal':
    case 'signal:filtered':
      return patchOrInvalidate(queryClient, ['signals'], (data: CachedSignal[] | undefined) => {
        if (!data || !payload) return undefined;
        const signal = payload as CachedSignal;
        if (data.some(s => s.id === signal.id)) {
          return data.map(s => s.id === signal.id ? { ...s, ...signal } : s);
        }
        return [signal, ...data];
      });
      
    // ============ Risk ============
    case 'risk:event':
      queryClient.invalidateQueries({ queryKey: ['risk-events'] });
      queryClient.invalidateQueries({ queryKey: ['active-risk-events'] });
      return false;
      
    case 'risk:metrics':
      queryClient.invalidateQueries({ queryKey: ['runtime-status'] });
      return false;
      
    // ============ PnL Snapshot (most important) ============
    case 'pnl:snapshot':
      // Store the snapshot directly
      queryClient.setQueryData(['pnl-snapshot'], payload);
      // Invalidate calculated metrics to recompute from snapshot
      queryClient.invalidateQueries({ queryKey: ['calculated-metrics'] });
      queryClient.invalidateQueries({ queryKey: ['session-stats'] });
      return true;
      
    // ============ Status/Health ============
    case 'status':
    case 'runtime:heartbeat':
      queryClient.setQueryData(['runtime-status'], payload);
      return true;
      
    case 'supervisor:health':
      queryClient.setQueryData(['runtime-health'], payload);
      return true;
      
    // ============ Regime ============
    case 'regime:update':
    case 'regime:changed':
      queryClient.setQueryData(['regime-state'], payload);
      return true;
      
    // ============ Warmup ============
    case 'warmup':
      queryClient.setQueryData(['warmup-state'], payload);
      return true;
      
    // ============ Supabase-specific ============
    case 'db:account_metrics':
      queryClient.invalidateQueries({ queryKey: ['account-metrics'] });
      queryClient.invalidateQueries({ queryKey: ['calculated-metrics'] });
      return false;
      
    case 'db:alerts':
    case 'alert:new':
      queryClient.invalidateQueries({ queryKey: ['alerts'] });
      return false;
      
    default:
      // Unknown event type - just invalidate common queries
      return false;
  }
}

/**
 * Helper to patch cached data or fall back to invalidation.
 */
function patchOrInvalidate<T>(
  queryClient: QueryClient,
  queryKey: unknown[],
  patcher: (data: T | undefined) => T | undefined
): boolean {
  try {
    const currentData = queryClient.getQueryData<T>(queryKey);
    const newData = patcher(currentData);
    
    if (newData !== undefined) {
      queryClient.setQueryData(queryKey, newData);
      return true;
    } else {
      // Can't patch, invalidate instead
      queryClient.invalidateQueries({ queryKey });
      return false;
    }
  } catch (error) {
    console.error('[applyEventToCache] Patch failed, invalidating:', error);
    queryClient.invalidateQueries({ queryKey });
    return false;
  }
}
