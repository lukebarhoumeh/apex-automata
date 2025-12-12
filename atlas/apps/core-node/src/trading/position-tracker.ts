import { EventEmitter } from 'events';
import { Logger } from '../core/logger';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { Fill } from '../exchanges/coinbase';

export interface PositionTrackerConfig {
  supabaseUrl: string;
  supabaseKey: string;
  updateInterval: number; // milliseconds
  pnlCalculationMethod: 'fifo' | 'lifo' | 'average';
  
  // Risk limits (from guardrails)
  maxPositionValueUsd: number;      // Max value per position
  maxUnrealizedLossUsd: number;     // Max unrealized loss before alert
  drawdownWarningPct: number;       // Drawdown % for warning alert
  drawdownCriticalPct: number;      // Drawdown % for critical alert
}

export interface Position {
  id: string;
  symbol: string;
  side: 'long' | 'short' | 'flat';
  size: number;
  averagePrice: number;
  marketPrice: number;
  unrealizedPnL: number;
  realizedPnL: number;
  totalPnL: number;
  openTime: Date;
  lastUpdateTime: Date;
  trades: Trade[];
  maxSize: number;
  maxDrawdown: number;
  metadata?: Record<string, any>;
}

export interface Trade {
  id: string;
  orderId: string;
  side: 'buy' | 'sell';
  size: number;
  price: number;
  fee: number;
  timestamp: Date;
  realizedPnL?: number;
}

export interface PositionTrackerEvents {
  'position:opened': (position: Position) => void;
  'position:updated': (position: Position) => void;
  'position:closed': (position: Position) => void;
  'pnl:update': (symbol: string, pnl: { unrealized: number; realized: number; total: number }) => void;
  'risk:alert': (symbol: string, alert: RiskAlert) => void;
}

export interface RiskAlert {
  type: 'drawdown' | 'size_limit' | 'loss_limit';
  severity: 'warning' | 'critical';
  message: string;
  value: number;
  threshold: number;
}

export interface FlattenResult {
  symbol: string;
  success: boolean;
  orderId?: string;
  error?: string;
}

export class PositionTracker extends EventEmitter {
  private config: PositionTrackerConfig;
  private logger: Logger;
  private supabase: SupabaseClient;
  private positions: Map<string, Position> = new Map();
  private marketPrices: Map<string, number> = new Map();
  private updateTimer: NodeJS.Timeout | null = null;
  
  // Order creator for placing flatten orders
  private orderCreator: ((symbol: string, side: 'buy' | 'sell', size: number, tag?: string) => Promise<string | null>) | null = null;
  
  // Mutex to prevent double-flattening
  private flatteningInProgress = false;

  constructor(config: PositionTrackerConfig, logger: Logger) {
    super();
    this.config = config;
    this.logger = logger;
    this.supabase = createClient(config.supabaseUrl, config.supabaseKey);

    this.startUpdateLoop();
  }
  
  /**
   * Set the order creator function for placing flatten orders.
   * Returns the order ID if successful, null if failed.
   */
  public setOrderCreator(
    creator: (symbol: string, side: 'buy' | 'sell', size: number, tag?: string) => Promise<string | null>
  ): void {
    this.orderCreator = creator;
  }

  private startUpdateLoop(): void {
    this.updateTimer = setInterval(() => {
      this.updateAllPositions();
    }, this.config.updateInterval);
  }

  public stopUpdateLoop(): void {
    if (this.updateTimer) {
      clearInterval(this.updateTimer);
      this.updateTimer = null;
    }
  }

  // Process a fill to update positions
  public async processFill(fill: Fill): Promise<void> {
    const symbol = fill.product_id;
    const side = fill.side;
    const size = parseFloat(fill.size);
    const price = parseFloat(fill.price);
    const fee = parseFloat(fill.fee);

    const trade: Trade = {
      id: fill.trade_id.toString(),
      orderId: fill.order_id,
      side,
      size,
      price,
      fee,
      timestamp: new Date(fill.created_at)
    };

    let position = this.positions.get(symbol);

    if (!position) {
      // Create new position
      position = this.createNewPosition(symbol);
      this.positions.set(symbol, position);
    }

    // Update position based on trade
    this.updatePositionWithTrade(position, trade);

    // Calculate P&L
    this.calculatePnL(position);

    // Check risk limits
    this.checkRiskLimits(position);

    // Persist to database
    await this.persistPosition(position);

    // Emit events
    if (position.size === 0) {
      this.emit('position:closed', position);
    } else if (position.trades.length === 1) {
      this.emit('position:opened', position);
    } else {
      this.emit('position:updated', position);
    }
  }

