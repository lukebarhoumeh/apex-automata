import { useEffect, useState, useRef, useCallback } from 'react';
import { tradingApi } from '@/services/tradingApi';
import { useToast } from '@/components/ui/use-toast';

export interface TradingEngineState {
  isConnected: boolean;
  engineRunning: boolean;
  mode: 'paper' | 'live' | null;
  lastTicker: any;
  lastSignal: any;
  lastOrder: any;
  lastPosition: any;
  lastAlert: any;
  backendAvailable: boolean;
  lastUpdate: Date | null;
  isReconnecting: boolean;
}

export const useTradingEngine = () => {
  const { toast } = useToast();
  const [state, setState] = useState<TradingEngineState>({
    isConnected: false,
    engineRunning: false,
    mode: null,
    lastTicker: null,
    lastSignal: null,
    lastOrder: null,
    lastPosition: null,
    lastAlert: null,
    backendAvailable: false,
    lastUpdate: null,
    isReconnecting: false,
  });

  const tickerDebounceRef = useRef<NodeJS.Timeout>();
  const reconnectTimeoutRef = useRef<NodeJS.Timeout>();

  // Debounced ticker update to avoid excessive re-renders
  const updateTicker = useCallback((ticker: any) => {
    if (tickerDebounceRef.current) {
      clearTimeout(tickerDebounceRef.current);
    }
    tickerDebounceRef.current = setTimeout(() => {
      setState(prev => ({ 
        ...prev, 
        lastTicker: ticker,
        lastUpdate: new Date()
      }));
    }, 150);
  }, []);

  // Check backend availability on mount
  useEffect(() => {
    const checkBackend = async () => {
      try {
        await tradingApi.getStatus();
        setState(prev => ({ ...prev, backendAvailable: true }));
      } catch (error) {
        setState(prev => ({ ...prev, backendAvailable: false }));
        console.log('Backend not available - UI will use Supabase data only');
      }
    };
    
    checkBackend();
  }, []);

  useEffect(() => {
    const unsubscribers: (() => void)[] = [];

    // Connection status
    unsubscribers.push(
      tradingApi.on('connected', () => {
        if (reconnectTimeoutRef.current) {
          clearTimeout(reconnectTimeoutRef.current);
        }
        setState(prev => ({ 
          ...prev, 
          isConnected: true, 
          backendAvailable: true,
          isReconnecting: false,
          lastUpdate: new Date()
        }));
        if (state.backendAvailable) {
          toast({
            title: "Connected to Trading Engine",
            description: "Real-time data stream established",
          });
        }
      })
    );

    unsubscribers.push(
      tradingApi.on('disconnected', () => {
        setState(prev => ({ ...prev, isConnected: false, isReconnecting: true }));
        if (state.backendAvailable) {
          toast({
            title: "Disconnected from Trading Engine",
            description: "Attempting to reconnect...",
            variant: "destructive",
          });
        }
        
        // Set reconnecting flag with timeout
        reconnectTimeoutRef.current = setTimeout(() => {
          setState(prev => ({ ...prev, isReconnecting: false }));
        }, 10000);
      })
    );

    // Engine status
    unsubscribers.push(
      tradingApi.on('status', (data: any) => {
        setState(prev => ({
          ...prev,
          engineRunning: data.engineRunning,
          mode: data.mode || null,
        }));
      })
    );

    // Market data - debounced
    unsubscribers.push(
      tradingApi.on('ticker', (ticker: any) => {
        updateTicker(ticker);
      })
    );

    // Trading signals
    unsubscribers.push(
      tradingApi.on('signal', (signal: any) => {
        setState(prev => ({ ...prev, lastSignal: signal }));
        toast({
          title: `${signal.strategy} Signal`,
          description: `${signal.direction.toUpperCase()} ${signal.symbol} @ ${signal.price}`,
        });
      })
    );

    // Orders
    unsubscribers.push(
      tradingApi.on('order:created', (order: any) => {
        setState(prev => ({ ...prev, lastOrder: order }));
        toast({
          title: "Order Placed",
          description: `${order.side} ${order.size} ${order.product} @ ${order.price || 'Market'}`,
        });
      })
    );

    unsubscribers.push(
      tradingApi.on('order:filled', ({ order, fill }: any) => {
        toast({
          title: "Order Filled",
          description: `${order.side} ${fill.size} ${order.product} @ ${fill.price}`,
          variant: "default",
        });
      })
    );

    // Positions
    unsubscribers.push(
      tradingApi.on('position:update', (position: any) => {
        setState(prev => ({ ...prev, lastPosition: position }));
      })
    );

    // Risk alerts
    unsubscribers.push(
      tradingApi.on('risk:alert', (alert: any) => {
        setState(prev => ({ ...prev, lastAlert: alert }));
        toast({
          title: "Risk Alert",
          description: JSON.stringify(alert),
          variant: "destructive",
        });
      })
    );

    // Cleanup
    return () => {
      unsubscribers.forEach(unsub => unsub());
      if (tickerDebounceRef.current) {
        clearTimeout(tickerDebounceRef.current);
      }
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
    };
  }, [toast, updateTicker]);

  return state;
};
