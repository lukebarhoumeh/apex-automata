import { EventEmitter } from 'events';
import { Logger } from '../core/logger';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { OrderRequest } from '../exchanges/coinbase';
import { Position, PositionTracker } from './position-tracker';

export interface RiskEngineConfig {
  supabaseUrl: string;
  supabaseKey: string;
  limits: {
    maxPositionSize: number;        // Max USD value per position
    maxTotalExposure: number;       // Max total USD exposure
    maxDailyLoss: number;          // Max daily loss in USD
    maxDrawdown: number;           // Max drawdown in percentage
    maxOrderSize: number;          // Max order size in USD
    minOrderSize: number;          // Min order size in USD
    maxOpenOrders: number;         // Max concurrent open orders
    maxLeverage: number;           // Max leverage allowed
  };
  killSwitches: {
    enabled: boolean;
    dailyLossLimit: number;        // Daily loss limit before shutdown
    consecutiveLossLimit: number;  // Number of consecutive losses
    errorRateLimit: number;        // Error rate percentage
    latencyLimit: number;          // Max latency in ms
  };
  riskPerTrade: number;            // Percentage of capital to risk per trade
  kellyFraction: number;           // Kelly criterion fraction (0.25 = quarter Kelly)
}

export interface RiskCheck {
  passed: boolean;
  reason?: string;
  checks: {
    positionSize: boolean;
    totalExposure: boolean;
    dailyLoss: boolean;
    orderSize: boolean;
    openOrders: boolean;
    killSwitch: boolean;
  };
}

export interface RiskMetrics {
  currentExposure: number;
  dailyPnL: number;
  dailyLossPercentage: number;
  maxDrawdown: number;
  openOrderCount: number;
  consecutiveLosses: number;
  errorRate: number;
  averageLatency: number;
  killSwitchActive: boolean;
  lastUpdated: Date;
}

export interface RiskEngineEvents {
  'risk:check:passed': (orderId: string) => void;
  'risk:check:failed': (orderId: string, reason: string) => void;
  'risk:limit:reached': (limit: string, value: number, threshold: number) => void;
  'risk:killswitch:triggered': (reason: string) => void;
  'risk:metrics:update': (metrics: RiskMetrics) => void;
}

export class RiskEngine extends EventEmitter {
  private config: RiskEngineConfig;
  private logger: Logger;
  private supabase: SupabaseClient;
  private positionTracker: PositionTracker;
  private metrics: RiskMetrics;
  private killSwitchActive = false;
  private dailyStartEquity = 0;
  private orderHistory: Array<{ timestamp: Date; success: boolean }> = [];
  private latencyHistory: number[] = [];
  private metricsUpdateInterval: NodeJS.Timeout | null = null;

  constructor(
    config: RiskEngineConfig,
    logger: Logger,
    positionTracker: PositionTracker
  ) {
    super();
    this.config = config;
    this.logger = logger;
    this.positionTracker = positionTracker;
    this.supabase = createClient(config.supabaseUrl, config.supabaseKey);

    this.metrics = this.initializeMetrics();
    this.startMetricsUpdate();
    this.loadDailyStartEquity();
  }

  private initializeMetrics(): RiskMetrics {
    return {
      currentExposure: 0,
      dailyPnL: 0,
      dailyLossPercentage: 0,
      maxDrawdown: 0,
      openOrderCount: 0,
      consecutiveLosses: 0,
      errorRate: 0,
      averageLatency: 0,
      killSwitchActive: false,
      lastUpdated: new Date()
    };
  }

  private startMetricsUpdate(): void {
    this.metricsUpdateInterval = setInterval(() => {
      this.updateMetrics();
    }, 5000); // Update every 5 seconds
  }

