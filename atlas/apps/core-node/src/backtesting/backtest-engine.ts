import { EventEmitter } from 'events';
import { Logger } from '../core/logger';
import { OHLCV, TechnicalIndicators } from '../indicators/technical';
import { SignalProcessor, Signal } from '../strategies/signal-processor';

type OrderSide = 'BUY' | 'SELL';

export interface BacktestConfig {
  startDate: Date;
  endDate: Date;
  initialCapital: number;
  commission: number; // Percentage (e.g., 0.002 for 0.2%)
  slippage: number; // Percentage
  products: string[];
  signals: {
    breakout: {
      enabled: boolean;
      parameters: any;
    };
    vwapMeanReversion: {
      enabled: boolean;
      parameters: any;
    };
    momentum: {
      enabled: boolean;
      parameters: any;
    };
  };
  risk: {
    maxPositionSize: number;
    maxTotalExposure: number;
    stopLossPercent: number;
    takeProfitPercent: number;
  };
}

export interface BacktestTrade {
  id: string;
  timestamp: Date;
  product: string;
  side: OrderSide;
  entryPrice: number;
  exitPrice?: number;
  size: number;
  entryFee: number;
  exitFee?: number;
  exitTimestamp?: Date;
  pnl?: number;
  pnlPercent?: number;
  exitReason?: 'signal' | 'stop_loss' | 'take_profit' | 'end_of_data';
  signal: Signal;
}

export interface BacktestPosition {
  product: string;
  side: 'long' | 'short';
  size: number;
  entryPrice: number;
  entryTimestamp: Date;
  unrealizedPnl: number;
  trades: BacktestTrade[];
}

export interface BacktestMetrics {
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number;
  grossProfit: number;
  grossLoss: number;
  netProfit: number;
  profitFactor: number;
  sharpeRatio: number;
  sortinoRatio: number;
  maxDrawdown: number;
  maxDrawdownPercent: number;
  averageWin: number;
  averageLoss: number;
  largestWin: number;
  largestLoss: number;
  averageHoldTime: number; // in minutes
  totalFees: number;
  finalCapital: number;
  returnPercent: number;
}

export interface BacktestResult {
  config: BacktestConfig;
  trades: BacktestTrade[];
  metrics: BacktestMetrics;
  equityCurve: { timestamp: Date; equity: number; drawdown: number }[];
  dailyReturns: { date: string; returnPercent: number }[];
}

export class BacktestEngine extends EventEmitter {
  private config: BacktestConfig;
  private logger: Logger;
  private signalProcessor: SignalProcessor | null = null;
  private historicalData: Map<string, OHLCV[]> = new Map();
  private positions: Map<string, BacktestPosition> = new Map();
  private closedTrades: BacktestTrade[] = [];
  private capital: number;
  private peakCapital: number;
  private equityCurve: { timestamp: Date; equity: number; drawdown: number }[] = [];
  private dailyReturns: Map<string, number> = new Map();
  private dailyStartEquity: number = 0;
  private currentDay: string = '';

  constructor(config: BacktestConfig, logger: Logger) {
    super();
    this.config = config;
    this.logger = logger;
    this.capital = config.initialCapital;
    this.peakCapital = config.initialCapital;
    this.dailyStartEquity = config.initialCapital;
  }

  public async loadHistoricalData(dataProvider: (product: string, start: Date, end: Date) => Promise<OHLCV[]>): Promise<void> {
    this.logger.info('Loading historical data', {
      products: this.config.products,
      startDate: this.config.startDate,
      endDate: this.config.endDate
    });

    for (const product of this.config.products) {
      const data = await dataProvider(product, this.config.startDate, this.config.endDate);
      this.historicalData.set(product, data);
      this.logger.info(`Loaded ${data.length} candles for ${product}`);
    }
  }

  public async run(): Promise<BacktestResult> {
    this.logger.info('Starting backtest');

    // Initialize signal processor
    this.initializeSignalProcessor();

    // Process each time step
    await this.processTimeSteps();

    // Close any remaining positions
    this.closeAllPositions('end_of_data');

    // Record final day's return
    if (this.currentDay) {
      const finalEquity = this.calculateCurrentEquity();
      const finalReturn = (finalEquity - this.dailyStartEquity) / this.dailyStartEquity;
      this.dailyReturns.set(this.currentDay, finalReturn);
    }

    // Calculate metrics
    const metrics = this.calculateMetrics();

    // Prepare result
    const result: BacktestResult = {
      config: this.config,
      trades: this.closedTrades,
      metrics,
      equityCurve: this.equityCurve,
      dailyReturns: this.getDailyReturns()
    };

    this.logger.info('Backtest completed', {
      totalTrades: metrics.totalTrades,
      netProfit: metrics.netProfit,
      returnPercent: metrics.returnPercent
    });

    return result;
  }

