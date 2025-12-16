import { EventEmitter } from 'events';
import { Logger } from '../core/logger';
import { TechnicalIndicators, OHLCV } from '../indicators/technical';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { v4 as uuidv4 } from 'uuid';

export interface SignalProcessorConfig {
  supabaseUrl: string;
  supabaseKey: string;
  strategies: {
    breakout: BreakoutConfig;
    vwapMeanReversion: VWAPConfig;
    momentum: MomentumConfig;
  };
  metaLabeling: {
    enabled: boolean;
    modelPath?: string;
    threshold: number;
  };
}

export interface BreakoutConfig {
  enabled: boolean;
  period: number;        // Donchian channel period
  atrPeriod: number;     // ATR period for stops
  atrMultiplier: number; // ATR multiplier for stop distance
  volumeThreshold: number; // Volume must be X% above average
}

export interface VWAPConfig {
  enabled: boolean;
  deviationEntry: number;  // Standard deviations from VWAP for entry
  deviationExit: number;   // Standard deviations for exit
  minVolume: number;       // Minimum volume requirement
}

export interface MomentumConfig {
  enabled: boolean;
  rsiPeriod: number;
  rsiOverbought: number;
  rsiOversold: number;
  macdFast: number;
  macdSlow: number;
  macdSignal: number;
}

export interface Signal {
  id: string;
  timestamp: Date;
  symbol: string;
  strategy: 'breakout' | 'vwap_mr' | 'momentum';
  direction: 'buy' | 'sell';
  strength: number; // 0-1 confidence score
  price: number;
  stopLoss: number;
  takeProfit: number;
  metaLabel?: number; // ML prediction if enabled
  metadata: {
    indicators: Record<string, number>;
    reason: string;
  };
}

export interface SignalProcessorEvents {
  'signal:generated': (signal: Signal) => void;
  'signal:filtered': (signal: Signal, reason: string) => void;
  'indicator:update': (symbol: string, indicators: Record<string, number>) => void;
  'warmup:progress': (symbol: string, candlesLoaded: number, required: number) => void;
  'warmup:complete': (symbol: string) => void;
}

// Warmup configuration
const WARMUP_CONFIG = {
  minCandlesRequired: 50,  // Minimum candles needed before generating signals
  defaultHistoricalLimit: 200, // Default number of historical candles to fetch
};

// Multi-timeframe candle storage
type TimeframeKey = '1m' | '5m' | '15m' | '1h';

interface MultiTimeframeCandles {
  '1m': OHLCV[];
  '5m': OHLCV[];
  '15m': OHLCV[];
  '1h': OHLCV[];
}

export class SignalProcessor extends EventEmitter {
  private config: SignalProcessorConfig;
  private logger: Logger;
  private supabase: SupabaseClient;
  private candles: Map<string, OHLCV[]> = new Map();
  private indicators: Map<string, Record<string, number[]>> = new Map();
  private lastSignals: Map<string, Signal> = new Map();
  
  // Multi-timeframe candle storage
  private mtfCandles: Map<string, MultiTimeframeCandles> = new Map();
  
  // Warmup state tracking
  private warmupComplete: Map<string, boolean> = new Map();
  private dataLoader: ((symbol: string, limit: number) => Promise<OHLCV[]>) | null = null;

  constructor(config: SignalProcessorConfig, logger: Logger) {
    super();
    this.config = config;
    this.logger = logger;
    this.supabase = createClient(config.supabaseUrl, config.supabaseKey);
  }
  
  /**
   * Initialize multi-timeframe candle storage for a symbol.
   */
  private initMtfCandles(symbol: string): MultiTimeframeCandles {
    if (!this.mtfCandles.has(symbol)) {
      this.mtfCandles.set(symbol, {
        '1m': [],
        '5m': [],
        '15m': [],
        '1h': [],
      });
    }
    return this.mtfCandles.get(symbol)!;
  }
  