  private async loadDailyStartEquity(): Promise<void> {
    // Load today's starting equity from database
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const { data, error } = await this.supabase
      .from('daily_equity')
      .select('equity')
      .eq('date', today.toISOString().split('T')[0])
      .single();

    if (data) {
      this.dailyStartEquity = data.equity;
    } else {
      // If no record for today, get current equity
      const equity = await this.calculateCurrentEquity();
      this.dailyStartEquity = equity;
      await this.saveDailyStartEquity(equity);
    }
  }

  private async saveDailyStartEquity(equity: number): Promise<void> {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    await this.supabase
      .from('daily_equity')
      .upsert({
        date: today.toISOString().split('T')[0],
        equity,
        created_at: new Date().toISOString()
      });
  }

  private async calculateCurrentEquity(): Promise<number> {
    // Get account balances
    // This is simplified - in production, you'd get actual balances from exchange
    const baseEquity = 50000; // Example starting equity
    const portfolioSummary = this.positionTracker.getPortfolioSummary();
    return baseEquity + portfolioSummary.totalPnL;
  }

  // Pre-trade risk check
  public async checkOrder(order: OrderRequest, currentPrice: number): Promise<RiskCheck> {
    const check: RiskCheck = {
      passed: true,
      checks: {
        positionSize: true,
        totalExposure: true,
        dailyLoss: true,
        orderSize: true,
        openOrders: true,
        killSwitch: true
      }
    };

    // Check if kill switch is active
    if (this.killSwitchActive) {
      check.passed = false;
      check.reason = 'Kill switch is active';
      check.checks.killSwitch = false;
      this.emit('risk:check:failed', order.client_oid || '', check.reason);
      return check;
    }

    const orderValue = this.calculateOrderValue(order, currentPrice);

    // Check minimum order size
    if (orderValue < this.config.limits.minOrderSize) {
      check.passed = false;
      check.reason = `Order size $${orderValue.toFixed(2)} below minimum $${this.config.limits.minOrderSize}`;
      check.checks.orderSize = false;
    }

    // Check maximum order size
    if (orderValue > this.config.limits.maxOrderSize) {
      check.passed = false;
      check.reason = `Order size $${orderValue.toFixed(2)} exceeds maximum $${this.config.limits.maxOrderSize}`;
      check.checks.orderSize = false;
    }

    // Check position size limit
    const position = this.positionTracker.getPosition(order.product_id);
    const currentPositionValue = position ? position.size * position.marketPrice : 0;
    const newPositionValue = currentPositionValue + (order.side === 'buy' ? orderValue : -orderValue);

    if (Math.abs(newPositionValue) > this.config.limits.maxPositionSize) {
      check.passed = false;
      check.reason = `Position size would exceed limit: $${Math.abs(newPositionValue).toFixed(2)} > $${this.config.limits.maxPositionSize}`;
      check.checks.positionSize = false;
    }

    // Check total exposure
    const currentExposure = this.calculateTotalExposure();
    const newExposure = currentExposure + orderValue;

    if (newExposure > this.config.limits.maxTotalExposure) {
      check.passed = false;
      check.reason = `Total exposure would exceed limit: $${newExposure.toFixed(2)} > $${this.config.limits.maxTotalExposure}`;
      check.checks.totalExposure = false;
    }

    // Check daily loss limit
    if (this.metrics.dailyPnL < -this.config.limits.maxDailyLoss) {
      check.passed = false;
      check.reason = `Daily loss limit reached: $${Math.abs(this.metrics.dailyPnL).toFixed(2)}`;
      check.checks.dailyLoss = false;
    }

    // Check open orders limit
    if (this.metrics.openOrderCount >= this.config.limits.maxOpenOrders) {
      check.passed = false;
      check.reason = `Maximum open orders limit reached: ${this.metrics.openOrderCount}`;
      check.checks.openOrders = false;
    }

    // Log risk check result
    if (check.passed) {
      this.emit('risk:check:passed', order.client_oid || '');
    } else {
      this.emit('risk:check:failed', order.client_oid || '', check.reason || 'Unknown');
    }

    return check;
  }

