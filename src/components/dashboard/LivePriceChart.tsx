import { useEffect, useRef, useState } from "react";
import { useTradingEngine } from "@/hooks/useTradingEngine";

interface PricePoint {
  time: number;
  price: number;
}

interface LivePriceChartProps {
  symbol: string;
  height?: number;
}

export const LivePriceChart = ({ symbol, height = 450 }: LivePriceChartProps) => {
  const { lastTicker } = useTradingEngine();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [priceHistory, setPriceHistory] = useState<PricePoint[]>([]);
  const animationFrameRef = useRef<number>();

  // Add new price data when ticker updates
  useEffect(() => {
    if (lastTicker?.price && lastTicker?.product_id === symbol) {
      const newPoint: PricePoint = {
        time: Date.now(),
        price: parseFloat(lastTicker.price)
      };
      
      setPriceHistory(prev => {
        const updated = [...prev, newPoint];
        // Keep last 5 minutes of data (assuming ~1 update per second)
        const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
        return updated.filter(p => p.time > fiveMinutesAgo);
      });
    }
  }, [lastTicker, symbol]);

  // Draw the chart
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || priceHistory.length === 0) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const draw = () => {
      // Set canvas size
      canvas.width = canvas.offsetWidth;
      canvas.height = canvas.offsetHeight;

      // Clear canvas
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      if (priceHistory.length < 2) return;

      // Calculate price range
      const prices = priceHistory.map(p => p.price);
      const minPrice = Math.min(...prices);
      const maxPrice = Math.max(...prices);
      const priceRange = maxPrice - minPrice || 1;
      const padding = priceRange * 0.1;

      // Draw grid
      ctx.strokeStyle = 'rgba(156, 163, 175, 0.1)'; // text-muted-foreground with opacity
      ctx.lineWidth = 1;
      
      // Horizontal grid lines
      for (let i = 0; i <= 5; i++) {
        const y = (canvas.height / 5) * i;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(canvas.width, y);
        ctx.stroke();
        
        // Price labels
        const price = maxPrice + padding - (priceRange + 2 * padding) * (i / 5);
        ctx.fillStyle = 'rgba(156, 163, 175, 0.6)';
        ctx.font = '11px monospace';
        ctx.fillText(`$${price.toFixed(2)}`, 5, y - 5);
      }

      // Draw price line
      ctx.strokeStyle = 'rgb(168, 85, 247)'; // primary color
      ctx.lineWidth = 2;
      ctx.beginPath();

      priceHistory.forEach((point, index) => {
        const x = (index / (priceHistory.length - 1)) * canvas.width;
        const y = ((maxPrice + padding - point.price) / (priceRange + 2 * padding)) * canvas.height;
        
        if (index === 0) {
          ctx.moveTo(x, y);
        } else {
          ctx.lineTo(x, y);
        }
      });
      
      ctx.stroke();

      // Draw gradient fill
      ctx.save();
      ctx.lineTo(canvas.width, canvas.height);
      ctx.lineTo(0, canvas.height);
      ctx.closePath();
      
      const gradient = ctx.createLinearGradient(0, 0, 0, canvas.height);
      gradient.addColorStop(0, 'rgba(168, 85, 247, 0.3)');
      gradient.addColorStop(1, 'rgba(168, 85, 247, 0.0)');
      ctx.fillStyle = gradient;
      ctx.fill();
      ctx.restore();

      // Draw current price
      if (priceHistory.length > 0) {
        const lastPoint = priceHistory[priceHistory.length - 1];
        const lastX = canvas.width;
        const lastY = ((maxPrice + padding - lastPoint.price) / (priceRange + 2 * padding)) * canvas.height;
        
        // Price dot
        ctx.beginPath();
        ctx.arc(lastX, lastY, 4, 0, 2 * Math.PI);
        ctx.fillStyle = 'rgb(168, 85, 247)';
        ctx.fill();
        
        // Price label
        ctx.fillStyle = 'rgb(34, 197, 94)'; // success color
        ctx.font = 'bold 14px monospace';
        ctx.fillText(`$${lastPoint.price.toFixed(2)}`, canvas.width - 80, 20);
      }
    };

    // Draw immediately and on resize
    draw();
    
    const handleResize = () => {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
      animationFrameRef.current = requestAnimationFrame(draw);
    };

    window.addEventListener('resize', handleResize);
    
    return () => {
      window.removeEventListener('resize', handleResize);
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
    };
  }, [priceHistory]);

  return (
    <div className="relative w-full" style={{ height }}>
      <canvas 
        ref={canvasRef}
        className="w-full h-full"
      />
      {priceHistory.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center">
          <p className="text-sm text-muted-foreground">Waiting for market data...</p>
        </div>
      )}
    </div>
  );
};
