/**
 * Runtime WebSocket Event Normalization Layer
 * 
 * Converts any backend event type/payload into the canonical internal format.
 * This is the BOUNDARY where all mapping happens - no hacks in components.
 */

import {
  CanonicalEventType,
  RuntimeEventEnvelope,
  StatusPayload,
  PnLSnapshotPayload,
  PositionSnapshotPayload,
  TickerPayload,
  CandlePayload,
  SignalPayload,
  OrderPayload,
  FillPayload,
  PositionPayload,
  RiskMetricsPayload,
  RiskEventPayload,
  WarmupPayload,
  RegimePayload,
  SupervisorHealthPayload,
} from './types';

// ============ Type Mapping ============

/**
 * Maps backend event types to canonical types.
 * Supports both legacy PascalCase and new colon-separated formats.
 */
const TYPE_MAP: Record<string, CanonicalEventType> = {
  // Legacy PascalCase backend types
  'StatusUpdate': 'status',
  'Status': 'status',
  'PnLSnapshot': 'pnl:snapshot',
  'PnlSnapshot': 'pnl:snapshot',
  'TickerUpdate': 'market:ticker',
  'Ticker': 'market:ticker',
  'CandleUpdate': 'market:candle',
  'Candle': 'market:candle',
  'Signal': 'signal',
  'SignalFiltered': 'signal:filtered',
  'SignalRejected': 'signal:filtered',
  'OrderCreated': 'order:created',
  'OrderUpdate': 'order:updated',
  'OrderUpdated': 'order:updated',
  'OrderFilled': 'order:filled',
  'Fill': 'fill',
  'PositionOpened': 'position:opened',
  'PositionUpdate': 'position:updated',
  'PositionUpdated': 'position:updated',
  'PositionClosed': 'position:closed',
  'RiskMetrics': 'risk:metrics',
  'RiskEvent': 'risk:event',
  'RiskUpdate': 'risk:metrics',
  'WarmupUpdate': 'warmup',
  'Warmup': 'warmup',
  'RegimeUpdate': 'regime:update',
  'RegimeChanged': 'regime:changed',
  'RegimeChange': 'regime:changed',
  'SupervisorHealth': 'supervisor:health',
  'HealthUpdate': 'supervisor:health',
  
  // Heartbeat events
  'Heartbeat': 'runtime:heartbeat',
  'Ping': 'runtime:heartbeat',
  'SupervisorHeartbeat': 'runtime:heartbeat',
  
  // Already canonical types (passthrough)
  'status': 'status',
  'pnl:snapshot': 'pnl:snapshot',
  'market:ticker': 'market:ticker',
  'market:candle': 'market:candle',
  'signal': 'signal',
  'signal:filtered': 'signal:filtered',
  'order:created': 'order:created',
  'order:updated': 'order:updated',
  'order:filled': 'order:filled',
  'order:placed': 'order:created', // Old UI name
  'fill': 'fill',
  'position:opened': 'position:opened',
  'position:updated': 'position:updated',
  'position:closed': 'position:closed',
  'risk:metrics': 'risk:metrics',
  'risk:event': 'risk:event',
  'warmup': 'warmup',
  'regime:update': 'regime:update',
  'regime:changed': 'regime:changed',
  'regime:change': 'regime:changed',
  'supervisor:health': 'supervisor:health',
  'runtime:heartbeat': 'runtime:heartbeat',
  
  // Candle alias
  'candle': 'market:candle',
};

// Track unknown types to log only once
const unknownTypesLogged = new Set<string>();

/**
 * Normalize a raw backend type to canonical type.
 * Returns null for unknown types.
 */
export function normalizeRuntimeType(rawType: string): CanonicalEventType | null {
  const canonical = TYPE_MAP[rawType];
  
  if (!canonical) {
    if (!unknownTypesLogged.has(rawType)) {
      unknownTypesLogged.add(rawType);
      console.warn(`[WS Normalize] Unknown event type: "${rawType}" - dropping`);
    }
    return null;
  }
  
  return canonical;
}

// ============ Payload Normalization ============

/**
 * Convert snake_case keys to camelCase
 */
function snakeToCamel(str: string): string {
  return str.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
}

