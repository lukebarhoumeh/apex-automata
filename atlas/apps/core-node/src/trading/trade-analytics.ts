import { EventEmitter } from 'events';
import { Counter, Gauge, Histogram, Summary } from 'prom-client';
import { Logger } from '../core/logger';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

// ============================================================================
// Prometheus Metrics - HFT-grade observability
// ============================================================================

// Trade execution metrics
const tradeExecutedCounter = new Counter({
  name: 'atlas_trades_executed_total',
  help: 'Total number of trades executed',
  labelNames: ['symbol', 'side', 'outcome'] as const,
});

const tradeSlippageHistogram = new Histogram({
  name: 'atlas_trade_slippage_bps',
  help: 'Trade slippage in basis points',
  labelNames: ['symbol', 'side'] as const,
  buckets: [-50, -20, -10, -5, -2, 0, 2, 5, 10, 20, 50, 100],
});

const tradePnlHistogram = new Histogram({
  name: 'atlas_trade_pnl_usd',
  help: 'Trade P&L in USD',
  labelNames: ['symbol'] as const,
  buckets: [-500, -200, -100, -50, -20, -10, 0, 10, 20, 50, 100, 200, 500, 1000],
});

const tradeDurationHistogram = new Histogram({
  name: 'atlas_trade_duration_seconds',
  help: 'Trade duration from open to close in seconds',
  labelNames: ['symbol'] as const,
  buckets: [60, 300, 600, 1800, 3600, 7200, 14400, 28800, 86400],
});

const orderLatencyHistogram = new Histogram({
  name: 'atlas_order_latency_ms',
  help: 'Order placement to acknowledgement latency in milliseconds',
  labelNames: ['order_type'] as const,
  buckets: [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000],
});

const fillRatioGauge = new Gauge({
  name: 'atlas_fill_ratio',
  help: 'Ratio of filled size to requested size (1.0 = full fill)',
  labelNames: ['symbol'] as const,
});

// Session-level metrics
const sessionPnlGauge = new Gauge({
  name: 'atlas_session_pnl_usd',
  help: 'Current session P&L in USD',
});

const sessionWinRateGauge = new Gauge({
  name: 'atlas_session_win_rate',
  help: 'Current session win rate (0-1)',
});

const sessionProfitFactorGauge = new Gauge({
  name: 'atlas_session_profit_factor',
  help: 'Current session profit factor (gross profit / gross loss)',
});

const sessionSharpeGauge = new Gauge({
  name: 'atlas_session_sharpe_estimate',
  help: 'Intraday Sharpe ratio estimate',
});

const sessionMaxDrawdownGauge = new Gauge({
  name: 'atlas_session_max_drawdown_usd',
  help: 'Maximum drawdown in USD during session',
});

const sessionTradeCountGauge = new Gauge({
  name: 'atlas_session_trade_count',
  help: 'Total trades in current session',
});

// System health metrics
const tickProcessingLagHistogram = new Histogram({
  name: 'atlas_tick_processing_lag_ms',
  help: 'Lag between tick receipt and processing completion',
  buckets: [0.1, 0.5, 1, 2, 5, 10, 25, 50, 100, 250],
});

const memoryUsageGauge = new Gauge({
  name: 'atlas_memory_usage_bytes',
  help: 'Current memory usage in bytes',
  labelNames: ['type'] as const,
});

const eventQueueDepthGauge = new Gauge({
  name: 'atlas_event_queue_depth',
  help: 'Number of pending events in processing queue',
  labelNames: ['queue_type'] as const,
});

// ============================================================================
// Types
// ============================================================================

export interface TradeRecord {
  id: string;
  symbol: string;
  side: 'long' | 'short';
  entryTime: Date;
  exitTime?: Date;
  entryPrice: number;
  exitPrice?: number;
  size: number;
  realizedPnl?: number;
  unrealizedPnl: number;
  fees: number;
  slippageBps?: number;
  duration?: number; // seconds
  outcome?: 'win' | 'loss' | 'breakeven';
  strategy?: string;
  signalId?: string;
  exitReason?: string;
  reasonCode?: string;
  entryOrderId?: string;
  exitOrderId?: string;
  maxFavorableExcursion?: number; // MFE in USD
  maxAdverseExcursion?: number;   // MAE in USD
}

export interface SessionStats {
  sessionId: string;
  startTime: Date;
  endTime?: Date;
  mode: 'paper' | 'live';
  
