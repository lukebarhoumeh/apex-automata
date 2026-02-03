/**
 * PnL Service - Single Source of Truth
 * 
 * This service is the ONLY place P&L and equity are computed.
 * All other modules (RiskEngine, TradeAnalytics, API endpoints) consume PnLSnapshot from here.
 * 
 * Invariants:
 * - totalEquityUsd = sessionStartEquityUsd + realizedPnlUsd + unrealizedPnlUsd (ALWAYS)
 * - dailyPnlUsd = totalEquityUsd - dayStartEquityUsd
 * - unrealizedPnlUsd = Σ position unrealized P&L (net of entry fees)
 * - realizedPnlUsd = Σ closed trade P&L (net of all fees)
 */

import { EventEmitter } from 'events';
import { Counter, Gauge } from 'prom-client';
import { Logger } from '../../core/logger';
import { Position, PositionTracker } from '../position-tracker';
import {
  PnLSnapshot,
  PnLServiceConfig,
  PositionSnapshot,
  EquityCurvePoint,
  applyPnLConfigDefaults,
} from './pnl-types';

// ============ Prometheus Metrics ============

const pnlSnapshotEmitTotal = new Counter({
  name: 'atlas_pnl_snapshot_emit_total',
  help: 'Total P&L snapshots emitted',
});

const totalEquityGauge = new Gauge({
  name: 'atlas_total_equity_usd',
  help: 'Current total equity in USD',
});

const realizedPnlGauge = new Gauge({
  name: 'atlas_realized_pnl_usd',
  help: 'Session realized P&L in USD',
});

const unrealizedPnlGauge = new Gauge({
  name: 'atlas_unrealized_pnl_usd',
  help: 'Current unrealized P&L in USD',
});

const dailyPnlGauge = new Gauge({
  name: 'atlas_daily_pnl_usd',
  help: 'Daily P&L in USD',
});

// ============ PnL Service ============

export class PnLService extends EventEmitter {
  private config: Required<PnLServiceConfig>;
  private logger: Logger;
  private positionTracker: PositionTracker;

  // State
  private sessionStartEquityUsd: number;
  private dayStartEquityUsd: number;
  private currentRiskDay: string;
  private realizedPnlUsd = 0;
  private unrealizedPnlUsd = 0;
  private lastMarkPrices: Map<string, number> = new Map();

  // Equity curve buffer (ring buffer)
  private equityCurveBuffer: EquityCurvePoint[] = [];
  private bufferIndex = 0;

  // Throttling
  private lastEmitTime = 0;
  private pendingEmit = false;
  private emitTimer: NodeJS.Timeout | null = null;

  // Shutdown
  private isShuttingDown = false;

  constructor(
    config: PnLServiceConfig,
    logger: Logger,
    positionTracker: PositionTracker
  ) {
    super();
    this.config = applyPnLConfigDefaults(config);
    this.logger = logger;
    this.positionTracker = positionTracker;

    this.sessionStartEquityUsd = this.config.sessionStartEquityUsd;
    this.dayStartEquityUsd = this.config.sessionStartEquityUsd;
    this.currentRiskDay = this.getRiskDay();

    // Subscribe to position events
    this.positionTracker.on('position:closed', (position: Position) => {
      this.handlePositionClosed(position);
    });

    this.positionTracker.on('position:opened', (position: Position) => {
      this.handlePositionOpened(position);
    });

    this.positionTracker.on('position:updated', (position: Position) => {
      this.handlePositionUpdated(position);
    });

    this.logger.info('PnLService initialized', {
      sessionId: this.config.sessionId,
      sessionStartEquityUsd: this.sessionStartEquityUsd,
      executionMode: this.config.executionMode,
    });
  }

  // ============ Public API ============

  /**
   * Get the current P&L snapshot (the canonical truth)
   */
  public getSnapshot(): PnLSnapshot {
    const openPositions = this.positionTracker.getOpenPositions();
    const exposureUsd = this.calculateExposure(openPositions);
    const positionsBySymbol = this.buildPositionSnapshots(openPositions);
    
    // Recompute unrealized from positions
    this.unrealizedPnlUsd = this.computeUnrealizedPnl(openPositions);
    
    const totalEquityUsd = this.sessionStartEquityUsd + this.realizedPnlUsd + this.unrealizedPnlUsd;
    const dailyPnlUsd = totalEquityUsd - this.dayStartEquityUsd;
    const riskUnitUsd = this.dayStartEquityUsd * this.config.perTradeRiskFraction;
    const dailyPnlR = riskUnitUsd > 0 ? dailyPnlUsd / riskUnitUsd : 0;

    return {
      ts: Date.now(),
      userId: this.config.userId,
      sessionId: this.config.sessionId,
      executionMode: this.config.executionMode,
      marketDataEnv: this.config.marketDataEnv,

      sessionStartEquityUsd: this.sessionStartEquityUsd,
      dayStartEquityUsd: this.dayStartEquityUsd,
      riskDay: this.currentRiskDay,

      realizedPnlUsd: this.realizedPnlUsd,
      unrealizedPnlUsd: this.unrealizedPnlUsd,
      totalEquityUsd,

      dailyPnlUsd,
      dailyPnlR,
      riskUnitUsd,

      openPositionsCount: openPositions.length,
      exposureUsd,
      lastMarkPriceBySymbol: Object.fromEntries(this.lastMarkPrices),
      positionsBySymbol,
    };
  }

