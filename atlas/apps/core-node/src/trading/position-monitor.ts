import { EventEmitter } from 'events';
import { Logger } from '../core/logger';
import { Position, PositionTracker } from './position-tracker';
import { GuardrailConfig } from '../config/loadGuardrails';

export interface PositionMonitorConfig {
  guardrails: GuardrailConfig;
  checkIntervalMs: number; // How often to check positions (e.g., 1000ms)
}

export interface PositionExitCondition {
  type: 'stop_loss' | 'take_profit' | 'time_stop' | 'trailing_stop';
  symbol: string;
  positionId: string;
  currentPrice: number;
  triggerPrice: number;
  reason: string;
}

export interface MonitoredPosition {
  positionId: string;
  symbol: string;
  side: 'long' | 'short';
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  trailingStop: number | null;
  highWaterMark: number; // For trailing stop
  barsInTrade: number;
  openedAt: Date;
}

export interface PositionMonitorEvents {
  'exit:triggered': (condition: PositionExitCondition) => void;
  'exit:executed': (positionId: string, condition: PositionExitCondition) => void;
  'exit:failed': (positionId: string, error: Error) => void;
}

/**
 * PositionMonitor watches open positions for exit conditions:
 * - Stop loss: Fixed price level
 * - Take profit: Target price level
 * - Time stop: Maximum bars in trade
 * - Trailing stop: Dynamic stop that follows price
 */
export class PositionMonitor extends EventEmitter {
  private config: PositionMonitorConfig;
  private logger: Logger;
  private positionTracker: PositionTracker;
  private monitoredPositions: Map<string, MonitoredPosition> = new Map();
  private marketPrices: Map<string, number> = new Map();
  private checkInterval: NodeJS.Timeout | null = null;
  private orderCreator: ((symbol: string, side: 'buy' | 'sell', size: number) => Promise<boolean>) | null = null;
  
  constructor(
    config: PositionMonitorConfig,
    logger: Logger,
    positionTracker: PositionTracker
  ) {
    super();
    this.config = config;
    this.logger = logger;
    this.positionTracker = positionTracker;
    
    // Listen for position updates
    this.positionTracker.on('position:opened', this.handlePositionOpened.bind(this));
    this.positionTracker.on('position:closed', this.handlePositionClosed.bind(this));
  }
  
  /**
   * Set the order creator function for placing exit orders.
   */
  public setOrderCreator(
    creator: (symbol: string, side: 'buy' | 'sell', size: number) => Promise<boolean>
  ): void {
    this.orderCreator = creator;
  }
  
  /**
   * Start monitoring positions.
   */
  public start(): void {
    if (this.checkInterval) {
      return;
    }
    
    this.logger.info('Position monitor started', {
      checkIntervalMs: this.config.checkIntervalMs,
      timeStopBars: this.config.guardrails.strategy.time_stop_bars,
    });
    
    this.checkInterval = setInterval(() => {
      this.checkAllPositions();
    }, this.config.checkIntervalMs);
  }
  
  /**
   * Stop monitoring positions.
   */
  public stop(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
    this.logger.info('Position monitor stopped');
  }
  
  /**
   * Update market price for a symbol.
   */
  public updatePrice(symbol: string, price: number): void {
    this.marketPrices.set(symbol, price);
    
    // Update high water mark for trailing stops
    for (const [id, monitored] of this.monitoredPositions) {
      if (monitored.symbol === symbol) {
        if (monitored.side === 'long' && price > monitored.highWaterMark) {
          monitored.highWaterMark = price;
          this.updateTrailingStop(monitored);
        } else if (monitored.side === 'short' && price < monitored.highWaterMark) {
          monitored.highWaterMark = price;
          this.updateTrailingStop(monitored);
        }
      }
    }
  }
  
  /**
   * Increment bar count for all positions (call on each new candle).
   */
  public incrementBarCount(symbol: string): void {
    for (const monitored of this.monitoredPositions.values()) {
      if (monitored.symbol === symbol) {
        monitored.barsInTrade++;
      }
    }
  }
  
