import { EventEmitter } from 'events';
import { Logger } from '../core/logger';
import { OHLCV } from '../indicators/technical';
import { Signal } from '../strategies/signal-processor';
import { AdvancedRiskManager, RiskConfig } from '../risk/advanced-risk-manager';
import * as fs from 'fs/promises';
import * as path from 'path';

export interface BacktestConfig {
  startDate: Date;
  endDate: Date;
  initialCapital: number;
  symbols: string[];
  
  // Data configuration
  dataSource: 'file' | 'api' | 'generated';
  dataPath?: string;
  timeframe: '1m' | '5m' | '15m' | '30m' | '1h' | '4h' | '1d';
  
  // Execution parameters
  slippage: number;          // Basis points
  commission: number;        // Basis points
  marketImpact: number;      // Basis points per unit size
  
  // Strategy parameters
  strategies: {
    breakout?: { enabled: boolean; params: any };
    momentum?: { enabled: boolean; params: any };
    meanReversion?: { enabled: boolean; params: any };
    arbitrage?: { enabled: boolean; params: any };
    ml?: { enabled: boolean; modelPath?: string };
  };
  
  // Risk parameters
  risk: RiskConfig;
  
  // Optimization
  walkForward: boolean;
  walkForwardPeriods: number;
  monteCarloRuns: number;
  
  // Output
  generateReport: boolean;
  saveTrades: boolean;
  saveMetrics: boolean;
}

export interface BacktestTrade {
  id: string;
  entryTime: Date;
  exitTime?: Date;
  symbol: string;
  side: 'long' | 'short';
  entryPrice: number;
  exitPrice?: number;
  quantity: number;
  commission: number;
  slippage: number;
  pnl?: number;
  pnlPercent?: number;
  holdingPeriod?: number; // in minutes
  maxDrawdown?: number;
  strategy: string;
  signalStrength: number;
  exitReason?: 'signal' | 'stop_loss' | 'take_profit' | 'time_exit' | 'risk_limit';
}

export interface BacktestMetrics {
  // Performance metrics
  totalReturn: number;
  totalReturnPercent: number;
  cagr: number;               // Compound Annual Growth Rate
  sharpeRatio: number;
  sortinoRatio: number;
  calmarRatio: number;
  
  // Risk metrics
  maxDrawdown: number;
  maxDrawdownDuration: number; // days
  var95: number;              // Value at Risk
  cvar95: number;             // Conditional VaR
  volatility: number;
  downfraction: number;        // % of losing trades
  
  // Trade statistics
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number;
  avgWin: number;
  avgLoss: number;
  profitFactor: number;
  expectancy: number;
  
  // Execution quality
  avgSlippage: number;
  totalCommission: number;
  totalSlippage: number;
  
  // Strategy breakdown
  strategyMetrics: Map<string, StrategyMetrics>;
  
  // Time analysis
  bestHour: number;
  worstHour: number;
  bestDay: number;
  worstDay: number;
  
  // Monte Carlo results
  monteCarloConfidence95: {
    minReturn: number;
    maxReturn: number;
    minSharpe: number;
    maxSharpe: number;
  };
}

interface StrategyMetrics {
  trades: number;
  winRate: number;
  totalPnL: number;
  sharpeRatio: number;
  avgHoldingPeriod: number;
}

export class AdvancedBacktestEngine extends EventEmitter {
  private config: BacktestConfig;
  private logger: Logger;
  private riskManager: AdvancedRiskManager;
  
  // Market data
  private marketData: Map<string, OHLCV[]> = new Map();
  private currentIndex: Map<string, number> = new Map();
  
  // Portfolio state
  private capital: number;
  private positions: Map<string, BacktestTrade> = new Map();
  private completedTrades: BacktestTrade[] = [];
  
  // Performance tracking
  private equityCurve: { timestamp: Date; equity: number; drawdown: number }[] = [];
  private highWaterMark: number;
  private dailyReturns: number[] = [];
  
  // Signal generation (would integrate with actual strategies)
  private signalGenerators: Map<string, any> = new Map();
  
  constructor(config: BacktestConfig, logger: Logger) {
    super();
    this.config = config;
    this.logger = logger;
    this.capital = config.initialCapital;
    this.highWaterMark = config.initialCapital;
    
    // Initialize risk manager
    this.riskManager = new AdvancedRiskManager(config.risk, logger);
  }
  