/**
 * Recursively convert all snake_case keys in an object to camelCase
 */
function normalizeKeys<T>(obj: unknown): T {
  if (obj === null || obj === undefined) {
    return obj as T;
  }
  
  if (Array.isArray(obj)) {
    return obj.map(item => normalizeKeys(item)) as T;
  }
  
  if (typeof obj === 'object') {
    const normalized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      const camelKey = snakeToCamel(key);
      normalized[camelKey] = normalizeKeys(value);
    }
    return normalized as T;
  }
  
  return obj as T;
}

/**
 * Normalize status payload
 */
function normalizeStatusPayload(raw: Record<string, unknown>): StatusPayload {
  const normalized = normalizeKeys<Record<string, unknown>>(raw);
  
  const killSwitch = normalized.killSwitch as Record<string, unknown> | undefined;
  const kill_switch = normalized.kill_switch as Record<string, unknown> | undefined;
  const riskData = normalized.risk as Record<string, unknown> | undefined;
  
  return {
    engineRunning: Boolean(normalized.engineRunning ?? normalized.engine_running ?? false),
    mode: (normalized.mode as 'paper' | 'live' | null) ?? null,
    paused: Boolean(normalized.paused ?? false),
    dailyStopHit: Boolean(normalized.dailyStopHit ?? normalized.daily_stop_hit ?? false),
    killSwitch: {
      active: Boolean(killSwitch?.active ?? kill_switch?.active ?? false),
      reasons: (killSwitch?.reasons ?? kill_switch?.reasons ?? []) as string[],
      since: (killSwitch?.since ?? kill_switch?.since) as number | undefined,
    },
    tradingState: normalized.tradingState as 'RUNNING' | 'PAUSED' | 'HALTED' | undefined,
    haltReasonCode: normalized.haltReasonCode as string | undefined,
    wsLatencyMs: normalized.wsLatencyMs as number | undefined,
    restLatencyMs: normalized.restLatencyMs as number | undefined,
    spreadPctile: normalized.spreadPctile as number | undefined,
    risk: riskData ? {
      dailyPnLUsd: riskData.dailyPnLUsd as number | undefined ?? riskData.daily_pnl_usd as number | undefined,
      exposureUsd: riskData.exposureUsd as number | undefined ?? riskData.exposure_usd as number | undefined,
      openPositionsCount: riskData.openPositionsCount as number | undefined ?? riskData.open_positions_count as number | undefined,
    } : undefined,
  };
}

/**
 * Normalize PnL snapshot payload
 */
function normalizePnLSnapshotPayload(raw: Record<string, unknown>): PnLSnapshotPayload {
  const normalized = normalizeKeys<Record<string, unknown>>(raw);
  
  return {
    ts: (normalized.ts as number) ?? Date.now(),
    userId: normalized.userId as string | undefined,
    sessionId: normalized.sessionId as string | undefined,
    executionMode: normalized.executionMode as 'paper' | 'live' | undefined,
    marketDataEnv: normalized.marketDataEnv as 'sandbox' | 'production' | undefined,
    sessionStartEquityUsd: (normalized.sessionStartEquityUsd as number) ?? 0,
    dayStartEquityUsd: (normalized.dayStartEquityUsd as number) ?? 0,
    riskDay: (normalized.riskDay as string) ?? new Date().toISOString().split('T')[0],
    realizedPnlUsd: (normalized.realizedPnlUsd as number) ?? 0,
    unrealizedPnlUsd: (normalized.unrealizedPnlUsd as number) ?? 0,
    totalEquityUsd: (normalized.totalEquityUsd as number) ?? 0,
    dailyPnlUsd: (normalized.dailyPnlUsd as number) ?? 0,
    dailyPnlR: (normalized.dailyPnlR as number) ?? 0,
    riskUnitUsd: (normalized.riskUnitUsd as number) ?? 0,
    openPositionsCount: (normalized.openPositionsCount as number) ?? 0,
    exposureUsd: (normalized.exposureUsd as number) ?? 0,
    lastMarkPriceBySymbol: normalized.lastMarkPriceBySymbol as Record<string, number> | undefined,
    positionsBySymbol: normalized.positionsBySymbol as Record<string, PositionSnapshotPayload> | undefined,
  };
}