  /**
   * Get 5-minute candles for a symbol.
   */
  public get5mCandles(symbol: string): OHLCV[] {
    return this.mtfCandles.get(symbol)?.['5m'] || [];
  }
  
  /**
   * Get 15-minute candles for a symbol.
   */
  public get15mCandles(symbol: string): OHLCV[] {
    return this.mtfCandles.get(symbol)?.['15m'] || [];
  }
  
  /**
   * Get 1-hour candles for a symbol.
   */
  public get1hCandles(symbol: string): OHLCV[] {
    return this.mtfCandles.get(symbol)?.['1h'] || [];
  }
  
  /**
   * Aggregate 1-minute candles into higher timeframe.
   */
  private aggregateToTimeframe(
    oneMinCandles: OHLCV[],
    periodMinutes: number,
    maxBars: number = 200
  ): OHLCV[] {
    if (oneMinCandles.length === 0) {
      return [];
    }
    
    const result: OHLCV[] = [];
    const periodMs = periodMinutes * 60 * 1000;
    
    // Group candles by time period
    const groups: Map<number, OHLCV[]> = new Map();
    
    for (const candle of oneMinCandles) {
      // Floor to period boundary
      const periodStart = Math.floor(candle.time / periodMs) * periodMs;
      
      if (!groups.has(periodStart)) {
        groups.set(periodStart, []);
      }
      groups.get(periodStart)!.push(candle);
    }
    
    // Aggregate each group
    const sortedPeriods = Array.from(groups.keys()).sort((a, b) => a - b);
    
    for (const periodStart of sortedPeriods) {
      const groupCandles = groups.get(periodStart)!;
      if (groupCandles.length === 0) continue;
      
      // Sort by time within group
      groupCandles.sort((a, b) => a.time - b.time);
      
      const aggregated: OHLCV = {
        time: periodStart,
        open: groupCandles[0].open,
        high: Math.max(...groupCandles.map(c => c.high)),
        low: Math.min(...groupCandles.map(c => c.low)),
        close: groupCandles[groupCandles.length - 1].close,
        volume: groupCandles.reduce((sum, c) => sum + c.volume, 0),
      };
      
      result.push(aggregated);
    }
    
    // Keep only the most recent bars
    return result.slice(-maxBars);
  }
  
  /**
   * Update multi-timeframe candles after adding a 1-minute candle.
   */
  private updateMultiTimeframeCandles(symbol: string): void {
    const mtf = this.initMtfCandles(symbol);
    const oneMinCandles = this.candles.get(symbol) || [];
    
    // Update 1m storage
    mtf['1m'] = oneMinCandles.slice(-500);
    
    // Aggregate higher timeframes
    mtf['5m'] = this.aggregateToTimeframe(oneMinCandles, 5, 200);
    mtf['15m'] = this.aggregateToTimeframe(oneMinCandles, 15, 200);
    mtf['1h'] = this.aggregateToTimeframe(oneMinCandles, 60, 200);
  }
  
  /**
   * Check higher timeframe trend filter.
   * Returns true if trade direction aligns with higher timeframe trend.
   */
  public checkTimeframeFilter(symbol: string, direction: 'buy' | 'sell'): boolean {
    const hourlyCandles = this.get1hCandles(symbol);
    if (hourlyCandles.length < 10) {
      // Not enough data, allow trade
      return true;
    }
    
    // Calculate 10-period EMA on hourly
    const closes = hourlyCandles.map(c => c.close);
    const ema = TechnicalIndicators.EMA(closes, 10);
    
    if (ema.length < 2) {
      return true;
    }
    
    const currentEma = ema[ema.length - 1];
    const prevEma = ema[ema.length - 2];
    const currentPrice = closes[closes.length - 1];
    
    // Trend is up if price above EMA and EMA rising
    const trendUp = currentPrice > currentEma && currentEma > prevEma;
    const trendDown = currentPrice < currentEma && currentEma < prevEma;
    
    // Only allow trades in direction of higher timeframe trend
    if (direction === 'buy') {
      return trendUp || !trendDown; // Allow if not clearly down
    } else {
      return trendDown || !trendUp; // Allow if not clearly up
    }
  }
  