  // Main backtest execution
  public async run(): Promise<BacktestMetrics> {
    this.logger.info('Starting advanced backtest...');
    
    // Load historical data
    await this.loadHistoricalData();
    
    // Initialize strategies
    this.initializeStrategies();
    
    // Run walk-forward analysis if enabled
    if (this.config.walkForward) {
      return await this.runWalkForwardAnalysis();
    }
    
    // Standard backtest
    const metrics = await this.runBacktest();
    
    // Run Monte Carlo simulation
    if (this.config.monteCarloRuns > 0) {
      const monteCarloResults = await this.runMonteCarloSimulation();
      metrics.monteCarloConfidence95 = monteCarloResults;
    }
    
    // Generate report if requested
    if (this.config.generateReport) {
      await this.generateReport(metrics);
    }
    
    return metrics;
  }
  
  private async runBacktest(): Promise<BacktestMetrics> {
    // Find the earliest common timestamp across all symbols
    const startTime = this.findCommonStartTime();
    const endTime = this.findCommonEndTime();
    
    let currentTime = new Date(startTime);
    let lastEquityUpdate = new Date(startTime);
    
    // Main backtest loop
    while (currentTime <= endTime) {
      // Update current market data indices
      this.updateMarketIndices(currentTime);
      
      // Check existing positions
      await this.updatePositions(currentTime);
      
      // Generate new signals
      const signals = await this.generateSignals(currentTime);
      
      // Process signals through risk management
      for (const signal of signals) {
        await this.processSignal(signal, currentTime);
      }
      
      // Update equity curve (every hour)
      if (currentTime.getTime() - lastEquityUpdate.getTime() >= 3600000) {
        this.updateEquityCurve(currentTime);
        lastEquityUpdate = new Date(currentTime);
      }
      
      // Advance time based on timeframe
      currentTime = this.advanceTime(currentTime);
      
      // Emit progress
      const progress = ((currentTime.getTime() - startTime.getTime()) / 
                       (endTime.getTime() - startTime.getTime())) * 100;
      this.emit('progress', progress);
    }
    
    // Close all remaining positions
    await this.closeAllPositions(endTime);
    
    // Calculate final metrics
    return this.calculateMetrics();
  }
  
  private async loadHistoricalData(): Promise<void> {
    this.logger.info('Loading historical data...');
    
    for (const symbol of this.config.symbols) {
      let data: OHLCV[];
      
      switch (this.config.dataSource) {
        case 'file':
          data = await this.loadDataFromFile(symbol);
          break;
        case 'api':
          data = await this.loadDataFromAPI(symbol);
          break;
        case 'generated':
          data = this.generateSyntheticData(symbol);
          break;
        default:
          throw new Error(`Unknown data source: ${this.config.dataSource}`);
      }
      
      // Filter by date range
      data = data.filter(bar => {
        const barTime = new Date(bar.time);
        return barTime >= this.config.startDate && barTime <= this.config.endDate;
      });
      
      this.marketData.set(symbol, data);
      this.currentIndex.set(symbol, 0);
      
      this.logger.info(`Loaded ${data.length} bars for ${symbol}`);
    }
  }
  
  private async loadDataFromFile(symbol: string): Promise<OHLCV[]> {
    const filePath = path.join(this.config.dataPath || '', `${symbol}_${this.config.timeframe}.json`);
    const content = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(content);
  }
  
  private async loadDataFromAPI(symbol: string): Promise<OHLCV[]> {
    // In real implementation, would call exchange API
    throw new Error('API data loading not implemented in this example');
  }
  
  private generateSyntheticData(symbol: string): OHLCV[] {
    const data: OHLCV[] = [];
    const basePrice = symbol.includes('BTC') ? 50000 : symbol.includes('ETH') ? 3000 : 100;
    let currentPrice = basePrice;
    
    const current = new Date(this.config.startDate);
    const end = new Date(this.config.endDate);
    
    while (current <= end) {
      // Generate realistic price movement
      const volatility = 0.002; // 0.2% per period
      const trend = Math.sin(current.getTime() / (86400000 * 30)) * 0.0001; // Monthly cycle
      const noise = (Math.random() - 0.5) * volatility;
      
      currentPrice *= (1 + trend + noise);
      
      const open = currentPrice * (1 + (Math.random() - 0.5) * 0.001);
      const close = currentPrice * (1 + (Math.random() - 0.5) * 0.001);
      const high = Math.max(open, close) * (1 + Math.random() * 0.0005);
      const low = Math.min(open, close) * (1 - Math.random() * 0.0005);
      const volume = 1000 + Math.random() * 9000;
      
      const bar: OHLCV = {
        time: current.getTime(),
        open,
        high,
        low,
        close,
        volume,
        typical_price: (high + low + close) / 3,
        weighted_close: (high + low + close * 2) / 4
      };
      
      bar.compute_derived();
      data.push(bar);
      
      // Advance time based on timeframe
      current.setMinutes(current.getMinutes() + this.getTimeframeMinutes());
    }
    
    return data;
  }
  