/**
 * Normalize signal payload
 */
function normalizeSignalPayload(raw: Record<string, unknown>): SignalPayload {
  const normalized = normalizeKeys<Record<string, unknown>>(raw);
  
  return {
    id: (normalized.id as string) ?? crypto.randomUUID(),
    symbol: (normalized.symbol as string) ?? '',
    strategy: (normalized.strategy as string) ?? '',
    side: (normalized.side as 'long' | 'short') ?? 'long',
    score: (normalized.score as number) ?? 0,
    confidence: normalized.confidence as number | undefined,
    metaProb: (normalized.metaProb ?? normalized.meta_prob) as number | undefined,
    allowed: Boolean(normalized.allowed ?? false),
    reason: normalized.reason as string | undefined,
    features: normalized.features as Record<string, number> | undefined,
    decidedAt: (normalized.decidedAt ?? normalized.decided_at) as string | undefined,
  };
}

/**
 * Normalize order payload
 */
function normalizeOrderPayload(raw: Record<string, unknown>): OrderPayload {
  const normalized = normalizeKeys<Record<string, unknown>>(raw);
  
  return {
    id: normalized.id as string | undefined,
    orderId: (normalized.orderId ?? normalized.id) as string | undefined,
    clientOrderId: normalized.clientOrderId as string | undefined,
    externalOrderId: normalized.externalOrderId as string | undefined,
    symbol: (normalized.symbol as string) ?? '',
    side: (normalized.side as 'buy' | 'sell') ?? 'buy',
    type: (normalized.type as string) ?? 'market',
    status: (normalized.status as string) ?? 'new',
    quantity: (normalized.quantity ?? normalized.qty) as number ?? 0,
    filledQty: (normalized.filledQty ?? normalized.filled_qty) as number | undefined,
    price: normalized.price as number | undefined,
    stopPrice: normalized.stopPrice as number | undefined,
    strategy: normalized.strategy as string | undefined,
    signalId: normalized.signalId as string | undefined,
    createdAt: normalized.createdAt as string | undefined,
    updatedAt: normalized.updatedAt as string | undefined,
  };
}

/**
 * Normalize fill payload
 */
function normalizeFillPayload(raw: Record<string, unknown>): FillPayload {
  const normalized = normalizeKeys<Record<string, unknown>>(raw);
  
  return {
    id: normalized.id as string | undefined,
    fillId: normalized.fillId as string | undefined,
    orderId: (normalized.orderId ?? normalized.order_id) as string ?? '',
    symbol: normalized.symbol as string | undefined,
    side: normalized.side as 'buy' | 'sell' | undefined,
    price: (normalized.price as number) ?? 0,
    quantity: (normalized.quantity ?? normalized.qty) as number ?? 0,
    feeAmount: normalized.feeAmount as number | undefined,
    feeCurrency: normalized.feeCurrency as string | undefined,
    maker: normalized.maker as boolean | undefined,
    slippageBps: normalized.slippageBps as number | undefined,
    filledAt: (normalized.filledAt ?? normalized.filled_at ?? new Date().toISOString()) as string,
    tradeId: normalized.tradeId as string | undefined,
  };
}

/**
 * Normalize position payload
 */
function normalizePositionPayload(raw: Record<string, unknown>): PositionPayload {
  const normalized = normalizeKeys<Record<string, unknown>>(raw);
  
  return {
    id: normalized.id as string | undefined,
    positionId: (normalized.positionId ?? normalized.id) as string | undefined,
    symbol: (normalized.symbol as string) ?? '',
    side: (normalized.side as 'long' | 'short') ?? 'long',
    qty: (normalized.qty ?? normalized.qtyOpen ?? normalized.quantity) as number ?? 0,
    qtyOpen: normalized.qtyOpen as number | undefined,
    entryPrice: (normalized.entryPrice ?? normalized.entry_price) as number ?? 0,
    exitPrice: (normalized.exitPrice ?? normalized.exit_price) as number | undefined,
    stopPriceAtEntry: normalized.stopPriceAtEntry as number | undefined,
    takeProfitPrice: normalized.takeProfitPrice as number | undefined,
    strategy: normalized.strategy as string | undefined,
    pnlUsd: (normalized.pnlUsd ?? normalized.realizedPnlUsd) as number | undefined,
    pnlR: (normalized.pnlR ?? normalized.realizedR) as number | undefined,
    realizedPnlUsd: normalized.realizedPnlUsd as number | undefined,
    realizedR: normalized.realizedR as number | undefined,
    openedAt: normalized.openedAt as string | undefined,
    closedAt: normalized.closedAt as string | undefined,
    exitReason: normalized.exitReason as string | undefined,
    phase: normalized.phase as 'opened' | 'updated' | 'closed' | undefined,
  };
}

