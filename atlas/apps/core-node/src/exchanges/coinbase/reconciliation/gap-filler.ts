/**
 * Market Data Gap Filler
 * 
 * Ensures continuous candle data even when WebSocket drops.
 * Fetches missing candles via REST to keep indicators running.
 */

import { EventEmitter } from 'events';
import { Counter, Gauge } from 'prom-client';
import { Logger } from '../../../core/logger';
import { Candle, Granularity, HistoricRatesParams } from '../types';

// Prometheus metrics
const gapFillRunsTotal = new Counter({
  name: 'coinbase_gapfill_runs_total',
  help: 'Total number of gap fill runs',
  labelNames: ['symbol', 'timeframe', 'status'],
});

const gapFillCandlesTotal = new Counter({
  name: 'coinbase_gapfill_candles_total',
  help: 'Total number of candles filled via REST',
  labelNames: ['symbol', 'timeframe'],
});

const lastMarketDataGauge = new Gauge({
  name: 'coinbase_last_market_data_timestamp',
  help: 'Timestamp of last market data received',
  labelNames: ['symbol', 'type'],
});

/**
 * Gap filler configuration
 */
export interface GapFillerConfig {
  /** Stale threshold before triggering gap fill (ms) */
  staleThresholdMs: number;
  /** Maximum candles to fetch per gap fill */
  maxCandlesPerFill: number;
  /** Check interval for staleness (ms) */
  checkIntervalMs: number;
  /** Granularity mappings (timeframe name -> seconds) */
  granularityMap: Record<string, number>;
}

/**
 * Symbol/timeframe tracking
 */
interface MarketDataTracker {
  symbol: string;
  timeframe: string;
  granularity: number;
  lastCandleAt: number;
  lastTickAt: number;
  candleBuffer: Candle[];
  maxBufferSize: number;
}

/**
 * Interface for REST client methods we need
 */
export interface GapFillerRestClient {
  getProductCandles(productId: string, params: HistoricRatesParams): Promise<Candle[]>;
}

/**
 * Default configuration
 */
export const DEFAULT_GAP_FILLER_CONFIG: GapFillerConfig = {
  staleThresholdMs: 30000, // 30 seconds
  maxCandlesPerFill: 300,
  checkIntervalMs: 5000, // 5 seconds
  granularityMap: {
    '1m': 60,
    '5m': 300,
    '15m': 900,
    '1h': 3600,
    '6h': 21600,
    '1d': 86400,
  },
};

/**
 * Market Data Gap Filler
 * 
 * Monitors market data freshness and fills gaps via REST when WebSocket
 * data becomes stale. Ensures indicators continue to receive candles.
 */
export class MarketDataGapFiller extends EventEmitter {
  private config: GapFillerConfig;
  private logger: Logger;
  private restClient: GapFillerRestClient;

  // Tracking per symbol/timeframe
  private trackers: Map<string, MarketDataTracker> = new Map();
  
  // State
  private running = false;
  private checkTimer: NodeJS.Timeout | null = null;

  constructor(
    config: Partial<GapFillerConfig>,
    logger: Logger,
    restClient: GapFillerRestClient
  ) {
    super();
    this.config = { ...DEFAULT_GAP_FILLER_CONFIG, ...config };
    this.logger = logger;
    this.restClient = restClient;
  }

  /**
   * Start gap filler monitoring
   */
  public start(): void {
    if (this.running) {
      return;
    }

    this.running = true;
    this.logger.info('Starting market data gap filler', {
      staleThresholdMs: this.config.staleThresholdMs,
      checkIntervalMs: this.config.checkIntervalMs,
    });

    this.checkTimer = setInterval(() => {
      this.checkForStaleData();
    }, this.config.checkIntervalMs);
  }

  /**
   * Stop gap filler monitoring
   */
  public stop(): void {
    this.running = false;
    
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = null;
    }