  // P&L metrics
  totalPnl: number;
  grossProfit: number;
  grossLoss: number;
  netProfit: number;
  
  // Trade counts
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  breakEvenTrades: number;
  
  // Ratios
  winRate: number;
  profitFactor: number;
  payoffRatio: number; // avg win / avg loss
  expectancy: number;  // (win_rate * avg_win) - (loss_rate * avg_loss)
  
  // Average metrics
  avgWin: number;
  avgLoss: number;
  avgTrade: number;
  avgDuration: number;
  avgSlippageBps: number;
  
  // Risk metrics
  maxDrawdown: number;
  maxDrawdownPct: number;
  sharpeEstimate: number;
  sortinoEstimate: number;
  calmarEstimate: number;
  
  // Execution quality
  avgFillRatio: number;
  avgOrderLatencyMs: number;
  
  // Equity curve
  equityCurve: Array<{ timestamp: number; equity: number; pnl: number }>;
  highWaterMark: number;
}

export interface EquityPoint {
  timestamp: number;
  equity: number;
  pnl: number;
  tradeId?: string;
}

export interface TradeAnalyticsConfig {
  supabaseUrl: string;
  supabaseKey: string;
  userId?: string;
  initialEquity: number;
  mode: 'paper' | 'live';
  equitySampleIntervalMs: number; // How often to sample equity curve
}

// ============================================================================
// TradeAnalytics Class
// ============================================================================

export class TradeAnalytics extends EventEmitter {
  private config: TradeAnalyticsConfig;
  private logger: Logger;
  private supabase: SupabaseClient;
  
  // Session state
  private sessionId: string;
  private sessionStartTime: Date;
  private trades: Map<string, TradeRecord> = new Map();
  private closedTrades: TradeRecord[] = [];
  private equityCurve: EquityPoint[] = [];
  private currentEquity: number;
  private highWaterMark: number;
  private maxDrawdown: number = 0;
  
  // Running statistics (efficient online calculation)
  private sumPnl: number = 0;
  private sumPnlSquared: number = 0; // For variance calculation
  private sumNegativePnlSquared: number = 0; // For Sortino
  private grossProfit: number = 0;
  private grossLoss: number = 0;
  private sumSlippage: number = 0;
  private sumDuration: number = 0;
  private sumOrderLatency: number = 0;
  private orderLatencyCount: number = 0;
  private sumFillRatio: number = 0;
  private fillRatioCount: number = 0;
  
  // Tick processing metrics
  private tickProcessingStart: number = 0;
  private tickCount: number = 0;
  
  // Memory monitoring
  private memoryMonitorInterval: NodeJS.Timeout | null = null;
  private equitySampleInterval: NodeJS.Timeout | null = null;

  constructor(config: TradeAnalyticsConfig, logger: Logger) {
    super();
    this.config = config;
    this.logger = logger;
    this.supabase = createClient(config.supabaseUrl, config.supabaseKey);
    
    this.sessionId = this.generateSessionId();
    this.sessionStartTime = new Date();
    this.currentEquity = config.initialEquity;
    this.highWaterMark = config.initialEquity;
    
    // Start monitoring
    this.startMemoryMonitor();
    this.startEquitySampler();
    
    this.logger.info('TradeAnalytics initialized', {
      sessionId: this.sessionId,
      initialEquity: config.initialEquity,
      mode: config.mode,
    });
  }
  
  private generateSessionId(): string {
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');
    const timeStr = now.toISOString().slice(11, 19).replace(/:/g, '');
    const random = Math.random().toString(36).slice(2, 6);
    return `${this.config.mode}-${dateStr}-${timeStr}-${random}`;
  }
  
  // ============================================================================
  // Trade Lifecycle
  // ============================================================================
  
