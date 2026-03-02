/**
 * Runtime WebSocket Client
 * 
 * SINGLE WebSocket connection to the runtime backend.
 * All WS events flow through here, get normalized, and dispatched to subscribers.
 * Also wires events to the Connectivity Service for accurate connection status.
 */

import { normalizeRuntimeEvent, getUnknownTypes, getUnknownTypesCount } from './normalizeEvent';
import { getConnectivityService } from '../connectivity/RuntimeConnectivityService';
import type { 
  CanonicalEventType, 
  RuntimeEventEnvelope, 
  RuntimeWsConnectionState,
  AnyRuntimeEvent,
  StatusPayload,
} from './types';

const WS_URL = import.meta.env.VITE_RUNTIME_WS_URL || 'ws://localhost:3001';

// Debug mode flag
const DEBUG_WS = import.meta.env.VITE_DEBUG_WS === '1' || import.meta.env.VITE_DEBUG_WS === 'true';

// ============ Types ============

export type EventHandler = (event: RuntimeEventEnvelope) => void;
export type TypedEventHandler<T extends CanonicalEventType> = (
  event: RuntimeEventEnvelope<T, AnyRuntimeEvent extends RuntimeEventEnvelope<T, infer P> ? P : unknown>
) => void;

interface SubscriberEntry {
  types: CanonicalEventType[] | '*';
  handler: EventHandler;
}

// Heartbeat-like event types (used to determine "alive" status)
const HEARTBEAT_EVENT_TYPES: CanonicalEventType[] = [
  'status',
  'pnl:snapshot',
  'runtime:heartbeat',
  'supervisor:health',
];

// ============ Runtime WS Client ============

export class RuntimeWsClient {
  private ws: WebSocket | null = null;
  private subscribers: Set<SubscriberEntry> = new Set();
  private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  // Infinite reconnect — matches backend WS behavior for 24/7 operation.
  // Previous value of 20 caused the UI to permanently disconnect after ~30 minutes.
  private maxReconnectAttempts = Infinity;
  private baseReconnectDelay = 1000;
  private maxReconnectDelay = 30000;
  
  private _state: RuntimeWsConnectionState = {
    connected: false,
    lastMessageAt: null,
    lastEventAt: null,
    reconnectAttempts: 0,
    error: null,
  };
  
  // Event ring buffer for debug
  private eventBuffer: RuntimeEventEnvelope[] = [];
  private eventBufferSize = 50;
  
  private stateListeners: Set<(state: RuntimeWsConnectionState) => void> = new Set();
  
  constructor(private autoConnect = true) {
    if (this.autoConnect) {
      this.connect();
    }
  }
  
  // ============ Connection Management ============
  
