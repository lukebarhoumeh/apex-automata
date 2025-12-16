import { EventEmitter } from 'events';
import { Logger } from '../core/logger';

export interface RiskConfig {
  // Account-level limits
  maxDrawdownPercent: number;        // Maximum drawdown before halting
  maxDailyLossPercent: number;       // Daily loss limit
  maxPositionSizePercent: number;    // Max position as % of account
  maxTotalExposurePercent: number;   // Max total exposure
  
  // Position-level limits
  maxLossPerTradePercent: number;    // Max loss per trade as % of account
  maxPositions: number;              // Maximum concurrent positions
  maxCorrelatedPositions: number;    // Max positions in correlated assets
  
  // Dynamic risk parameters
  useVolatilityScaling: boolean;     // Scale position size by volatility
  useDynamicStops: boolean;         // Adjust stops based on market conditions
  usePortfolioOptimization: boolean; // Optimize portfolio allocation
  
  // Risk metrics thresholds
  minSharpeRatio: number;           // Minimum acceptable Sharpe ratio
  maxValueAtRisk: number;           // Maximum VaR (95% confidence)
  maxLeverage: number;              // Maximum account leverage
}

export interface PositionSizeRequest {
  symbol: string;
  strategy: string;
  signalStrength: number;
  entryPrice: number;
  stopPrice: number;
  volatility?: number;
  correlation?: Record<string, number>;
}

export interface RiskMetrics {
  currentDrawdown: number;
  dailyPnL: number;
  totalExposure: number;
  valueAtRisk: number;
  sharpeRatio: number;
  currentLeverage: number;
  positionCount: number;
  riskScore: number; // 0-100, higher = riskier
}

interface PortfolioPosition {
  symbol: string;
  size: number;
  entryPrice: number;
  currentPrice: number;
  unrealizedPnL: number;
  weight: number;
  beta: number;
  correlation: Record<string, number>;
}

export class AdvancedRiskManager extends EventEmitter {
  private config: RiskConfig;
  private logger: Logger;
  
  // Portfolio state
  private positions: Map<string, PortfolioPosition> = new Map();
  private accountBalance: number = 100000; // Default starting balance
  private highWaterMark: number = 100000;
  private dailyStartBalance: number = 100000;
  
  // Risk metrics cache
  private metricsCache: RiskMetrics = {
    currentDrawdown: 0,
    dailyPnL: 0,
    totalExposure: 0,
    valueAtRisk: 0,
    sharpeRatio: 0,
    currentLeverage: 0,
    positionCount: 0,
    riskScore: 0
  };
  
  // Historical data for calculations
  private returns: number[] = [];
  private readonly RETURNS_WINDOW = 252; // 1 year of daily returns
  
  // Volatility regime detection
  private volatilityRegime: 'low' | 'normal' | 'high' = 'normal';
  private marketVolatility: Map<string, number> = new Map();
  
  constructor(config: RiskConfig, logger: Logger) {
    super();
    this.config = config;
    this.logger = logger;
    
    // Start periodic risk monitoring
    this.startRiskMonitoring();
  }
  
  // Calculate optimal position size using multiple methods
  public calculatePositionSize(request: PositionSizeRequest): number {
    // Check if trading is allowed
    if (!this.isTradingAllowed()) {
      this.logger.warn('Trading halted due to risk limits');
      return 0;
    }
    
    // Base position size using fixed fractional method
    const riskAmount = this.accountBalance * (this.config.maxLossPerTradePercent / 100);
    const riskPerUnit = Math.abs(request.entryPrice - request.stopPrice);
    let baseSize = riskPerUnit > 0 ? riskAmount / riskPerUnit : 0;
    
    // Apply Kelly Criterion
    const kellySize = this.calculateKellySize(request);
    baseSize = Math.min(baseSize, kellySize);
    
    // Apply volatility scaling
    if (this.config.useVolatilityScaling && request.volatility) {
      const volAdjustment = this.getVolatilityAdjustment(request.symbol, request.volatility);
      baseSize *= volAdjustment;
    }
    
    // Apply portfolio optimization
    if (this.config.usePortfolioOptimization) {
      const portfolioAdjustment = this.getPortfolioAdjustment(request);
      baseSize *= portfolioAdjustment;
    }
    
    // Apply signal strength
    baseSize *= Math.pow(request.signalStrength, 1.5); // Non-linear scaling
    
    // Apply position limits
    baseSize = this.applyPositionLimits(request.symbol, baseSize, request.entryPrice);
    
    // Apply regime-based adjustments
    baseSize = this.applyRegimeAdjustments(baseSize);
    
    return Math.floor(baseSize);
  }
  
