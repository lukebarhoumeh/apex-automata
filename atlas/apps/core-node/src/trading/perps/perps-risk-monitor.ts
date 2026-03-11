/**
 * PerpsRiskMonitor — real-time risk monitoring for perpetual futures positions.
 *
 * Monitors:
 * 1. Liquidation proximity — warns when position is within buffer of liquidation price
 * 2. Funding rate costs — warns when funding rate exceeds configured threshold
 * 3. Leverage enforcement — warns when effective leverage exceeds max
 * 4. Margin utilization — tracks total margin used vs available collateral
 *
 * Does NOT execute trades. Emits events that the trading engine or risk controller
 * can act on (e.g., auto-reduce positions, pause entries).
 */

import { EventEmitter } from 'events';
import { Logger } from '../../core/logger';
import { IExchangeAdapter, isPerpsAdapter, AdapterPosition, AdapterFundingRate } from '../../exchanges/types';
import { PerpsRiskConfig, PerpsPositionRisk, PerpsRiskSummary } from './types';

export class PerpsRiskMonitor extends EventEmitter {
  private config: PerpsRiskConfig;
  private logger: Logger;
  private adapter: IExchangeAdapter | null = null;
  private checkInterval: NodeJS.Timeout | null = null;
  private lastSummary: PerpsRiskSummary | null = null;
  private fundingRateCache: Map<string, AdapterFundingRate> = new Map();

  constructor(config: PerpsRiskConfig, logger: Logger) {
    super();
    this.config = config;
    this.logger = logger;
  }

  /**
   * Attach a perps-capable exchange adapter.
   * The monitor will query this adapter for positions, funding rates, etc.
   */
  setAdapter(adapter: IExchangeAdapter): void {
    if (!isPerpsAdapter(adapter)) {
      this.logger.warn('PerpsRiskMonitor: adapter does not implement IPerpsAdapter — monitor will be limited');
    }
    this.adapter = adapter;
    this.logger.info(`PerpsRiskMonitor: adapter set to '${adapter.id}'`);
  }

  /**
   * Start the periodic risk check loop.
   */
  start(): void {
    if (this.checkInterval) {
      this.logger.warn('PerpsRiskMonitor already running');
      return;
    }

    const intervalMs = this.config.fundingCheckIntervalSec * 1000;
    this.logger.info(`PerpsRiskMonitor starting (check interval: ${this.config.fundingCheckIntervalSec}s)`);

    this.runRiskCheck().catch((err) =>
      this.logger.error('PerpsRiskMonitor initial check failed:', err)
    );

    this.checkInterval = setInterval(() => {
      this.runRiskCheck().catch((err) =>
        this.logger.error('PerpsRiskMonitor check failed:', err)
      );
    }, intervalMs);
  }