  private initializeStrategies(): void {
    // Initialize enabled strategies
    // In real implementation, would create actual strategy instances
    if (this.config.strategies.breakout?.enabled) {
      this.signalGenerators.set('breakout', {});
    }
    if (this.config.strategies.momentum?.enabled) {
      this.signalGenerators.set('momentum', {});
    }
    if (this.config.strategies.meanReversion?.enabled) {
      this.signalGenerators.set('meanReversion', {});
    }
  }
  
  private async generateSignals(timestamp: Date): Promise<Signal[]> {
    const signals: Signal[] = [];
    
    for (const symbol of this.config.symbols) {
      const data = this.marketData.get(symbol);
      const index = this.currentIndex.get(symbol);
      
      if (!data || index === undefined || index < 50) continue;
      
      // Get recent data for signal generation
      const recentData = data.slice(Math.max(0, index - 100), index + 1);
      
      // Generate signals from each strategy
      for (const [strategy, generator] of this.signalGenerators) {
        const signal = this.generateStrategySignal(strategy, symbol, recentData, timestamp);
        if (signal) {
          signals.push(signal);
        }
      }
    }
    
    return signals;
  }
  
  private generateStrategySignal(
    strategy: string, 
    symbol: string, 
    data: OHLCV[], 
    timestamp: Date
  ): Signal | null {
    // Simplified signal generation for demo
    const latest = data[data.length - 1];
    const prev = data[data.length - 2];
    
    // Random signal generation with some logic
    if (Math.random() > 0.98) { // 2% chance per bar
      const direction = latest.close > prev.close ? 'buy' : 'sell';
      const stopDistance = latest.close * 0.02; // 2% stop
      
      return {
        id: `${symbol}_${strategy}_${timestamp.getTime()}`,
        timestamp,
        symbol,
        strategy: strategy as any,
        direction,
        strength: 0.5 + Math.random() * 0.5,
        price: latest.close,
        stopLoss: direction === 'buy' ? 
          latest.close - stopDistance : 
          latest.close + stopDistance,
        takeProfit: direction === 'buy' ? 
          latest.close + stopDistance * 2 : 
          latest.close - stopDistance * 2,
        metadata: {
          indicators: {},
          reason: 'Backtest signal'
        }
      };
    }
    
    return null;
  }
  
  private async processSignal(signal: Signal, timestamp: Date): Promise<void> {
    // Check if already have position in this symbol
    if (this.positions.has(signal.symbol)) {
      return;
    }
    
    // Calculate position size through risk management
    const currentData = this.getCurrentMarketData(signal.symbol);
    if (!currentData) return;
    
    const sizeRequest = {
      symbol: signal.symbol,
      strategy: signal.strategy,
      signalStrength: signal.strength,
      entryPrice: signal.price,
      stopPrice: signal.stopLoss,
      volatility: this.calculateVolatility(signal.symbol)
    };
    
    const positionSize = this.riskManager.calculatePositionSize(sizeRequest);
    if (positionSize <= 0) return;
    
    // Check risk limits
    if (!this.riskManager.checkRiskLimits(signal.symbol, positionSize, signal.price)) {
      return;
    }
    
    // Calculate execution costs
    const slippageCost = signal.price * (this.config.slippage / 10000) * positionSize;
    const commissionCost = signal.price * positionSize * (this.config.commission / 10000);
    const totalCost = (signal.price * positionSize) + slippageCost + commissionCost;
    
    // Check if have enough capital
    if (totalCost > this.capital) {
      return;
    }
    
    // Create position
    const trade: BacktestTrade = {
      id: signal.id,
      entryTime: timestamp,
      symbol: signal.symbol,
      side: signal.direction === 'buy' ? 'long' : 'short',
      entryPrice: signal.price + (signal.price * this.config.slippage / 10000),
      quantity: positionSize,
      commission: commissionCost,
      slippage: slippageCost,
      strategy: signal.strategy,
      signalStrength: signal.strength
    };
    
    this.positions.set(signal.symbol, trade);
    this.capital -= totalCost;
    
    // Update risk manager
    this.riskManager.updatePosition(signal.symbol, {
      symbol: signal.symbol,
      size: positionSize,
      entryPrice: trade.entryPrice,
      currentPrice: trade.entryPrice,
      unrealizedPnL: 0,
      weight: totalCost / (this.capital + totalCost)
    });
    
    this.logger.debug(`Opened position: ${signal.symbol} ${trade.side} ${positionSize} @ ${trade.entryPrice}`);
  }
  
