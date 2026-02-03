/**
 * Risk Math - Canonical Computation Layer
 * 
 * Single source of truth for all risk calculations.
 * Eliminates inconsistency across modules.
 * 
 * Key concepts:
 * - R ("risk unit"): The dollar amount risked per trade (1R)
 * - Daily P&L in R: How many R units gained/lost today
 * - Equity: Starting equity + net P&L
 * 
 * IMPORTANT: per_trade_risk is a FRACTION (e.g., 0.01 = 1%)
 * NOT a percentage. This module enforces consistent interpretation.
 */

import { Logger } from '../core/logger';

/**
 * Risk math snapshot (computed on each tick)
 */
export interface RiskSnapshot {
  /** Starting equity for the risk day (frozen at day start) */
  dayStartEquityUsd: number;
  
  /** Current equity (start + net P&L) */
  currentEquityUsd: number;
  
  /** Realized P&L from closed trades (USD) */
  realizedPnlUsd: number;
  
  /** Unrealized P&L from open positions (USD) */
  unrealizedPnlUsd: number;
  
  /** Net P&L (realized + unrealized) */
  netPnlUsd: number;
  
  /** Daily P&L (current equity - day start equity) */
  dailyPnlUsd: number;
  
  /** Risk unit in USD ("1R" = per_trade_risk * dayStartEquity) */
  riskUnitUsd: number;
  
  /** Daily P&L in R units */
  dailyPnlR: number;
  
  /** Current drawdown from intraday high (USD) */
  drawdownUsd: number;
  
  /** Current drawdown from intraday high (percent) */
  drawdownPct: number;
  
  /** Intraday high water mark */
  intradayHighUsd: number;
  
  /** Timestamp of this snapshot */
  timestamp: number;
}

/**
 * Risk math configuration
 */
export interface RiskMathConfig {
  /** Account equity (starting capital) */
  accountEquityUsd: number;
  
  /** 
   * Per-trade risk as a FRACTION (0.01 = 1%).
   * This is the fraction of equity risked per trade.
   */
  perTradeRiskFraction: number;
  
  /** Logger */
  logger: Logger;
}

/**
 * Validate that perTradeRisk is a fraction, not a percentage
 */
export function validatePerTradeRisk(value: number, source: string, logger: Logger): number {
  if (!Number.isFinite(value)) {
    logger.error(`Invalid per_trade_risk from ${source}: not a number`, { value });
    return 0.01; // Safe default
  }
  
  // Catch common "percentage instead of fraction" mistake
  if (value >= 1) {
    logger.error(`RISK_MATH_ERROR: per_trade_risk from ${source} is >= 1 (got ${value}). ` +
      `This looks like a percentage, not a fraction. Expected 0.01 for 1%, not 1.0 or 100.`);
    
    // Auto-correct if it looks like a percentage
    if (value <= 100) {
      const corrected = value / 100;
      logger.warn(`Auto-correcting per_trade_risk from ${value} to ${corrected}`);
      return corrected;
    }
    
    return 0.01; // Safe default
  }
  
  // Sanity check: should be between 0.001 (0.1%) and 0.1 (10%)
  if (value < 0.001 || value > 0.1) {
    logger.warn(`per_trade_risk from ${source} is ${value} (${(value * 100).toFixed(2)}%). ` +
      `This is outside typical range [0.1% - 10%].`);
  }
  
  return value;
}

/**
 * Risk Math Calculator
 * 
 * Produces consistent risk snapshots for kill switch decisions,
 * API status payloads, and persisted metrics.
 */
export class RiskMath {
  private config: RiskMathConfig;
  private logger: Logger;
  
  // State
  private dayStartEquityUsd: number;
  private intradayHighUsd: number;
  private currentSnapshot: RiskSnapshot | null = null;
  
  // Validated per-trade risk
  private perTradeRiskFraction: number;