  /**
   * Stop the periodic risk check loop.
   */
  stop(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
      this.logger.info('PerpsRiskMonitor stopped');
    }
  }

  /**
   * Get the most recent risk summary without running a new check.
   */
  getLastSummary(): PerpsRiskSummary | null {
    return this.lastSummary;
  }

  /**
   * Force an immediate risk check and return the summary.
   */
  async forceCheck(): Promise<PerpsRiskSummary> {
    return this.runRiskCheck();
  }

  /**
   * Evaluate risk for a single position given current market data.
   */
  evaluatePositionRisk(position: AdapterPosition, fundingRate: AdapterFundingRate | null): PerpsPositionRisk {
    const markPrice = parseFloat(position.markPrice);
    const size = parseFloat(position.size);
    const leverage = position.leverage ?? this.config.defaultLeverage;
    const liqPrice = position.liquidationPrice ? parseFloat(position.liquidationPrice) : null;

    // Calculate liquidation distance
    let liquidationDistance = 1.0;
    if (liqPrice && liqPrice > 0 && markPrice > 0) {
      if (position.side === 'buy') {
        liquidationDistance = (markPrice - liqPrice) / markPrice;
      } else {
        liquidationDistance = (liqPrice - markPrice) / markPrice;
      }
      liquidationDistance = Math.max(0, liquidationDistance);
    }

    const liquidationDanger = liquidationDistance < this.config.liquidationBufferPct;

    // Funding rate
    const fundingRateBps = fundingRate ? parseFloat(fundingRate.rate) * 10000 : 0;
    const fundingExcessive = Math.abs(fundingRateBps) > this.config.maxFundingRateBps;

    // Estimated hourly funding cost
    const notional = size * markPrice;
    const hourlyFundingCost = fundingRate
      ? Math.abs(parseFloat(fundingRate.rate)) * notional
      : 0;

    return {
      symbol: position.symbol,
      side: position.side === 'buy' ? 'long' : 'short',
      size: position.size,
      entryPrice: position.entryPrice,
      markPrice: position.markPrice,
      liquidationPrice: position.liquidationPrice ?? null,
      liquidationDistance,
      liquidationDanger,
      leverage,
      unrealizedPnl: position.unrealizedPnl,
      marginUsed: position.marginUsed ?? '0',
      fundingRateBps,
      fundingExcessive,
      estimatedHourlyFundingCost: hourlyFundingCost,
    };
  }

  // ---- Internal ----

  private async runRiskCheck(): Promise<PerpsRiskSummary> {
    if (!this.adapter) {
      const empty: PerpsRiskSummary = {
        totalPositions: 0,
        totalMarginUsed: '0',
        totalUnrealizedPnl: '0',
        effectiveLeverage: 0,
        maxLeverage: this.config.maxLeverage,
        positionsInDanger: [],
        positionsWithHighFunding: [],
        estimatedDailyFundingCost: 0,
        riskBreached: false,
        breachReasons: [],
        timestamp: Date.now(),
      };
      this.lastSummary = empty;
      return empty;
    }

    const positions = await this.adapter.getPositions();
    const activePositions = positions.filter((p) => parseFloat(p.size) > 0);

    // Fetch funding rates for each position
    const perpsAdapterRef = isPerpsAdapter(this.adapter) ? this.adapter : null;
    for (const pos of activePositions) {
      if (perpsAdapterRef) {
        try {
          const rate = await perpsAdapterRef.getFundingRate(pos.symbol);
          if (rate) {
            this.fundingRateCache.set(pos.symbol, rate);
          }
        } catch (err) {
          this.logger.warn(`Failed to fetch funding rate for ${pos.symbol}:`, err);
        }
      }
    }

    // Evaluate each position
    const positionRisks: PerpsPositionRisk[] = activePositions.map((pos) => {
      const funding = this.fundingRateCache.get(pos.symbol) ?? null;
      return this.evaluatePositionRisk(pos, funding);
    });

    // Aggregate
    let totalMarginUsed = 0;
    let totalUnrealizedPnl = 0;
    let totalDailyFundingCost = 0;
    const positionsInDanger: string[] = [];
    const positionsWithHighFunding: string[] = [];
    const breachReasons: string[] = [];

    for (const risk of positionRisks) {
      totalMarginUsed += parseFloat(risk.marginUsed);
      totalUnrealizedPnl += parseFloat(risk.unrealizedPnl);
      totalDailyFundingCost += risk.estimatedHourlyFundingCost * 24;

      if (risk.liquidationDanger) {
        positionsInDanger.push(risk.symbol);
        this.emit('perps:liquidation_warning', risk);
        this.emit('perps:reduce_recommended', risk.symbol, `Liquidation proximity: ${(risk.liquidationDistance * 100).toFixed(1)}%`);
        breachReasons.push(`${risk.symbol}: liquidation proximity ${(risk.liquidationDistance * 100).toFixed(1)}%`);
      }

      if (risk.fundingExcessive) {
        positionsWithHighFunding.push(risk.symbol);
        this.emit('perps:funding_warning', risk);
        breachReasons.push(`${risk.symbol}: funding rate ${risk.fundingRateBps.toFixed(1)} bps exceeds ${this.config.maxFundingRateBps} bps`);
      }
    }

    // Get portfolio summary for effective leverage
    let effectiveLeverage = 0;
    if (perpsAdapterRef) {
      const portfolio = await perpsAdapterRef.getPortfolioSummary();
      if (portfolio) {
        const collateral = parseFloat(portfolio.totalCollateral);
        const marginUsed = parseFloat(portfolio.marginUsed);
        effectiveLeverage = collateral > 0 ? marginUsed / collateral : 0;
      }
    }

    if (effectiveLeverage > this.config.maxLeverage) {
      breachReasons.push(`Effective leverage ${effectiveLeverage.toFixed(1)}x exceeds max ${this.config.maxLeverage}x`);
    }

    const summary: PerpsRiskSummary = {
      totalPositions: activePositions.length,
      totalMarginUsed: totalMarginUsed.toFixed(2),
      totalUnrealizedPnl: totalUnrealizedPnl.toFixed(2),
      effectiveLeverage,
      maxLeverage: this.config.maxLeverage,
      positionsInDanger,
      positionsWithHighFunding,
      estimatedDailyFundingCost: totalDailyFundingCost,
      riskBreached: breachReasons.length > 0,
      breachReasons,
      timestamp: Date.now(),
    };

    this.lastSummary = summary;
    this.emit('perps:risk_update', summary);

    if (effectiveLeverage > this.config.maxLeverage) {
      this.emit('perps:leverage_warning', summary);
    }

    return summary;
  }
}