  /**
   * Register a position for monitoring with custom stop/target levels.
   */
  public registerPosition(
    position: Position,
    stopLoss: number,
    takeProfit: number
  ): void {
    if (position.side === 'flat') {
      return;
    }
    
    const monitored: MonitoredPosition = {
      positionId: position.id,
      symbol: position.symbol,
      side: position.side,
      entryPrice: position.averagePrice,
      stopLoss,
      takeProfit,
      trailingStop: null,
      highWaterMark: position.averagePrice,
      barsInTrade: 0,
      openedAt: position.openTime,
    };
    
    this.monitoredPositions.set(position.id, monitored);
    
    this.logger.info('Position registered for monitoring', {
      positionId: position.id,
      symbol: position.symbol,
      side: position.side,
      stopLoss,
      takeProfit,
    });
  }
  
  /**
   * Handle new position opened.
   */
  private handlePositionOpened(position: Position): void {
    // Auto-register if not already monitored
    if (this.monitoredPositions.has(position.id)) {
      return;
    }
    
    // Calculate default stop/target based on entry price
    const entryPrice = position.averagePrice;
    const stopPercent = 0.02; // Default 2% stop
    const targetPercent = 0.03; // Default 3% target
    
    const stopLoss = position.side === 'long'
      ? entryPrice * (1 - stopPercent)
      : entryPrice * (1 + stopPercent);
      
    const takeProfit = position.side === 'long'
      ? entryPrice * (1 + targetPercent)
      : entryPrice * (1 - targetPercent);
    
    this.registerPosition(position, stopLoss, takeProfit);
  }
  
  /**
   * Handle position closed.
   */
  private handlePositionClosed(position: Position): void {
    this.monitoredPositions.delete(position.id);
    this.logger.debug(`Position ${position.id} removed from monitoring`);
  }
  
  /**
   * Update trailing stop based on high water mark.
   */
  private updateTrailingStop(monitored: MonitoredPosition): void {
    const trailAtr = this.config.guardrails.strategy.stop_trail_atr;
    // Simplified: use percentage of high water mark
    const trailPercent = trailAtr * 0.01; // Rough approximation
    
    if (monitored.side === 'long') {
      const newTrailing = monitored.highWaterMark * (1 - trailPercent);
      if (monitored.trailingStop === null || newTrailing > monitored.trailingStop) {
        monitored.trailingStop = newTrailing;
      }
    } else {
      const newTrailing = monitored.highWaterMark * (1 + trailPercent);
      if (monitored.trailingStop === null || newTrailing < monitored.trailingStop) {
        monitored.trailingStop = newTrailing;
      }
    }
  }
  
  /**
   * Check all monitored positions for exit conditions.
   */
  private checkAllPositions(): void {
    for (const [positionId, monitored] of this.monitoredPositions) {
      const currentPrice = this.marketPrices.get(monitored.symbol);
      if (!currentPrice) {
        continue;
      }
      
      const condition = this.checkExitConditions(monitored, currentPrice);
      if (condition) {
        this.handleExitCondition(positionId, monitored, condition);
      }
    }
  }
  