  private async updatePositions(timestamp: Date): Promise<void> {
    for (const [symbol, position] of this.positions) {
      const currentData = this.getCurrentMarketData(symbol);
      if (!currentData) continue;
      
      const currentPrice = currentData.close;
      
      // Calculate unrealized P&L
      const priceDiff = position.side === 'long' ? 
        currentPrice - position.entryPrice : 
        position.entryPrice - currentPrice;
      const unrealizedPnL = priceDiff * position.quantity;
      
      // Update risk manager
      this.riskManager.updatePosition(symbol, {
        currentPrice,
        unrealizedPnL
      });
      
      // Check exit conditions
      let shouldExit = false;
      let exitReason: BacktestTrade['exitReason'];
      
      // Check for opposite signal
      const signals = await this.generateSignals(timestamp);
      const oppositeSignal = signals.find(s => 
        s.symbol === symbol && 
        ((position.side === 'long' && s.direction === 'sell') ||
         (position.side === 'short' && s.direction === 'buy'))
      );
      
      if (oppositeSignal) {
        shouldExit = true;
        exitReason = 'signal';
      }
      
      // Check stop loss (simplified - in real implementation would track actual stop order)
      const maxLoss = position.quantity * Math.abs(position.entryPrice - currentPrice);
      if (unrealizedPnL < -position.quantity * position.entryPrice * 0.02) { // 2% stop
        shouldExit = true;
        exitReason = 'stop_loss';
      }
      
      // Check take profit
      if (unrealizedPnL > position.quantity * position.entryPrice * 0.04) { // 4% target
        shouldExit = true;
        exitReason = 'take_profit';
      }
      
      // Time-based exit (hold for max 1 week)
      const holdingTime = timestamp.getTime() - position.entryTime.getTime();
      if (holdingTime > 7 * 24 * 60 * 60 * 1000) {
        shouldExit = true;
        exitReason = 'time_exit';
      }
      
      if (shouldExit) {
        await this.closePosition(symbol, currentPrice, timestamp, exitReason!);
      }
    }
  }
  
  private async closePosition(
    symbol: string, 
    exitPrice: number, 
    timestamp: Date, 
    exitReason: BacktestTrade['exitReason']
  ): Promise<void> {
    const position = this.positions.get(symbol);
    if (!position) return;
    
    // Calculate exit costs
    const slippageCost = exitPrice * (this.config.slippage / 10000) * position.quantity;
    const commissionCost = exitPrice * position.quantity * (this.config.commission / 10000);
    
    // Adjust exit price for slippage
    const actualExitPrice = position.side === 'long' ?
      exitPrice - (exitPrice * this.config.slippage / 10000) :
      exitPrice + (exitPrice * this.config.slippage / 10000);
    
    // Calculate P&L
    const priceDiff = position.side === 'long' ?
      actualExitPrice - position.entryPrice :
      position.entryPrice - actualExitPrice;
    
    const grossPnL = priceDiff * position.quantity;
    const totalCommission = position.commission + commissionCost;
    const totalSlippage = position.slippage + slippageCost;
    const netPnL = grossPnL - totalCommission - totalSlippage;
    
    // Update capital
    this.capital += (actualExitPrice * position.quantity) - commissionCost;
    
    // Complete trade record
    position.exitTime = timestamp;
    position.exitPrice = actualExitPrice;
    position.pnl = netPnL;
    position.pnlPercent = (netPnL / (position.entryPrice * position.quantity)) * 100;
    position.holdingPeriod = (timestamp.getTime() - position.entryTime.getTime()) / 60000; // minutes
    position.exitReason = exitReason;
    
    // Calculate max drawdown during trade
    // (simplified - would track intra-trade drawdown in real implementation)
    position.maxDrawdown = Math.min(0, netPnL);
    
    // Move to completed trades
    this.completedTrades.push(position);
    this.positions.delete(symbol);
    
    // Update risk manager
    this.riskManager.updatePosition(symbol, {
      size: 0
    });
    
    this.logger.debug(`Closed position: ${symbol} ${position.side} P&L: ${netPnL.toFixed(2)}`);
  }
  
  private async closeAllPositions(timestamp: Date): Promise<void> {
    for (const symbol of Array.from(this.positions.keys())) {
      const currentData = this.getCurrentMarketData(symbol);
      if (currentData) {
        await this.closePosition(symbol, currentData.close, timestamp, 'signal');
      }
    }
  }
  
