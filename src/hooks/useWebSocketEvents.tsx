import { useEffect, useRef, useState, useCallback, createContext, useContext } from 'react';
import type { ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useToast } from '@/hooks/use-toast';

const WS_URL = import.meta.env.VITE_RUNTIME_WS_URL || 'ws://localhost:3001';

export type WebSocketEventType = 
  | 'candle'
  | 'signal'
  | 'order:placed'
  | 'order:filled'
  | 'position:opened'
  | 'position:closed'
  | 'status'
  | 'regime:change';

export interface WebSocketEvent {
  type: WebSocketEventType;
  payload: unknown;
  timestamp: string;
}

export interface CandleEvent {
  symbol: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  timestamp: string;
}

export interface SignalEvent {
  id: string;
  symbol: string;
  strategy: string;
  side: 'long' | 'short';
  score: number;
  meta_prob?: number;
  allowed: boolean;
  reason?: string;
}

export interface OrderEvent {
  id: string;
  symbol: string;
  side: 'buy' | 'sell';
  type: string;
  quantity: number;
  price?: number;
  status: string;
  strategy: string;
}

export interface PositionEvent {
  id: string;
  symbol: string;
  side: 'long' | 'short';
  entry_price: number;
  exit_price?: number;
  qty: number;
  pnl_usd?: number;
  pnl_r?: number;
  strategy: string;
}

export interface StatusEvent {
  engineRunning: boolean;
  mode: 'paper' | 'live' | null;
  paused: boolean;
  dailyStopHit: boolean;
  killSwitch: {
    active: boolean;
    reasons: string[];
  };
}

export interface RegimeEvent {
  symbol: string;
  regime: 'strong_trend' | 'weak_trend' | 'ranging' | 'choppy';
  previous: string;
  confidence: number;
  adx: number;
  choppiness: number;
}

type EventCallback = (payload: unknown) => void;

interface UseWebSocketEventsOptions {
  autoConnect?: boolean;
  showNotifications?: boolean;
}

