import { EventEmitter } from 'events';
import { Logger } from '../core/logger';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { Fill } from '../exchanges/coinbase';
import { v4 as uuidv4 } from 'uuid';

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
  // Strategy metadata (populated when available)
  strategy?: string;
  signalId?: string;
  stopPrice?: number;
  takeProfit?: number;
  exitReason?: string;
  side: 'long' | 'short' | 'flat';
  size: number;
  averagePrice: number;
  marketPrice: number;
  unrealizedPnL: number;
  realizedPnL: number;
  totalPnL: number;
  openTime: Date;
  closedAt?: Date;
  exitPrice?: number;
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

export interface FillContext {
  strategy?: string;
  signalId?: string;
  stopPrice?: number;
  takeProfit?: number;
  tag?: string;
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
  // Accumulator to preserve realized P&L after positions are closed and removed from memory.
  private realizedPnLClosed = 0;
  
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
  public async processFill(fill: Fill, context?: FillContext): Promise<void> {
    const symbol = fill.product_id;
    const side = fill.side;
    const size = parseFloat(fill.size);
    const price = parseFloat(fill.price);
    const fee = parseFloat(fill.fee);
    
    if (!Number.isFinite(size) || size <= 0 || !Number.isFinite(price) || price <= 0) {
      this.logger.warn('Ignoring fill with non-finite/invalid size or price', {
        symbol,
        side,
        size: fill.size,
        price: fill.price,
        fee: fill.fee,
        orderId: fill.order_id,
        tradeId: fill.trade_id,
      });
      return;
    }

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
      position = this.createNewPosition(symbol, trade.timestamp);
      // Attach strategy context if available
      if (context?.strategy) {
        position.strategy = context.strategy;
      }
      if (context?.signalId) {
        position.signalId = context.signalId;
      }
      if (typeof context?.stopPrice === 'number' && Number.isFinite(context.stopPrice) && context.stopPrice > 0) {
        position.stopPrice = context.stopPrice;
      }
      if (typeof context?.takeProfit === 'number' && Number.isFinite(context.takeProfit) && context.takeProfit > 0) {
        position.takeProfit = context.takeProfit;
      }
      position.metadata = {
        ...(position.metadata ?? {}),
        entryOrderId: fill.order_id,
        entryTag: context?.tag,
      };
      this.positions.set(symbol, position);
    } else {
      // Backfill context if we didn't have it at open
      if (!position.strategy && context?.strategy) {
        position.strategy = context.strategy;
      }
      if (!position.signalId && context?.signalId) {
        position.signalId = context.signalId;
      }
      if ((!position.stopPrice || position.stopPrice <= 0) && typeof context?.stopPrice === 'number' && Number.isFinite(context.stopPrice) && context.stopPrice > 0) {
        position.stopPrice = context.stopPrice;
      }
      if ((!position.takeProfit || position.takeProfit <= 0) && typeof context?.takeProfit === 'number' && Number.isFinite(context.takeProfit) && context.takeProfit > 0) {
        position.takeProfit = context.takeProfit;
      }
    }

    const preTradeSide = position.side;

    // Update position based on trade
    this.updatePositionWithTrade(position, trade);

    // Calculate P&L
    this.calculatePnL(position);

    // Check risk limits
    this.checkRiskLimits(position);

    // Persist to database (handled upstream in API layer)
    await this.persistPosition(position);