  private createNewPosition(symbol: string): Position {
    return {
      id: `${symbol}_${Date.now()}`,
      symbol,
      side: 'flat',
      size: 0,
      averagePrice: 0,
      marketPrice: this.marketPrices.get(symbol) || 0,
      unrealizedPnL: 0,
      realizedPnL: 0,
      totalPnL: 0,
      openTime: new Date(),
      lastUpdateTime: new Date(),
      trades: [],
      maxSize: 0,
      maxDrawdown: 0
    };
  }

  private updatePositionWithTrade(position: Position, trade: Trade): void {
    const previousSize = position.size;
    const previousAvgPrice = position.averagePrice;

    if (trade.side === 'buy') {
      // Increasing or opening long position
      if (position.side === 'short') {
        // Closing short position
        const closingSize = Math.min(Math.abs(position.size), trade.size);
        const realizedPnL = closingSize * (previousAvgPrice - trade.price) - trade.fee;
        trade.realizedPnL = realizedPnL;
        position.realizedPnL += realizedPnL;

        position.size += trade.size;
        if (position.size > 0) {
          position.side = 'long';
          position.averagePrice = trade.price;
        }
      } else {
        // Adding to long position
        const newSize = position.size + trade.size;
        position.averagePrice = ((previousSize * previousAvgPrice) + (trade.size * trade.price)) / newSize;
        position.size = newSize;
        position.side = 'long';
      }
    } else {
      // Sell trade
      if (position.side === 'long') {
        // Closing long position
        const closingSize = Math.min(position.size, trade.size);
        const realizedPnL = closingSize * (trade.price - previousAvgPrice) - trade.fee;
        trade.realizedPnL = realizedPnL;
        position.realizedPnL += realizedPnL;

        position.size -= trade.size;
        if (position.size < 0) {
          position.side = 'short';
          position.averagePrice = trade.price;
          position.size = Math.abs(position.size);
        }
      } else {
        // Adding to short position
        const newSize = position.size + trade.size;
        position.averagePrice = ((previousSize * previousAvgPrice) + (trade.size * trade.price)) / newSize;
        position.size = newSize;
        position.side = 'short';
      }
    }

    // Update position metadata
    position.trades.push(trade);
    position.lastUpdateTime = new Date();
    position.maxSize = Math.max(position.maxSize, Math.abs(position.size));

    if (position.size === 0) {
      position.side = 'flat';
      position.averagePrice = 0;
    }
  }

  private calculatePnL(position: Position): void {
    if (position.side === 'flat' || position.size === 0) {
      position.unrealizedPnL = 0;
    } else {
      const marketPrice = this.marketPrices.get(position.symbol) || position.averagePrice;
      
      if (position.side === 'long') {
        position.unrealizedPnL = position.size * (marketPrice - position.averagePrice);
      } else {
        position.unrealizedPnL = position.size * (position.averagePrice - marketPrice);
      }
    }

    position.totalPnL = position.realizedPnL + position.unrealizedPnL;

    // Track max drawdown
    if (position.totalPnL < 0) {
      position.maxDrawdown = Math.max(position.maxDrawdown, Math.abs(position.totalPnL));
    }

    this.emit('pnl:update', position.symbol, {
      unrealized: position.unrealizedPnL,
      realized: position.realizedPnL,
      total: position.totalPnL
    });
  }

  private checkRiskLimits(position: Position): void {
    // Check drawdown using config values
    if (position.maxDrawdown > 0) {
      const drawdownPercent = (position.maxDrawdown / (position.maxSize * position.averagePrice)) * 100;
      
      const criticalThreshold = this.config.drawdownCriticalPct;
      const warningThreshold = this.config.drawdownWarningPct;
      
      if (drawdownPercent > criticalThreshold) {
        this.emit('risk:alert', position.symbol, {
          type: 'drawdown',
          severity: 'critical',
          message: `Drawdown exceeded ${criticalThreshold}%: ${drawdownPercent.toFixed(2)}%`,
          value: drawdownPercent,
          threshold: criticalThreshold
        });
      } else if (drawdownPercent > warningThreshold) {
        this.emit('risk:alert', position.symbol, {
          type: 'drawdown',
          severity: 'warning',
          message: `Drawdown warning: ${drawdownPercent.toFixed(2)}%`,
          value: drawdownPercent,
          threshold: warningThreshold
        });
      }
    }

    // Check position size limits from config
    const positionValue = position.size * position.averagePrice;
    const maxPositionValue = this.config.maxPositionValueUsd;

    if (positionValue > maxPositionValue) {
      this.emit('risk:alert', position.symbol, {
        type: 'size_limit',
        severity: 'critical',
        message: `Position size exceeded limit: $${positionValue.toFixed(2)}`,
        value: positionValue,
        threshold: maxPositionValue
      });
    }

    // Check loss limits from config
    const maxLoss = this.config.maxUnrealizedLossUsd;
    if (position.unrealizedPnL < -maxLoss) {
      this.emit('risk:alert', position.symbol, {
        type: 'loss_limit',
        severity: 'critical',
        message: `Unrealized loss exceeded limit: $${position.unrealizedPnL.toFixed(2)}`,
        value: position.unrealizedPnL,
        threshold: -maxLoss
      });
    }
  }

