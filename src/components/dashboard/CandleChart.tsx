import { useEffect, useRef, useState, useMemo } from "react";
import { useTradingEngine } from "@/hooks/useTradingEngine";
import { useRecentSignals } from "@/hooks/useSignals";
import type { LiveCandle } from "@/hooks/useLiveTicker";

interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface CandleChartProps {
  symbol: string;
  height?: number;
  timeframe?: "1m" | "5m" | "15m";
  showVwap?: boolean;
  showDonchian?: boolean;
  donchianPeriod?: number;
  liveCandles?: LiveCandle[];
}

export const CandleChart = ({ 
  symbol, 
  height = 450, 
  timeframe = "1m",
  showVwap = true,
  showDonchian = true,
  donchianPeriod = 20,
  liveCandles = []
}: CandleChartProps) => {
  const { lastTicker } = useTradingEngine();
  const { data: recentSignals } = useRecentSignals(20);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [candles, setCandles] = useState<Candle[]>([]);
  const currentCandleRef = useRef<Candle | null>(null);

  const tfMs = useMemo(() => {
    switch (timeframe) {
      case "1m": return 60 * 1000;
      case "5m": return 5 * 60 * 1000;
      case "15m": return 15 * 60 * 1000;
      default: return 60 * 1000;
    }
  }, [timeframe]);

  // Merge live WebSocket candles with polling-based candles
  useEffect(() => {
    if (liveCandles.length > 0) {
      // Use WebSocket candles as source of truth
      setCandles(liveCandles);
      return;
    }
  }, [liveCandles]);

  // Process ticker into candles (fallback when no WS candles)
  useEffect(() => {
    if (liveCandles.length > 0) return; // Skip if WS provides candles
    if (!lastTicker?.price) return;
    
    const price = parseFloat(lastTicker.price);
    const now = Date.now();
    const candleTime = Math.floor(now / tfMs) * tfMs;

    setCandles(prev => {
      const updated = [...prev];
      const lastCandle = updated[updated.length - 1];

      if (!lastCandle || lastCandle.time < candleTime) {
        // Start new candle
        const newCandle: Candle = {
          time: candleTime,
          open: price,
          high: price,
          low: price,
          close: price,
          volume: 0
        };
        updated.push(newCandle);
        currentCandleRef.current = newCandle;
        
        // Keep last 100 candles
        if (updated.length > 100) updated.shift();
      } else {
        // Update current candle
        lastCandle.high = Math.max(lastCandle.high, price);
        lastCandle.low = Math.min(lastCandle.low, price);
        lastCandle.close = price;
        currentCandleRef.current = lastCandle;
      }

      return updated;
    });
  }, [lastTicker, tfMs, liveCandles.length]);

  // Calculate indicators
  const { vwap, donchianHigh, donchianLow } = useMemo(() => {
    if (candles.length < 2) return { vwap: 0, donchianHigh: 0, donchianLow: 0 };

    // VWAP (simplified - using typical price)
    const typicalPrices = candles.map(c => (c.high + c.low + c.close) / 3);
    const vwap = typicalPrices.reduce((a, b) => a + b, 0) / typicalPrices.length;

    // Donchian Channel
    const lookback = candles.slice(-donchianPeriod);
    const donchianHigh = Math.max(...lookback.map(c => c.high));
    const donchianLow = Math.min(...lookback.map(c => c.low));

    return { vwap, donchianHigh, donchianLow };
  }, [candles, donchianPeriod]);

  // Get signal markers for chart
  const signalMarkers = useMemo(() => {
    if (!recentSignals) return [];
    return recentSignals
      .filter(s => s.symbol === symbol && s.allowed)
      .map(s => ({
        time: new Date(s.decided_at).getTime(),
        side: s.side,
        strategy: s.strategy
      }));
  }, [recentSignals, symbol]);

  // Draw the chart
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || candles.length < 2) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Set canvas size
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);

    const width = rect.width;
    const chartHeight = rect.height;
    const padding = { top: 20, right: 60, bottom: 30, left: 10 };
    const chartWidth = width - padding.left - padding.right;
    const innerHeight = chartHeight - padding.top - padding.bottom;

    // Clear
    ctx.clearRect(0, 0, width, chartHeight);

    // Price range
    const allPrices = candles.flatMap(c => [c.high, c.low]);
    if (showDonchian) {
      allPrices.push(donchianHigh, donchianLow);
    }
    const minPrice = Math.min(...allPrices);
    const maxPrice = Math.max(...allPrices);
    const priceRange = maxPrice - minPrice || 1;
    const pricePadding = priceRange * 0.05;

    const priceToY = (price: number) => {
      return padding.top + ((maxPrice + pricePadding - price) / (priceRange + 2 * pricePadding)) * innerHeight;
    };

    const candleWidth = Math.max(2, (chartWidth / candles.length) - 2);
    const candleSpacing = chartWidth / candles.length;

    // Draw grid
    ctx.strokeStyle = "rgba(100, 100, 120, 0.15)";
    ctx.lineWidth = 1;
    for (let i = 0; i <= 5; i++) {
      const y = padding.top + (innerHeight / 5) * i;
      ctx.beginPath();
      ctx.moveTo(padding.left, y);
      ctx.lineTo(width - padding.right, y);
      ctx.stroke();

      // Price labels
      const price = maxPrice + pricePadding - ((priceRange + 2 * pricePadding) * (i / 5));
      ctx.fillStyle = "rgba(150, 150, 170, 0.8)";
      ctx.font = "11px monospace";
      ctx.textAlign = "left";
      ctx.fillText(`$${price.toFixed(2)}`, width - padding.right + 5, y + 4);
    }

    // Draw Donchian Channel
    if (showDonchian && donchianHigh > 0) {
      ctx.strokeStyle = "rgba(59, 130, 246, 0.5)"; // Blue
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      
      // High line
      const yHigh = priceToY(donchianHigh);
      ctx.beginPath();
      ctx.moveTo(padding.left, yHigh);
      ctx.lineTo(width - padding.right, yHigh);
      ctx.stroke();

      // Low line
      const yLow = priceToY(donchianLow);
      ctx.beginPath();
      ctx.moveTo(padding.left, yLow);
      ctx.lineTo(width - padding.right, yLow);
      ctx.stroke();

      ctx.setLineDash([]);

      // Fill between
      ctx.fillStyle = "rgba(59, 130, 246, 0.05)";
      ctx.fillRect(padding.left, yHigh, chartWidth, yLow - yHigh);
    }

    // Draw VWAP
    if (showVwap && vwap > 0) {
      ctx.strokeStyle = "rgba(168, 85, 247, 0.8)"; // Purple
      ctx.lineWidth = 2;
      const yVwap = priceToY(vwap);
      ctx.beginPath();
      ctx.moveTo(padding.left, yVwap);
      ctx.lineTo(width - padding.right, yVwap);
      ctx.stroke();

      ctx.fillStyle = "rgba(168, 85, 247, 0.9)";
      ctx.font = "10px monospace";
      ctx.fillText("VWAP", padding.left + 5, yVwap - 5);
    }

    // Draw candles
    candles.forEach((candle, i) => {
      const x = padding.left + (i * candleSpacing) + candleSpacing / 2;
      const isGreen = candle.close >= candle.open;

      // Wick
      ctx.strokeStyle = isGreen ? "rgb(34, 197, 94)" : "rgb(239, 68, 68)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, priceToY(candle.high));
      ctx.lineTo(x, priceToY(candle.low));
      ctx.stroke();

      // Body
      const bodyTop = priceToY(Math.max(candle.open, candle.close));
      const bodyBottom = priceToY(Math.min(candle.open, candle.close));
      const bodyHeight = Math.max(1, bodyBottom - bodyTop);

      ctx.fillStyle = isGreen ? "rgb(34, 197, 94)" : "rgb(239, 68, 68)";
      ctx.fillRect(x - candleWidth / 2, bodyTop, candleWidth, bodyHeight);
    });

    // Draw signal markers
    signalMarkers.forEach(marker => {
      const candleIndex = candles.findIndex(c => 
        Math.abs(c.time - marker.time) < tfMs
      );
      if (candleIndex === -1) return;

      const candle = candles[candleIndex];
      const x = padding.left + (candleIndex * candleSpacing) + candleSpacing / 2;
      const y = marker.side === "long" 
        ? priceToY(candle.low) + 15 
        : priceToY(candle.high) - 15;

      // Draw triangle marker
      ctx.beginPath();
      if (marker.side === "long") {
        ctx.moveTo(x, y);
        ctx.lineTo(x - 6, y + 10);
        ctx.lineTo(x + 6, y + 10);
      } else {
        ctx.moveTo(x, y);
        ctx.lineTo(x - 6, y - 10);
        ctx.lineTo(x + 6, y - 10);
      }
      ctx.closePath();
      ctx.fillStyle = marker.side === "long" ? "rgb(34, 197, 94)" : "rgb(239, 68, 68)";
      ctx.fill();
    });

    // Current price line
    if (candles.length > 0) {
      const lastCandle = candles[candles.length - 1];
      const yLast = priceToY(lastCandle.close);
      
      ctx.strokeStyle = "rgba(168, 85, 247, 0.6)";
      ctx.setLineDash([2, 2]);
      ctx.beginPath();
      ctx.moveTo(padding.left, yLast);
      ctx.lineTo(width - padding.right, yLast);
      ctx.stroke();
      ctx.setLineDash([]);

      // Price tag
      ctx.fillStyle = "rgb(168, 85, 247)";
      ctx.fillRect(width - padding.right, yLast - 10, 55, 20);
      ctx.fillStyle = "#fff";
      ctx.font = "bold 11px monospace";
      ctx.textAlign = "left";
      ctx.fillText(`$${lastCandle.close.toFixed(2)}`, width - padding.right + 3, yLast + 4);
    }

  }, [candles, vwap, donchianHigh, donchianLow, showVwap, showDonchian, signalMarkers, tfMs]);

  return (
    <div className="relative w-full" style={{ height }}>
      <canvas 
        ref={canvasRef}
        className="w-full h-full"
        style={{ display: "block" }}
      />
      {candles.length < 2 && (
        <div className="absolute inset-0 flex items-center justify-center bg-background/50">
          <p className="text-sm text-muted-foreground">Building candles from market data...</p>
        </div>
      )}
    </div>
  );
};