export const useWebSocketEvents = (options: UseWebSocketEventsOptions = {}) => {
  const { autoConnect = true, showNotifications = true } = options;
  const { toast } = useToast();
  const queryClient = useQueryClient();
  
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttempts = useRef(0);
  const maxReconnectAttempts = 10;
  const baseReconnectDelay = 1000;

  const [isConnected, setIsConnected] = useState(false);
  const [lastEvent, setLastEvent] = useState<WebSocketEvent | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);

  const listenersRef = useRef<Map<WebSocketEventType, Set<EventCallback>>>(new Map());

  const subscribe = useCallback((type: WebSocketEventType, callback: EventCallback) => {
    if (!listenersRef.current.has(type)) {
      listenersRef.current.set(type, new Set());
    }
    listenersRef.current.get(type)!.add(callback);

    return () => {
      listenersRef.current.get(type)?.delete(callback);
    };
  }, []);

  const handleEvent = useCallback((event: WebSocketEvent) => {
    setLastEvent(event);

    const listeners = listenersRef.current.get(event.type);
    if (listeners) {
      listeners.forEach(callback => callback(event.payload));
    }

    switch (event.type) {
      case 'signal':
        queryClient.invalidateQueries({ queryKey: ['signals'] });
        if (showNotifications) {
          const signal = event.payload as SignalEvent;
          toast({
            title: `Signal: ${signal.symbol}`,
            description: `${signal.strategy} ${signal.side.toUpperCase()} - ${signal.allowed ? 'Allowed' : 'Blocked'}`,
            variant: signal.allowed ? 'default' : 'destructive',
          });
        }
        break;

      case 'order:placed':
        queryClient.invalidateQueries({ queryKey: ['orders'] });
        if (showNotifications) {
          const order = event.payload as OrderEvent;
          toast({
            title: 'Order Placed',
            description: `${order.side.toUpperCase()} ${order.quantity} ${order.symbol} @ ${order.price || 'MKT'}`,
          });
        }
        break;

      case 'order:filled':
        queryClient.invalidateQueries({ queryKey: ['orders'] });
        queryClient.invalidateQueries({ queryKey: ['fills'] });
        if (showNotifications) {
          const order = event.payload as OrderEvent;
          toast({
            title: 'Order Filled',
            description: `${order.side.toUpperCase()} ${order.quantity} ${order.symbol}`,
          });
        }
        break;

      case 'position:opened':
        queryClient.invalidateQueries({ queryKey: ['positions'] });
        queryClient.invalidateQueries({ queryKey: ['calculated-metrics'] });
        if (showNotifications) {
          const pos = event.payload as PositionEvent;
          toast({
            title: 'Position Opened',
            description: `${pos.side.toUpperCase()} ${pos.qty} ${pos.symbol} @ ${pos.entry_price.toFixed(2)}`,
          });
        }
        break;

      case 'position:closed':
        queryClient.invalidateQueries({ queryKey: ['positions'] });
        queryClient.invalidateQueries({ queryKey: ['calculated-metrics'] });
        queryClient.invalidateQueries({ queryKey: ['session-stats'] });
        if (showNotifications) {
          const pos = event.payload as PositionEvent;
          toast({
            title: 'Position Closed',
            description: `${pos.symbol}: ${(pos.pnl_usd || 0) >= 0 ? '+' : ''}$${pos.pnl_usd?.toFixed(2)} (${pos.pnl_r?.toFixed(2)}R)`,
            variant: (pos.pnl_usd || 0) >= 0 ? 'default' : 'destructive',
          });
        }
        break;

      case 'status':
        queryClient.invalidateQueries({ queryKey: ['runtime-status'] });
        break;

      case 'regime:change':
        queryClient.invalidateQueries({ queryKey: ['regime-state'] });
        if (showNotifications) {
          const regime = event.payload as RegimeEvent;
          toast({
            title: `Regime Change: ${regime.symbol}`,
            description: `${regime.previous} → ${regime.regime} (${(regime.confidence * 100).toFixed(0)}% conf)`,
          });
        }
        break;

      case 'candle':
        break;
    }
  }, [queryClient, showNotifications, toast]);

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      return;
    }

    try {
      console.log('[WS] Connecting to', WS_URL);
      wsRef.current = new WebSocket(WS_URL);

      wsRef.current.onopen = () => {
        console.log('[WS] Connected');
        setIsConnected(true);
        setConnectionError(null);
        reconnectAttempts.current = 0;
      };

      wsRef.current.onclose = (event) => {
        console.log('[WS] Disconnected', event.code, event.reason);
        setIsConnected(false);

        if (reconnectAttempts.current < maxReconnectAttempts) {
          const delay = baseReconnectDelay * Math.pow(2, reconnectAttempts.current);
          console.log(`[WS] Reconnecting in ${delay}ms (attempt ${reconnectAttempts.current + 1})`);
          reconnectTimeoutRef.current = setTimeout(() => {
            reconnectAttempts.current++;
            connect();
          }, delay);
        } else {
          setConnectionError('Max reconnection attempts reached');
        }
      };

      wsRef.current.onerror = () => {
        console.error('[WS] Connection error');
        setConnectionError('WebSocket connection error');
      };

      wsRef.current.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data) as WebSocketEvent;
          handleEvent(data);
        } catch (error) {
          console.error('[WS] Failed to parse message:', error);
        }
      };
    } catch (error) {
      console.error('[WS] Failed to connect:', error);
      setConnectionError('Failed to connect to WebSocket');
    }
  }, [handleEvent]);

  const disconnect = useCallback(() => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    setIsConnected(false);
  }, []);

  useEffect(() => {
    if (autoConnect) {
      connect();
    }

    return () => {
      disconnect();
    };
  }, [autoConnect, connect, disconnect]);

  return {
    isConnected,
    connectionError,
    lastEvent,
    connect,
    disconnect,
    subscribe,
  };
};

interface WebSocketContextValue {
  isConnected: boolean;
  connectionError: string | null;
  lastEvent: WebSocketEvent | null;
  subscribe: (type: WebSocketEventType, callback: EventCallback) => () => void;
}

const WebSocketContext = createContext<WebSocketContextValue | null>(null);

export function WebSocketProvider({ children }: { children: ReactNode }) {
  const ws = useWebSocketEvents({ autoConnect: true, showNotifications: true });

  const value: WebSocketContextValue = {
    isConnected: ws.isConnected,
    connectionError: ws.connectionError,
    lastEvent: ws.lastEvent,
    subscribe: ws.subscribe,
  };

  return (
    <WebSocketContext.Provider value={value}>
      {children}
    </WebSocketContext.Provider>
  );
}

export function useWebSocket() {
  const context = useContext(WebSocketContext);
  if (!context) {
    throw new Error('useWebSocket must be used within a WebSocketProvider');
  }
  return context;
}
