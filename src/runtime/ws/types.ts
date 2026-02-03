/**
 * Canonical Runtime WebSocket Event Types
 * 
 * This is the SINGLE SOURCE OF TRUTH for all runtime WS event types.
 * All consumers must use these canonical types, not backend-specific names.
 */

// ============ Canonical Event Types ============

export const CANONICAL_EVENT_TYPES = [
  'status',
  'pnl:snapshot',
  'market:ticker',
  'market:candle',
  'signal',
  'signal:filtered',
  'order:created',
  'order:updated',
  'order:filled',
  'fill',
  'position:opened',
  'position:updated',
  'position:closed',
  'risk:metrics',
  'risk:event',
  'warmup',
  'regime:update',
  'regime:changed',
  'supervisor:health',
] as const;

export type CanonicalEventType = typeof CANONICAL_EVENT_TYPES[number];

// ============ Event Envelope ============

export interface RuntimeEventEnvelope<
  TType extends CanonicalEventType = CanonicalEventType,
  TPayload = unknown
> {
  type: TType;
  payload: TPayload;
  ts: number;
  rawType?: string; // Original backend type for debugging
}

// ============ Payload Interfaces ============

/** Status payload from /api/status or WS StatusUpdate */
export interface StatusPayload {
  engineRunning: boolean;
  mode: 'paper' | 'live' | null;
  paused: boolean;
  dailyStopHit: boolean;
  killSwitch: {
    active: boolean;
    reasons: string[];
    since?: number;
  };
  tradingState?: 'RUNNING' | 'PAUSED' | 'HALTED';
  haltReasonCode?: string;
  wsLatencyMs?: number;
  restLatencyMs?: number;
  spreadPctile?: number;
  risk?: {
    dailyPnLUsd?: number;
    exposureUsd?: number;
    openPositionsCount?: number;
  };
}

/** PnL Snapshot - canonical P&L payload from backend PnLService */
export interface PnLSnapshotPayload {
  ts: number;
  userId?: string;
  sessionId?: string;
  executionMode?: 'paper' | 'live';
  marketDataEnv?: 'sandbox' | 'production';
  
  // Baselines
  sessionStartEquityUsd: number;
  dayStartEquityUsd: number;
  riskDay: string;
  
  // Performance
  realizedPnlUsd: number;
  unrealizedPnlUsd: number;
  totalEquityUsd: number;
  
  // Daily view
  dailyPnlUsd: number;
  dailyPnlR: number;
  riskUnitUsd: number;
  
  // Context
  openPositionsCount: number;
  exposureUsd: number;
  lastMarkPriceBySymbol?: Record<string, number>;
  positionsBySymbol?: Record<string, PositionSnapshotPayload>;
}

export interface PositionSnapshotPayload {
  symbol: string;
  side: 'long' | 'short';
  quantity: number;
  entryPrice: number;
  markPrice: number;
  unrealizedPnl: number;
  notional: number;
}

/** Market ticker update */
export interface TickerPayload {
  symbol: string;
  price: number;
  bid: number;
  ask: number;
  volume: number;
  timestamp: number;
}

/** Market candle update */
export interface CandlePayload {
  symbol: string;
  timeframe?: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  timestamp: number;
}

/** Signal payload */
export interface SignalPayload {
  id: string;
  symbol: string;
  strategy: string;
  side: 'long' | 'short';
  score: number;
  confidence?: number;
  metaProb?: number;
  allowed: boolean;
  reason?: string;
  features?: Record<string, number>;
  decidedAt?: string;
}

/** Order payload */
export interface OrderPayload {
  id?: string;
  orderId?: string;
  clientOrderId?: string;
  externalOrderId?: string;
  symbol: string;
  side: 'buy' | 'sell';
  type: string;
  status: string;
  quantity: number;
  filledQty?: number;
  price?: number;
  stopPrice?: number;
  strategy?: string;
  signalId?: string;
  createdAt?: string;
  updatedAt?: string;
}

/** Fill payload */
export interface FillPayload {
  id?: string;
  fillId?: string;
  orderId: string;
  symbol?: string;
  side?: 'buy' | 'sell';
  price: number;
  quantity: number;
  feeAmount?: number;
  feeCurrency?: string;
  maker?: boolean;
  slippageBps?: number;
  filledAt: string;
  tradeId?: string;
}