  /**
   * Get the equity curve (for /api/analytics/equity-curve)
   */
  public getEquityCurve(): EquityCurvePoint[] {
    // Return chronologically sorted
    const filled = this.equityCurveBuffer.filter(p => p.ts > 0);
    return filled.sort((a, b) => a.ts - b.ts);
  }

  /**
   * Update mark price for a symbol (call on every market tick)
   */
  public updateMarkPrice(symbol: string, price: number): void {
    this.lastMarkPrices.set(symbol, price);
    this.scheduleEmit();
  }

  /**
   * Bulk update mark prices
   */
  public updateMarkPrices(prices: Record<string, number>): void {
    for (const [symbol, price] of Object.entries(prices)) {
      this.lastMarkPrices.set(symbol, price);
    }
    this.scheduleEmit();
  }

  /**
   * Check for day rollover (call periodically)
   */
  public checkDayRollover(): boolean {
    const newRiskDay = this.getRiskDay();
    if (newRiskDay !== this.currentRiskDay) {
      this.performDayRollover(newRiskDay);
      return true;
    }
    return false;
  }

  /**
   * Set day start equity (for persistence restore)
   */
  public setDayStartEquity(equity: number): void {
    this.dayStartEquityUsd = equity;
    this.logger.info('Day start equity set', { dayStartEquityUsd: equity });
  }

  /**
   * Get session realized P&L (for trade analytics)
   */
  public getSessionRealizedPnl(): number {
    return this.realizedPnlUsd;
  }

  /**
   * Import existing positions at startup (mark-to-market policy)
   */
  public importExistingPositions(positions: Position[]): void {
    if (this.config.startupPositionPolicy !== 'import_mark_to_market') {
      return;
    }

    for (const position of positions) {
      const markPrice = this.lastMarkPrices.get(position.symbol) || position.marketPrice || position.entryPrice;
      
      // Seed entry price to mark so unrealized starts at 0
      this.logger.info('Importing existing position at mark', {
        symbol: position.symbol,
        originalEntry: position.entryPrice,
        markPrice,
        side: position.side,
        size: position.size,
      });
    }

    this.emitSnapshot();
  }

  /**
   * Shutdown
   */
  public shutdown(): void {
    this.isShuttingDown = true;
    if (this.emitTimer) {
      clearTimeout(this.emitTimer);
      this.emitTimer = null;
    }
    this.logger.info('PnLService shutdown');
  }

  // ============ Internal ============

  private handlePositionClosed(position: Position): void {
    const realized = position.realizedPnL || 0;
    this.realizedPnlUsd += realized;

    this.logger.debug('Position closed, realized P&L updated', {
      symbol: position.symbol,
      realizedPnl: realized,
      totalRealizedPnl: this.realizedPnlUsd,
    });

    // Emit immediately on close
    this.emitSnapshot();
  }

  private handlePositionOpened(position: Position): void {
    // Update mark price if available
    if (position.marketPrice) {
      this.lastMarkPrices.set(position.symbol, position.marketPrice);
    }
    this.scheduleEmit();
  }

  private handlePositionUpdated(position: Position): void {
    if (position.marketPrice) {
      this.lastMarkPrices.set(position.symbol, position.marketPrice);
    }
    this.scheduleEmit();
  }

  private computeUnrealizedPnl(positions: Position[]): number {
    let unrealized = 0;

    for (const pos of positions) {
      const markPrice = this.lastMarkPrices.get(pos.symbol) || pos.marketPrice || pos.entryPrice;
      const direction = pos.side === 'long' ? 1 : -1;
      const pnl = (markPrice - pos.entryPrice) * pos.size * direction;
      unrealized += pnl;
    }

    return unrealized;
  }

  private calculateExposure(positions: Position[]): number {
    return positions.reduce((total, pos) => {
      const markPrice = this.lastMarkPrices.get(pos.symbol) || pos.marketPrice || pos.entryPrice;
      return total + Math.abs(pos.size * markPrice);
    }, 0);
  }