  /**
   * Record a new trade entry.
   */
  public recordEntry(params: {
    tradeId: string;
    symbol: string;
    side: 'long' | 'short';
    entryPrice: number;
    size: number;
    expectedPrice?: number;
    strategy?: string;
    signalId?: string;
    reasonCode?: string;
    entryOrderId?: string;
  }): void {
    const slippageBps = params.expectedPrice 
      ? ((params.entryPrice - params.expectedPrice) / params.expectedPrice) * 10000
      : undefined;
    
    // Adjust slippage sign for side (positive = unfavorable)
    const adjustedSlippage = slippageBps !== undefined
      ? (params.side === 'long' ? slippageBps : -slippageBps)
      : undefined;
    
    const trade: TradeRecord = {
      id: params.tradeId,
      symbol: params.symbol,
      side: params.side,
      entryTime: new Date(),
      entryPrice: params.entryPrice,
      size: params.size,
      fees: 0,
      unrealizedPnl: 0,
      slippageBps: adjustedSlippage,
      strategy: params.strategy,
      signalId: params.signalId,
      reasonCode: params.reasonCode,
      entryOrderId: params.entryOrderId,
      maxFavorableExcursion: 0,
      maxAdverseExcursion: 0,
    };
    
    this.trades.set(params.tradeId, trade);
    
    // Record slippage metric
    if (adjustedSlippage !== undefined) {
      tradeSlippageHistogram.observe({ symbol: params.symbol, side: params.side }, adjustedSlippage);
    }
    
    this.emit('trade:opened', trade);
    
    this.logger.debug('Trade entry recorded', {
      tradeId: params.tradeId,
      symbol: params.symbol,
      side: params.side,
      price: params.entryPrice,
      slippageBps: adjustedSlippage,
    });
  }
  
  /**
   * Update an open trade with current market price (for MFE/MAE tracking).
   */
  public updateOpenTrade(tradeId: string, currentPrice: number, fees?: number): void {
    const trade = this.trades.get(tradeId);
    if (!trade) return;
    
    // Calculate unrealized P&L
    const priceDelta = currentPrice - trade.entryPrice;
    const unrealized = trade.side === 'long' 
      ? trade.size * priceDelta
      : -trade.size * priceDelta;
    
    trade.unrealizedPnl = unrealized - (trade.fees + (fees ?? 0));
    
    if (fees !== undefined) {
      trade.fees += fees;
    }
    
    // Track MFE/MAE
    if (unrealized > 0) {
      trade.maxFavorableExcursion = Math.max(trade.maxFavorableExcursion ?? 0, unrealized);
    } else {
      trade.maxAdverseExcursion = Math.max(trade.maxAdverseExcursion ?? 0, Math.abs(unrealized));
    }
  }
  
  /**
   * Record a trade exit.
   */
  public recordExit(params: {
    tradeId: string;
    exitPrice: number;
    realizedPnl: number;
    fees: number;
    exitReason?: string;
    expectedPrice?: number;
    exitOrderId?: string;
  }): void {
    const trade = this.trades.get(params.tradeId);
    if (!trade) {
      this.logger.warn('Trade not found for exit', { tradeId: params.tradeId });
      return;
    }
    
    const exitTime = new Date();
    const duration = (exitTime.getTime() - trade.entryTime.getTime()) / 1000;
    
    // Calculate exit slippage
    const exitSlippageBps = params.expectedPrice
      ? ((params.exitPrice - params.expectedPrice) / params.expectedPrice) * 10000
      : undefined;
    
    // Adjust for side (positive = unfavorable)
    const adjustedExitSlippage = exitSlippageBps !== undefined
      ? (trade.side === 'long' ? -exitSlippageBps : exitSlippageBps)
      : undefined;
    
    // Combine entry and exit slippage
    const totalSlippage = (trade.slippageBps ?? 0) + (adjustedExitSlippage ?? 0);
    
    // Determine outcome
    let outcome: 'win' | 'loss' | 'breakeven';
    if (params.realizedPnl > 0.01) {
      outcome = 'win';
    } else if (params.realizedPnl < -0.01) {
      outcome = 'loss';
    } else {
      outcome = 'breakeven';
    }
    
    // Update trade record
    trade.exitTime = exitTime;
    trade.exitPrice = params.exitPrice;
    trade.realizedPnl = params.realizedPnl;
    trade.fees += params.fees;
    trade.duration = duration;
    trade.slippageBps = totalSlippage;
    trade.outcome = outcome;
    trade.exitReason = params.exitReason;
    trade.exitOrderId = params.exitOrderId;
    trade.unrealizedPnl = 0;
    
    // Move to closed trades
    this.trades.delete(params.tradeId);
    this.closedTrades.push(trade);
    
    // Update equity FIRST so HWM/drawdown calculation is accurate
    this.currentEquity += params.realizedPnl;
    
    // Update running statistics (uses currentEquity for HWM/drawdown)
    this.updateStatistics(trade);
    
    // Add to equity curve
    this.addEquityPoint(params.realizedPnl, params.tradeId);
    
    // Update Prometheus metrics
    tradeExecutedCounter.inc({ symbol: trade.symbol, side: trade.side, outcome });
    tradePnlHistogram.observe({ symbol: trade.symbol }, params.realizedPnl);
    tradeDurationHistogram.observe({ symbol: trade.symbol }, duration);
    
    if (adjustedExitSlippage !== undefined) {
      tradeSlippageHistogram.observe({ symbol: trade.symbol, side: trade.side }, adjustedExitSlippage);
    }
    
    // Update session gauges
    this.updateSessionGauges();
    
    // Persist to database
    this.persistTrade(trade).catch(err => {
      this.logger.error('Failed to persist trade:', err);
    });
    
    this.emit('trade:closed', trade);
    
    this.logger.info('Trade exit recorded', {
      tradeId: params.tradeId,
      symbol: trade.symbol,
      side: trade.side,
      pnl: params.realizedPnl,
      duration,
      outcome,
      exitReason: params.exitReason,
    });
  }
  