  private calculateMetrics(): BacktestMetrics {
    // Calculate returns
    const startEquity = this.config.initialCapital;
    const endEquity = this.capital + Array.from(this.positions.values())
      .reduce((sum, pos) => {
        const currentData = this.getCurrentMarketData(pos.symbol);
        if (!currentData) return sum;
        const unrealizedPnL = pos.side === 'long' ?
          (currentData.close - pos.entryPrice) * pos.quantity :
          (pos.entryPrice - currentData.close) * pos.quantity;
        return sum + unrealizedPnL;
      }, 0);
    
    const totalReturn = endEquity - startEquity;
    const totalReturnPercent = (totalReturn / startEquity) * 100;
    
    // Calculate daily returns from equity curve
    this.calculateDailyReturns();
    
    // Performance metrics
    const days = (this.config.endDate.getTime() - this.config.startDate.getTime()) / 86400000;
    const years = days / 365;
    const cagr = (Math.pow(endEquity / startEquity, 1 / years) - 1) * 100;
    
    // Risk metrics
    const sharpeRatio = this.calculateSharpeRatio();
    const sortinoRatio = this.calculateSortinoRatio();
    const maxDrawdown = this.calculateMaxDrawdown();
    const calmarRatio = maxDrawdown > 0 ? cagr / maxDrawdown : 0;
    
    // Trade statistics
    const winningTrades = this.completedTrades.filter(t => (t.pnl || 0) > 0).length;
    const losingTrades = this.completedTrades.filter(t => (t.pnl || 0) < 0).length;
    const winRate = this.completedTrades.length > 0 ? 
      winningTrades / this.completedTrades.length : 0;
    
    const wins = this.completedTrades.filter(t => (t.pnl || 0) > 0).map(t => t.pnl || 0);
    const losses = this.completedTrades.filter(t => (t.pnl || 0) < 0).map(t => t.pnl || 0);
    
    const avgWin = wins.length > 0 ? wins.reduce((a, b) => a + b, 0) / wins.length : 0;
    const avgLoss = losses.length > 0 ? losses.reduce((a, b) => a + b, 0) / losses.length : 0;
    const profitFactor = Math.abs(avgLoss) > 0 ? avgWin / Math.abs(avgLoss) : 0;
    
    // Strategy breakdown
    const strategyMetrics = this.calculateStrategyMetrics();
    
    // Time analysis
    const { bestHour, worstHour, bestDay, worstDay } = this.calculateTimeAnalysis();
    
    return {
      totalReturn,
      totalReturnPercent,
      cagr,
      sharpeRatio,
      sortinoRatio,
      calmarRatio,
      maxDrawdown,
      maxDrawdownDuration: this.calculateMaxDrawdownDuration(),
      var95: this.calculateVaR(0.95),
      cvar95: this.calculateCVaR(0.95),
      volatility: this.calculateVolatility('portfolio'),
      downfraction: losingTrades / Math.max(1, this.completedTrades.length),
      totalTrades: this.completedTrades.length,
      winningTrades,
      losingTrades,
      winRate,
      avgWin,
      avgLoss,
      profitFactor,
      expectancy: winRate * avgWin + (1 - winRate) * avgLoss,
      avgSlippage: this.completedTrades.reduce((sum, t) => sum + t.slippage, 0) / 
                   Math.max(1, this.completedTrades.length),
      totalCommission: this.completedTrades.reduce((sum, t) => sum + t.commission, 0),
      totalSlippage: this.completedTrades.reduce((sum, t) => sum + t.slippage, 0),
      strategyMetrics,
      bestHour,
      worstHour,
      bestDay,
      worstDay,
      monteCarloConfidence95: {
        minReturn: 0,
        maxReturn: 0,
        minSharpe: 0,
        maxSharpe: 0
      }
    };
  }
  
  private calculateSharpeRatio(): number {
    if (this.dailyReturns.length < 2) return 0;
    
    const avgReturn = this.dailyReturns.reduce((a, b) => a + b, 0) / this.dailyReturns.length;
    const stdDev = Math.sqrt(
      this.dailyReturns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / 
      this.dailyReturns.length
    );
    
    const riskFreeRate = 0.02 / 252; // 2% annual
    return stdDev > 0 ? ((avgReturn - riskFreeRate) / stdDev) * Math.sqrt(252) : 0;
  }
  
  private calculateSortinoRatio(): number {
    if (this.dailyReturns.length < 2) return 0;
    
    const avgReturn = this.dailyReturns.reduce((a, b) => a + b, 0) / this.dailyReturns.length;
    const downReturns = this.dailyReturns.filter(r => r < 0);
    
    if (downReturns.length === 0) return 0;
    
    const downDeviation = Math.sqrt(
      downReturns.reduce((sum, r) => sum + r * r, 0) / downReturns.length
    );
    
    const riskFreeRate = 0.02 / 252;
    return downDeviation > 0 ? ((avgReturn - riskFreeRate) / downDeviation) * Math.sqrt(252) : 0;
  }
  
  private calculateMaxDrawdown(): number {
    let maxDD = 0;
    let peak = this.config.initialCapital;
    
    for (const point of this.equityCurve) {
      if (point.equity > peak) {
        peak = point.equity;
      }
      const drawdown = ((peak - point.equity) / peak) * 100;
      maxDD = Math.max(maxDD, drawdown);
    }
    
    return maxDD;
  }
  