/** Position payload */
export interface PositionPayload {
  id?: string;
  positionId?: string;
  symbol: string;
  side: 'long' | 'short';
  qty: number;
  qtyOpen?: number;
  entryPrice: number;
  exitPrice?: number;
  stopPriceAtEntry?: number;
  takeProfitPrice?: number;
  strategy?: string;
  pnlUsd?: number;
  pnlR?: number;
  realizedPnlUsd?: number;
  realizedR?: number;
  openedAt?: string;
  closedAt?: string;
  exitReason?: string;
  phase?: 'opened' | 'updated' | 'closed';
}

/** Risk metrics payload */
export interface RiskMetricsPayload {
  dailyPnl?: number;
  dailyPnlR?: number;
  exposureUsd?: number;
  maxDrawdown?: number;
  consecutiveLosses?: number;
  errorRate?: number;
  killSwitchActive?: boolean;
  heatPct?: number;
}

/** Risk event payload */
export interface RiskEventPayload {
  id?: string;
  eventType: string;
  active: boolean;
  triggeredAt: string;
  clearedAt?: string;
  details?: Record<string, unknown>;
}

/** Warmup payload */
export interface WarmupPayload {
  phase: 'starting' | 'loading' | 'ready';
  progress?: number;
  message?: string;
  barsLoaded?: number;
  barsRequired?: number;
}

/** Regime payload */
export interface RegimePayload {
  symbol: string;
  regime: 'strong_trend' | 'weak_trend' | 'ranging' | 'choppy';
  previous?: string;
  confidence: number;
  adx?: number;
  choppiness?: number;
  trendDirection?: 'up' | 'down' | 'neutral';
}

/** Supervisor health payload */
export interface SupervisorHealthPayload {
  healthy: boolean;
  restarts: number;
  lastHeartbeat?: number;
  engineState?: string;
  degradedMode?: boolean;
}

// ============ Type-safe Event Creators ============

export type StatusEvent = RuntimeEventEnvelope<'status', StatusPayload>;
export type PnLSnapshotEvent = RuntimeEventEnvelope<'pnl:snapshot', PnLSnapshotPayload>;
export type TickerEvent = RuntimeEventEnvelope<'market:ticker', TickerPayload>;
export type CandleEvent = RuntimeEventEnvelope<'market:candle', CandlePayload>;
export type SignalEvent = RuntimeEventEnvelope<'signal', SignalPayload>;
export type SignalFilteredEvent = RuntimeEventEnvelope<'signal:filtered', SignalPayload>;
export type OrderCreatedEvent = RuntimeEventEnvelope<'order:created', OrderPayload>;
export type OrderUpdatedEvent = RuntimeEventEnvelope<'order:updated', OrderPayload>;
export type OrderFilledEvent = RuntimeEventEnvelope<'order:filled', OrderPayload>;
export type FillEvent = RuntimeEventEnvelope<'fill', FillPayload>;
export type PositionOpenedEvent = RuntimeEventEnvelope<'position:opened', PositionPayload>;
export type PositionUpdatedEvent = RuntimeEventEnvelope<'position:updated', PositionPayload>;
export type PositionClosedEvent = RuntimeEventEnvelope<'position:closed', PositionPayload>;
export type RiskMetricsEvent = RuntimeEventEnvelope<'risk:metrics', RiskMetricsPayload>;
export type RiskEventEvent = RuntimeEventEnvelope<'risk:event', RiskEventPayload>;
export type WarmupEvent = RuntimeEventEnvelope<'warmup', WarmupPayload>;
export type RegimeUpdateEvent = RuntimeEventEnvelope<'regime:update', RegimePayload>;
export type RegimeChangedEvent = RuntimeEventEnvelope<'regime:changed', RegimePayload>;
export type SupervisorHealthEvent = RuntimeEventEnvelope<'supervisor:health', SupervisorHealthPayload>;

export type AnyRuntimeEvent =
  | StatusEvent
  | PnLSnapshotEvent
  | TickerEvent
  | CandleEvent
  | SignalEvent
  | SignalFilteredEvent
  | OrderCreatedEvent
  | OrderUpdatedEvent
  | OrderFilledEvent
  | FillEvent
  | PositionOpenedEvent
  | PositionUpdatedEvent
  | PositionClosedEvent
  | RiskMetricsEvent
  | RiskEventEvent
  | WarmupEvent
  | RegimeUpdateEvent
  | RegimeChangedEvent
  | SupervisorHealthEvent;

// ============ Connection State ============

export interface RuntimeWsConnectionState {
  connected: boolean;
  lastMessageAt: number | null;
  lastEventAt: number | null;
  reconnectAttempts: number;
  error: string | null;
}