  // ============================================================================
  // Statistics Calculation
  // ============================================================================
  
  private updateStatistics(trade: TradeRecord): void {
    const pnl = trade.realizedPnl ?? 0;
    
    // Running totals for variance calculation (Welford's algorithm)
    this.sumPnl += pnl;
    this.sumPnlSquared += pnl * pnl;
    
    if (pnl < 0) {
      this.sumNegativePnlSquared += pnl * pnl;
    }
    
    // Gross profit/loss
    if (pnl > 0) {
      this.grossProfit += pnl;
    } else {
      this.grossLoss += Math.abs(pnl);
    }
    
    // Slippage
    if (trade.slippageBps !== undefined) {
      this.sumSlippage += trade.slippageBps;
    }
    
    // Duration
    if (trade.duration !== undefined) {
      this.sumDuration += trade.duration;
    }
    
    // Update high water mark and drawdown
    if (this.currentEquity > this.highWaterMark) {
      this.highWaterMark = this.currentEquity;
    }
    
    const drawdown = this.highWaterMark - this.currentEquity;
    if (drawdown > this.maxDrawdown) {
      this.maxDrawdown = drawdown;
    }
  }
  
  private updateSessionGauges(): void {
    const stats = this.getSessionStats();
    
    sessionPnlGauge.set(stats.totalPnl);
    sessionWinRateGauge.set(stats.winRate);
    sessionProfitFactorGauge.set(Number.isFinite(stats.profitFactor) ? stats.profitFactor : 0);
    sessionSharpeGauge.set(Number.isFinite(stats.sharpeEstimate) ? stats.sharpeEstimate : 0);
    sessionMaxDrawdownGauge.set(stats.maxDrawdown);
    sessionTradeCountGauge.set(stats.totalTrades);
  }
  