  private initializeSignalProcessor(): void {
    const signalConfig = {
      supabaseUrl: '', // Not needed for backtest
      supabaseKey: '', // Not needed for backtest
      strategies: {
        breakout: {
          enabled: this.config.signals.breakout.enabled,
          period: this.config.signals.breakout.parameters.period || 20,
          atrPeriod: this.config.signals.breakout.parameters.atrPeriod || 14,
          atrMultiplier: this.config.signals.breakout.parameters.atrMultiplier || 2,
          volumeThreshold: this.config.signals.breakout.parameters.volumeThreshold || 1.5
        },
        vwapMeanReversion: {
          enabled: this.config.signals.vwapMeanReversion.enabled,
          deviationEntry: this.config.signals.vwapMeanReversion.parameters.deviationEntry || 2,
          deviationExit: this.config.signals.vwapMeanReversion.parameters.deviationExit || 0.5,
          minVolume: this.config.signals.vwapMeanReversion.parameters.minVolume || 1000
        },
        momentum: {
          enabled: this.config.signals.momentum.enabled,
          rsiPeriod: this.config.signals.momentum.parameters.rsiPeriod || 14,
          rsiOverbought: this.config.signals.momentum.parameters.rsiOverbought || 70,
          rsiOversold: this.config.signals.momentum.parameters.rsiOversold || 30,
          macdFast: this.config.signals.momentum.parameters.macdFast || 12,
          macdSlow: this.config.signals.momentum.parameters.macdSlow || 26,
          macdSignal: this.config.signals.momentum.parameters.macdSignal || 9
        }
      },
      metaLabeling: {
        enabled: false, // Disable meta-labeling for backtest
        threshold: 0.5
      }
    };

    this.signalProcessor = new SignalProcessor(signalConfig, this.logger);

    // Listen for signals
    this.signalProcessor.on('signal:generated', this.handleSignal.bind(this));
  }

  private async processTimeSteps(): Promise<void> {
    const processor = this.signalProcessor;
    if (!processor) {
      throw new Error('Signal processor not initialized');
    }

    // Find minimum candle count across all products
    let minCandles = Infinity;
    for (const data of this.historicalData.values()) {
      minCandles = Math.min(minCandles, data.length);
    }

    const firstSeries = this.historicalData.values().next().value as OHLCV[] | undefined;
    if (!firstSeries || !Number.isFinite(minCandles) || minCandles === Infinity) {
      this.logger.warn('No historical data available for backtest');
      return;
    }

    // Process each timestamp
    for (let i = 50; i < minCandles; i++) { // Start at 50 for indicator warmup
      const baseCandle = firstSeries[i];
      if (!baseCandle) {
        continue;
      }
      const timestamp = new Date(baseCandle.time);

      // Feed data to signal processor for each product
      for (const [product, data] of this.historicalData.entries()) {
        const latestCandle = data[i];
        if (!latestCandle) {
          continue;
        }

        // Update positions with current price
        this.updatePositions(product, latestCandle.close, timestamp);

        // Check stop loss and take profit
        this.checkExitConditions(product, latestCandle, timestamp);

        // Add candle to signal processor
        processor.addCandle(product, latestCandle);
      }

      // Record equity curve
      this.recordEquity(timestamp);
    }
  }

  private handleSignal(signal: Signal): void {
    // Check if we already have a position
    const position = this.positions.get(signal.symbol);
    
    if (position) {
      // Check if signal is opposite direction (exit signal)
      if ((position.side === 'long' && signal.direction === 'sell') ||
          (position.side === 'short' && signal.direction === 'buy')) {
        this.closePosition(signal.symbol, signal.price, signal.timestamp, 'signal');
      }
    } else {
      // Open new position if risk checks pass
      this.openPosition(signal);
    }
  }

  private openPosition(signal: Signal): void {
    // Risk checks
    const positionSize = this.calculatePositionSize(signal);
    if (positionSize === 0) {
      return;
    }

    // Calculate total exposure
    let totalExposure = positionSize * signal.price;
    for (const pos of this.positions.values()) {
      totalExposure += pos.size * pos.entryPrice;
    }

    if (totalExposure > this.config.risk.maxTotalExposure) {
      this.logger.debug('Position rejected: exceeds max total exposure');
      return;
    }

    // Create trade
    const trade: BacktestTrade = {
      id: `${signal.symbol}_${Date.now()}`,
      timestamp: signal.timestamp,
      product: signal.symbol,
      side: signal.direction === 'buy' ? 'BUY' : 'SELL',
      entryPrice: signal.price * (1 + this.config.slippage * (signal.direction === 'buy' ? 1 : -1)),
      size: positionSize,
      entryFee: positionSize * signal.price * this.config.commission,
      signal
    };

    this.capital -= trade.entryFee;

    // Create position
    const position: BacktestPosition = {
      product: signal.symbol,
      side: signal.direction === 'buy' ? 'long' : 'short',
      size: positionSize,
      entryPrice: trade.entryPrice,
      entryTimestamp: signal.timestamp,
      unrealizedPnl: 0,
      trades: [trade]
    };

    this.positions.set(signal.symbol, position);

    this.logger.debug('Opened position', {
      product: signal.symbol,
      side: position.side,
      size: position.size,
      price: position.entryPrice
    });
  }

