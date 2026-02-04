/**
 * Supabase Realtime Types
 * 
 * Types for Supabase realtime subscriptions and catch-up logic.
 */

export type RealtimeTableName = 
  | 'positions'
  | 'orders'
  | 'order_legs'
  | 'fills'
  | 'signals'
  | 'risk_events'
  | 'risk_metrics'
  | 'alerts'
  | 'account_metrics'
  | 'trading_sessions';

export interface RealtimeSubscriptionConfig {
  tables: RealtimeTableName[];
  userId: string;
}

export interface RealtimeLatencyStats {
  lastEventTs: number | null;
  lastEventTable: RealtimeTableName | null;
  lastEventLatencyMs: number | null;
  isSubscribed: boolean;
  eventCounts: Record<RealtimeTableName, number>;
  connectionStatus: 'connecting' | 'connected' | 'disconnected' | 'error';
}

export interface CatchUpResult {
  positions: number;
  orders: number;
  fills: number;
  signals: number;
  riskEvents: number;
  accountMetrics: boolean;
  error?: string;
}