  /**
   * Check if any exit condition is triggered for a position.
   */
  private checkExitConditions(
    monitored: MonitoredPosition,
    currentPrice: number
  ): PositionExitCondition | null {
    const { symbol, positionId, side, stopLoss, takeProfit, trailingStop } = monitored;
    
    // Check stop loss
    if (side === 'long' && currentPrice <= stopLoss) {
      return {
        type: 'stop_loss',
        symbol,
        positionId,
        currentPrice,
        triggerPrice: stopLoss,
        reason: `Price ${currentPrice.toFixed(2)} hit stop loss at ${stopLoss.toFixed(2)}`,
      };
    }
    if (side === 'short' && currentPrice >= stopLoss) {
      return {
        type: 'stop_loss',
        symbol,
        positionId,
        currentPrice,
        triggerPrice: stopLoss,
        reason: `Price ${currentPrice.toFixed(2)} hit stop loss at ${stopLoss.toFixed(2)}`,
      };
    }
    
    // Check take profit
    if (side === 'long' && currentPrice >= takeProfit) {
      return {
        type: 'take_profit',
        symbol,
        positionId,
        currentPrice,
        triggerPrice: takeProfit,
        reason: `Price ${currentPrice.toFixed(2)} hit take profit at ${takeProfit.toFixed(2)}`,
      };
    }
    if (side === 'short' && currentPrice <= takeProfit) {
      return {
        type: 'take_profit',
        symbol,
        positionId,
        currentPrice,
        triggerPrice: takeProfit,
        reason: `Price ${currentPrice.toFixed(2)} hit take profit at ${takeProfit.toFixed(2)}`,
      };
    }
    
    // Check trailing stop
    if (trailingStop !== null) {
      if (side === 'long' && currentPrice <= trailingStop) {
        return {
          type: 'trailing_stop',
          symbol,
          positionId,
          currentPrice,
          triggerPrice: trailingStop,
          reason: `Price ${currentPrice.toFixed(2)} hit trailing stop at ${trailingStop.toFixed(2)}`,
        };
      }
      if (side === 'short' && currentPrice >= trailingStop) {
        return {
          type: 'trailing_stop',
          symbol,
          positionId,
          currentPrice,
          triggerPrice: trailingStop,
          reason: `Price ${currentPrice.toFixed(2)} hit trailing stop at ${trailingStop.toFixed(2)}`,
        };
      }
    }
    
    // Check time stop
    const maxBars = this.config.guardrails.strategy.time_stop_bars;
    if (monitored.barsInTrade >= maxBars) {
      return {
        type: 'time_stop',
        symbol,
        positionId,
        currentPrice,
        triggerPrice: currentPrice,
        reason: `Position exceeded max bars (${monitored.barsInTrade}/${maxBars})`,
      };
    }
    
    return null;
  }
  
  /**
   * Handle an exit condition by placing an exit order.
   */
  private async handleExitCondition(
    positionId: string,
    monitored: MonitoredPosition,
    condition: PositionExitCondition
  ): Promise<void> {
    this.logger.warn(`Exit condition triggered for ${monitored.symbol}`, {
      positionId,
      type: condition.type,
      reason: condition.reason,
    });
    
    this.emit('exit:triggered', condition);
    
    // Get position size from tracker
    const position = this.positionTracker.getPosition(monitored.symbol);
    if (!position || position.size === 0) {
      this.logger.warn(`Position ${positionId} already closed`);
      this.monitoredPositions.delete(positionId);
      return;
    }
    
    // Determine exit order side (opposite of position)
    const exitSide: 'buy' | 'sell' = position.side === 'long' ? 'sell' : 'buy';
    
    // Place exit order
    if (this.orderCreator) {
      try {
        const success = await this.orderCreator(
          monitored.symbol,
          exitSide,
          position.size
        );
        
        if (success) {
          this.emit('exit:executed', positionId, condition);
          this.monitoredPositions.delete(positionId);
          this.logger.info(`Exit order placed for ${monitored.symbol}`, {
            positionId,
            type: condition.type,
            exitSide,
            size: position.size,
          });
        } else {
          this.emit('exit:failed', positionId, new Error('Order creation returned false'));
          this.logger.error(`Failed to place exit order for ${monitored.symbol}`);
        }
      } catch (error) {
        this.emit('exit:failed', positionId, error as Error);
        this.logger.error(`Error placing exit order for ${monitored.symbol}:`, error);
      }
    } else {
      this.logger.error('No order creator set - cannot execute exit');
      this.emit('exit:failed', positionId, new Error('No order creator configured'));
    }
  }
  
  /**
   * Get all monitored positions.
   */
  public getMonitoredPositions(): MonitoredPosition[] {
    return Array.from(this.monitoredPositions.values());
  }
}
