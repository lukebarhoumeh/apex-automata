# TASK_002C — Perpetual Futures Risk Module

**Status:** TODO
**Priority:** HIGH — Safety-critical for leveraged trading
**Depends on:** TASK_002A (perps adapter), TASK_002B (guardrails)
**Estimated checks:** ~40

---

## Context

Perpetual futures introduce leverage, liquidation, funding costs, and margin — all risks that don't exist in spot trading. This module monitors these risks in real-time and can force-reduce positions when danger thresholds are breached.

The module integrates with the existing risk infrastructure (`risk-engine.ts`, `risk-controller.ts`) but lives in its own file to keep concerns separated.

---

## IMPORTANT CONSTRAINTS

1. **DO NOT** modify `risk-engine.ts` — the perps risk module is a NEW companion module
2. **DO NOT** modify `risk-controller.ts` — integration happens at the engine level (TASK_002D)
3. **ALL financial calculations** use string arithmetic or careful parseFloat with explicit rounding
4. The module MUST be self-contained — import from types, not from concrete implementations
5. **JSDoc** on every exported function/class/interface
6. Follow existing patterns in `trading/risk/` directory

---

## Step 1: Create Perps Risk Types

**File:** `atlas/apps/core-node/src/trading/perps/types.ts` (NEW FILE — create directory `perps/`)

```typescript
/**
 * Types for the perpetual futures risk monitoring module.
 */

/** Configuration for the perps risk monitor, loaded from guardrails.yaml perps section */
export interface PerpsRiskConfig {
  /** Risk per trade for leveraged positions (decimal, e.g., 0.015 = 1.5%) */
  riskPerTrade: number;
  /** Default leverage for new positions */
  defaultLeverage: number;
  /** Maximum leverage allowed */
  maxLeverage: number;
  /** Minimum distance from liquidation price before auto-reduce (decimal, e.g., 0.20 = 20%) */
  liquidationBufferPct: number;
  /** Maximum acceptable funding rate in basis points */
  maxFundingRateBps: number;
  /** How often to check funding rates (seconds) */
  fundingCheckIntervalSec: number;
  /** Maker fee (decimal) */
  makerFee: number;
  /** Taker fee (decimal) */
  takerFee: number;
  /** Nano contract size (e.g., 0.01) */
  nanoContractSize: number;
}

/** Snapshot of risk state for a single perpetual position */
export interface PerpsPositionRisk {
  symbol: string;
  side: 'long' | 'short';
  size: string;
  entryPrice: string;
  markPrice: string;
  liquidationPrice: string | null;
  /** Distance to liquidation as decimal (e.g., 0.25 = 25% away) */
  liquidationDistance: number;
  /** Whether position is within the danger zone (< liquidationBufferPct) */
  liquidationDanger: boolean;
  leverage: number;
  unrealizedPnl: string;
  marginUsed: string;
  /** Current funding rate for this symbol (bps) */
  fundingRateBps: number;
  /** Whether funding rate exceeds threshold */
  fundingExcessive: boolean;
  /** Estimated hourly funding cost in USD */
  estimatedHourlyFundingCost: number;
}

/** Aggregate risk summary across all perp positions */
export interface PerpsRiskSummary {
  totalPositions: number;
  totalMarginUsed: string;
  totalUnrealizedPnl: string;
  effectiveLeverage: number;
  maxLeverage: number;
  /** Positions in liquidation danger zone */
  positionsInDanger: string[];
  /** Positions with excessive funding costs */
  positionsWithHighFunding: string[];
  /** Total estimated daily funding cost in USD */
  estimatedDailyFundingCost: number;
  /** Whether any risk threshold is breached */
  riskBreached: boolean;
  /** List of breach reasons */
  breachReasons: string[];
  timestamp: number;
}

/** Events emitted by the PerpsRiskMonitor */
export interface PerpsRiskEvents {
  /** Fired when a position enters liquidation danger zone */
  'perps:liquidation_warning': (risk: PerpsPositionRisk) => void;
  /** Fired when funding rate exceeds threshold */
  'perps:funding_warning': (risk: PerpsPositionRisk) => void;
  /** Fired when effective leverage exceeds max */
  'perps:leverage_warning': (summary: PerpsRiskSummary) => void;
  /** Fired on each risk check cycle with full summary */
  'perps:risk_update': (summary: PerpsRiskSummary) => void;
  /** Fired when auto-reduce is recommended */
  'perps:reduce_recommended': (symbol: string, reason: string) => void;
}
```