  // Update position for real-time risk tracking
  public updatePosition(symbol: string, position: Partial<PortfolioPosition>): void {
    const existing = this.positions.get(symbol);
    if (existing) {
      this.positions.set(symbol, { ...existing, ...position });
    } else if (position.size && position.size > 0) {
      this.positions.set(symbol, position as PortfolioPosition);
    } else {
      this.positions.delete(symbol);
    }
    
    this.recalculateMetrics();
  }
  
  // Get current risk metrics
  public getRiskMetrics(): RiskMetrics {
    return { ...this.metricsCache };
  }
  
  // Check if a new position would breach risk limits
  public checkRiskLimits(symbol: string, size: number, price: number): boolean {
    const potentialExposure = size * price;
    const newTotalExposure = this.metricsCache.totalExposure + potentialExposure;
    const exposurePercent = (newTotalExposure / this.accountBalance) * 100;
    
    if (exposurePercent > this.config.maxTotalExposurePercent) {
      this.logger.warn(`Position would exceed max exposure: ${exposurePercent.toFixed(2)}%`);
      return false;
    }
    
    if (this.positions.size >= this.config.maxPositions) {
      this.logger.warn('Maximum number of positions reached');
      return false;
    }
    
    // Check correlation limits
    const correlatedCount = this.countCorrelatedPositions(symbol);
    if (correlatedCount >= this.config.maxCorrelatedPositions) {
      this.logger.warn('Too many correlated positions');
      return false;
    }
    
    return true;
  }
  
  // Update market volatility for a symbol
  public updateVolatility(symbol: string, volatility: number): void {
    this.marketVolatility.set(symbol, volatility);
    this.updateVolatilityRegime();
  }
  
  // Emergency stop - close all positions
  public emergencyStop(reason: string): void {
    this.logger.error(`EMERGENCY STOP TRIGGERED: ${reason}`);
    this.emit('emergency:stop', reason);
    
    // Signal to close all positions
    for (const [symbol, position] of this.positions) {
      this.emit('close:position', {
        symbol,
        size: position.size,
        reason: `Emergency stop: ${reason}`
      });
    }
  }
  
  private calculateKellySize(request: PositionSizeRequest): number {
    // Simplified Kelly Criterion
    // f = (p * b - q) / b
    // where f = fraction to bet, p = probability of win, b = odds, q = probability of loss
    
    // Estimate win probability based on signal strength and historical performance
    const winProbability = 0.45 + (request.signalStrength * 0.15); // 45-60% win rate
    const avgWinLoss = 1.5; // Risk-reward ratio
    
    const kellyFraction = (winProbability * avgWinLoss - (1 - winProbability)) / avgWinLoss;
    const conservativeKelly = Math.max(0, kellyFraction * 0.25); // Use 1/4 Kelly for safety
    
    return this.accountBalance * conservativeKelly / request.entryPrice;
  }
  
  private getVolatilityAdjustment(symbol: string, currentVol: number): number {
    // Scale position size inversely with volatility
    const baselineVol = 0.02; // 2% daily volatility baseline
    const volRatio = baselineVol / currentVol;
    
    // Cap adjustments
    return Math.max(0.5, Math.min(1.5, volRatio));
  }
  
  private getPortfolioAdjustment(request: PositionSizeRequest): number {
    // Reduce position size if highly correlated with existing positions
    if (!request.correlation) return 1.0;
    
    let totalCorrelation = 0;
    let count = 0;
    
    for (const [symbol, position] of this.positions) {
      if (request.correlation[symbol]) {
        const weightedCorr = Math.abs(request.correlation[symbol]) * position.weight;
        totalCorrelation += weightedCorr;
        count++;
      }
    }
    
    if (count === 0) return 1.0;
    
    const avgCorrelation = totalCorrelation / count;
    // Reduce size for high correlation
    return 1.0 - (avgCorrelation * 0.5); // Max 50% reduction
  }
  
  private applyPositionLimits(symbol: string, size: number, price: number): number {
    const positionValue = size * price;
    const maxPositionValue = this.accountBalance * (this.config.maxPositionSizePercent / 100);
    
    if (positionValue > maxPositionValue) {
      size = maxPositionValue / price;
    }
    
    // Check total exposure
    const newExposure = this.metricsCache.totalExposure + positionValue;
    const maxExposure = this.accountBalance * (this.config.maxTotalExposurePercent / 100);
    
    if (newExposure > maxExposure) {
      const availableExposure = maxExposure - this.metricsCache.totalExposure;
      size = Math.max(0, availableExposure / price);
    }
    
    return size;
  }
  
