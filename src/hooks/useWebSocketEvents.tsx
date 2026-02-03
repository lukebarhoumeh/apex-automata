/**
 * @deprecated Use RuntimeWsProvider and useRuntimeWs from @/runtime/ws instead.
 * 
 * This file is kept for backward compatibility only.
 * All new code should use the unified runtime WS pipeline.
 */

import { useRuntimeWs, useRuntimeWsState, RuntimeWsProvider } from '@/runtime/ws';
import type { 
  CanonicalEventType, 
  RuntimeEventEnvelope,
  SignalPayload,
  OrderPayload,
  PositionPayload,
  StatusPayload,
  RegimePayload,
  CandlePayload,
} from '@/runtime/ws/types';

// Re-export types for backward compatibility
export type WebSocketEventType = CanonicalEventType;
export type WebSocketEvent = RuntimeEventEnvelope;

export interface CandleEvent extends CandlePayload {}
export interface SignalEvent extends SignalPayload {}
export interface OrderEvent extends OrderPayload {}
export interface PositionEvent extends PositionPayload {}
export interface StatusEvent extends StatusPayload {}
export interface RegimeEvent extends RegimePayload {}

type EventCallback = (payload: unknown) => void;

interface UseWebSocketEventsOptions {
  autoConnect?: boolean;
  showNotifications?: boolean;
}

/**
 * @deprecated Use useRuntimeWs() instead
 */
export const useWebSocketEvents = (_options: UseWebSocketEventsOptions = {}) => {
  const wsState = useRuntimeWsState();
  const { subscribe: runtimeSubscribe, getRecentEvents } = useRuntimeWs();
  
  // Wrap the new subscribe to match old API
  const subscribe = (type: CanonicalEventType, callback: EventCallback) => {
    return runtimeSubscribe([type], (event) => callback(event.payload));
  };
  
  return {
    isConnected: wsState.connected,
    connectionError: wsState.error,
    lastEvent: getRecentEvents()[0] ?? null,
    connect: () => {}, // No-op, managed by provider
    disconnect: () => {}, // No-op, managed by provider
    subscribe,
  };
};

/**
 * @deprecated Use useRuntimeWs() instead
 */
export function useWebSocket() {
  return useWebSocketEvents();
}

// Re-export provider for apps that haven't migrated yet
export { RuntimeWsProvider as WebSocketProvider };
