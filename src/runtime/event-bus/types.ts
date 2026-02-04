/**
 * Event Bus Types
 * 
 * Unified event stream merging WS events + Supabase Realtime
 * into one canonical stream for deterministic cache updates.
 */

// ============ Event Sources ============

export type EventSource = 'ws' | 'supabase' | 'rest';

// ============ Bus Event Envelope ============

export interface BusEvent<TType extends string = string, TPayload = unknown> {
  /** Canonical event type (e.g., 'position:opened', 'order:filled') */
  type: TType;
  /** Canonical payload (camelCase) */
  payload: TPayload;
  /** Event timestamp (epoch ms) */
  ts: number;
  /** Source of the event */
  source: EventSource;
  /** Key for deduplication (prevents same event from WS + Supabase double-applying) */
  dedupeKey?: string;
}

// ============ Canonical Bus Event Types ============

export type BusEventType =
  // Status/Health
  | 'status'
  | 'runtime:heartbeat'
  | 'supervisor:health'
  // PnL
  | 'pnl:snapshot'
  // Market
  | 'market:ticker'
  | 'market:candle'
  // Signals
  | 'signal'
  | 'signal:filtered'
  // Orders
  | 'order:created'
  | 'order:updated'
  | 'order:filled'
  // Fills
  | 'fill'
  // Positions
  | 'position:opened'
  | 'position:updated'
  | 'position:closed'
  // Risk
  | 'risk:metrics'
  | 'risk:event'
  // Regime
  | 'regime:update'
  | 'regime:changed'
  // Warmup
  | 'warmup'
  // Supabase-specific (for tables that don't map to WS events)
  | 'db:account_metrics'
  | 'db:alerts'
  | 'db:risk_metrics'
  | 'db:trading_sessions'
  | 'alert:new';

// ============ Handler Types ============

export type BusEventHandler = (event: BusEvent) => void;

export type TypedBusEventHandler<T extends BusEventType> = (
  event: BusEvent<T>
) => void;

// ============ Stats ============

export interface EventBusStats {
  totalEventsPublished: number;
  eventsBySource: Record<EventSource, number>;
  eventsByType: Record<string, number>;
  dedupeHits: number;
  lastEventAt: number | null;
}

// ============ Dedupe Config ============

export interface DedupeConfig {
  /** Max number of keys to keep in LRU cache */
  maxKeys: number;
  /** TTL in ms for dedupe keys */
  ttlMs: number;
}

export const DEFAULT_DEDUPE_CONFIG: DedupeConfig = {
  maxKeys: 5000,
  ttlMs: 2 * 60 * 1000, // 2 minutes
};