/**
 * Normalize ticker payload
 */
function normalizeTickerPayload(raw: Record<string, unknown>): TickerPayload {
  const normalized = normalizeKeys<Record<string, unknown>>(raw);
  
  return {
    symbol: (normalized.symbol as string) ?? '',
    price: (normalized.price as number) ?? 0,
    bid: (normalized.bid as number) ?? 0,
    ask: (normalized.ask as number) ?? 0,
    volume: (normalized.volume as number) ?? 0,
    timestamp: (normalized.timestamp as number) ?? Date.now(),
  };
}

/**
 * Normalize candle payload
 */
function normalizeCandlePayload(raw: Record<string, unknown>): CandlePayload {
  const normalized = normalizeKeys<Record<string, unknown>>(raw);
  
  return {
    symbol: (normalized.symbol as string) ?? '',
    timeframe: normalized.timeframe as string | undefined,
    open: (normalized.open as number) ?? 0,
    high: (normalized.high as number) ?? 0,
    low: (normalized.low as number) ?? 0,
    close: (normalized.close as number) ?? 0,
    volume: (normalized.volume as number) ?? 0,
    timestamp: (normalized.timestamp as number) ?? Date.now(),
  };
}

/**
 * Normalize risk metrics payload
 */
function normalizeRiskMetricsPayload(raw: Record<string, unknown>): RiskMetricsPayload {
  const normalized = normalizeKeys<Record<string, unknown>>(raw);
  
  return {
    dailyPnl: normalized.dailyPnl as number | undefined,
    dailyPnlR: normalized.dailyPnlR as number | undefined,
    exposureUsd: normalized.exposureUsd as number | undefined,
    maxDrawdown: normalized.maxDrawdown as number | undefined,
    consecutiveLosses: normalized.consecutiveLosses as number | undefined,
    errorRate: normalized.errorRate as number | undefined,
    killSwitchActive: normalized.killSwitchActive as boolean | undefined,
    heatPct: normalized.heatPct as number | undefined,
  };
}

/**
 * Normalize risk event payload
 */
function normalizeRiskEventPayload(raw: Record<string, unknown>): RiskEventPayload {
  const normalized = normalizeKeys<Record<string, unknown>>(raw);
  
  return {
    id: normalized.id as string | undefined,
    eventType: (normalized.eventType ?? normalized.event_type) as string ?? '',
    active: Boolean(normalized.active ?? true),
    triggeredAt: (normalized.triggeredAt ?? normalized.triggered_at ?? new Date().toISOString()) as string,
    clearedAt: normalized.clearedAt as string | undefined,
    details: normalized.details as Record<string, unknown> | undefined,
  };
}

/**
 * Normalize warmup payload
 */
function normalizeWarmupPayload(raw: Record<string, unknown>): WarmupPayload {
  const normalized = normalizeKeys<Record<string, unknown>>(raw);
  
  return {
    phase: (normalized.phase as 'starting' | 'loading' | 'ready') ?? 'starting',
    progress: normalized.progress as number | undefined,
    message: normalized.message as string | undefined,
    barsLoaded: normalized.barsLoaded as number | undefined,
    barsRequired: normalized.barsRequired as number | undefined,
  };
}

/**
 * Normalize regime payload
 */