  private calculateMaxDrawdownDuration(): number {
    let maxDuration = 0;
    let currentDuration = 0;
    let peak = this.config.initialCapital;
    let drawdownStart: Date | null = null;
    
    for (const point of this.equityCurve) {
      if (point.equity >= peak) {
        peak = point.equity;
        if (drawdownStart) {
          const duration = (point.timestamp.getTime() - drawdownStart.getTime()) / 86400000;
          maxDuration = Math.max(maxDuration, duration);
          drawdownStart = null;
        }
      } else if (!drawdownStart) {
        drawdownStart = point.timestamp;
      }
    }
    
    return maxDuration;
  }
  
  private calculateVaR(confidence: number): number {
    const sortedReturns = [...this.dailyReturns].sort((a, b) => a - b);
    const index = Math.floor(sortedReturns.length * (1 - confidence));
    return sortedReturns[index] || 0;
  }
  
  private calculateCVaR(confidence: number): number {
    const var95 = this.calculateVaR(confidence);
    const tailReturns = this.dailyReturns.filter(r => r <= var95);
    return tailReturns.length > 0 ?
      tailReturns.reduce((a, b) => a + b, 0) / tailReturns.length : 0;
  }
  
  private calculateStrategyMetrics(): Map<string, StrategyMetrics> {
    const metrics = new Map<string, StrategyMetrics>();
    
    for (const strategy of this.signalGenerators.keys()) {
      const strategyTrades = this.completedTrades.filter(t => t.strategy === strategy);
      
      if (strategyTrades.length === 0) continue;
      
      const wins = strategyTrades.filter(t => (t.pnl || 0) > 0).length;
      const totalPnL = strategyTrades.reduce((sum, t) => sum + (t.pnl || 0), 0);
      const avgHolding = strategyTrades.reduce((sum, t) => sum + (t.holdingPeriod || 0), 0) / 
                        strategyTrades.length;
      
      // Calculate strategy-specific Sharpe
      // (simplified - would need strategy-specific returns in real implementation)
      
      metrics.set(strategy, {
        trades: strategyTrades.length,
        winRate: wins / strategyTrades.length,
        totalPnL,
        sharpeRatio: this.calculateSharpeRatio(), // Would be strategy-specific
        avgHoldingPeriod: avgHolding
      });
    }
    
    return metrics;
  }
  
  private calculateTimeAnalysis(): {
    bestHour: number;
    worstHour: number;
    bestDay: number;
    worstDay: number;
  } {
    const hourlyPnL = new Array(24).fill(0);
    const hourlyCounts = new Array(24).fill(0);
    const dailyPnL = new Array(7).fill(0);
    const dailyCounts = new Array(7).fill(0);
    
    for (const trade of this.completedTrades) {
      const hour = trade.entryTime.getHours();
      const day = trade.entryTime.getDay();
      
      hourlyPnL[hour] += trade.pnl || 0;
      hourlyCounts[hour]++;
      dailyPnL[day] += trade.pnl || 0;
      dailyCounts[day]++;
    }
    
    // Find best/worst hour
    let bestHour = 0, worstHour = 0;
    let bestHourAvg = -Infinity, worstHourAvg = Infinity;
    
    for (let i = 0; i < 24; i++) {
      if (hourlyCounts[i] > 0) {
        const avg = hourlyPnL[i] / hourlyCounts[i];
        if (avg > bestHourAvg) {
          bestHourAvg = avg;
          bestHour = i;
        }
        if (avg < worstHourAvg) {
          worstHourAvg = avg;
          worstHour = i;
        }
      }
    }
    
    // Find best/worst day
    let bestDay = 0, worstDay = 0;
    let bestDayAvg = -Infinity, worstDayAvg = Infinity;
    
    for (let i = 0; i < 7; i++) {
      if (dailyCounts[i] > 0) {
        const avg = dailyPnL[i] / dailyCounts[i];
        if (avg > bestDayAvg) {
          bestDayAvg = avg;
          bestDay = i;
        }
        if (avg < worstDayAvg) {
          worstDayAvg = avg;
          worstDay = i;
        }
      }
    }
    
    return { bestHour, worstHour, bestDay, worstDay };
  }
  
  // Walk-forward analysis for robustness testing
  private async runWalkForwardAnalysis(): Promise<BacktestMetrics> {
    const results: BacktestMetrics[] = [];
    const totalDuration = this.config.endDate.getTime() - this.config.startDate.getTime();
    const periodDuration = totalDuration / this.config.walkForwardPeriods;
    
    for (let i = 0; i < this.config.walkForwardPeriods; i++) {
      // In-sample period (80%)
      const inSampleStart = new Date(this.config.startDate.getTime() + i * periodDuration);
      const inSampleEnd = new Date(inSampleStart.getTime() + periodDuration * 0.8);
      
      // Out-of-sample period (20%)
      const outSampleStart = inSampleEnd;
      const outSampleEnd = new Date(inSampleStart.getTime() + periodDuration);
      
      // Optimize on in-sample
      // (simplified - would run actual optimization in real implementation)
      
      // Test on out-of-sample
      this.config.startDate = outSampleStart;
      this.config.endDate = outSampleEnd;
      
      const metrics = await this.runBacktest();
      results.push(metrics);
      
      // Reset state
      this.reset();
    }
    
    // Aggregate results
    return this.aggregateWalkForwardResults(results);
  }
  