  /**
   * Get current session statistics.
   */
  public getSessionStats(): SessionStats {
    const n = this.closedTrades.length;
    
    const winningTrades = this.closedTrades.filter(t => t.outcome === 'win').length;
    const losingTrades = this.closedTrades.filter(t => t.outcome === 'loss').length;
    const breakEvenTrades = this.closedTrades.filter(t => t.outcome === 'breakeven').length;
    
    const winRate = n > 0 ? winningTrades / n : 0;
    const lossRate = n > 0 ? losingTrades / n : 0;
    
    const avgWin = winningTrades > 0 ? this.grossProfit / winningTrades : 0;
    const avgLoss = losingTrades > 0 ? this.grossLoss / losingTrades : 0;
    const avgTrade = n > 0 ? this.sumPnl / n : 0;
    
    const profitFactor = this.grossLoss > 0 ? this.grossProfit / this.grossLoss : Infinity;
    const payoffRatio = avgLoss > 0 ? avgWin / avgLoss : Infinity;
    const expectancy = (winRate * avgWin) - (lossRate * avgLoss);
    
    // Variance and Sharpe calculation
    let variance = 0;
    let sharpeEstimate = 0;
    let sortinoEstimate = 0;
    
    if (n > 1) {
      variance = (this.sumPnlSquared - (this.sumPnl * this.sumPnl) / n) / (n - 1);
      const stdDev = Math.sqrt(variance);
      
      if (stdDev > 0) {
        // Annualized assuming ~252 trading days, scale by sqrt(n) for sample size
        sharpeEstimate = (avgTrade / stdDev) * Math.sqrt(Math.min(n, 252));
      }
      
      // Sortino (downside deviation)
      const downsideVariance = this.sumNegativePnlSquared / n;
      const downsideDeviation = Math.sqrt(downsideVariance);
      if (downsideDeviation > 0) {
        sortinoEstimate = (avgTrade / downsideDeviation) * Math.sqrt(Math.min(n, 252));
      }
    }
    
    // Calmar ratio
    const maxDrawdownPct = this.highWaterMark > 0 
      ? (this.maxDrawdown / this.highWaterMark) * 100 
      : 0;
    const calmarEstimate = this.maxDrawdown > 0 ? this.sumPnl / this.maxDrawdown : 0;
    
    return {
      sessionId: this.sessionId,
      startTime: this.sessionStartTime,
      mode: this.config.mode,
      
      totalPnl: this.sumPnl,
      grossProfit: this.grossProfit,
      grossLoss: this.grossLoss,
      netProfit: this.grossProfit - this.grossLoss,
      
      totalTrades: n,
      winningTrades,
      losingTrades,
      breakEvenTrades,
      
      winRate,
      profitFactor,
      payoffRatio,
      expectancy,
      
      avgWin,
      avgLoss,
      avgTrade,
      avgDuration: n > 0 ? this.sumDuration / n : 0,
      avgSlippageBps: n > 0 ? this.sumSlippage / n : 0,
      
      maxDrawdown: this.maxDrawdown,
      maxDrawdownPct,
      sharpeEstimate,
      sortinoEstimate,
      calmarEstimate,
      
      avgFillRatio: this.fillRatioCount > 0 ? this.sumFillRatio / this.fillRatioCount : 1,
      avgOrderLatencyMs: this.orderLatencyCount > 0 ? this.sumOrderLatency / this.orderLatencyCount : 0,
      
      equityCurve: [...this.equityCurve],
      highWaterMark: this.highWaterMark,
    };
  }
  
  /**
   * Get recent closed trades.
   */
  public getRecentTrades(limit: number = 50): TradeRecord[] {
    return this.closedTrades.slice(-limit);
  }
  
  /**
   * Get open trades.
   */
  public getOpenTrades(): TradeRecord[] {
    return Array.from(this.trades.values());
  }
  
  /**
   * Get equity curve data.
   */
  public getEquityCurve(): EquityPoint[] {
    return [...this.equityCurve];
  }
  
  // ============================================================================
  // Execution Quality Tracking
  // ============================================================================
  
  /**
   * Record order placement latency.
   */
  public recordOrderLatency(latencyMs: number, orderType: string = 'market'): void {
    orderLatencyHistogram.observe({ order_type: orderType }, latencyMs);
    this.sumOrderLatency += latencyMs;
    this.orderLatencyCount++;
  }
  
  /**
   * Record fill ratio (filled size / requested size).
   */
  public recordFillRatio(symbol: string, ratio: number): void {
    fillRatioGauge.set({ symbol }, ratio);
    this.sumFillRatio += ratio;
    this.fillRatioCount++;
  }
  
  // ============================================================================
  // System Metrics
  // ============================================================================
  
  /**
   * Start tick processing timer (call before processing).
   */
  public startTickProcessing(): void {
    this.tickProcessingStart = performance.now();
  }
  
  /**
   * End tick processing timer (call after processing complete).
   */
  public endTickProcessing(): void {
    if (this.tickProcessingStart > 0) {
      const lag = performance.now() - this.tickProcessingStart;
      tickProcessingLagHistogram.observe(lag);
      this.tickProcessingStart = 0;
      this.tickCount++;
    }
  }
  
  /**
   * Record event queue depth.
   */
  public recordQueueDepth(queueType: string, depth: number): void {
    eventQueueDepthGauge.set({ queue_type: queueType }, depth);
  }
  
  private startMemoryMonitor(): void {
    this.memoryMonitorInterval = setInterval(() => {
      const usage = process.memoryUsage();
      memoryUsageGauge.set({ type: 'heapUsed' }, usage.heapUsed);
      memoryUsageGauge.set({ type: 'heapTotal' }, usage.heapTotal);
      memoryUsageGauge.set({ type: 'rss' }, usage.rss);
      memoryUsageGauge.set({ type: 'external' }, usage.external);
    }, 5000); // Every 5 seconds
  }
  
  private startEquitySampler(): void {
    // Sample equity curve at regular intervals (in addition to trade-triggered samples)
    this.equitySampleInterval = setInterval(() => {
      this.addEquityPoint(0); // Sample with no P&L change
    }, this.config.equitySampleIntervalMs);
  }
  
