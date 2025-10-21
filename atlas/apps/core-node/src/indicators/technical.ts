export interface OHLCV {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export class TechnicalIndicators {
  // Simple Moving Average
  public static SMA(data: number[], period: number): number[] {
    const result: number[] = [];
    if (period <= 0 || data.length < period) {
      return result;
    }
    
    for (let i = period - 1; i < data.length; i++) {
      let sum = 0;
      for (let j = 0; j < period; j++) {
        sum += data[i - j];
      }
      result.push(sum / period);
    }
    
    return result;
  }

  // Exponential Moving Average
  public static EMA(data: number[], period: number): number[] {
    const result: number[] = [];
    if (period <= 0 || data.length < period) {
      return result;
    }
    const multiplier = 2 / (period + 1);
    
    // Start with SMA
    let sum = 0;
    for (let i = 0; i < period; i++) {
      sum += data[i];
    }
    result.push(sum / period);
    
    // Calculate EMA
    for (let i = period; i < data.length; i++) {
      const ema = (data[i] - result[result.length - 1]) * multiplier + result[result.length - 1];
      result.push(ema);
    }
    
    return result;
  }

  // Relative Strength Index
  public static RSI(data: number[], period: number = 14): number[] {
    const result: number[] = [];
    if (data.length <= period) {
      return result;
    }
    const gains: number[] = [];
    const losses: number[] = [];
    
    // Calculate price changes
    for (let i = 1; i < data.length; i++) {
      const change = data[i] - data[i - 1];
      gains.push(change > 0 ? change : 0);
      losses.push(change < 0 ? Math.abs(change) : 0);
    }
    
    // Calculate initial average gain/loss
    let avgGain = 0;
    let avgLoss = 0;
    for (let i = 0; i < period; i++) {
      avgGain += gains[i];
      avgLoss += losses[i];
    }
    avgGain /= period;
    avgLoss /= period;
    
    // Calculate RSI
    for (let i = period; i < gains.length; i++) {
      avgGain = (avgGain * (period - 1) + gains[i]) / period;
      avgLoss = (avgLoss * (period - 1) + losses[i]) / period;
      
      const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
      const rsi = 100 - (100 / (1 + rs));
      result.push(rsi);
    }
    
    return result;
  }

  // MACD (Moving Average Convergence Divergence)
  public static MACD(
    data: number[],
    fastPeriod: number = 12,
    slowPeriod: number = 26,
    signalPeriod: number = 9
  ): { macd: number[]; signal: number[]; histogram: number[] } {
    if (data.length < Math.max(fastPeriod, slowPeriod)) {
      return { macd: [], signal: [], histogram: [] };
    }

    const fastEMA = this.EMA(data, fastPeriod);
    const slowEMA = this.EMA(data, slowPeriod);
    
    // Calculate MACD line
    const macd: number[] = [];
    const offset = slowPeriod - fastPeriod;
    for (let i = 0; i < slowEMA.length; i++) {
      const fastIndex = i + offset;
      if (fastIndex < 0 || fastIndex >= fastEMA.length) {
        continue;
      }
      macd.push(fastEMA[fastIndex] - slowEMA[i]);
    }

    if (macd.length === 0) {
      return { macd: [], signal: [], histogram: [] };
    }
    
    // Calculate signal line
    const signal = this.EMA(macd, signalPeriod);
    if (signal.length === 0) {
      return { macd, signal, histogram: [] };
    }
    
    // Calculate histogram
    const histogram: number[] = [];
    const signalOffset = signalPeriod - 1;
    for (let i = 0; i < signal.length; i++) {
      const macdIndex = i + signalOffset;
      if (macdIndex >= macd.length) {
        break;
      }
      histogram.push(macd[macdIndex] - signal[i]);
    }
    
    return { macd, signal, histogram };
  }

  // Bollinger Bands
  public static BollingerBands(
    data: number[],
    period: number = 20,
    stdDev: number = 2
  ): { upper: number[]; middle: number[]; lower: number[] } {
    if (data.length < period) {
      return { upper: [], middle: [], lower: [] };
    }
    const middle = this.SMA(data, period);
    const upper: number[] = [];
    const lower: number[] = [];
    
    for (let i = period - 1; i < data.length; i++) {
      // Calculate standard deviation
      let sum = 0;
      for (let j = 0; j < period; j++) {
        sum += Math.pow(data[i - j] - middle[i - (period - 1)], 2);
      }
      const std = Math.sqrt(sum / period);
      
      upper.push(middle[i - (period - 1)] + stdDev * std);
      lower.push(middle[i - (period - 1)] - stdDev * std);
    }
    
    return { upper, middle, lower };
  }

  // VWAP (Volume Weighted Average Price)
  public static VWAP(candles: OHLCV[]): number[] {
    const result: number[] = [];
    if (candles.length === 0) {
      return result;
    }
    let cumulativeTPV = 0;
    let cumulativeVolume = 0;
    
    // Reset at each trading day
    let lastDate = new Date(candles[0].time);
    
    for (const candle of candles) {
      const currentDate = new Date(candle.time);
      
      // Reset if new day
      if (currentDate.getDate() !== lastDate.getDate()) {
        cumulativeTPV = 0;
        cumulativeVolume = 0;
        lastDate = currentDate;
      }
      
      const typicalPrice = (candle.high + candle.low + candle.close) / 3;
      cumulativeTPV += typicalPrice * candle.volume;
      cumulativeVolume += candle.volume;
      
      const vwap = cumulativeVolume > 0 ? cumulativeTPV / cumulativeVolume : typicalPrice;
      result.push(vwap);
    }
    
    return result;
  }

  // ATR (Average True Range)
  public static ATR(candles: OHLCV[], period: number = 14): number[] {
    const trueRanges: number[] = [];
    if (candles.length <= 1) {
      return [];
    }
    
    // Calculate true ranges
    for (let i = 1; i < candles.length; i++) {
      const highLow = candles[i].high - candles[i].low;
      const highPrevClose = Math.abs(candles[i].high - candles[i - 1].close);
      const lowPrevClose = Math.abs(candles[i].low - candles[i - 1].close);
      
      trueRanges.push(Math.max(highLow, highPrevClose, lowPrevClose));
    }
    
    // Calculate ATR using EMA
    return this.EMA(trueRanges, period);
  }

  // Donchian Channels
  public static DonchianChannels(
    candles: OHLCV[],
    period: number = 20
  ): { upper: number[]; lower: number[]; middle: number[] } {
    const upper: number[] = [];
    const lower: number[] = [];
    const middle: number[] = [];
    if (candles.length < period) {
      return { upper, lower, middle };
    }
    
    for (let i = period - 1; i < candles.length; i++) {
      let highest = -Infinity;
      let lowest = Infinity;
      
      for (let j = 0; j < period; j++) {
        highest = Math.max(highest, candles[i - j].high);
        lowest = Math.min(lowest, candles[i - j].low);
      }
      
      upper.push(highest);
      lower.push(lowest);
      middle.push((highest + lowest) / 2);
    }
    
    return { upper, lower, middle };
  }

  // Standard Deviation
  public static StandardDeviation(data: number[], period: number): number[] {
    const result: number[] = [];
    if (period <= 0 || data.length < period) {
      return result;
    }
    const sma = this.SMA(data, period);
    
    for (let i = period - 1; i < data.length; i++) {
      let sum = 0;
      for (let j = 0; j < period; j++) {
        sum += Math.pow(data[i - j] - sma[i - (period - 1)], 2);
      }
      result.push(Math.sqrt(sum / period));
    }
    
    return result;
  }

  // Volume analysis
  public static VolumeProfile(candles: OHLCV[], bins: number = 20): Map<number, number> {
    const profile = new Map<number, number>();
    if (candles.length === 0 || bins <= 0) {
      return profile;
    }
    
    // Find price range
    let minPrice = Infinity;
    let maxPrice = -Infinity;
    for (const candle of candles) {
      minPrice = Math.min(minPrice, candle.low);
      maxPrice = Math.max(maxPrice, candle.high);
    }
    
    const binSize = (maxPrice - minPrice) / bins;
    if (binSize === 0) {
      return profile;
    }
    
    // Initialize bins
    for (let i = 0; i < bins; i++) {
      const binPrice = minPrice + i * binSize + binSize / 2;
      profile.set(binPrice, 0);
    }
    
    // Accumulate volume
    for (const candle of candles) {
      const binIndex = Math.floor((candle.close - minPrice) / binSize);
      const binPrice = minPrice + binIndex * binSize + binSize / 2;
      const currentVolume = profile.get(binPrice) || 0;
      profile.set(binPrice, currentVolume + candle.volume);
    }
    
    return profile;
  }

  // Support and Resistance levels
  public static SupportResistance(
    candles: OHLCV[],
    lookback: number = 20,
    threshold: number = 0.02
  ): { support: number[]; resistance: number[] } {
    const support: number[] = [];
    const resistance: number[] = [];
    if (candles.length < lookback * 2 + 1) {
      return { support, resistance };
    }
    
    for (let i = lookback; i < candles.length - lookback; i++) {
      let isSupport = true;
      let isResistance = true;
      
      // Check if current low is a support level
      for (let j = 1; j <= lookback; j++) {
        if (candles[i - j].low < candles[i].low || candles[i + j].low < candles[i].low) {
          isSupport = false;
          break;
        }
      }
      
      // Check if current high is a resistance level
      for (let j = 1; j <= lookback; j++) {
        if (candles[i - j].high > candles[i].high || candles[i + j].high > candles[i].high) {
          isResistance = false;
          break;
        }
      }
      
      if (isSupport) {
        support.push(candles[i].low);
      }
      
      if (isResistance) {
        resistance.push(candles[i].high);
      }
    }
    
    // Filter out levels that are too close
    const filteredSupport = this.filterLevels(support, threshold);
    const filteredResistance = this.filterLevels(resistance, threshold);
    
    return { support: filteredSupport, resistance: filteredResistance };
  }

  private static filterLevels(levels: number[], threshold: number): number[] {
    if (levels.length === 0) return [];
    
    const sorted = [...levels].sort((a, b) => a - b);
    const filtered: number[] = [sorted[0]];
    
    for (let i = 1; i < sorted.length; i++) {
      const lastLevel = filtered[filtered.length - 1];
      const percentDiff = Math.abs(sorted[i] - lastLevel) / lastLevel;
      
      if (percentDiff > threshold) {
        filtered.push(sorted[i]);
      }
    }
    
    return filtered;
  }
}