  // Monte Carlo simulation for confidence intervals
  private async runMonteCarloSimulation(): Promise<{
    minReturn: number;
    maxReturn: number;
    minSharpe: number;
    maxSharpe: number;
  }> {
    const results: { return: number; sharpe: number }[] = [];
    
    for (let i = 0; i < this.config.monteCarloRuns; i++) {
      // Randomly shuffle trade order
      const shuffledTrades = [...this.completedTrades].sort(() => Math.random() - 0.5);
      
      // Recalculate equity curve with shuffled trades
      let equity = this.config.initialCapital;
      const returns: number[] = [];
      let lastEquity = equity;
      
      for (const trade of shuffledTrades) {
        equity += trade.pnl || 0;
        const dailyReturn = (equity - lastEquity) / lastEquity;
        returns.push(dailyReturn);
        lastEquity = equity;
      }
      
      // Calculate metrics
      const totalReturn = ((equity - this.config.initialCapital) / this.config.initialCapital) * 100;
      const avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
      const stdDev = Math.sqrt(
        returns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / returns.length
      );
      const sharpe = stdDev > 0 ? (avgReturn / stdDev) * Math.sqrt(252) : 0;
      
      results.push({ return: totalReturn, sharpe });
    }
    
    // Sort and find 95% confidence intervals
    results.sort((a, b) => a.return - b.return);
    const index5 = Math.floor(results.length * 0.05);
    const index95 = Math.floor(results.length * 0.95);
    
    return {
      minReturn: results[index5].return,
      maxReturn: results[index95].return,
      minSharpe: results[index5].sharpe,
      maxSharpe: results[index95].sharpe
    };
  }
  
  private async generateReport(metrics: BacktestMetrics): Promise<void> {
    const report = {
      config: this.config,
      metrics,
      trades: this.config.saveTrades ? this.completedTrades : undefined,
      equityCurve: this.equityCurve,
      timestamp: new Date()
    };
    
    const reportPath = path.join(
      process.cwd(), 
      'backtest_reports',
      `backtest_${Date.now()}.json`
    );
    
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
    
    this.logger.info(`Backtest report saved to: ${reportPath}`);
  }
  
  // Helper methods
  private findCommonStartTime(): number {
    let maxStart = 0;
    
    for (const data of this.marketData.values()) {
      if (data.length > 0) {
        maxStart = Math.max(maxStart, data[0].time);
      }
    }
    
    return maxStart;
  }
  
  private findCommonEndTime(): number {
    let minEnd = Infinity;
    
    for (const data of this.marketData.values()) {
      if (data.length > 0) {
        minEnd = Math.min(minEnd, data[data.length - 1].time);
      }
    }
    
    return minEnd;
  }
  
  private updateMarketIndices(timestamp: Date): void {
    const targetTime = timestamp.getTime();
    
    for (const [symbol, data] of this.marketData) {
      const currentIndex = this.currentIndex.get(symbol) || 0;
      
      // Find the appropriate index for this timestamp
      let newIndex = currentIndex;
      while (newIndex < data.length - 1 && data[newIndex + 1].time <= targetTime) {
        newIndex++;
      }
      
      this.currentIndex.set(symbol, newIndex);
    }
  }
  
  private getCurrentMarketData(symbol: string): OHLCV | null {
    const data = this.marketData.get(symbol);
    const index = this.currentIndex.get(symbol);
    
    if (!data || index === undefined || index >= data.length) {
      return null;
    }
    
    return data[index];
  }
  
  private advanceTime(current: Date): Date {
    const next = new Date(current);
    const minutes = this.getTimeframeMinutes();
    next.setMinutes(next.getMinutes() + minutes);
    return next;
  }
  
  private getTimeframeMinutes(): number {
    const map: Record<string, number> = {
      '1m': 1,
      '5m': 5,
      '15m': 15,
      '30m': 30,
      '1h': 60,
      '4h': 240,
      '1d': 1440
    };
    return map[this.config.timeframe] || 5;
  }
  