  // Update market price for a symbol
  public updateMarketPrice(symbol: string, price: number): void {
    this.marketPrices.set(symbol, price);
    
    const position = this.positions.get(symbol);
    if (position) {
      position.marketPrice = price;
      this.calculatePnL(position);
    }
  }

  // Update all positions with latest market prices
  private async updateAllPositions(): Promise<void> {
    for (const position of this.positions.values()) {
      if (position.side !== 'flat') {
        this.calculatePnL(position);
        await this.persistPosition(position);
      }
    }
  }

  // Persist position to database
  private async persistPosition(position: Position): Promise<void> {
    // Persistence is handled by the API layer when positions are broadcast.
    return;
  }

  private async persistTrade(positionId: string, trade: Trade): Promise<void> {
    // Persistence is handled by the API layer when fills are processed.
    return;
  }

  // Get current positions
  public getPositions(): Position[] {
    return Array.from(this.positions.values());
  }

  public getPosition(symbol: string): Position | undefined {
    return this.positions.get(symbol);
  }

  public getOpenPositions(): Position[] {
    return this.getPositions().filter(p => p.side !== 'flat');
  }

  // Get portfolio summary
  public getPortfolioSummary(): {
    totalUnrealizedPnL: number;
    totalRealizedPnL: number;
    totalPnL: number;
    positionCount: number;
    totalValue: number;
  } {
    let totalUnrealizedPnL = 0;
    let totalRealizedPnL = 0;
    let totalValue = 0;
    let positionCount = 0;

    for (const position of this.positions.values()) {
      if (position.side !== 'flat') {
        totalUnrealizedPnL += position.unrealizedPnL;
        totalValue += position.size * position.marketPrice;
        positionCount++;
      }
      totalRealizedPnL += position.realizedPnL;
    }

    return {
      totalUnrealizedPnL,
      totalRealizedPnL,
      totalPnL: totalUnrealizedPnL + totalRealizedPnL,
      positionCount,
      totalValue
    };
  }

  /**
   * Close all positions by placing real market orders.
   * Returns array of results for each position flatten attempt.
   */
  public async closeAllPositions(): Promise<FlattenResult[]> {
    // Prevent double-flattening
    if (this.flatteningInProgress) {
      this.logger.warn('Flatten already in progress, skipping duplicate request');
      return [];
    }
    
    this.flatteningInProgress = true;
    this.logger.warn('Closing all positions with real orders');
    
    const results: FlattenResult[] = [];
    const openPositions = this.getOpenPositions();
    
    if (openPositions.length === 0) {
      this.logger.info('No open positions to close');
      this.flatteningInProgress = false;
      return results;
    }
    
    for (const position of openPositions) {
      const result: FlattenResult = {
        symbol: position.symbol,
        success: false,
      };
      
      try {
        // Determine exit side (opposite of position)
        const exitSide: 'buy' | 'sell' = position.side === 'long' ? 'sell' : 'buy';
        const size = Math.abs(position.size);
        
        if (this.orderCreator) {
          this.logger.info(`Flattening ${position.symbol}: ${exitSide} ${size}`, {
            positionId: position.id,
            side: position.side,
          });
          
          // Place market order to flatten
          const orderId = await this.orderCreator(position.symbol, exitSide, size, 'flatten');
          
          if (orderId) {
            result.success = true;
            result.orderId = orderId;
            this.logger.info(`Flatten order placed for ${position.symbol}`, { orderId });
          } else {
            result.error = 'Order creation returned null';
            this.logger.error(`Failed to flatten ${position.symbol}: order creation returned null`);
          }
        } else {
          // Fallback: just mark as closed (legacy behavior)
          this.logger.warn(`No order creator set - marking ${position.symbol} as closed without order`);
          position.side = 'flat';
          position.size = 0;
          position.unrealizedPnL = 0;
          position.lastUpdateTime = new Date();
          
          await this.persistPosition(position);
          this.emit('position:closed', position);
          result.success = true;
        }
      } catch (error) {
        result.error = error instanceof Error ? error.message : String(error);
        this.logger.error(`Error flattening ${position.symbol}:`, error);
      }
      
      results.push(result);
    }
    
    this.flatteningInProgress = false;
    
    const successCount = results.filter(r => r.success).length;
    this.logger.info(`Flatten complete: ${successCount}/${results.length} positions closed`);
    
    return results;
  }
  
  /**
   * Check if a flatten operation is in progress.
   */
  public isFlatteningInProgress(): boolean {
    return this.flatteningInProgress;
  }
}