    this.logger.info('Market data gap filler stopped');
  }

  /**
   * Register a symbol/timeframe for monitoring
   */
  public register(
    symbol: string,
    timeframe: string,
    maxBufferSize: number = 1000
  ): void {
    const key = this.getKey(symbol, timeframe);
    
    if (this.trackers.has(key)) {
      return;
    }

    const granularity = this.config.granularityMap[timeframe];
    if (!granularity) {
      this.logger.warn(`Unknown timeframe: ${timeframe}`);
      return;
    }

    this.trackers.set(key, {
      symbol,
      timeframe,
      granularity,
      lastCandleAt: 0,
      lastTickAt: 0,
      candleBuffer: [],
      maxBufferSize,
    });

    this.logger.info('Registered symbol for gap filling', { symbol, timeframe });
  }

  /**
   * Unregister a symbol/timeframe
   */
  public unregister(symbol: string, timeframe: string): void {
    const key = this.getKey(symbol, timeframe);
    this.trackers.delete(key);
  }

  /**
   * Record a tick (used to detect WS liveness)
   */
  public recordTick(symbol: string, timestamp?: number): void {
    const now = timestamp || Date.now();
    
    // Update all trackers for this symbol
    for (const [key, tracker] of this.trackers) {
      if (tracker.symbol === symbol) {
        tracker.lastTickAt = now;
        lastMarketDataGauge.set({ symbol, type: 'tick' }, now);
      }
    }
  }

  /**
   * Record a candle from WebSocket
   */
  public recordCandle(
    symbol: string,
    timeframe: string,
    candle: Candle
  ): void {
    const key = this.getKey(symbol, timeframe);
    const tracker = this.trackers.get(key);
    
    if (!tracker) {
      return;
    }

    tracker.lastCandleAt = Date.now();
    lastMarketDataGauge.set({ symbol, type: `candle_${timeframe}` }, tracker.lastCandleAt);

    // Add to buffer (dedupe by timestamp)
    const existingIdx = tracker.candleBuffer.findIndex(c => c.time === candle.time);
    if (existingIdx === -1) {
      tracker.candleBuffer.push(candle);
      
      // Sort by time
      tracker.candleBuffer.sort((a, b) => a.time - b.time);
      
      // Trim buffer
      if (tracker.candleBuffer.length > tracker.maxBufferSize) {
        tracker.candleBuffer = tracker.candleBuffer.slice(-tracker.maxBufferSize);
      }
    } else {
      // Update existing candle (in case of updates)
      tracker.candleBuffer[existingIdx] = candle;
    }
  }

  /**
   * Get candle buffer for a symbol/timeframe
   */
  public getBuffer(symbol: string, timeframe: string): Candle[] {
    const key = this.getKey(symbol, timeframe);
    const tracker = this.trackers.get(key);
    return tracker ? [...tracker.candleBuffer] : [];
  }

  /**
   * Check for stale data and trigger gap fills
   */
  private async checkForStaleData(): Promise<void> {
    const now = Date.now();

    for (const [key, tracker] of this.trackers) {
      const candleAge = now - tracker.lastCandleAt;
      
      // Skip if not registered long enough
      if (tracker.lastCandleAt === 0) {
        continue;
      }

      // Check if candle data is stale
      if (candleAge > this.config.staleThresholdMs) {
        this.logger.warn('Stale market data detected, triggering gap fill', {
          symbol: tracker.symbol,
          timeframe: tracker.timeframe,
          candleAgeMs: candleAge,
          threshold: this.config.staleThresholdMs,
        });

        try {
          await this.fillGap(tracker);
        } catch (error) {
          this.logger.error('Gap fill failed', {
            symbol: tracker.symbol,
            timeframe: tracker.timeframe,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
  }

  /**
   * Fill gap for a tracker via REST
   */
  private async fillGap(tracker: MarketDataTracker): Promise<number> {
    gapFillRunsTotal.inc({
      symbol: tracker.symbol,
      timeframe: tracker.timeframe,
      status: 'started',
    });

    try {
      // Calculate time range to fetch
      const now = Math.floor(Date.now() / 1000);
      const lastCandle = tracker.candleBuffer.length > 0
        ? tracker.candleBuffer[tracker.candleBuffer.length - 1]
        : null;
      
      const startTime = lastCandle 
        ? lastCandle.time + tracker.granularity
        : now - (this.config.maxCandlesPerFill * tracker.granularity);

      // Fetch candles from REST
      const candles = await this.restClient.getProductCandles(tracker.symbol, {
        granularity: tracker.granularity as Granularity,
        start: new Date(startTime * 1000).toISOString(),
        end: new Date(now * 1000).toISOString(),
      });

      if (candles.length === 0) {
        gapFillRunsTotal.inc({
          symbol: tracker.symbol,
          timeframe: tracker.timeframe,
          status: 'no_data',
        });
        return 0;
      }

      // Process and dedupe candles
      let newCandles = 0;
      const existingTimes = new Set(tracker.candleBuffer.map(c => c.time));

      for (const candle of candles) {
        if (!existingTimes.has(candle.time)) {
          tracker.candleBuffer.push(candle);
          newCandles++;
        }
      }

      // Sort and trim buffer
      tracker.candleBuffer.sort((a, b) => a.time - b.time);
      if (tracker.candleBuffer.length > tracker.maxBufferSize) {
        tracker.candleBuffer = tracker.candleBuffer.slice(-tracker.maxBufferSize);
      }

      // Update last candle time
      tracker.lastCandleAt = Date.now();

      this.logger.info('gapfill_applied', {
        symbol: tracker.symbol,
        timeframe: tracker.timeframe,
        candlesFetched: candles.length,
        newCandles,
        bufferSize: tracker.candleBuffer.length,
      });

      gapFillRunsTotal.inc({
        symbol: tracker.symbol,
        timeframe: tracker.timeframe,
        status: 'success',
      });

      gapFillCandlesTotal.inc(
        { symbol: tracker.symbol, timeframe: tracker.timeframe },
        newCandles
      );

      // Emit event for consumers
      this.emit('gapfill:applied', {
        symbol: tracker.symbol,
        timeframe: tracker.timeframe,
        newCandles,
        candles: candles.filter(c => !existingTimes.has(c.time)),
      });

      return newCandles;
    } catch (error) {
      gapFillRunsTotal.inc({
        symbol: tracker.symbol,
        timeframe: tracker.timeframe,
        status: 'error',
      });
      throw error;
    }
  }

  /**
   * Force gap fill for a symbol/timeframe
   */
  public async forceGapFill(symbol: string, timeframe: string): Promise<number> {
    const key = this.getKey(symbol, timeframe);
    const tracker = this.trackers.get(key);
    
    if (!tracker) {
      throw new Error(`No tracker registered for ${symbol}/${timeframe}`);
    }

    return this.fillGap(tracker);
  }

  /**
   * Get status of all tracked symbols
   */
  public getStatus(): Array<{
    symbol: string;
    timeframe: string;
    lastCandleAt: number;
    lastTickAt: number;
    bufferSize: number;
    isStale: boolean;
    staleMs: number;
  }> {
    const now = Date.now();
    
    return Array.from(this.trackers.values()).map(tracker => ({
      symbol: tracker.symbol,
      timeframe: tracker.timeframe,
      lastCandleAt: tracker.lastCandleAt,
      lastTickAt: tracker.lastTickAt,
      bufferSize: tracker.candleBuffer.length,
      isStale: tracker.lastCandleAt > 0 && 
               (now - tracker.lastCandleAt) > this.config.staleThresholdMs,
      staleMs: tracker.lastCandleAt > 0 ? now - tracker.lastCandleAt : 0,
    }));
  }

  /**
   * Check if any data is stale
   */
  public hasStaleData(): boolean {
    const now = Date.now();
    
    for (const tracker of this.trackers.values()) {
      if (tracker.lastCandleAt > 0 && 
          (now - tracker.lastCandleAt) > this.config.staleThresholdMs) {
        return true;
      }
    }
    
    return false;
  }

  private getKey(symbol: string, timeframe: string): string {
    return `${symbol}:${timeframe}`;
  }
}
