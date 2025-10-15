import { useEffect, useState } from 'react';
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
  });

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

    // Connection status - only show toasts if backend was available
    unsubscribers.push(
      tradingApi.on('connected', () => {
        setState(prev => ({ ...prev, isConnected: true, backendAvailable: true }));
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
        setState(prev => ({ ...prev, isConnected: false }));
        if (state.backendAvailable) {
          toast({
            title: "Disconnected from Trading Engine",
            description: "Attempting to reconnect...",
            variant: "destructive",
          });
        }
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

    // Market data
    unsubscribers.push(
      tradingApi.on('ticker', (ticker: any) => {
        setState(prev => ({ ...prev, lastTicker: ticker }));
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
    };
  }, [toast]);

  return state;
};