  private updateEquityCurve(timestamp: Date): void {
    const positions = Array.from(this.positions.values());
    const unrealizedPnL = positions.reduce((sum, pos) => {
      const currentData = this.getCurrentMarketData(pos.symbol);
      if (!currentData) return sum;
      
      const priceDiff = pos.side === 'long' ?
        currentData.close - pos.entryPrice :
        pos.entryPrice - currentData.close;
      
      return sum + (priceDiff * pos.quantity);
    }, 0);
    
    const totalEquity = this.capital + unrealizedPnL;
    
    if (totalEquity > this.highWaterMark) {
      this.highWaterMark = totalEquity;
    }
    
    const drawdown = ((this.highWaterMark - totalEquity) / this.highWaterMark) * 100;
    
    this.equityCurve.push({
      timestamp,
      equity: totalEquity,
      drawdown
    });
  }
  
  private calculateDailyReturns(): void {
    this.dailyReturns = [];
    
    if (this.equityCurve.length < 2) return;
    
    let lastDayEquity = this.config.initialCapital;
    let lastDay = new Date(this.equityCurve[0].timestamp);
    lastDay.setHours(0, 0, 0, 0);
    
    for (const point of this.equityCurve) {
      const currentDay = new Date(point.timestamp);
      currentDay.setHours(0, 0, 0, 0);
      
      if (currentDay.getTime() > lastDay.getTime()) {
        const dailyReturn = (point.equity - lastDayEquity) / lastDayEquity;
        this.dailyReturns.push(dailyReturn);
        lastDayEquity = point.equity;
        lastDay = currentDay;
      }
    }
    
    // Add return to current day
    this.riskManager.addReturn(this.dailyReturns[this.dailyReturns.length - 1] || 0);
  }
  
  private calculateVolatility(symbol: string): number {
    const data = this.marketData.get(symbol);
    const index = this.currentIndex.get(symbol);
    
    if (!data || index === undefined || index < 20) return 0.02; // Default 2%
    
    const returns: number[] = [];
    for (let i = index - 19; i <= index; i++) {
      if (i > 0) {
        const ret = (data[i].close - data[i-1].close) / data[i-1].close;
        returns.push(ret);
      }
    }
    
    const avg = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((sum, r) => sum + Math.pow(r - avg, 2), 0) / returns.length;
    
    return Math.sqrt(variance);
  }
  
  private aggregateWalkForwardResults(results: BacktestMetrics[]): BacktestMetrics {
    // Average all metrics across walk-forward periods
    const avg = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;
    
    return {
      totalReturn: avg(results.map(r => r.totalReturn)),
      totalReturnPercent: avg(results.map(r => r.totalReturnPercent)),
      cagr: avg(results.map(r => r.cagr)),
      sharpeRatio: avg(results.map(r => r.sharpeRatio)),
      sortinoRatio: avg(results.map(r => r.sortinoRatio)),
      calmarRatio: avg(results.map(r => r.calmarRatio)),
      maxDrawdown: Math.max(...results.map(r => r.maxDrawdown)),
      maxDrawdownDuration: Math.max(...results.map(r => r.maxDrawdownDuration)),
      var95: avg(results.map(r => r.var95)),
      cvar95: avg(results.map(r => r.cvar95)),
      volatility: avg(results.map(r => r.volatility)),
      downfraction: avg(results.map(r => r.downfraction)),
      totalTrades: results.reduce((sum, r) => sum + r.totalTrades, 0),
      winningTrades: results.reduce((sum, r) => sum + r.winningTrades, 0),
      losingTrades: results.reduce((sum, r) => sum + r.losingTrades, 0),
      winRate: avg(results.map(r => r.winRate)),
      avgWin: avg(results.map(r => r.avgWin)),
      avgLoss: avg(results.map(r => r.avgLoss)),
      profitFactor: avg(results.map(r => r.profitFactor)),
      expectancy: avg(results.map(r => r.expectancy)),
      avgSlippage: avg(results.map(r => r.avgSlippage)),
      totalCommission: results.reduce((sum, r) => sum + r.totalCommission, 0),
      totalSlippage: results.reduce((sum, r) => sum + r.totalSlippage, 0),
      strategyMetrics: results[0].strategyMetrics, // Simplified
      bestHour: Math.floor(avg(results.map(r => r.bestHour))),
      worstHour: Math.floor(avg(results.map(r => r.worstHour))),
      bestDay: Math.floor(avg(results.map(r => r.bestDay))),
      worstDay: Math.floor(avg(results.map(r => r.worstDay))),
      monteCarloConfidence95: results[0].monteCarloConfidence95 // Take from first
    };
  }
  
  private reset(): void {
    this.capital = this.config.initialCapital;
    this.positions.clear();
    this.completedTrades = [];
    this.equityCurve = [];
    this.highWaterMark = this.config.initialCapital;
    this.dailyReturns = [];
    this.currentIndex.clear();
    
    for (const symbol of this.config.symbols) {
      this.currentIndex.set(symbol, 0);
    }
  }
}
