/**
 * Shared typed test access for the TradingEngine lifecycle suites (lint batch B7)
 * and the paper order-path suites (lint batch B8).
 *
 * The lifecycle tests drive TradingEngine internals that are private at
 * type-level only (historically `(engine as any).startHeartbeat()` style
 * pokes). This module gives those pokes a precise structural type so they
 * stay compile-checked without `any` and without widening TradingEngine's
 * public API.
 *
 * NOTE: `TradingEngineTestAccess` mirrors the private members of
 * `src/trading/trading-engine.ts` that tests touch. If one of those members
 * is renamed, tsc will NOT catch the drift here (the view is a cast) — but
 * the tests exercising it will fail, which is the same guarantee `as any`
 * gave.
 */
import type { TradingEngine, EngineState } from '../../trading/trading-engine';
import type { OrderManager } from '../../trading/order-manager';
import type { PositionTracker } from '../../trading/position-tracker';
import type { PaperTradingSimulator } from '../../trading/paper-trading-simulator';

/**
 * Minimal structural stub for the RiskEngine instances the lifecycle tests
 * inject (each test fabricates only the one or two members it exercises).
 * The paper-path suites (B8) read the REAL RiskEngine through this same
 * window, but only call the optional `stop` teardown hook.
 */
export interface LifecycleRiskEngineStub {
  activateKillSwitch?: (reason: string, reasonCode?: string) => void;
  getMetrics?: () => { killSwitchActive: boolean };
  stop?: () => void;
}

/** Structural window onto the TradingEngine internals the lifecycle tests drive. */
export interface TradingEngineTestAccess {
  isRunning: boolean;
  startInFlight: boolean;
  engineState: EngineState;
  engineStartTime: number;
  activeSymbols: string[];
  lastMarketDataPerSymbol: Map<string, number>;
  dataGapMonitor: NodeJS.Timeout | null;
  riskEngine: LifecycleRiskEngineStub | null;
  exchange: unknown;
  marketPrices: Map<string, number>;
  orderManager: OrderManager | null;
  positionTracker: PositionTracker | null;
  paperSimulator: PaperTradingSimulator | null;
  startHeartbeat(): void;
  stopHeartbeat(): void;
  setEngineState(state: EngineState, reason: string): void;
  startDataGapMonitor(): void;
  initializePaperSimulator(): void;
  initializeOrderManager(): void;
  initializePositionTracker(): void;
  initializeRiskEngine(): void;
  setupEventHandlers(): void;
}

/** View an engine through its test-access window (type-level unlock only; no runtime effect). */
export const tradingEngineInternals = (engine: TradingEngine): TradingEngineTestAccess =>
  engine as unknown as TradingEngineTestAccess;