  private applyRegimeAdjustments(size: number): number {
    switch (this.volatilityRegime) {
      case 'high':
        return size * 0.5; // Reduce size by 50% in high volatility
      case 'low':
        return size * 1.2; // Increase size by 20% in low volatility
      default:
        return size;
    }
  }
  
  private isTradingAllowed(): boolean {
    // Check drawdown limit
    if (this.metricsCache.currentDrawdown > this.config.maxDrawdownPercent) {
      this.logger.error('Max drawdown exceeded - trading halted');
      return false;
    }
    
    // Check daily loss limit
    const dailyLossPercent = (this.metricsCache.dailyPnL / this.dailyStartBalance) * 100;
    if (dailyLossPercent < -this.config.maxDailyLossPercent) {
      this.logger.error('Daily loss limit exceeded - trading halted');
      return false;
    }
    
    // Check risk score
    if (this.metricsCache.riskScore > 80) {
      this.logger.warn('Risk score too high - trading halted');
      return false;
    }
    
    return true;
  }
  
  private countCorrelatedPositions(symbol: string): number {
    // In real implementation, would use actual correlation matrix
    // For now, use simple sector/asset class grouping
    const correlationGroups: Record<string, string[]> = {
      crypto: ['BTC-USD', 'ETH-USD', 'SOL-USD'],
      forex: ['EUR-USD', 'GBP-USD', 'USD-JPY'],
      commodities: ['GC=F', 'CL=F', 'SI=F']
    };
    
    const symbolGroup = Object.entries(correlationGroups).find(([_, symbols]) => 
      symbols.includes(symbol)
    )?.[0];
    
    if (!symbolGroup) return 0;
    
    return Array.from(this.positions.keys()).filter(pos => {
      const posGroup = Object.entries(correlationGroups).find(([_, symbols]) => 
        symbols.includes(pos)
      )?.[0];
      return posGroup === symbolGroup;
    }).length;
  }
  
  private recalculateMetrics(): void {
    // Update exposure
    this.metricsCache.totalExposure = Array.from(this.positions.values())
      .reduce((sum, pos) => sum + pos.size * pos.currentPrice, 0);
    
    // Update position count
    this.metricsCache.positionCount = this.positions.size;
    
    // Update leverage
    this.metricsCache.currentLeverage = this.metricsCache.totalExposure / this.accountBalance;
    
    // Update PnL
    const totalValue = this.accountBalance + Array.from(this.positions.values())
      .reduce((sum, pos) => sum + pos.unrealizedPnL, 0);
    
    // Update drawdown
    if (totalValue > this.highWaterMark) {
      this.highWaterMark = totalValue;
    }
    this.metricsCache.currentDrawdown = ((this.highWaterMark - totalValue) / this.highWaterMark) * 100;
    
    // Update daily PnL
    this.metricsCache.dailyPnL = totalValue - this.dailyStartBalance;
    
    // Calculate VaR (simplified)
    this.metricsCache.valueAtRisk = this.calculateVaR();
    
    // Calculate Sharpe ratio
    this.metricsCache.sharpeRatio = this.calculateSharpeRatio();
    
    // Calculate overall risk score
    this.metricsCache.riskScore = this.calculateRiskScore();
    
    // Emit warnings if needed
    this.checkRiskWarnings();
  }
  
  private calculateVaR(): number {
    if (this.returns.length < 20) return 0;
    
    // Simple historical VaR at 95% confidence
    const sortedReturns = [...this.returns].sort((a, b) => a - b);
    const index = Math.floor(sortedReturns.length * 0.05);
    const var95 = sortedReturns[index];
    
    return Math.abs(var95) * this.metricsCache.totalExposure;
  }
  
  private calculateSharpeRatio(): number {
    if (this.returns.length < 20) return 0;
    
    const avgReturn = this.returns.reduce((a, b) => a + b, 0) / this.returns.length;
    const stdDev = Math.sqrt(
      this.returns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / this.returns.length
    );
    
    const riskFreeRate = 0.02 / 252; // 2% annual risk-free rate
    return stdDev > 0 ? (avgReturn - riskFreeRate) / stdDev * Math.sqrt(252) : 0;
  }
  
  private calculateRiskScore(): number {
    let score = 0;
    
    // Drawdown component (0-30 points)
    score += (this.metricsCache.currentDrawdown / this.config.maxDrawdownPercent) * 30;
    
    // Leverage component (0-20 points)
    score += (this.metricsCache.currentLeverage / this.config.maxLeverage) * 20;
    
    // Volatility regime component (0-20 points)
    score += this.volatilityRegime === 'high' ? 20 : this.volatilityRegime === 'normal' ? 10 : 0;
    
    // Position concentration (0-15 points)
    const largestPosition = Math.max(...Array.from(this.positions.values()).map(p => p.weight));
    score += largestPosition * 15;
    
    // Daily loss component (0-15 points)
    const dailyLossPercent = Math.abs(Math.min(0, this.metricsCache.dailyPnL / this.accountBalance * 100));
    score += (dailyLossPercent / this.config.maxDailyLossPercent) * 15;
    
    return Math.min(100, Math.max(0, score));
  }
  