    // Emit events
    if (position.size === 0) {
      position.closedAt = trade.timestamp;
      position.exitPrice = trade.price;
      if (preTradeSide !== 'flat') {
        // Preserve last non-flat side for downstream persistence (Supabase enum doesn't allow 'flat')
        position.side = preTradeSide;
      }
      // Preserve realized P&L after we delete the position object (needed for correct daily P&L / equity).
      if (Number.isFinite(position.realizedPnL)) {
        this.realizedPnLClosed += position.realizedPnL;
      }
      this.emit('position:closed', position);
      // Remove closed positions so a new trade creates a fresh position (new id/openTime)
      this.positions.delete(symbol);
    } else if (position.trades.length === 1) {
      this.emit('position:opened', position);
    } else {
      this.emit('position:updated', position);
    }
  }

  private createNewPosition(symbol: string, openedAt: Date): Position {
    return {
      id: uuidv4(),
      symbol,
      side: 'flat',
      size: 0,
      averagePrice: 0,
      marketPrice: this.marketPrices.get(symbol) || 0,
      unrealizedPnL: 0,
      realizedPnL: 0,
      totalPnL: 0,
      openTime: openedAt,
      lastUpdateTime: openedAt,
      trades: [],
      maxSize: 0,
      maxDrawdown: 0
    };
  }

  private updatePositionWithTrade(position: Position, trade: Trade): void {
    const previousSide = position.side;
    const previousSize = position.size;
    const previousAvgPrice = position.averagePrice;
    
    const size = Number.isFinite(trade.size) ? trade.size : 0;
    const price = Number.isFinite(trade.price) ? trade.price : 0;
    const fee = Number.isFinite(trade.fee) ? trade.fee : 0;
    
    if (size <= 0 || price <= 0) {
      this.logger.warn('Ignoring trade with non-positive size/price', {
        symbol: position.symbol,
        size,
        price,
        fee,
        orderId: trade.orderId,
      });
      return;
    }
    
    const allocateFee = (portionSize: number): number => {
      if (fee === 0 || portionSize <= 0) return 0;
      return fee * (portionSize / size);
    };

    // Opening from flat
    if (previousSide === 'flat' || previousSize === 0) {
      position.side = trade.side === 'buy' ? 'long' : 'short';
      position.size = size;
      // Incorporate entry fee into cost basis / proceeds so P&L matches fills.
      position.averagePrice = position.side === 'long'
        ? ((size * price) + fee) / size
        : ((size * price) - fee) / size;
    } else if (previousSide === 'long') {
      if (trade.side === 'buy') {
        // Add to long
        const newSize = previousSize + size;
        const totalCost = (previousSize * previousAvgPrice) + (size * price) + fee;
        position.averagePrice = totalCost / newSize;
        position.size = newSize;
        position.side = 'long';
      } else {
        // Sell reduces long or flips to short
        const closingSize = Math.min(previousSize, size);
        const feeClose = allocateFee(closingSize);
        const realizedPnL = closingSize * (price - previousAvgPrice) - feeClose;
        trade.realizedPnL = realizedPnL;
        position.realizedPnL += realizedPnL;

        const remainingLong = previousSize - closingSize;
        const flipSize = size - closingSize;
        const feeOpen = fee - feeClose;

        if (flipSize > 0) {
          position.side = 'short';
          position.size = flipSize;
          position.averagePrice = ((flipSize * price) - feeOpen) / flipSize;
        } else {
          position.size = remainingLong;
          position.side = position.size === 0 ? 'flat' : 'long';
          // Keep existing cost basis for remaining position (or for post-close reporting).
          position.averagePrice = previousAvgPrice;
        }
      }
    } else if (previousSide === 'short') {
      if (trade.side === 'sell') {
        // Add to short
        const newSize = previousSize + size;
        const totalProceeds = (previousSize * previousAvgPrice) + (size * price) - fee;
        position.averagePrice = totalProceeds / newSize;
        position.size = newSize;
        position.side = 'short';
      } else {
        // Buy reduces short or flips to long
        const closingSize = Math.min(previousSize, size);
        const feeClose = allocateFee(closingSize);
        const realizedPnL = closingSize * (previousAvgPrice - price) - feeClose;
        trade.realizedPnL = realizedPnL;
        position.realizedPnL += realizedPnL;

        const remainingShort = previousSize - closingSize;
        const flipSize = size - closingSize;
        const feeOpen = fee - feeClose;

        if (flipSize > 0) {
          position.side = 'long';
          position.size = flipSize;
          position.averagePrice = ((flipSize * price) + feeOpen) / flipSize;
        } else {
          position.size = remainingShort;
          position.side = position.size === 0 ? 'flat' : 'short';
          position.averagePrice = previousAvgPrice;
        }
      }
    }

    // Update position metadata
    position.trades.push(trade);
    position.lastUpdateTime = new Date();
    position.maxSize = Math.max(position.maxSize, Math.abs(position.size));
    
    if (!Number.isFinite(position.averagePrice) || position.averagePrice < 0) {
      position.averagePrice = Number.isFinite(price) ? price : 0;
    }

    if (!Number.isFinite(position.size) || position.size < 0) {
      position.size = Math.max(0, Number.isFinite(position.size) ? position.size : 0);
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
    let totalRealizedPnL = this.realizedPnLClosed;
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
          const preCloseSide = position.side;
          position.size = 0;
          position.unrealizedPnL = 0;
          position.closedAt = new Date();
          position.exitPrice = position.marketPrice;
          position.lastUpdateTime = new Date();
          
          await this.persistPosition(position);
          if (preCloseSide !== 'flat') {
            position.side = preCloseSide;
          }
          if (Number.isFinite(position.realizedPnL)) {
            this.realizedPnLClosed += position.realizedPnL;
          }
          this.emit('position:closed', position);
          this.positions.delete(position.symbol);
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
