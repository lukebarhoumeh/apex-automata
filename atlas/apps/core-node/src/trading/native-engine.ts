import { EventEmitter } from 'events';
import { Logger } from '../core/logger';
import { Signal } from '../strategies/signal-processor';
import { MarketData } from '../exchanges/types';
import { Order } from '../trading/types';

// Try to load native module, fallback to TypeScript implementation if not available
let NativeTradingEngine: any;
try {
  NativeTradingEngine = require('../../build/Release/trading_engine.node').TradingEngine;
} catch (error) {
  console.warn('Native trading engine not available, using TypeScript implementation');
  NativeTradingEngine = null;
}

export interface NativeEngineConfig {
  scalping: {
    minSpreadBps: number;
    maxPositionSize: number;
    profitTargetBps: number;
    stopLossBps: number;
    momentumPeriod: number;
    volumeMultiplier: number;
    useMarketMicrostructure: boolean;
  };
  arbitrage: {
    minProfitBps: number;
    maxLatencyMs: number;
    feeBps: number;
    slippageBps: number;
    triangularEnabled: boolean;
    maxExposure: number;
  };
  execution: {
    maxParticipationRate: number;
    minSliceSize: number;
    maxSliceSize: number;
    minIntervalMs: number;
    maxIntervalMs: number;
  };
}

export interface ExchangeMetrics {
  latencyMs: number;
  fillRate: number;
  effectiveSpread: number;
  availableLiquidity: number;
  feeBps: number;
}

export interface RouteResult {
  exchange: string;
  orderId: string;
  quantity: number;
  price: number;
}

export class NativeEngineWrapper extends EventEmitter {
  private nativeEngine: any;
  private logger: Logger;
  private isNative: boolean;
  private config: NativeEngineConfig;

  constructor(config: NativeEngineConfig, logger: Logger) {
    super();
    this.config = config;
    this.logger = logger;
    this.isNative = !!NativeTradingEngine;

    if (this.isNative) {
      this.initializeNativeEngine();
    } else {
      this.logger.warn('Running in TypeScript mode - performance may be reduced');
    }
  }

  private initializeNativeEngine(): void {
    try {
      this.nativeEngine = new NativeTradingEngine();
      
      const callbacks = {
        onSignal: (signal: any) => {
          this.handleNativeSignal(signal);
        },
        onOrder: (order: any) => {
          this.emit('order:created', order);
        }
      };

      const success = this.nativeEngine.initialize(this.config, callbacks);
      if (!success) {
        throw new Error('Failed to initialize native engine');
      }

      this.logger.info('Native C++ trading engine initialized successfully');
    } catch (error) {
      this.logger.error('Failed to initialize native engine:', error);
      this.isNative = false;
    }
  }

  public processMarketData(data: MarketData): void {
    if (this.isNative && this.nativeEngine) {
      try {
        const tickData = {
          symbol: data.symbol,
          bid: data.bid,
          ask: data.ask,
          last: data.last,
          bidSize: data.bid_size,
          askSize: data.ask_size,
          lastSize: data.last_size || 0
        };
        
        this.nativeEngine.processMarketData(tickData);
      } catch (error) {
        this.logger.error('Native engine market data processing failed:', error);
      }
    } else {
      // Fallback to TypeScript implementation
      this.emit('market:update', data);
    }
  }

  public updateExchangeMetrics(exchange: string, metrics: ExchangeMetrics): void {
    if (this.isNative && this.nativeEngine) {
      try {
        this.nativeEngine.updateExchangeMetrics(exchange, metrics);
      } catch (error) {
        this.logger.error('Failed to update exchange metrics:', error);
      }
    }
  }

