import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import type { RealtimePostgresChangesPayload } from '@supabase/supabase-js';

type TableName = 'positions' | 'orders' | 'fills' | 'signals' | 'risk_events' | 'alerts';

interface UseRealtimeSubscriptionOptions {
  tables: TableName[];
  userId?: string;
}

/**
 * Subscribe to Supabase Realtime changes for trading tables.
 * Automatically invalidates relevant queries when data changes.
 */
export function useRealtimeSubscription({ tables, userId }: UseRealtimeSubscriptionOptions) {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!tables.length) return;

    const channel = supabase.channel('trading-realtime');

    // Subscribe to each table
    tables.forEach((table) => {
      channel.on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table,
          ...(userId ? { filter: `user_id=eq.${userId}` } : {}),
        },
        (payload: RealtimePostgresChangesPayload<Record<string, unknown>>) => {
          console.log(`[Realtime] ${table}:`, payload.eventType);
          
          // Invalidate relevant queries based on table
          switch (table) {
            case 'positions':
              queryClient.invalidateQueries({ queryKey: ['positions'] });
              queryClient.invalidateQueries({ queryKey: ['calculated-metrics'] });
              queryClient.invalidateQueries({ queryKey: ['session-stats'] });
              break;
            case 'orders':
              queryClient.invalidateQueries({ queryKey: ['orders'] });
              break;
            case 'fills':
              queryClient.invalidateQueries({ queryKey: ['fills'] });
              queryClient.invalidateQueries({ queryKey: ['orders'] });
              break;
            case 'signals':
              queryClient.invalidateQueries({ queryKey: ['signals'] });
              break;
            case 'risk_events':
              queryClient.invalidateQueries({ queryKey: ['risk-events'] });
              break;
            case 'alerts':
              queryClient.invalidateQueries({ queryKey: ['alerts'] });
              break;
          }
        }
      );
    });

    channel.subscribe((status) => {
      console.log('[Realtime] Subscription status:', status);
    });

    return () => {
      supabase.removeChannel(channel);
    };
  }, [tables, userId, queryClient]);
}
