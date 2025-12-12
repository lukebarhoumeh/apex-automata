import { EventEmitter } from 'events';
import { Logger } from '../core/logger';
import { TechnicalIndicators, OHLCV } from '../indicators/technical';

export interface MetricsTrackerConfig {
  spreadWindowSize: number;   // Number of samples to keep for spread percentile
  latencyWindowSize: number;  // Number of samples to keep for latency
  regimeAtrPeriod: number;    // ATR period for regime detection
  regimeAtrThreshold: number; // ADX threshold for trend vs chop
}

export interface RealTimeMetrics {
  wsLatencyMs: number;
  restLatencyMs: number;
  spreadPctile: number;
  regime: 'trend' | 'chop';
  spreadBps: number;          // Current spread in basis points
  atr: number;                // Current ATR value
}

/**
 * MetricsTracker calculates real-time trading metrics from market data.
 */
export class MetricsTracker extends EventEmitter {
  private config: MetricsTrackerConfig;
  private logger: Logger;
  
  // Latency tracking
  private wsLatencyHistory: number[] = [];
  private restLatencyHistory: number[] = [];
  private lastWsPingTime = 0;
  
  // Spread tracking
  private spreadHistory: number[] = [];
  private lastBid: Map<string, number> = new Map();
  private lastAsk: Map<string, number> = new Map();
  
  // Regime tracking
  private candles: Map<string, OHLCV[]> = new Map();
  private regimeCache: 'trend' | 'chop' = 'chop';
  
  constructor(config: Partial<MetricsTrackerConfig>, logger: Logger) {
    super();
    this.config = {
      spreadWindowSize: 100,
      latencyWindowSize: 50,
      regimeAtrPeriod: 14,
      regimeAtrThreshold: 0.015, // 1.5% ATR = trend
      ...config,
    };
    this.logger = logger;
  }
  
  /**
   * Record WebSocket ping/pong latency.
   */
  public recordWsLatency(latencyMs: number): void {
    this.wsLatencyHistory.push(latencyMs);
    if (this.wsLatencyHistory.length > this.config.latencyWindowSize) {
      this.wsLatencyHistory.shift();
    }
  }
  
  /**
   * Record REST API latency.
   */
  public recordRestLatency(latencyMs: number): void {
    this.restLatencyHistory.push(latencyMs);
    if (this.restLatencyHistory.length > this.config.latencyWindowSize) {
      this.restLatencyHistory.shift();
    }
  }
  
  /**
   * Start tracking WS latency (call before sending ping).
   */
  public startWsPing(): void {
    this.lastWsPingTime = Date.now();
  }
  
  /**
   * End tracking WS latency (call when pong received).
   */
  public endWsPing(): void {
    if (this.lastWsPingTime > 0) {
      const latency = Date.now() - this.lastWsPingTime;
      this.recordWsLatency(latency);
      this.lastWsPingTime = 0;
    }
  }
  
  /**
   * Update bid/ask prices for spread calculation.
   */
  public updateOrderbook(symbol: string, bestBid: number, bestAsk: number): void {
    this.lastBid.set(symbol, bestBid);
    this.lastAsk.set(symbol, bestAsk);
    
    // Calculate spread in basis points
    const midPrice = (bestBid + bestAsk) / 2;
    const spreadBps = ((bestAsk - bestBid) / midPrice) * 10000;
    
    this.spreadHistory.push(spreadBps);
    if (this.spreadHistory.length > this.config.spreadWindowSize) {
      this.spreadHistory.shift();
    }
  }
  
  /**
   * Update with ticker data (can estimate spread from last trade).
   */
  public updateFromTicker(symbol: string, price: number, bidPrice?: number, askPrice?: number): void {
    if (bidPrice !== undefined && askPrice !== undefined) {
      this.updateOrderbook(symbol, bidPrice, askPrice);
    }
  }
  
  /**
   * Add candle for regime detection.
   */
  public addCandle(symbol: string, candle: OHLCV): void {
    if (!this.candles.has(symbol)) {
      this.candles.set(symbol, []);
    }
    
    const candles = this.candles.get(symbol)!;
    candles.push(candle);
    
    // Keep last 50 candles for regime calculation
    if (candles.length > 50) {
      candles.shift();
    }
    
    // Update regime detection
    this.updateRegime(symbol);
  }
  
  /**
   * Detect market regime based on ATR and price action.
   */
  private updateRegime(symbol: string): void {
    const candles = this.candles.get(symbol);
    if (!candles || candles.length < this.config.regimeAtrPeriod + 1) {
      return;
    }
    
    // Calculate ATR
    const atrValues = TechnicalIndicators.ATR(candles, this.config.regimeAtrPeriod);
    if (atrValues.length === 0) {
      return;
    }
    
    const currentAtr = atrValues[atrValues.length - 1];
    const currentPrice = candles[candles.length - 1].close;
    const atrPercent = currentAtr / currentPrice;
    
    // Simple regime detection: high ATR = trend, low ATR = chop
    // Also check price direction consistency
    const recentCandles = candles.slice(-10);
    let upMoves = 0;
    let downMoves = 0;
    
    for (let i = 1; i < recentCandles.length; i++) {
      if (recentCandles[i].close > recentCandles[i - 1].close) {
        upMoves++;
      } else {
        downMoves++;
      }
    }
    
    const directionRatio = Math.max(upMoves, downMoves) / recentCandles.length;
    
    // Trend: high ATR AND consistent direction
    // Chop: low ATR OR inconsistent direction
    if (atrPercent > this.config.regimeAtrThreshold && directionRatio > 0.6) {
      this.regimeCache = 'trend';
    } else {
      this.regimeCache = 'chop';
    }
  }
  
  /**
   * Calculate percentile of spread values.
   */
  private calculateSpreadPercentile(): number {
    if (this.spreadHistory.length === 0) {
      return 50; // Default to median
    }
    
    const sorted = [...this.spreadHistory].sort((a, b) => a - b);
    const currentSpread = sorted[sorted.length - 1];
    
    // Find rank of current spread
    const rank = sorted.filter(s => s <= currentSpread).length;
    return Math.round((rank / sorted.length) * 100);
  }
  
  /**
   * Calculate average latency.
   */
  private calculateAverageLatency(history: number[]): number {
    if (history.length === 0) {
      return 0;
    }
    return Math.round(history.reduce((a, b) => a + b, 0) / history.length);
  }
  
  /**
   * Get current real-time metrics.
   */
  public getMetrics(): RealTimeMetrics {
    const spreadBps = this.spreadHistory.length > 0 
      ? this.spreadHistory[this.spreadHistory.length - 1] 
      : 0;
    
    // Get ATR from first symbol with data
    let atr = 0;
    for (const [symbol, candles] of this.candles) {
      if (candles.length >= this.config.regimeAtrPeriod + 1) {
        const atrValues = TechnicalIndicators.ATR(candles, this.config.regimeAtrPeriod);
        if (atrValues.length > 0) {
          atr = atrValues[atrValues.length - 1];
          break;
        }
      }
    }
    
    return {
      wsLatencyMs: this.calculateAverageLatency(this.wsLatencyHistory),
      restLatencyMs: this.calculateAverageLatency(this.restLatencyHistory),
      spreadPctile: this.calculateSpreadPercentile(),
      regime: this.regimeCache,
      spreadBps,
      atr,
    };
  }
}