  private buildPositionSnapshots(positions: Position[]): Record<string, PositionSnapshot> {
    const result: Record<string, PositionSnapshot> = {};

    for (const pos of positions) {
      const markPrice = this.lastMarkPrices.get(pos.symbol) || pos.marketPrice || pos.entryPrice;
      const direction = pos.side === 'long' ? 1 : -1;
      const unrealizedPnl = (markPrice - pos.entryPrice) * pos.size * direction;

      result[pos.symbol] = {
        symbol: pos.symbol,
        side: pos.side === 'long' ? 'long' : 'short',
        quantity: pos.size,
        entryPrice: pos.entryPrice,
        markPrice,
        unrealizedPnl,
        notional: Math.abs(pos.size * markPrice),
      };
    }

    return result;
  }

  private getRiskDay(): string {
    const now = new Date();
    const adjusted = new Date(now);
    adjusted.setUTCHours(adjusted.getUTCHours() - this.config.riskDayRolloverHour);
    return adjusted.toISOString().split('T')[0];
  }

  private performDayRollover(newRiskDay: string): void {
    const snapshot = this.getSnapshot();
    const previousDay = this.currentRiskDay;

    this.currentRiskDay = newRiskDay;
    this.dayStartEquityUsd = snapshot.totalEquityUsd;

    this.logger.info('P&L day rollover', {
      previousDay,
      newDay: newRiskDay,
      newDayStartEquity: this.dayStartEquityUsd,
    });

    this.emit('pnl:day_rollover', {
      previousDay,
      newDay: newRiskDay,
      dayStartEquityUsd: this.dayStartEquityUsd,
    });

    this.emitSnapshot();
  }

  private scheduleEmit(): void {
    if (this.isShuttingDown) return;

    const now = Date.now();
    const elapsed = now - this.lastEmitTime;

    if (elapsed >= this.config.snapshotThrottleMs) {
      this.emitSnapshot();
    } else if (!this.pendingEmit) {
      this.pendingEmit = true;
      const delay = this.config.snapshotThrottleMs - elapsed;
      this.emitTimer = setTimeout(() => {
        this.pendingEmit = false;
        this.emitSnapshot();
      }, delay);
    }
  }

  private emitSnapshot(): void {
    if (this.isShuttingDown) return;

    const snapshot = this.getSnapshot();
    this.lastEmitTime = Date.now();

    // Update Prometheus metrics
    totalEquityGauge.set(snapshot.totalEquityUsd);
    realizedPnlGauge.set(snapshot.realizedPnlUsd);
    unrealizedPnlGauge.set(snapshot.unrealizedPnlUsd);
    dailyPnlGauge.set(snapshot.dailyPnlUsd);
    pnlSnapshotEmitTotal.inc();

    // Add to equity curve buffer
    this.addToEquityCurve(snapshot);

    // Emit event
    this.emit('pnl:snapshot', snapshot);
  }

  private addToEquityCurve(snapshot: PnLSnapshot): void {
    const point: EquityCurvePoint = {
      ts: snapshot.ts,
      totalEquityUsd: snapshot.totalEquityUsd,
      realizedPnlUsd: snapshot.realizedPnlUsd,
      unrealizedPnlUsd: snapshot.unrealizedPnlUsd,
      dayStartEquityUsd: snapshot.dayStartEquityUsd,
      openPositionsCount: snapshot.openPositionsCount,
    };

    // Ring buffer
    if (this.equityCurveBuffer.length < this.config.equityCurveBufferSize) {
      this.equityCurveBuffer.push(point);
    } else {
      this.equityCurveBuffer[this.bufferIndex] = point;
      this.bufferIndex = (this.bufferIndex + 1) % this.config.equityCurveBufferSize;
    }
  }
}

// ============ Singleton Factory ============

let pnlServiceInstance: PnLService | null = null;

export function getPnLService(): PnLService {
  if (!pnlServiceInstance) {
    throw new Error('PnLService not initialized. Call initPnLService() first.');
  }
  return pnlServiceInstance;
}

export function initPnLService(
  config: PnLServiceConfig,
  logger: Logger,
  positionTracker: PositionTracker
): PnLService {
  if (pnlServiceInstance) {
    return pnlServiceInstance;
  }
  pnlServiceInstance = new PnLService(config, logger, positionTracker);
  return pnlServiceInstance;
}

export function shutdownPnLService(): void {
  if (pnlServiceInstance) {
    pnlServiceInstance.shutdown();
    pnlServiceInstance = null;
  }
}
