import { EventEmitter } from 'events';
import { Logger } from '../core/logger';
import { TechnicalIndicators, OHLCV } from '../indicators/technical';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

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
}

export class SignalProcessor extends EventEmitter {
  private config: SignalProcessorConfig;
  private logger: Logger;
  private supabase: SupabaseClient;
  private candles: Map<string, OHLCV[]> = new Map();
  private indicators: Map<string, Record<string, number[]>> = new Map();
  private lastSignals: Map<string, Signal> = new Map();

  constructor(config: SignalProcessorConfig, logger: Logger) {
    super();
    this.config = config;
    this.logger = logger;
    this.supabase = createClient(config.supabaseUrl, config.supabaseKey);
  }

  // Add new candle data
  public addCandle(symbol: string, candle: OHLCV): void {
    if (!this.candles.has(symbol)) {
      this.candles.set(symbol, []);
    }

    const candles = this.candles.get(symbol)!;
    candles.push(candle);

    // Keep only last 500 candles
    if (candles.length > 500) {
      candles.shift();
    }

    // Update indicators
    this.updateIndicators(symbol);

    // Check for signals
    this.checkSignals(symbol);
  }

  private updateIndicators(symbol: string): void {
    const candles = this.candles.get(symbol);
    if (!candles || candles.length < 50) {
      return; // Not enough data
    }

    const closes = candles.map(c => c.close);
    const indicators: Record<string, number[]> = {};

    // Calculate all indicators
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
    indicators.atr = TechnicalIndicators.ATR(candles, 14);

    const donchian = TechnicalIndicators.DonchianChannels(candles, 20);
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

    const currentUpper = donchianUpper[donchianUpper.length - 1];
    const currentLower = donchianLower[donchianLower.length - 1];
    const currentATR = atr[atr.length - 1];
    const avgVolume = volumeSMA[volumeSMA.length - 1];

    // Volume filter
    const volumeRatio = latestCandle.volume / avgVolume;
    if (volumeRatio < config.volumeThreshold) {
      return;
    }

    // Check for breakout
    let signal: Signal | null = null;

    if (latestCandle.close > currentUpper && latestCandle.volume > avgVolume * config.volumeThreshold) {
      // Bullish breakout
      signal = {
        id: `${symbol}_breakout_${Date.now()}`,
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
            donchianUpper: currentUpper,
            atr: currentATR,
            volumeRatio
          },
          reason: `Price broke above ${config.period}-period high with ${volumeRatio.toFixed(2)}x volume`
        }
      };
    } else if (latestCandle.close < currentLower && latestCandle.volume > avgVolume * config.volumeThreshold) {
      // Bearish breakout
      signal = {
        id: `${symbol}_breakout_${Date.now()}`,
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
            donchianLower: currentLower,
            atr: currentATR,
            volumeRatio
          },
          reason: `Price broke below ${config.period}-period low with ${volumeRatio.toFixed(2)}x volume`
        }
      };
    }

    if (signal) {
      this.processSignal(signal);
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
        id: `${symbol}_vwap_${Date.now()}`,
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
        id: `${symbol}_vwap_${Date.now()}`,
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

    if (!rsi || !macdHistogram || !ema12 || !ema26) {
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
        id: `${symbol}_momentum_${Date.now()}`,
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
        id: `${symbol}_momentum_${Date.now()}`,
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
    await this.persistSignal(signal);

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

  private async persistSignal(signal: Signal): Promise<void> {
    try {
      const { error } = await this.supabase
        .from('signals')
        .insert({
          id: signal.id,
          timestamp: signal.timestamp.toISOString(),
          symbol: signal.symbol,
          strategy: signal.strategy,
          direction: signal.direction,
          strength: signal.strength,
          price: signal.price,
          stop_loss: signal.stopLoss,
          take_profit: signal.takeProfit,
          meta_label: signal.metaLabel,
          metadata: signal.metadata,
          created_at: new Date().toISOString()
        });

      if (error) {
        this.logger.error('Failed to persist signal:', error);
      }
    } catch (error) {
      this.logger.error('Error persisting signal:', error);
    }
  }

  // Get historical candles from exchange or database
  public async loadHistoricalData(symbol: string, limit: number = 200): Promise<void> {
    // TODO: Implement historical data loading
    this.logger.info(`Loading historical data for ${symbol}`);
  }

  // Get latest signals
  public getLatestSignals(limit: number = 10): Signal[] {
    return Array.from(this.lastSignals.values())
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
      .slice(0, limit);
  }
}
