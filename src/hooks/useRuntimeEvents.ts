// WebSocket hook for real-time runtime events from the Node backend
import { useEffect, useRef, useState, useCallback } from 'react';

// Backend WebSocket is on root path, not /events
const WS_URL = import.meta.env.VITE_RUNTIME_WS_URL || 'ws://localhost:3001';

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

export interface TickerUpdate {
  symbol: string;
  price: number;
  bid: number;
  ask: number;
  volume: number;
  timestamp: number;
}

export interface CandleUpdate {
  symbol: string;
  timeframe: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  timestamp: number;
}

export interface RuntimeEvent<T = unknown> {
  type: EventType;
  payload: T;
  timestamp: number;
}

interface UseRuntimeEventsOptions {
  onTicker?: (data: TickerUpdate) => void;
  onCandle?: (data: CandleUpdate) => void;
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

export function useRuntimeEvents(options: UseRuntimeEventsOptions = {}) {
  const {
    onTicker,
    onCandle,
    onSignal,
    onOrderUpdate,
    onFill,
    onPositionUpdate,
    onRiskEvent,
    onAlert,
    onStatusUpdate,
    autoReconnect = true,
    reconnectInterval = 3000,
  } = options;

  const [isConnected, setIsConnected] = useState(false);
  const [lastMessage, setLastMessage] = useState<RuntimeEvent | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<number | null>(null);
  const mountedRef = useRef(true);

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    try {
      const ws = new WebSocket(WS_URL);
      wsRef.current = ws;

      ws.onopen = () => {
        if (!mountedRef.current) return;
        setIsConnected(true);
        setConnectionError(null);
        console.log('[WS] Connected to runtime events');
      };

      ws.onmessage = (event) => {
        if (!mountedRef.current) return;
        try {
          const data: RuntimeEvent = JSON.parse(event.data);
          setLastMessage(data);

          // Route to appropriate handler
          switch (data.type) {
            case 'TickerUpdate':
              onTicker?.(data.payload as TickerUpdate);
              break;
            case 'CandleUpdate':
              onCandle?.(data.payload as CandleUpdate);
              break;
            case 'Signal':
              onSignal?.(data.payload);
              break;
            case 'OrderUpdate':
              onOrderUpdate?.(data.payload);
              break;
            case 'Fill':
              onFill?.(data.payload);
              break;
            case 'PositionUpdate':
              onPositionUpdate?.(data.payload);
              break;
            case 'RiskEvent':
              onRiskEvent?.(data.payload);
              break;
            case 'Alert':
              onAlert?.(data.payload);
              break;
            case 'StatusUpdate':
              onStatusUpdate?.(data.payload);
              break;
          }
        } catch (err) {
          console.error('[WS] Failed to parse message:', err);
        }
      };

      ws.onclose = () => {
        if (!mountedRef.current) return;
        setIsConnected(false);
        console.log('[WS] Disconnected from runtime events');

        // Auto reconnect
        if (autoReconnect && mountedRef.current) {
          reconnectTimeoutRef.current = window.setTimeout(() => {
            if (mountedRef.current) {
              connect();
            }
          }, reconnectInterval);
        }
      };

      ws.onerror = (error) => {
        if (!mountedRef.current) return;
        console.error('[WS] WebSocket error:', error);
        setConnectionError('WebSocket connection failed');
      };
    } catch (err) {
      console.error('[WS] Failed to create WebSocket:', err);
      setConnectionError('Failed to create WebSocket connection');
    }
  }, [onTicker, onCandle, onSignal, onOrderUpdate, onFill, onPositionUpdate, onRiskEvent, onAlert, onStatusUpdate, autoReconnect, reconnectInterval]);

  const disconnect = useCallback(() => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    connect();

    return () => {
      mountedRef.current = false;
      disconnect();
    };
  }, [connect, disconnect]);

  return {
    isConnected,
    lastMessage,
    connectionError,
    reconnect: connect,
    disconnect,
  };
}