  private closePosition(product: string, price: number, timestamp: Date, reason: 'signal' | 'stop_loss' | 'take_profit' | 'end_of_data'): void {
    const position = this.positions.get(product);
    if (!position) return;

    // Calculate exit price with slippage
    const exitPrice = price * (1 + this.config.slippage * (position.side === 'long' ? -1 : 1));

    // Update trades
    for (const trade of position.trades) {
      trade.exitPrice = exitPrice;
      trade.exitTimestamp = timestamp;
      trade.exitFee = trade.size * exitPrice * this.config.commission;
      trade.exitReason = reason;

      // Calculate PnL
      if (position.side === 'long') {
        trade.pnl = (exitPrice - trade.entryPrice) * trade.size - trade.entryFee - trade.exitFee;
      } else {
        trade.pnl = (trade.entryPrice - exitPrice) * trade.size - trade.entryFee - trade.exitFee;
      }
      trade.pnlPercent = trade.pnl / (trade.size * trade.entryPrice);

      this.closedTrades.push(trade);
    }

    const firstTrade = position.trades[0];
    const exitFee = firstTrade?.exitFee ?? 0;
    const sideMultiplier = position.side === 'long' ? 1 : -1;
    const pnl = (exitPrice - position.entryPrice) * position.size * sideMultiplier;
    this.capital += pnl - exitFee;

    // Remove position
    this.positions.delete(product);

    this.logger.debug('Closed position', {
      product,
      exitPrice,
      reason,
      pnl: firstTrade?.pnl ?? 0
    });
  }

  private updatePositions(product: string, currentPrice: number, timestamp: Date): void {
    const position = this.positions.get(product);
    if (!position) return;

    // Calculate unrealized PnL
    if (position.side === 'long') {
      position.unrealizedPnl = (currentPrice - position.entryPrice) * position.size;
    } else {
      position.unrealizedPnl = (position.entryPrice - currentPrice) * position.size;
    }

    const dateKey = timestamp.toISOString().split('T')[0] ?? '';
    const currentEquity = this.calculateCurrentEquity();

    if (!this.currentDay) {
      this.currentDay = dateKey;
      this.dailyStartEquity = currentEquity;
    } else if (dateKey !== this.currentDay) {
      const dailyReturn = (currentEquity - this.dailyStartEquity) / this.dailyStartEquity;
      this.dailyReturns.set(this.currentDay, dailyReturn);
      this.dailyStartEquity = currentEquity;
      this.currentDay = dateKey;
    }
  }

  private checkExitConditions(product: string, candle: OHLCV, timestamp: Date): void {
    const position = this.positions.get(product);
    if (!position) return;

    const entryPrice = position.entryPrice;
    
    // Check stop loss
    const stopLoss = position.side === 'long'
      ? entryPrice * (1 - this.config.risk.stopLossPercent)
      : entryPrice * (1 + this.config.risk.stopLossPercent);

    if ((position.side === 'long' && candle.low <= stopLoss) ||
        (position.side === 'short' && candle.high >= stopLoss)) {
      this.closePosition(product, stopLoss, timestamp, 'stop_loss');
      return;
    }

    // Check take profit
    const takeProfit = position.side === 'long'
      ? entryPrice * (1 + this.config.risk.takeProfitPercent)
      : entryPrice * (1 - this.config.risk.takeProfitPercent);

    if ((position.side === 'long' && candle.high >= takeProfit) ||
        (position.side === 'short' && candle.low <= takeProfit)) {
      this.closePosition(product, takeProfit, timestamp, 'take_profit');
    }
  }

  private calculatePositionSize(signal: Signal): number {
    // Sum notional value of all open positions (allocated capital)
    let allocatedCapital = 0;
    for (const pos of this.positions.values()) {
      allocatedCapital += pos.size * pos.entryPrice;
    }

    // Size against equity (cash + unrealized P&L), not raw cash
    const equity = this.calculateCurrentEquity();
    const availableCapital = equity - allocatedCapital;
    if (availableCapital <= 0) return 0;

    const maxPositionValue = Math.min(
      availableCapital * 0.95,
      this.config.risk.maxPositionSize
    );

    return Math.floor(maxPositionValue / signal.price);
  }