---

## Step 2: Create Perps Risk Monitor

**File:** `atlas/apps/core-node/src/trading/perps/perps-risk-monitor.ts` (NEW FILE)

```typescript
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

    // Run immediately, then on interval
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
    const entryPrice = parseFloat(position.entryPrice);
    const size = parseFloat(position.size);
    const leverage = position.leverage ?? this.config.defaultLeverage;
    const liqPrice = position.liquidationPrice ? parseFloat(position.liquidationPrice) : null;

    // Calculate liquidation distance
    let liquidationDistance = 1.0; // default: far from liquidation
    if (liqPrice && liqPrice > 0 && markPrice > 0) {
      if (position.side === 'buy') {
        // Long: liq price is below mark price
        liquidationDistance = (markPrice - liqPrice) / markPrice;
      } else {
        // Short: liq price is above mark price
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

    // Fetch positions
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
```

---

## Step 3: Create Barrel Export

**File:** `atlas/apps/core-node/src/trading/perps/index.ts` (NEW FILE)

```typescript
export * from './types';
export { PerpsRiskMonitor } from './perps-risk-monitor';
```

---

## Verification Checklist

Run: `node CURSOR_TASKS/verify/verify_002c.js`

### Section 1: File Structure (3 checks)
- [ ] `trading/perps/` directory exists
- [ ] `trading/perps/types.ts` exists
- [ ] `trading/perps/perps-risk-monitor.ts` exists
- [ ] `trading/perps/index.ts` exists

### Section 2: Perps Types (8 checks)
- [ ] `PerpsRiskConfig` interface exists
- [ ] `PerpsRiskConfig` has `liquidationBufferPct` field
- [ ] `PerpsRiskConfig` has `maxFundingRateBps` field
- [ ] `PerpsPositionRisk` interface exists
- [ ] `PerpsPositionRisk` has `liquidationDanger` field
- [ ] `PerpsPositionRisk` has `fundingExcessive` field
- [ ] `PerpsRiskSummary` interface exists
- [ ] `PerpsRiskEvents` interface exists

### Section 3: PerpsRiskMonitor Class (12 checks)
- [ ] Class extends EventEmitter
- [ ] `setAdapter()` method exists
- [ ] `start()` method exists
- [ ] `stop()` method exists
- [ ] `forceCheck()` method exists
- [ ] `getLastSummary()` method exists
- [ ] `evaluatePositionRisk()` method exists
- [ ] Uses `isPerpsAdapter` type guard
- [ ] Emits `perps:liquidation_warning` event
- [ ] Emits `perps:funding_warning` event
- [ ] Emits `perps:leverage_warning` event
- [ ] Emits `perps:risk_update` event
- [ ] Emits `perps:reduce_recommended` event
- [ ] Has `fundingRateCache` Map
- [ ] Calculates liquidation distance for both long and short

### Section 4: Barrel Exports (3 checks)
- [ ] `index.ts` exports PerpsRiskMonitor
- [ ] `index.ts` exports types (via `export *`)

### Section 5: No Regressions (3 checks)
- [ ] `risk-engine.ts` is unchanged
- [ ] `risk-controller.ts` is unchanged
- [ ] `order-manager.ts` is unchanged

**Total: ~32 checks**

---

## Files Created Summary

| File | Action | Description |
|------|--------|-------------|
| `trading/perps/types.ts` | CREATE | PerpsRiskConfig, PerpsPositionRisk, PerpsRiskSummary, PerpsRiskEvents |
| `trading/perps/perps-risk-monitor.ts` | CREATE | PerpsRiskMonitor class with liquidation/funding/leverage monitoring |
| `trading/perps/index.ts` | CREATE | Barrel exports |

---

## What NOT To Do

- Do NOT modify existing risk-engine.ts or risk-controller.ts
- Do NOT execute trades from this module — it only monitors and emits events
- Do NOT import concrete adapter classes — use the interface + type guard
- Do NOT use `any` type — everything is properly typed
- Do NOT add WebSocket subscriptions — the monitor polls via REST on interval
