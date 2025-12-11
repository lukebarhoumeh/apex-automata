// Hook for live ticker data from WebSocket events
import { useState, useCallback, useMemo } from 'react';
import { useRuntimeEvents, TickerUpdate, CandleUpdate } from './useRuntimeEvents';

export interface LiveTickerData {
  symbol: string;
  price: number;
  bid: number;
  ask: number;
  volume: number;
  change24h?: number;
  timestamp: number;
}

export interface LiveCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

const MAX_CANDLES = 200;

export function useLiveTicker(symbols: string[] = ['BTC-USD']) {
  const [tickers, setTickers] = useState<Record<string, LiveTickerData>>({});
  const [candles, setCandles] = useState<Record<string, LiveCandle[]>>({});

  const handleTicker = useCallback((data: TickerUpdate) => {
    setTickers(prev => ({
      ...prev,
      [data.symbol]: {
        symbol: data.symbol,
        price: data.price,
        bid: data.bid,
        ask: data.ask,
        volume: data.volume,
        timestamp: data.timestamp,
      },
    }));
  }, []);

  const handleCandle = useCallback((data: CandleUpdate) => {
    setCandles(prev => {
      const symbolCandles = prev[data.symbol] || [];
      const newCandle: LiveCandle = {
        time: data.timestamp,
        open: data.open,
        high: data.high,
        low: data.low,
        close: data.close,
        volume: data.volume,
      };

      // Check if this is an update to the last candle or a new one
      const lastCandle = symbolCandles[symbolCandles.length - 1];
      if (lastCandle && lastCandle.time === data.timestamp) {
        // Update existing candle
        const updated = [...symbolCandles];
        updated[updated.length - 1] = newCandle;
        return { ...prev, [data.symbol]: updated };
      } else {
        // Add new candle, keep max candles
        const updated = [...symbolCandles, newCandle].slice(-MAX_CANDLES);
        return { ...prev, [data.symbol]: updated };
      }
    });
  }, []);

  const { isConnected, connectionError } = useRuntimeEvents({
    onTicker: handleTicker,
    onCandle: handleCandle,
  });

  // Get ticker for a specific symbol
  const getTicker = useCallback((symbol: string) => tickers[symbol], [tickers]);

  // Get candles for a specific symbol
  const getCandles = useCallback((symbol: string) => candles[symbol] || [], [candles]);

  // Get current price for a symbol
  const getPrice = useCallback((symbol: string) => tickers[symbol]?.price, [tickers]);

  // Get spread percentage
  const getSpread = useCallback((symbol: string) => {
    const ticker = tickers[symbol];
    if (!ticker || !ticker.bid || !ticker.ask) return 0;
    return ((ticker.ask - ticker.bid) / ticker.price) * 100;
  }, [tickers]);

  return {
    tickers,
    candles,
    isConnected,
    connectionError,
    getTicker,
    getCandles,
    getPrice,
    getSpread,
    // For specific symbols the user cares about
    primaryTicker: tickers[symbols[0]] || null,
    primaryCandles: candles[symbols[0]] || [],
  };
}
