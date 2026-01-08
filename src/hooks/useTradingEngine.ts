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
  const backendCheckIntervalRef = useRef<NodeJS.Timeout>();

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

  // Check backend availability on mount and periodically
  useEffect(() => {
    const checkBackend = async () => {
      try {
        const status = await tradingApi.getStatus();
        setState(prev => ({ 
          ...prev, 
          backendAvailable: true,
          engineRunning: status.engineRunning,
          mode: status.mode,
        }));
      } catch (error) {
        setState(prev => ({ ...prev, backendAvailable: false }));
      }
    };
    
    // Initial check
    checkBackend();
    
    // Periodic check every 5 seconds
    backendCheckIntervalRef.current = setInterval(checkBackend, 5000);
    
    return () => {
      if (backendCheckIntervalRef.current) {
        clearInterval(backendCheckIntervalRef.current);
      }
    };
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

    // Engine status - backend sends StatusUpdate
    unsubscribers.push(
      tradingApi.on('StatusUpdate', (status: any) => {
        console.log('Received StatusUpdate:', status);
        setState(prev => ({
          ...prev,
          engineRunning: status.mode !== null && !status.paused,
          mode: status.mode || null,
        }));
      })
    );

    // Market data - backend sends TickerUpdate
    unsubscribers.push(
      tradingApi.on('TickerUpdate', (ticker: any) => {
        console.log('Received TickerUpdate:', ticker);
        updateTicker(ticker);
      })
    );

    // Trading signals - backend sends Signal
    unsubscribers.push(
      tradingApi.on('Signal', (signal: any) => {
        console.log('Received Signal:', signal);
        setState(prev => ({ ...prev, lastSignal: signal }));
        toast({
          title: `${signal.strategy} Signal`,
          description: `${signal.direction.toUpperCase()} ${signal.symbol} @ ${signal.price}`,
        });
      })
    );

    // Orders - backend sends OrderUpdate
    unsubscribers.push(
      tradingApi.on('OrderUpdate', (order: any) => {
        console.log('Received OrderUpdate:', order);
        setState(prev => ({ ...prev, lastOrder: order }));
        toast({
          title: "Order Placed",
          description: `${order.side} ${order.size} ${order.product} @ ${order.price || 'Market'}`,
        });
      })
    );

    // Fills - backend sends Fill
    unsubscribers.push(
      tradingApi.on('Fill', (fill: any) => {
        console.log('Received Fill:', fill);
        toast({
          title: "Order Filled",
          description: `Filled ${fill.quantity} @ ${fill.price}`,
          variant: "default",
        });
      })
    );

    // Positions - backend sends PositionUpdate
    unsubscribers.push(
      tradingApi.on('PositionUpdate', (position: any) => {
        console.log('Received PositionUpdate:', position);
        setState(prev => ({ ...prev, lastPosition: position }));
      })
    );

    // Risk alerts - backend sends RiskEvent
    unsubscribers.push(
      tradingApi.on('RiskEvent', (alert: any) => {
        console.log('Received RiskEvent:', alert);
        setState(prev => ({ ...prev, lastAlert: alert }));
        toast({
          title: "Risk Alert",
          description: alert.message || JSON.stringify(alert),
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