function normalizeRegimePayload(raw: Record<string, unknown>): RegimePayload {
  const normalized = normalizeKeys<Record<string, unknown>>(raw);
  
  return {
    symbol: (normalized.symbol as string) ?? '',
    regime: (normalized.regime as 'strong_trend' | 'weak_trend' | 'ranging' | 'choppy') ?? 'ranging',
    previous: normalized.previous as string | undefined,
    confidence: (normalized.confidence as number) ?? 0,
    adx: normalized.adx as number | undefined,
    choppiness: normalized.choppiness as number | undefined,
    trendDirection: normalized.trendDirection as 'up' | 'down' | 'neutral' | undefined,
  };
}

/**
 * Normalize supervisor health payload
 */
function normalizeSupervisorHealthPayload(raw: Record<string, unknown>): SupervisorHealthPayload {
  const normalized = normalizeKeys<Record<string, unknown>>(raw);
  
  return {
    healthy: Boolean(normalized.healthy ?? true),
    restarts: (normalized.restarts as number) ?? 0,
    lastHeartbeat: normalized.lastHeartbeat as number | undefined,
    engineState: normalized.engineState as string | undefined,
    degradedMode: normalized.degradedMode as boolean | undefined,
  };
}

// ============ Main Normalization Function ============

/**
 * Normalize a raw runtime WebSocket message into canonical format.
 * Returns null if the event type is unknown.
 */
export function normalizeRuntimeEvent(raw: unknown): RuntimeEventEnvelope | null {
  if (!raw || typeof raw !== 'object') {
    console.warn('[WS Normalize] Invalid message format:', raw);
    return null;
  }
  
  const rawObj = raw as Record<string, unknown>;
  const rawType = (rawObj.type as string) ?? '';
  const rawPayload = (rawObj.payload ?? rawObj.data ?? rawObj) as Record<string, unknown>;
  const rawTs = (rawObj.timestamp ?? rawObj.ts ?? Date.now()) as number | string;
  
  // Normalize type
  const canonicalType = normalizeRuntimeType(rawType);
  if (!canonicalType) {
    return null;
  }
  
  // Normalize timestamp
  const ts = typeof rawTs === 'string' ? new Date(rawTs).getTime() : rawTs;
  
  // Normalize payload based on type
  let payload: unknown;
  
  switch (canonicalType) {
    case 'status':
      payload = normalizeStatusPayload(rawPayload);
      break;
    case 'pnl:snapshot':
      payload = normalizePnLSnapshotPayload(rawPayload);
      break;
    case 'market:ticker':
      payload = normalizeTickerPayload(rawPayload);
      break;
    case 'market:candle':
      payload = normalizeCandlePayload(rawPayload);
      break;
    case 'signal':
    case 'signal:filtered':
      payload = normalizeSignalPayload(rawPayload);
      break;
    case 'order:created':
    case 'order:updated':
    case 'order:filled':
      payload = normalizeOrderPayload(rawPayload);
      break;
    case 'fill':
      payload = normalizeFillPayload(rawPayload);
      break;
    case 'position:opened':
    case 'position:updated':
    case 'position:closed':
      payload = normalizePositionPayload(rawPayload);
      break;
    case 'risk:metrics':
      payload = normalizeRiskMetricsPayload(rawPayload);
      break;
    case 'risk:event':
      payload = normalizeRiskEventPayload(rawPayload);
      break;
    case 'warmup':
      payload = normalizeWarmupPayload(rawPayload);
      break;
    case 'regime:update':
    case 'regime:changed':
      payload = normalizeRegimePayload(rawPayload);
      break;
    case 'supervisor:health':
      payload = normalizeSupervisorHealthPayload(rawPayload);
      break;
    case 'runtime:heartbeat':
      // Heartbeat has minimal payload - just normalize keys
      payload = normalizeKeys(rawPayload);
      break;
    default:
      payload = normalizeKeys(rawPayload);
  }
  
  return {
    type: canonicalType,
    payload,
    ts,
    rawType: rawType !== canonicalType ? rawType : undefined,
  };
}

/**
 * Get count of unknown types encountered (for debug)
 */
export function getUnknownTypesCount(): number {
  return unknownTypesLogged.size;
}

/**
 * Get list of unknown types encountered (for debug)
 */
export function getUnknownTypes(): string[] {
  return Array.from(unknownTypesLogged);
}

/**
 * Clear unknown types tracking (for tests)
 */
export function clearUnknownTypes(): void {
  unknownTypesLogged.clear();
}
