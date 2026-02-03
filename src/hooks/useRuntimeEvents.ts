/**
 * @deprecated Use useRuntimeWs from @/runtime/ws instead.
 * 
 * This file is kept for backward compatibility only.
 */

import { useEffect, useState } from 'react';
import { useRuntimeWs, useRuntimeWsState } from '@/runtime/ws';
import type { 
  TickerPayload, 
  CandlePayload,
  RuntimeEventEnvelope 
} from '@/runtime/ws/types';

// Re-export types for backward compatibility
export type EventType = 
  | 'StatusUpdate'
  | 'TickerUpdate'
  | 'Signal'
  | 'OrderUpdate'
  | 'Fill'
  | 'PositionUpdate'
  | 'RiskEvent'
  | 'Alert'
  | 'CandleUpdate';

export interface TickerUpdate extends TickerPayload {}
export interface CandleUpdate extends CandlePayload {}

export interface RuntimeEvent<T = unknown> {
  type: EventType;
  payload: T;
  timestamp: number;
}

interface UseRuntimeEventsOptions {
  onTicker?: (data: TickerPayload) => void;
  onCandle?: (data: CandlePayload) => void;
  onSignal?: (data: unknown) => void;
  onOrderUpdate?: (data: unknown) => void;
  onFill?: (data: unknown) => void;
  onPositionUpdate?: (data: unknown) => void;
  onRiskEvent?: (data: unknown) => void;
  onAlert?: (data: unknown) => void;
  onStatusUpdate?: (data: unknown) => void;
  autoReconnect?: boolean;
  reconnectInterval?: number;
}

/**
 * @deprecated Use useRuntimeWs() and subscribe to specific events instead
 */
export function useRuntimeEvents(options: UseRuntimeEventsOptions = {}) {
  const wsState = useRuntimeWsState();
  const { on, getRecentEvents } = useRuntimeWs();
  const [lastMessage, setLastMessage] = useState<RuntimeEventEnvelope | null>(null);

  useEffect(() => {
    const unsubscribers: (() => void)[] = [];

    if (options.onTicker) {
      unsubscribers.push(on('market:ticker', (e) => {
        setLastMessage(e);
        options.onTicker?.(e.payload as TickerPayload);
      }));
    }

    if (options.onCandle) {
      unsubscribers.push(on('market:candle', (e) => {
        setLastMessage(e);
        options.onCandle?.(e.payload as CandlePayload);
      }));
    }

    if (options.onSignal) {
      unsubscribers.push(on('signal', (e) => {
        setLastMessage(e);
        options.onSignal?.(e.payload);
      }));
    }

    if (options.onOrderUpdate) {
      unsubscribers.push(on('order:updated', (e) => {
        setLastMessage(e);
        options.onOrderUpdate?.(e.payload);
      }));
      unsubscribers.push(on('order:created', (e) => {
        setLastMessage(e);
        options.onOrderUpdate?.(e.payload);
      }));
      unsubscribers.push(on('order:filled', (e) => {
        setLastMessage(e);
        options.onOrderUpdate?.(e.payload);
      }));
    }

    if (options.onFill) {
      unsubscribers.push(on('fill', (e) => {
        setLastMessage(e);
        options.onFill?.(e.payload);
      }));
    }

    if (options.onPositionUpdate) {
      unsubscribers.push(on('position:opened', (e) => {
        setLastMessage(e);
        options.onPositionUpdate?.(e.payload);
      }));
      unsubscribers.push(on('position:updated', (e) => {
        setLastMessage(e);
        options.onPositionUpdate?.(e.payload);
      }));
      unsubscribers.push(on('position:closed', (e) => {
        setLastMessage(e);
        options.onPositionUpdate?.(e.payload);
      }));
    }

    if (options.onRiskEvent) {
      unsubscribers.push(on('risk:event', (e) => {
        setLastMessage(e);
        options.onRiskEvent?.(e.payload);
      }));
      unsubscribers.push(on('risk:metrics', (e) => {
        setLastMessage(e);
        options.onRiskEvent?.(e.payload);
      }));
    }

    if (options.onStatusUpdate) {
      unsubscribers.push(on('status', (e) => {
        setLastMessage(e);
        options.onStatusUpdate?.(e.payload);
      }));
    }

    return () => {
      unsubscribers.forEach(unsub => unsub());
    };
  }, [on, options]);

  return {
    isConnected: wsState.connected,
    lastMessage,
    connectionError: wsState.error,
    reconnect: () => {}, // No-op, managed by provider
    disconnect: () => {}, // No-op, managed by provider
  };
}