  /**
   * Set a custom data loader for historical candles.
   * This allows the trading engine to inject exchange-specific loading.
   */
  public setDataLoader(loader: (symbol: string, limit: number) => Promise<OHLCV[]>): void {
    this.dataLoader = loader;
  }
  
  /**
   * Get the number of candles buffered for a symbol.
   */
  public getCandleCount(symbol: string): number {
    return this.candles.get(symbol)?.length || 0;
  }
  
  /**
   * Get candle counts for all symbols.
   */
  public getAllCandleCounts(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const [symbol, candles] of this.candles) {
      counts[symbol] = candles.length;
    }
    return counts;
  }
  
  /**
   * Check if warmup is complete for a symbol.
   */
  public isWarmupComplete(symbol: string): boolean {
    return this.warmupComplete.get(symbol) || false;
  }
  
  /**
   * Check if warmup is complete for all tracked symbols.
   */
  public isAllWarmedUp(): boolean {
    if (this.warmupComplete.size === 0) {
      return false;
    }
    for (const complete of this.warmupComplete.values()) {
      if (!complete) {
        return false;
      }
    }
    return true;
  }

  // Add new candle data from live feed
  public addCandle(symbol: string, candle: OHLCV): void {
    this.logger.debug(`Signal processor: ${symbol} receiving candle, current count: ${this.getCandleCount(symbol)}`);
    
    // Use internal method, don't skip signals (this is live data)
    this.addCandleInternal(symbol, candle, false);
  }

  private updateIndicators(symbol: string): void {
    const candles = this.candles.get(symbol);
    if (!candles || candles.length < 50) {
      return; // Not enough data
    }

    const closes = candles.map(c => c.close);
    const indicators: Record<string, number[]> = {};

    // Calculate all indicators
    const breakoutCfg = this.config.strategies.breakout;
    const donchianPeriod = breakoutCfg?.period ?? 20;
    const atrPeriod = breakoutCfg?.atrPeriod ?? 14;
    indicators.sma20 = TechnicalIndicators.SMA(closes, 20);
    indicators.sma50 = TechnicalIndicators.SMA(closes, 50);
    indicators.ema12 = TechnicalIndicators.EMA(closes, 12);
    indicators.ema26 = TechnicalIndicators.EMA(closes, 26);
    indicators.rsi = TechnicalIndicators.RSI(closes, 14);
    
    const macd = TechnicalIndicators.MACD(closes);
    indicators.macd = macd.macd;
    indicators.macdSignal = macd.signal;
    indicators.macdHistogram = macd.histogram;

    const bb = TechnicalIndicators.BollingerBands(closes, 20, 2);
    indicators.bbUpper = bb.upper;
    indicators.bbMiddle = bb.middle;
    indicators.bbLower = bb.lower;

    indicators.vwap = TechnicalIndicators.VWAP(candles);
    indicators.atr = TechnicalIndicators.ATR(candles, atrPeriod);

    const donchian = TechnicalIndicators.DonchianChannels(candles, donchianPeriod);
    indicators.donchianUpper = donchian.upper;
    indicators.donchianLower = donchian.lower;
    indicators.donchianMiddle = donchian.middle;

    // Calculate volume average
    const volumes = candles.map(c => c.volume);
    indicators.volumeSMA = TechnicalIndicators.SMA(volumes, 20);

    this.indicators.set(symbol, indicators);

    // Emit latest values
    const latestIndicators: Record<string, number> = {};
    for (const [key, values] of Object.entries(indicators)) {
      if (values.length > 0) {
        latestIndicators[key] = values[values.length - 1];
      }
    }
    this.emit('indicator:update', symbol, latestIndicators);
  }

  private checkSignals(symbol: string): void {
    const candles = this.candles.get(symbol);
    const indicators = this.indicators.get(symbol);

    if (!candles || !indicators || candles.length < 50) {
      return;
    }

    const latestCandle = candles[candles.length - 1];
    const previousCandle = candles[candles.length - 2];

    // Check each strategy
    if (this.config.strategies.breakout.enabled) {
      this.checkBreakoutSignal(symbol, candles, indicators, latestCandle);
    }

    if (this.config.strategies.vwapMeanReversion.enabled) {
      this.checkVWAPSignal(symbol, candles, indicators, latestCandle);
    }

    if (this.config.strategies.momentum.enabled) {
      this.checkMomentumSignal(symbol, candles, indicators, latestCandle);
    }
  }

  private checkBreakoutSignal(
    symbol: string,
    candles: OHLCV[],
    indicators: Record<string, number[]>,
    latestCandle: OHLCV
  ): void {
    const config = this.config.strategies.breakout;
    const donchianUpper = indicators.donchianUpper;
    const donchianLower = indicators.donchianLower;
    const atr = indicators.atr;
    const volumeSMA = indicators.volumeSMA;

    if (!donchianUpper || !donchianLower || !atr || !volumeSMA) {
      return;
    }

    // Use previous-period highs/lows to avoid self-referencing current candle
    const prevUpper = donchianUpper.length > 1 ? donchianUpper[donchianUpper.length - 2] : undefined;
    const prevLower = donchianLower.length > 1 ? donchianLower[donchianLower.length - 2] : undefined;
    const currentATR = atr[atr.length - 1];
    const avgVolume = volumeSMA[volumeSMA.length - 1];

    if (!prevUpper || !prevLower || !Number.isFinite(prevUpper) || !Number.isFinite(prevLower)) {
      return;
    }

    // Volume filter
    const volumeRatio = latestCandle.volume / avgVolume;
    if (!Number.isFinite(volumeRatio) || volumeRatio < config.volumeThreshold) {
      this.logger.debug('Breakout filtered by volume', { symbol, volumeRatio, threshold: config.volumeThreshold });
      return;
    }

    // Check for breakout
    let signal: Signal | null = null;

    if (latestCandle.close > prevUpper && latestCandle.volume > avgVolume * config.volumeThreshold) {
      // Bullish breakout
      signal = {
        id: uuidv4(),
        timestamp: new Date(),
        symbol,
        strategy: 'breakout',
        direction: 'buy',
        strength: Math.min(volumeRatio / 2, 1), // Higher volume = stronger signal
        price: latestCandle.close,
        stopLoss: latestCandle.close - (currentATR * config.atrMultiplier),
        takeProfit: latestCandle.close + (currentATR * config.atrMultiplier * 2),
        metadata: {
          indicators: {
            donchianUpper: prevUpper,
            atr: currentATR,
            volumeRatio
          },
          reason: `Price broke above ${config.period}-period high with ${volumeRatio.toFixed(2)}x volume`
        }
      };
    } else if (latestCandle.close < prevLower && latestCandle.volume > avgVolume * config.volumeThreshold) {
      // Bearish breakout
      signal = {
        id: uuidv4(),
        timestamp: new Date(),
        symbol,
        strategy: 'breakout',
        direction: 'sell',
        strength: Math.min(volumeRatio / 2, 1),
        price: latestCandle.close,
        stopLoss: latestCandle.close + (currentATR * config.atrMultiplier),
        takeProfit: latestCandle.close - (currentATR * config.atrMultiplier * 2),
        metadata: {
          indicators: {
            donchianLower: prevLower,
            atr: currentATR,
            volumeRatio
          },
          reason: `Price broke below ${config.period}-period low with ${volumeRatio.toFixed(2)}x volume`
        }
      };
    }

    if (signal) {
      this.processSignal(signal);
    } else {
      this.logger.debug('No breakout signal', {
        symbol,
        close: latestCandle.close,
        prevUpper,
        prevLower,
        volumeRatio
      });
    }
  }

  private checkVWAPSignal(
    symbol: string,
    candles: OHLCV[],
    indicators: Record<string, number[]>,
    latestCandle: OHLCV
  ): void {
    const config = this.config.strategies.vwapMeanReversion;
    const vwap = indicators.vwap;
    const closes = candles.map(c => c.close);

    if (!vwap || vwap.length < 20) {
      return;
    }

    const currentVWAP = vwap[vwap.length - 1];
    const currentPrice = latestCandle.close;

    // Calculate standard deviation from VWAP
    const vwapStdDev = this.calculateVWAPStdDev(candles, vwap);
    const deviation = (currentPrice - currentVWAP) / vwapStdDev;

    // Volume filter
    if (latestCandle.volume < config.minVolume) {
      return;
    }

    let signal: Signal | null = null;

    if (deviation < -config.deviationEntry) {
      // Price significantly below VWAP - potential long
      signal = {
        id: uuidv4(),
        timestamp: new Date(),
        symbol,
        strategy: 'vwap_mr',
        direction: 'buy',
        strength: Math.min(Math.abs(deviation) / 3, 1),
        price: currentPrice,
        stopLoss: currentPrice - vwapStdDev,
        takeProfit: currentVWAP,
        metadata: {
          indicators: {
            vwap: currentVWAP,
            deviation,
            stdDev: vwapStdDev
          },
          reason: `Price ${Math.abs(deviation).toFixed(2)} std devs below VWAP`
        }
      };
    } else if (deviation > config.deviationEntry) {
      // Price significantly above VWAP - potential short
      signal = {
        id: uuidv4(),
        timestamp: new Date(),
        symbol,
        strategy: 'vwap_mr',
        direction: 'sell',
        strength: Math.min(Math.abs(deviation) / 3, 1),
        price: currentPrice,
        stopLoss: currentPrice + vwapStdDev,
        takeProfit: currentVWAP,
        metadata: {
          indicators: {
            vwap: currentVWAP,
            deviation,
            stdDev: vwapStdDev
          },
          reason: `Price ${Math.abs(deviation).toFixed(2)} std devs above VWAP`
        }
      };
    }

    if (signal) {
      this.processSignal(signal);
    }
  }

  private checkMomentumSignal(
    symbol: string,
    candles: OHLCV[],
    indicators: Record<string, number[]>,
    latestCandle: OHLCV
  ): void {
    const config = this.config.strategies.momentum;
    const rsi = indicators.rsi;
    const macdHistogram = indicators.macdHistogram;
    const ema12 = indicators.ema12;
    const ema26 = indicators.ema26;

    if (!rsi || rsi.length < 2 || !macdHistogram || macdHistogram.length < 2 || !ema12 || ema12.length === 0 || !ema26 || ema26.length === 0) {
      return;
    }

    const currentRSI = rsi[rsi.length - 1];
    const previousRSI = rsi[rsi.length - 2];
    const currentMACD = macdHistogram[macdHistogram.length - 1];
    const previousMACD = macdHistogram[macdHistogram.length - 2];

    let signal: Signal | null = null;

    // Bullish momentum
    if (currentRSI > config.rsiOversold && 
        previousRSI <= config.rsiOversold &&
        currentMACD > previousMACD &&
        ema12[ema12.length - 1] > ema26[ema26.length - 1]) {
      
      signal = {
        id: uuidv4(),
        timestamp: new Date(),
        symbol,
        strategy: 'momentum',
        direction: 'buy',
        strength: (currentRSI - config.rsiOversold) / (50 - config.rsiOversold),
        price: latestCandle.close,
        stopLoss: latestCandle.close * 0.98, // 2% stop
        takeProfit: latestCandle.close * 1.03, // 3% target
        metadata: {
          indicators: {
            rsi: currentRSI,
            macdHistogram: currentMACD
          },
          reason: `RSI bounced from oversold with positive MACD momentum`
        }
      };
    }
    // Bearish momentum
    else if (currentRSI < config.rsiOverbought && 
             previousRSI >= config.rsiOverbought &&
             currentMACD < previousMACD &&
             ema12[ema12.length - 1] < ema26[ema26.length - 1]) {
      
      signal = {
        id: uuidv4(),
        timestamp: new Date(),
        symbol,
        strategy: 'momentum',
        direction: 'sell',
        strength: (config.rsiOverbought - currentRSI) / (config.rsiOverbought - 50),
        price: latestCandle.close,
        stopLoss: latestCandle.close * 1.02, // 2% stop
        takeProfit: latestCandle.close * 0.97, // 3% target
        metadata: {
          indicators: {
            rsi: currentRSI,
            macdHistogram: currentMACD
          },
          reason: `RSI dropped from overbought with negative MACD momentum`
        }
      };
    }

    if (signal) {
      this.processSignal(signal);
    }
  }

  private calculateVWAPStdDev(candles: OHLCV[], vwap: number[]): number {
    const recentCandles = candles.slice(-20);
    const recentVWAP = vwap.slice(-20);
    
    if (recentCandles.length !== recentVWAP.length) {
      return 0;
    }

    let sumSquaredDiff = 0;
    for (let i = 0; i < recentCandles.length; i++) {
      const diff = recentCandles[i].close - recentVWAP[i];
      sumSquaredDiff += diff * diff;
    }

    return Math.sqrt(sumSquaredDiff / recentCandles.length);
  }

  private async processSignal(signal: Signal): Promise<void> {
    // Check if we recently generated a similar signal
    const lastSignal = this.lastSignals.get(signal.symbol);
    if (lastSignal && 
        lastSignal.strategy === signal.strategy &&
        lastSignal.direction === signal.direction &&
        Date.now() - lastSignal.timestamp.getTime() < 300000) { // 5 minutes
      this.emit('signal:filtered', signal, 'Too soon after previous signal');
      return;
    }

    // Apply meta-labeling if enabled
    if (this.config.metaLabeling.enabled) {
      const metaLabel = await this.applyMetaLabeling(signal);
      signal.metaLabel = metaLabel;

      if (metaLabel < this.config.metaLabeling.threshold) {
        this.emit('signal:filtered', signal, `Meta-label below threshold: ${metaLabel.toFixed(3)}`);
        return;
      }
    }

    // Store signal
    this.lastSignals.set(signal.symbol, signal);

    // Emit signal
    this.emit('signal:generated', signal);
    this.logger.info('Signal generated', {
      symbol: signal.symbol,
      strategy: signal.strategy,
      direction: signal.direction,
      strength: signal.strength,
      metaLabel: signal.metaLabel
    });
  }

  private async applyMetaLabeling(signal: Signal): Promise<number> {
    // TODO: Implement ONNX model inference
    // For now, return a mock score based on signal strength
    return signal.strength * 0.8 + Math.random() * 0.2;
  }

  /**
   * Load historical candles for a symbol and feed them through the pipeline.
   * This warms up indicators so signals can be generated immediately.
   */
  public async loadHistoricalData(symbol: string, limit: number = WARMUP_CONFIG.defaultHistoricalLimit): Promise<void> {
    this.logger.info(`Loading historical data for ${symbol}`, { limit });
    
    // Initialize warmup state
    this.warmupComplete.set(symbol, false);
    
    try {
      let historicalCandles: OHLCV[] = [];
      
      // Try custom data loader first (injected from exchange)
      if (this.dataLoader) {
        this.logger.debug(`Using custom data loader for ${symbol}`);
        historicalCandles = await this.dataLoader(symbol, limit);
      } else {
        // Fallback: try to load from Supabase bars table
        this.logger.debug(`Attempting to load ${symbol} candles from Supabase`);
        historicalCandles = await this.loadFromSupabase(symbol, limit);
      }
      
      if (historicalCandles.length === 0) {
        this.logger.warn(`No historical data available for ${symbol}, will warm up from live data`);
        return;
      }
      
      this.logger.info(`Loaded ${historicalCandles.length} historical candles for ${symbol}`);
      
      // Sort candles by time (oldest first)
      historicalCandles.sort((a, b) => a.time - b.time);
      
      // Feed each candle through the pipeline (without generating signals during warmup)
      const skipSignals = true;
      for (const candle of historicalCandles) {
        this.addCandleInternal(symbol, candle, skipSignals);
      }
      
      // Check if warmup is complete
      const candleCount = this.getCandleCount(symbol);
      if (candleCount >= WARMUP_CONFIG.minCandlesRequired) {
        this.warmupComplete.set(symbol, true);
        this.emit('warmup:complete', symbol);
        this.logger.info(`Warmup complete for ${symbol}`, { candleCount });
      } else {
        this.emit('warmup:progress', symbol, candleCount, WARMUP_CONFIG.minCandlesRequired);
        this.logger.info(`Warmup in progress for ${symbol}`, { 
          candleCount, 
          required: WARMUP_CONFIG.minCandlesRequired 
        });
      }
      
    } catch (error) {
      this.logger.error(`Failed to load historical data for ${symbol}:`, error);
      // Don't throw - allow live data to warm up the system
    }
  }
  
  /**
   * Load historical candles from Supabase bars table.
   */
  private async loadFromSupabase(symbol: string, limit: number): Promise<OHLCV[]> {
    try {
      const { data, error } = await this.supabase
        .from('bars')
        .select('*')
        .eq('symbol', symbol)
        .order('time', { ascending: false })
        .limit(limit);
      
      if (error) {
        // Table might not exist
        if (error.code === '42P01') {
          this.logger.debug('bars table does not exist, skipping Supabase load');
          return [];
        }
        throw error;
      }
      
      if (!data || data.length === 0) {
        return [];
      }
      
      // Convert to OHLCV format
      return data.map((row: any) => ({
        time: new Date(row.time).getTime(),
        open: parseFloat(row.open),
        high: parseFloat(row.high),
        low: parseFloat(row.low),
        close: parseFloat(row.close),
        volume: parseFloat(row.volume),
      }));
    } catch (error) {
      this.logger.warn(`Failed to load from Supabase for ${symbol}:`, error);
      return [];
    }
  }
  
  /**
   * Internal method to add a candle, with option to skip signal generation.
   */
  private addCandleInternal(symbol: string, candle: OHLCV, skipSignals: boolean): void {
    if (!this.candles.has(symbol)) {
      this.candles.set(symbol, []);
    }

    const candles = this.candles.get(symbol)!;
    candles.push(candle);

    // Keep only last 500 candles
    if (candles.length > 500) {
      candles.shift();
    }

    // Update multi-timeframe aggregations
    this.updateMultiTimeframeCandles(symbol);

    // Update indicators
    this.updateIndicators(symbol);

    // Check warmup status
    if (!this.warmupComplete.get(symbol) && candles.length >= WARMUP_CONFIG.minCandlesRequired) {
      this.warmupComplete.set(symbol, true);
      this.emit('warmup:complete', symbol);
      this.logger.info(`Warmup complete for ${symbol} (via live data)`, { candleCount: candles.length });
    }

    // Only check for signals if not skipping (during historical load)
    if (!skipSignals && this.warmupComplete.get(symbol)) {
      this.checkSignals(symbol);
    }
  }

  // Get latest signals
  public getLatestSignals(limit: number = 10): Signal[] {
    return Array.from(this.lastSignals.values())
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
      .slice(0, limit);
  }
}