  private addEquityPoint(pnlDelta: number, tradeId?: string): void {
    const point: EquityPoint = {
      timestamp: Date.now(),
      equity: this.currentEquity,
      pnl: this.sumPnl,
      tradeId,
    };
    
    this.equityCurve.push(point);
    
    // Keep last 24 hours of data (at 1-minute intervals = ~1440 points)
    const maxPoints = 1440;
    if (this.equityCurve.length > maxPoints) {
      this.equityCurve.shift();
    }
  }
  
  // ============================================================================
  // Persistence
  // ============================================================================
  
  private async persistTrade(trade: TradeRecord): Promise<void> {
    if (!this.config.userId) {
      return;
    }
    
    try {
      const record = {
        id: trade.id,
        user_id: this.config.userId,
        session_id: this.sessionId,
        symbol: trade.symbol,
        side: trade.side,
        entry_time: trade.entryTime.toISOString(),
        exit_time: trade.exitTime?.toISOString(),
        entry_price: trade.entryPrice,
        exit_price: trade.exitPrice,
        size: trade.size,
        realized_pnl: trade.realizedPnl,
        fees: trade.fees,
        slippage_bps: trade.slippageBps,
        duration_seconds: trade.duration,
        outcome: trade.outcome,
        strategy: trade.strategy,
        signal_id: trade.signalId,
        exit_reason: trade.exitReason,
        reason_code: trade.reasonCode,
        entry_order_id: trade.entryOrderId,
        exit_order_id: trade.exitOrderId,
        max_favorable_excursion: trade.maxFavorableExcursion,
        max_adverse_excursion: trade.maxAdverseExcursion,
        created_at: new Date().toISOString(),
      };
      
      const { error } = await this.supabase
        .from('trade_log')
        .upsert(record, { onConflict: 'id' });
      
      if (error && error.code !== '42P01') { // Ignore table not exists
        this.logger.warn('Failed to persist trade to database:', error);
      }
    } catch (err) {
      this.logger.warn('Error persisting trade:', err);
    }
  }
  
  /**
   * Persist session summary to database.
   */
  public async persistSessionSummary(): Promise<void> {
    if (!this.config.userId) {
      return;
    }
    
    try {
      const stats = this.getSessionStats();
      
      const record = {
        session_id: this.sessionId,
        user_id: this.config.userId,
        mode: this.config.mode,
        start_time: stats.startTime.toISOString(),
        end_time: new Date().toISOString(),
        initial_equity: this.config.initialEquity,
        final_equity: this.currentEquity,
        total_pnl: stats.totalPnl,
        gross_profit: stats.grossProfit,
        gross_loss: stats.grossLoss,
        total_trades: stats.totalTrades,
        winning_trades: stats.winningTrades,
        losing_trades: stats.losingTrades,
        win_rate: stats.winRate,
        profit_factor: Number.isFinite(stats.profitFactor) ? stats.profitFactor : null,
        avg_win: stats.avgWin,
        avg_loss: stats.avgLoss,
        expectancy: stats.expectancy,
        max_drawdown: stats.maxDrawdown,
        max_drawdown_pct: stats.maxDrawdownPct,
        sharpe_estimate: stats.sharpeEstimate,
        avg_duration_seconds: stats.avgDuration,
        avg_slippage_bps: stats.avgSlippageBps,
        created_at: new Date().toISOString(),
      };
      
      const { error } = await this.supabase
        .from('trading_sessions')
        .upsert(record, { onConflict: 'session_id' });
      
      if (error && error.code !== '42P01') {
        this.logger.warn('Failed to persist session summary:', error);
      }
    } catch (err) {
      this.logger.warn('Error persisting session summary:', err);
    }
  }
  
  // ============================================================================
  // Cleanup
  // ============================================================================
  
  public async stop(): Promise<void> {
    if (this.memoryMonitorInterval) {
      clearInterval(this.memoryMonitorInterval);
      this.memoryMonitorInterval = null;
    }
    
    if (this.equitySampleInterval) {
      clearInterval(this.equitySampleInterval);
      this.equitySampleInterval = null;
    }
    
    // Persist final session summary
    await this.persistSessionSummary();
    
    this.logger.info('TradeAnalytics stopped', {
      sessionId: this.sessionId,
      totalTrades: this.closedTrades.length,
      totalPnl: this.sumPnl,
    });
  }
}