  private calculateOrderValue(order: OrderRequest, currentPrice: number): number {
    if (order.type === 'market') {
      const size = parseFloat(order.size || '0');
      return size * currentPrice;
    } else {
      const size = parseFloat(order.size || '0');
      const price = parseFloat(order.price || '0');
      return size * price;
    }
  }

  private calculateTotalExposure(): number {
    const positions = this.positionTracker.getOpenPositions();
    return positions.reduce((total, position) => {
      return total + Math.abs(position.size * position.marketPrice);
    }, 0);
  }

  // Update risk metrics
  private async updateMetrics(): Promise<void> {
    const positions = this.positionTracker.getPositions();
    const portfolioSummary = this.positionTracker.getPortfolioSummary();

    // Update exposure
    this.metrics.currentExposure = this.calculateTotalExposure();

    // Update daily P&L
    const currentEquity = await this.calculateCurrentEquity();
    this.metrics.dailyPnL = currentEquity - this.dailyStartEquity;
    this.metrics.dailyLossPercentage = (this.metrics.dailyPnL / this.dailyStartEquity) * 100;

    // Calculate max drawdown
    let maxEquity = this.dailyStartEquity;
    let currentDrawdown = 0;
    for (const position of positions) {
      const equity = this.dailyStartEquity + position.totalPnL;
      maxEquity = Math.max(maxEquity, equity);
      currentDrawdown = ((maxEquity - equity) / maxEquity) * 100;
      this.metrics.maxDrawdown = Math.max(this.metrics.maxDrawdown, currentDrawdown);
    }

    // Update error rate
    const recentOrders = this.orderHistory.filter(
      o => o.timestamp > new Date(Date.now() - 3600000) // Last hour
    );
    if (recentOrders.length > 0) {
      const errors = recentOrders.filter(o => !o.success).length;
      this.metrics.errorRate = (errors / recentOrders.length) * 100;
    }

    // Update average latency
    if (this.latencyHistory.length > 0) {
      this.metrics.averageLatency = 
        this.latencyHistory.reduce((a, b) => a + b, 0) / this.latencyHistory.length;
    }

    this.metrics.lastUpdated = new Date();

    // Check kill switches
    this.checkKillSwitches();

    // Emit metrics update
    this.emit('risk:metrics:update', this.metrics);

    // Persist metrics
    await this.persistMetrics();
  }

  private checkKillSwitches(): void {
    if (!this.config.killSwitches.enabled) {
      return;
    }

    // Check daily loss kill switch
    if (Math.abs(this.metrics.dailyPnL) > this.config.killSwitches.dailyLossLimit) {
      this.triggerKillSwitch(`Daily loss limit exceeded: $${Math.abs(this.metrics.dailyPnL).toFixed(2)}`);
    }

    // Check consecutive losses
    if (this.metrics.consecutiveLosses > this.config.killSwitches.consecutiveLossLimit) {
      this.triggerKillSwitch(`Consecutive losses exceeded: ${this.metrics.consecutiveLosses}`);
    }

    // Check error rate
    if (this.metrics.errorRate > this.config.killSwitches.errorRateLimit) {
      this.triggerKillSwitch(`Error rate too high: ${this.metrics.errorRate.toFixed(2)}%`);
    }

    // Check latency
    if (this.metrics.averageLatency > this.config.killSwitches.latencyLimit) {
      this.triggerKillSwitch(`Latency too high: ${this.metrics.averageLatency.toFixed(0)}ms`);
    }
  }

  private triggerKillSwitch(reason: string): void {
    if (this.killSwitchActive) {
      return; // Already triggered
    }

    this.logger.error(`KILL SWITCH TRIGGERED: ${reason}`);
    this.killSwitchActive = true;
    this.metrics.killSwitchActive = true;
    
    this.emit('risk:killswitch:triggered', reason);

    // Close all positions
    this.positionTracker.closeAllPositions().catch(error => {
      this.logger.error('Failed to close positions during kill switch:', error);
    });
  }