  public async routeOrder(order: Order, marketData: Record<string, MarketData>): Promise<RouteResult[]> {
    if (this.isNative && this.nativeEngine) {
      try {
        const orderData = {
          id: order.id,
          symbol: order.symbol,
          side: order.side.toLowerCase(),
          quantity: order.quantity,
          price: order.price
        };

        const marketDataMap: Record<string, any> = {};
        for (const [exchange, data] of Object.entries(marketData)) {
          marketDataMap[exchange] = {
            bid: data.bid,
            ask: data.ask,
            bidSize: data.bid_size,
            askSize: data.ask_size
          };
        }

        const results = this.nativeEngine.routeOrder(orderData, marketDataMap);
        return results as RouteResult[];
      } catch (error) {
        this.logger.error('Native order routing failed:', error);
        // Fallback to simple routing
        return this.fallbackRouting(order);
      }
    } else {
      return this.fallbackRouting(order);
    }
  }

  public getFeatures(): number[] {
    if (this.isNative && this.nativeEngine) {
      try {
        return this.nativeEngine.getFeatures();
      } catch (error) {
        this.logger.error('Failed to get features from native engine:', error);
        return [];
      }
    }
    return [];
  }

  public getStats(): any {
    if (this.isNative && this.nativeEngine) {
      try {
        return this.nativeEngine.getStats();
      } catch (error) {
        this.logger.error('Failed to get stats:', error);
        return {};
      }
    }
    return {
      isNative: false,
      queueSize: 0,
      signalsGenerated: 0
    };
  }

  public shutdown(): void {
    if (this.isNative && this.nativeEngine) {
      try {
        this.nativeEngine.shutdown();
        this.logger.info('Native engine shut down successfully');
      } catch (error) {
        this.logger.error('Error shutting down native engine:', error);
      }
    }
  }

  private handleNativeSignal(nativeSignal: any): void {
    // Convert native signal to TypeScript Signal type
    const signal: Signal = {
      id: `${nativeSignal.symbol}_${nativeSignal.strategy}_${Date.now()}`,
      timestamp: new Date(),
      symbol: nativeSignal.symbol,
      strategy: nativeSignal.strategy,
      direction: nativeSignal.direction as 'buy' | 'sell',
      strength: nativeSignal.strength,
      price: nativeSignal.entryPrice,
      stopLoss: nativeSignal.stopLoss,
      takeProfit: nativeSignal.takeProfit,
      metadata: {
        indicators: {},
        reason: `${nativeSignal.strategy} signal with strength ${nativeSignal.strength.toFixed(2)}`
      }
    };

    this.emit('signal:generated', signal);
  }

  private fallbackRouting(order: Order): RouteResult[] {
    // Simple fallback routing - send entire order to primary exchange
    return [{
      exchange: 'coinbase',
      orderId: order.id,
      quantity: order.quantity,
      price: order.price
    }];
  }
}

// High-frequency trading utilities
export class HFTUtils {
  // Fast moving average calculation using circular buffer
  static fastSMA(values: number[], period: number): number {
    if (values.length < period) return 0;
    
    let sum = 0;
    const start = values.length - period;
    for (let i = start; i < values.length; i++) {
      sum += values[i];
    }
    return sum / period;
  }

  // Optimized standard deviation
  static fastStdDev(values: number[], mean: number): number {
    if (values.length === 0) return 0;
    
    let sumSquaredDiff = 0;
    for (const val of values) {
      const diff = val - mean;
      sumSquaredDiff += diff * diff;
    }
    return Math.sqrt(sumSquaredDiff / values.length);
  }

  // Fast order book imbalance calculation
  static orderBookImbalance(bidSizes: number[], askSizes: number[]): number {
    let bidSum = 0, askSum = 0;
    const levels = Math.min(bidSizes.length, askSizes.length);
    
    for (let i = 0; i < levels; i++) {
      bidSum += bidSizes[i];
      askSum += askSizes[i];
    }
    
    const total = bidSum + askSum;
    return total > 0 ? (bidSum - askSum) / total : 0;
  }

  // Microsecond timestamp
  static microTimestamp(): number {
    const [seconds, nanoseconds] = process.hrtime();
    return seconds * 1000000 + Math.floor(nanoseconds / 1000);
  }
}
