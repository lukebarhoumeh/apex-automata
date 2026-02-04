/**
 * Supabase Realtime Module
 * 
 * Exports the unified Supabase Realtime manager and types.
 */

export * from './types';
export * from './SupabaseRealtimeManager';
export * from './catchUp';

// Legacy exports for backwards compatibility
export {
  getRealtimeBridge,
  startRealtimeBridge,
  stopRealtimeBridge,
} from './supabaseRealtimeBridge';