  // Calculate position size based on Kelly criterion
  public calculatePositionSize(
    winRate: number,
    avgWin: number,
    avgLoss: number,
    accountEquity: number
  ): number {
    // Kelly formula: f = (p * b - q) / b
    // where: f = fraction of capital to bet
    //        p = probability of winning
    //        q = probability of losing (1 - p)
    //        b = ratio of win to loss

    const p = winRate;
    const q = 1 - winRate;
    const b = avgWin / avgLoss;

    let kellyFraction = (p * b - q) / b;

    // Apply Kelly fraction scaling (quarter Kelly is safer)
    kellyFraction *= this.config.kellyFraction;

    // Apply risk per trade limit
    kellyFraction = Math.min(kellyFraction, this.config.riskPerTrade / 100);

    // Calculate position size
    const positionSize = accountEquity * kellyFraction;

    // Apply limits
    return Math.max(
      this.config.limits.minOrderSize,
      Math.min(positionSize, this.config.limits.maxOrderSize)
    );
  }

  // Record order result for tracking
  public recordOrderResult(orderId: string, success: boolean, latency: number): void {
    this.orderHistory.push({
      timestamp: new Date(),
      success
    });

    // Keep only last 1000 orders
    if (this.orderHistory.length > 1000) {
      this.orderHistory.shift();
    }

    // Track latency
    this.latencyHistory.push(latency);
    if (this.latencyHistory.length > 100) {
      this.latencyHistory.shift();
    }

    // Update consecutive losses
    if (!success) {
      this.metrics.consecutiveLosses++;
    } else {
      this.metrics.consecutiveLosses = 0;
    }
  }

  // Update open order count
  public updateOpenOrderCount(count: number): void {
    this.metrics.openOrderCount = count;
  }

  // Persist metrics to database
  private async persistMetrics(): Promise<void> {
    try {
      const { error } = await this.supabase
        .from('risk_metrics')
        .insert({
          current_exposure: this.metrics.currentExposure,
          daily_pnl: this.metrics.dailyPnL,
          daily_loss_percentage: this.metrics.dailyLossPercentage,
          max_drawdown: this.metrics.maxDrawdown,
          open_order_count: this.metrics.openOrderCount,
          consecutive_losses: this.metrics.consecutiveLosses,
          error_rate: this.metrics.errorRate,
          average_latency: this.metrics.averageLatency,
          kill_switch_active: this.metrics.killSwitchActive,
          timestamp: this.metrics.lastUpdated.toISOString()
        });

      if (error) {
        // Silently ignore if table doesn't exist in development
        if (error.code !== 'PGRST205') {
          this.logger.error('Failed to persist risk metrics:', error);
        }
      }
    } catch (error) {
      this.logger.error('Error persisting risk metrics:', error);
    }
  }

  // Get current risk metrics
  public getMetrics(): RiskMetrics {
    return { ...this.metrics };
  }

  // Reset daily metrics (call at start of trading day)
  public async resetDailyMetrics(): Promise<void> {
    const currentEquity = await this.calculateCurrentEquity();
    this.dailyStartEquity = currentEquity;
    await this.saveDailyStartEquity(currentEquity);

    this.metrics.dailyPnL = 0;
    this.metrics.dailyLossPercentage = 0;
    this.metrics.consecutiveLosses = 0;
    this.metrics.maxDrawdown = 0;

    this.logger.info('Daily risk metrics reset');
  }

  // Manual kill switch control
  public activateKillSwitch(reason: string): void {
    this.triggerKillSwitch(`Manual activation: ${reason}`);
  }

  public deactivateKillSwitch(): void {
    this.killSwitchActive = false;
    this.metrics.killSwitchActive = false;
    this.logger.info('Kill switch deactivated');
  }

  // Cleanup
  public stop(): void {
    if (this.metricsUpdateInterval) {
      clearInterval(this.metricsUpdateInterval);
      this.metricsUpdateInterval = null;
    }
  }
}