  public connect(): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      return;
    }
    
    if (this.ws?.readyState === WebSocket.CONNECTING) {
      return;
    }
    
    try {
      if (DEBUG_WS) {
        console.log('[RuntimeWS] Connecting to', WS_URL);
      }
      
      this.ws = new WebSocket(WS_URL);
      
      this.ws.onopen = this.handleOpen.bind(this);
      this.ws.onmessage = this.handleMessage.bind(this);
      this.ws.onerror = this.handleError.bind(this);
      this.ws.onclose = this.handleClose.bind(this);
    } catch (error) {
      console.error('[RuntimeWS] Failed to connect:', error);
      this.updateState({ error: 'Failed to connect' });
      this.scheduleReconnect();
    }
  }
  
  public disconnect(): void {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    
    this.updateState({ 
      connected: false, 
      error: null,
      reconnectAttempts: 0,
    });
  }
  
  public getState(): RuntimeWsConnectionState {
    return { ...this._state };
  }
  
  public onStateChange(listener: (state: RuntimeWsConnectionState) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }
  
  // ============ Event Subscription ============
  
  /**
   * Subscribe to all events or specific types.
   * Returns unsubscribe function.
   */
  public subscribe(
    typesOrHandler: CanonicalEventType[] | '*' | EventHandler,
    handler?: EventHandler
  ): () => void {
    let entry: SubscriberEntry;
    
    if (typeof typesOrHandler === 'function') {
      // subscribe(handler) - subscribe to all events
      entry = { types: '*', handler: typesOrHandler };
    } else {
      // subscribe(types, handler)
      entry = { types: typesOrHandler, handler: handler! };
    }
    
    this.subscribers.add(entry);
    
    return () => {
      this.subscribers.delete(entry);
    };
  }
  
  /**
   * Subscribe to a specific event type with typed handler.
   */
  public on<T extends CanonicalEventType>(
    type: T,
    handler: (event: RuntimeEventEnvelope<T>) => void
  ): () => void {
    return this.subscribe([type], handler as EventHandler);
  }
  
  // ============ Debug API ============
  
  public getRecentEvents(): RuntimeEventEnvelope[] {
    return [...this.eventBuffer];
  }
  
  public getUnknownTypesInfo(): { count: number; types: string[] } {
    return {
      count: getUnknownTypesCount(),
      types: getUnknownTypes(),
    };
  }
  
  public isDebugMode(): boolean {
    return DEBUG_WS;
  }
  
  // ============ Internal Handlers ============
  
  private handleOpen(): void {
    if (DEBUG_WS) {
      console.log('[RuntimeWS] Connected');
    }
    
    this.reconnectAttempts = 0;
    this.updateState({
      connected: true,
      error: null,
      reconnectAttempts: 0,
    });
    
    // Notify connectivity service
    getConnectivityService().ingestWsOpen();
  }
  
  private handleMessage(event: MessageEvent): void {
    const now = Date.now();
    this.updateState({ lastMessageAt: now });
    
    try {
      const raw = JSON.parse(event.data);
      const normalized = normalizeRuntimeEvent(raw);
      
      if (normalized) {
        this.updateState({ lastEventAt: now });
        this.dispatchEvent(normalized);
        
        // Feed heartbeat-like events to connectivity service
        this.ingestToConnectivity(normalized, now);
        
        // Add to debug buffer
        this.eventBuffer.push(normalized);
        if (this.eventBuffer.length > this.eventBufferSize) {
          this.eventBuffer.shift();
        }
        
        if (DEBUG_WS) {
          console.log('[RuntimeWS] Event:', normalized.type, normalized.payload);
        }
      }
    } catch (error) {
      console.error('[RuntimeWS] Failed to parse message:', error);
    }
  }
  
  /**
   * Feed events to the connectivity service for accurate status tracking
   */
  private ingestToConnectivity(event: RuntimeEventEnvelope, ts: number): void {
    const connectivity = getConnectivityService();
    
    // Status events carry engine state - special handling
    if (event.type === 'status') {
      const statusPayload = event.payload as StatusPayload;
      connectivity.ingestStatus({
        engineRunning: statusPayload.engineRunning,
        mode: statusPayload.mode,
        paused: statusPayload.paused,
        tradingState: statusPayload.tradingState,
        haltReasonCode: statusPayload.haltReasonCode,
        dailyStopHit: statusPayload.dailyStopHit,
        killSwitch: statusPayload.killSwitch,
      }, ts);
      return;
    }
    
    // All heartbeat-like events count as heartbeat
    if (HEARTBEAT_EVENT_TYPES.includes(event.type)) {
      connectivity.ingestHeartbeat(ts);
    }
  }
  
  private handleError(event: Event): void {
    console.error('[RuntimeWS] WebSocket error:', event);
    this.updateState({ error: 'WebSocket error' });
  }
  
  private handleClose(event: CloseEvent): void {
    if (DEBUG_WS) {
      console.log('[RuntimeWS] Disconnected:', event.code, event.reason);
    }
    
    this.ws = null;
    this.updateState({ connected: false });
    
    // Notify connectivity service
    getConnectivityService().ingestWsClose(event.reason || 'Connection closed');
    
    this.scheduleReconnect();
  }
  
  private scheduleReconnect(): void {
    if (this.reconnectTimeout) {
      return;
    }
    
    // Never give up reconnecting — crypto runs 24/7
    // Log a warning every 50 attempts for visibility
    if (this.reconnectAttempts > 0 && this.reconnectAttempts % 50 === 0) {
      console.warn(`[RuntimeWS] Still reconnecting after ${this.reconnectAttempts} attempts`);
    }
    
    // Exponential backoff with jitter
    const delay = Math.min(
      this.baseReconnectDelay * Math.pow(2, this.reconnectAttempts) + Math.random() * 1000,
      this.maxReconnectDelay
    );
    
    this.reconnectAttempts++;
    this.updateState({ reconnectAttempts: this.reconnectAttempts });
    
    if (DEBUG_WS) {
      console.log(`[RuntimeWS] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);
    }
    
    this.reconnectTimeout = setTimeout(() => {
      this.reconnectTimeout = null;
      this.connect();
    }, delay);
  }
  
  private dispatchEvent(event: RuntimeEventEnvelope): void {
    for (const subscriber of this.subscribers) {
      if (subscriber.types === '*' || subscriber.types.includes(event.type)) {
        try {
          subscriber.handler(event);
        } catch (error) {
          console.error('[RuntimeWS] Subscriber error:', error);
        }
      }
    }
  }
  
  private updateState(partial: Partial<RuntimeWsConnectionState>): void {
    this._state = { ...this._state, ...partial };
    
    for (const listener of this.stateListeners) {
      try {
        listener(this._state);
      } catch (error) {
        console.error('[RuntimeWS] State listener error:', error);
      }
    }
  }
}

// ============ Singleton Instance ============

let clientInstance: RuntimeWsClient | null = null;

export function getRuntimeWsClient(): RuntimeWsClient {
  if (!clientInstance) {
    clientInstance = new RuntimeWsClient(true);
  }
  return clientInstance;
}

export function resetRuntimeWsClient(): void {
  if (clientInstance) {
    clientInstance.disconnect();
    clientInstance = null;
  }
}