  constructor(config: RiskMathConfig) {
    this.config = config;
    this.logger = config.logger;
    
    // Validate per-trade risk
    this.perTradeRiskFraction = validatePerTradeRisk(
      config.perTradeRiskFraction,
      'RiskMath constructor',
      this.logger
    );
    
    // Initialize day start
    this.dayStartEquityUsd = config.accountEquityUsd;
    this.intradayHighUsd = config.accountEquityUsd;
    
    this.logger.info('RiskMath initialized', {
      accountEquityUsd: config.accountEquityUsd,
      perTradeRiskFraction: this.perTradeRiskFraction,
      perTradeRiskPercent: (this.perTradeRiskFraction * 100).toFixed(2) + '%',
      riskUnitUsd: this.computeRiskUnit(),
    });
  }

  // ============ Core Computations ============

  /**
   * Compute risk unit (1R in USD)
   */
  public computeRiskUnit(): number {
    return this.dayStartEquityUsd * this.perTradeRiskFraction;
  }

  /**
   * Get validated per-trade risk fraction
   */
  public getPerTradeRiskFraction(): number {
    return this.perTradeRiskFraction;
  }

  /**
   * Get per-trade risk as percentage (for display)
   */
  public getPerTradeRiskPercent(): number {
    return this.perTradeRiskFraction * 100;
  }

  /**
   * Convert USD to R units
   */
  public usdToR(usd: number): number {
    const riskUnit = this.computeRiskUnit();
    if (riskUnit <= 0) return 0;
    return usd / riskUnit;
  }

  /**
   * Convert R units to USD
   */
  public rToUsd(r: number): number {
    return r * this.computeRiskUnit();
  }

  /**
   * Compute a full risk snapshot
   */
  public computeSnapshot(
    realizedPnlUsd: number,
    unrealizedPnlUsd: number
  ): RiskSnapshot {
    const netPnlUsd = realizedPnlUsd + unrealizedPnlUsd;
    const currentEquityUsd = this.dayStartEquityUsd + netPnlUsd;
    const dailyPnlUsd = currentEquityUsd - this.dayStartEquityUsd;
    const riskUnitUsd = this.computeRiskUnit();
    const dailyPnlR = riskUnitUsd > 0 ? dailyPnlUsd / riskUnitUsd : 0;
    
    // Update intraday high
    if (currentEquityUsd > this.intradayHighUsd) {
      this.intradayHighUsd = currentEquityUsd;
    }
    
    // Compute drawdown
    const drawdownUsd = this.intradayHighUsd - currentEquityUsd;
    const drawdownPct = this.intradayHighUsd > 0 ? drawdownUsd / this.intradayHighUsd : 0;
    
    const snapshot: RiskSnapshot = {
      dayStartEquityUsd: this.dayStartEquityUsd,
      currentEquityUsd,
      realizedPnlUsd,
      unrealizedPnlUsd,
      netPnlUsd,
      dailyPnlUsd,
      riskUnitUsd,
      dailyPnlR,
      drawdownUsd,
      drawdownPct,
      intradayHighUsd: this.intradayHighUsd,
      timestamp: Date.now(),
    };
    
    this.currentSnapshot = snapshot;
    return snapshot;
  }

  /**
   * Get the most recent snapshot
   */
  public getSnapshot(): RiskSnapshot | null {
    return this.currentSnapshot;
  }

  // ============ Threshold Checks ============

  /**
   * Check if daily stop threshold is exceeded
   * 
   * @param thresholdR - Threshold in R (e.g., -2.0 for -2R)
   */
  public isDailyStopTriggered(thresholdR: number): boolean {
    if (!this.currentSnapshot) return false;
    // Threshold is typically negative (e.g., -2.0 means lose 2R)
    // Daily P&L R is negative when losing
    // Triggered when dailyPnlR <= thresholdR (more negative)
    return this.currentSnapshot.dailyPnlR <= thresholdR;
  }