  private calculateCurrentEquity(): number {
    let equity = this.capital;
    
    // Add unrealized PnL
    for (const position of this.positions.values()) {
      equity += position.unrealizedPnl;
    }

    return equity;
  }

  private recordEquity(timestamp: Date): void {
    const equity = this.calculateCurrentEquity();
    
    // Update peak
    if (equity > this.peakCapital) {
      this.peakCapital = equity;
    }

    // Calculate drawdown
    const drawdown = (this.peakCapital - equity) / this.peakCapital;

    this.equityCurve.push({ timestamp, equity, drawdown });
  }

  private closeAllPositions(reason: 'signal' | 'stop_loss' | 'take_profit' | 'end_of_data'): void {
    for (const [product, position] of this.positions.entries()) {
      // Get last price
      const data = this.historicalData.get(product);
      if (data && data.length > 0) {
        const lastCandle = data[data.length - 1];
        if (!lastCandle) {
          continue;
        }
        this.closePosition(product, lastCandle.close, new Date(lastCandle.time), reason);
      }
    }
  }

  private calculateMetrics(): BacktestMetrics {
    const trades = this.closedTrades;
    const winningTrades = trades.filter(t => t.pnl! > 0);
    const losingTrades = trades.filter(t => t.pnl! <= 0);

    const grossProfit = winningTrades.reduce((sum, t) => sum + t.pnl!, 0);
    const grossLoss = Math.abs(losingTrades.reduce((sum, t) => sum + t.pnl!, 0));
    const netProfit = grossProfit - grossLoss;
    const totalFees = trades.reduce((sum, t) => sum + t.entryFee + (t.exitFee || 0), 0);

    // Calculate average hold time
    let totalHoldTime = 0;
    let validTrades = 0;
    for (const trade of trades) {
      if (trade.exitTimestamp) {
        totalHoldTime += (trade.exitTimestamp.getTime() - trade.timestamp.getTime()) / 60000; // minutes
        validTrades++;
      }
    }

    // Calculate Sharpe ratio
    const returns = Array.from(this.dailyReturns.values());
    const avgReturn = returns.length > 0
      ? returns.reduce((a, b) => a + b, 0) / returns.length
      : 0;
    const stdDev = returns.length > 1
      ? Math.sqrt(returns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / returns.length)
      : 0;
    const sharpeRatio = stdDev > 0 ? (avgReturn / stdDev) * Math.sqrt(252) : 0;

    // Sortino ratio — downside-only deviation
    const downsideReturns = returns.filter(r => r < 0);
    const downsideDev = downsideReturns.length > 0
      ? Math.sqrt(downsideReturns.reduce((sum, r) => sum + r * r, 0) / downsideReturns.length)
      : 0;
    const sortinoRatio = downsideDev > 0 ? (avgReturn / downsideDev) * Math.sqrt(252) : 0;

    // Max drawdown
    let maxDrawdown = 0;
    let maxDrawdownPercent = 0;
    for (const point of this.equityCurve) {
      if (point.drawdown > maxDrawdownPercent) {
        maxDrawdownPercent = point.drawdown;
        maxDrawdown = this.peakCapital * point.drawdown;
      }
    }

    const finalCapital = this.calculateCurrentEquity();

    return {
      totalTrades: trades.length,
      winningTrades: winningTrades.length,
      losingTrades: losingTrades.length,
      winRate: trades.length > 0 ? winningTrades.length / trades.length : 0,
      grossProfit,
      grossLoss,
      netProfit,
      profitFactor: grossLoss > 0 ? grossProfit / grossLoss : 0,
      sharpeRatio,
      sortinoRatio,
      maxDrawdown,
      maxDrawdownPercent,
      averageWin: winningTrades.length > 0 ? grossProfit / winningTrades.length : 0,
      averageLoss: losingTrades.length > 0 ? grossLoss / losingTrades.length : 0,
      largestWin: winningTrades.length > 0 ? Math.max(...winningTrades.map(t => t.pnl!)) : 0,
      largestLoss: losingTrades.length > 0 ? Math.min(...losingTrades.map(t => t.pnl!)) : 0,
      averageHoldTime: validTrades > 0 ? totalHoldTime / validTrades : 0,
      totalFees,
      finalCapital,
      returnPercent: ((finalCapital - this.config.initialCapital) / this.config.initialCapital) * 100
    };
  }

  private getDailyReturns(): { date: string; returnPercent: number }[] {
    return Array.from(this.dailyReturns.entries()).map(([date, returnPercent]) => ({
      date,
      returnPercent: returnPercent * 100
    }));
  }
}