  private updateVolatilityRegime(): void {
    const avgVolatility = Array.from(this.marketVolatility.values())
      .reduce((sum, v) => sum + v, 0) / Math.max(1, this.marketVolatility.size);
    
    if (avgVolatility > 0.04) {
      this.volatilityRegime = 'high';
    } else if (avgVolatility < 0.01) {
      this.volatilityRegime = 'low';
    } else {
      this.volatilityRegime = 'normal';
    }
  }
  
  private checkRiskWarnings(): void {
    // Drawdown warning
    if (this.metricsCache.currentDrawdown > this.config.maxDrawdownPercent * 0.8) {
      this.emit('risk:warning', {
        type: 'drawdown',
        message: `Approaching max drawdown: ${this.metricsCache.currentDrawdown.toFixed(2)}%`,
        severity: 'high'
      });
    }
    
    // Daily loss warning
    const dailyLossPercent = (this.metricsCache.dailyPnL / this.dailyStartBalance) * 100;
    if (dailyLossPercent < -this.config.maxDailyLossPercent * 0.8) {
      this.emit('risk:warning', {
        type: 'daily_loss',
        message: `Approaching daily loss limit: ${dailyLossPercent.toFixed(2)}%`,
        severity: 'high'
      });
    }
    
    // High risk score warning
    if (this.metricsCache.riskScore > 70) {
      this.emit('risk:warning', {
        type: 'risk_score',
        message: `High risk score: ${this.metricsCache.riskScore.toFixed(0)}`,
        severity: this.metricsCache.riskScore > 85 ? 'critical' : 'high'
      });
    }
    
    // Low Sharpe ratio warning
    if (this.metricsCache.sharpeRatio < this.config.minSharpeRatio && this.returns.length > 50) {
      this.emit('risk:warning', {
        type: 'sharpe_ratio',
        message: `Low Sharpe ratio: ${this.metricsCache.sharpeRatio.toFixed(2)}`,
        severity: 'medium'
      });
    }
  }
  
  private startRiskMonitoring(): void {
    // Monitor risk every second
    setInterval(() => {
      this.recalculateMetrics();
      
      // Check for emergency conditions
      if (this.metricsCache.currentDrawdown > this.config.maxDrawdownPercent) {
        this.emergencyStop('Maximum drawdown exceeded');
      }
      
      const dailyLossPercent = (this.metricsCache.dailyPnL / this.dailyStartBalance) * 100;
      if (dailyLossPercent < -this.config.maxDailyLossPercent) {
        this.emergencyStop('Daily loss limit exceeded');
      }
    }, 1000);
    
    // Reset daily metrics at midnight
    const resetDaily = () => {
      const now = new Date();
      const tomorrow = new Date(now);
      tomorrow.setDate(tomorrow.getDate() + 1);
      tomorrow.setHours(0, 0, 0, 0);
      
      const msUntilMidnight = tomorrow.getTime() - now.getTime();
      
      setTimeout(() => {
        this.dailyStartBalance = this.accountBalance + Array.from(this.positions.values())
          .reduce((sum, pos) => sum + pos.unrealizedPnL, 0);
        this.metricsCache.dailyPnL = 0;
        this.logger.info('Daily risk metrics reset');
        
        resetDaily(); // Schedule next reset
      }, msUntilMidnight);
    };
    
    resetDaily();
  }
  
  // Public method to update returns history
  public addReturn(dailyReturn: number): void {
    this.returns.push(dailyReturn);
    if (this.returns.length > this.RETURNS_WINDOW) {
      this.returns.shift();
    }
  }
  
  // Get position sizing parameters for strategies
  public getPositionSizingParams(): {
    volatilityAdjustment: number;
    regimeAdjustment: number;
    riskBudgetRemaining: number;
  } {
    const maxExposure = this.accountBalance * (this.config.maxTotalExposurePercent / 100);
    const riskBudgetRemaining = (maxExposure - this.metricsCache.totalExposure) / this.accountBalance;
    
    return {
      volatilityAdjustment: this.volatilityRegime === 'high' ? 0.5 : 
                           this.volatilityRegime === 'low' ? 1.2 : 1.0,
      regimeAdjustment: 1.0 - (this.metricsCache.riskScore / 200), // 50% reduction at max risk
      riskBudgetRemaining: Math.max(0, riskBudgetRemaining)
    };
  }
}