  /**
   * Check if max drawdown threshold is exceeded
   * 
   * @param thresholdPct - Threshold as fraction (e.g., 0.05 for 5%)
   */
  public isMaxDrawdownTriggered(thresholdPct: number): boolean {
    if (!this.currentSnapshot) return false;
    return this.currentSnapshot.drawdownPct >= thresholdPct;
  }

  // ============ Day Management ============

  /**
   * Reset for new risk day
   */
  public resetForNewDay(newDayStartEquityUsd: number): void {
    this.logger.info('RiskMath day reset', {
      previousDayStartEquity: this.dayStartEquityUsd,
      newDayStartEquity: newDayStartEquityUsd,
    });
    
    this.dayStartEquityUsd = newDayStartEquityUsd;
    this.intradayHighUsd = newDayStartEquityUsd;
    this.currentSnapshot = null;
  }

  /**
   * Set day start equity (on startup or from database)
   */
  public setDayStartEquity(equity: number): void {
    this.dayStartEquityUsd = equity;
    if (this.intradayHighUsd < equity) {
      this.intradayHighUsd = equity;
    }
  }

  /**
   * Get day start equity
   */
  public getDayStartEquity(): number {
    return this.dayStartEquityUsd;
  }

  // ============ Status for API ============

  /**
   * Get status for API response
   */
  public getStatus(): {
    dayStartEquityUsd: number;
    riskUnitUsd: number;
    perTradeRiskPct: number;
    dailyPnlUsd: number;
    dailyPnlR: number;
    realizedPnlUsd: number;
    unrealizedPnlUsd: number;
    drawdownPct: number;
  } {
    const snapshot = this.currentSnapshot;
    
    return {
      dayStartEquityUsd: this.dayStartEquityUsd,
      riskUnitUsd: this.computeRiskUnit(),
      perTradeRiskPct: this.perTradeRiskFraction * 100,
      dailyPnlUsd: snapshot?.dailyPnlUsd ?? 0,
      dailyPnlR: snapshot?.dailyPnlR ?? 0,
      realizedPnlUsd: snapshot?.realizedPnlUsd ?? 0,
      unrealizedPnlUsd: snapshot?.unrealizedPnlUsd ?? 0,
      drawdownPct: snapshot?.drawdownPct ?? 0,
    };
  }
}

/**
 * Compute daily stop threshold in R from config
 * 
 * The daily_loss_limit in config is typically a FRACTION (0.02 = 2% of equity).
 * We convert this to R units.
 * 
 * @param dailyLossLimitFraction - e.g., 0.02 for 2%
 * @param perTradeRiskFraction - e.g., 0.01 for 1%
 * @returns Daily stop threshold in R (negative, e.g., -2.0)
 */
export function computeDailyStopThresholdR(
  dailyLossLimitFraction: number,
  perTradeRiskFraction: number
): number {
  if (perTradeRiskFraction <= 0) return -Infinity;
  // dailyLossLimitFraction / perTradeRiskFraction = how many R units
  // Return as negative since it's a loss limit
  return -(Math.abs(dailyLossLimitFraction) / perTradeRiskFraction);
}

/**
 * Parse daily stop from R value (e.g., -2.0) or fraction (e.g., 0.02)
 */
export function parseDailyStopSetting(
  value: number,
  perTradeRiskFraction: number
): { r: number; usdMultiplier: number } {
  // If value is small (< 1), treat as fraction of equity
  // If value is >= 1, treat as R units
  if (Math.abs(value) < 1) {
    // Fraction of equity (e.g., 0.02 = 2%)
    const r = computeDailyStopThresholdR(Math.abs(value), perTradeRiskFraction);
    return { r, usdMultiplier: Math.abs(value) };
  } else {
    // R units (e.g., -2.0 or 2.0)
    return { r: -Math.abs(value), usdMultiplier: Math.abs(value) * perTradeRiskFraction };
  }
}
