/**
 * Supabase Catch-Up Fetcher
 * 
 * Fetches latest state from Supabase after reconnection or page load.
 * This ensures the UI has complete state even if some realtime events were missed.
 */

import { supabase } from '@/integrations/supabase/client';
import { getEventBus } from '../event-bus/EventBus';
import type { BusEvent } from '../event-bus/types';
import type { CatchUpResult } from './types';

const DEBUG = import.meta.env.VITE_DEBUG_REALTIME === '1' || import.meta.env.VITE_DEBUG_EVENT_BUS === '1';

/** How many recent items to fetch for catch-up */
const CATCH_UP_LIMITS = {
  positions: 50,
  orders: 100,
  fills: 100,
  signals: 50,
  riskEvents: 20,
};

/** How far back to look for recent items (in minutes) */
const RECENT_WINDOW_MINUTES = 60;

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
 * Perform catch-up fetch after reconnection.
 * This fetches latest state from Supabase and publishes to the event bus.
 */
export async function performCatchUp(userId: string): Promise<CatchUpResult> {
  const result: CatchUpResult = {
    positions: 0,
    orders: 0,
    fills: 0,
    signals: 0,
    riskEvents: 0,
    accountMetrics: false,
  };

  const bus = getEventBus();
  const recentCutoff = new Date(Date.now() - RECENT_WINDOW_MINUTES * 60 * 1000).toISOString();

  if (DEBUG) {
    console.log('[CatchUp] Starting catch-up fetch for user:', userId);
  }

  try {
    // Fetch in parallel for speed
    const [
      positionsResult,
      ordersResult,
      fillsResult,
      signalsResult,
      riskEventsResult,
      accountMetricsResult,
    ] = await Promise.all([
      // Open positions (no time filter - we want all open)
      supabase
        .from('positions')
        .select('*')
        .eq('user_id', userId)
        .is('closed_at', null)
        .order('opened_at', { ascending: false })
        .limit(CATCH_UP_LIMITS.positions),
      
      // Recent orders
      supabase
        .from('orders')
        .select('*')
        .eq('user_id', userId)
        .gte('created_at', recentCutoff)
        .order('created_at', { ascending: false })
        .limit(CATCH_UP_LIMITS.orders),
      
      // Recent fills
      supabase
        .from('fills')
        .select('*')
        .eq('user_id', userId)
        .gte('filled_at', recentCutoff)
        .order('filled_at', { ascending: false })
        .limit(CATCH_UP_LIMITS.fills),
      
      // Recent signals
      supabase
        .from('signals')
        .select('*')
        .eq('user_id', userId)
        .gte('created_at', recentCutoff)
        .order('created_at', { ascending: false })
        .limit(CATCH_UP_LIMITS.signals),
      
      // Active risk events
      supabase
        .from('risk_events')
        .select('*')
        .eq('user_id', userId)
        .eq('active', true)
        .order('triggered_at', { ascending: false })
        .limit(CATCH_UP_LIMITS.riskEvents),
      
      // Latest account metrics
      supabase
        .from('account_metrics')
        .select('*')
        .eq('user_id', userId)
        .order('updated_at', { ascending: false })
        .limit(1),
    ]);

    // Process positions
    if (positionsResult.data) {
      result.positions = positionsResult.data.length;
      for (const pos of positionsResult.data) {
        const event: BusEvent = {
          type: 'position:updated',
          payload: snakeToCamel(pos as Record<string, unknown>),
          ts: Date.now(),
          source: 'rest', // Mark as REST since it's a fetch, not realtime
          dedupeKey: `catchup:pos:${pos.id}`,
        };
        bus.publish(event);
      }
    }

    // Process orders
    if (ordersResult.data) {
      result.orders = ordersResult.data.length;
      for (const order of ordersResult.data) {
        const event: BusEvent = {
          type: 'order:updated',
          payload: snakeToCamel(order as Record<string, unknown>),
          ts: Date.now(),
          source: 'rest',
          dedupeKey: `catchup:order:${order.id}`,
        };
        bus.publish(event);
      }
    }

    // Process fills
    if (fillsResult.data) {
      result.fills = fillsResult.data.length;
      for (const fill of fillsResult.data) {
        const event: BusEvent = {
          type: 'fill',
          payload: snakeToCamel(fill as Record<string, unknown>),
          ts: Date.now(),
          source: 'rest',
          dedupeKey: `catchup:fill:${fill.id}`,
        };
        bus.publish(event);
      }
    }

    // Process signals
    if (signalsResult.data) {
      result.signals = signalsResult.data.length;
      for (const signal of signalsResult.data) {
        const event: BusEvent = {
          type: 'signal',
          payload: snakeToCamel(signal as Record<string, unknown>),
          ts: Date.now(),
          source: 'rest',
          dedupeKey: `catchup:sig:${signal.id}`,
        };
        bus.publish(event);
      }
    }

    // Process risk events
    if (riskEventsResult.data) {
      result.riskEvents = riskEventsResult.data.length;
      for (const riskEvent of riskEventsResult.data) {
        const event: BusEvent = {
          type: 'risk:event',
          payload: snakeToCamel(riskEvent as Record<string, unknown>),
          ts: Date.now(),
          source: 'rest',
          dedupeKey: `catchup:risk:${riskEvent.id}`,
        };
        bus.publish(event);
      }
    }

    // Process account metrics
    if (accountMetricsResult.data && accountMetricsResult.data.length > 0) {
      result.accountMetrics = true;
      const metrics = accountMetricsResult.data[0];
      const event: BusEvent = {
        type: 'db:account_metrics',
        payload: snakeToCamel(metrics as Record<string, unknown>),
        ts: Date.now(),
        source: 'rest',
        dedupeKey: `catchup:metrics:${metrics.id}`,
      };
      bus.publish(event);
    }

    if (DEBUG) {
      console.log('[CatchUp] Complete:', result);
    }

  } catch (error) {
    console.error('[CatchUp] Error during catch-up:', error);
    result.error = error instanceof Error ? error.message : 'Unknown error';
  }

  return result;
}

/**
 * Clear old dedupe entries and prepare for fresh data.
 */
export function prepareCatchUp(): void {
  const bus = getEventBus();
  // Clear entries older than 2 minutes to allow catch-up data
  bus.clearDedupeOlderThan(Date.now() - 120000);
}
