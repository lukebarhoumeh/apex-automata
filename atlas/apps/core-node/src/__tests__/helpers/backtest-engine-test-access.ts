/**
 * Shared typed test access for the BacktestEngine suites (lint batch B9).
 *
 * The backtest tests drive BacktestEngine internals that are private at
 * type-level only (historically `(engine as any).handleSignal(...)` style
 * pokes). This module gives those pokes a precise structural type so they
 * stay compile-checked without `any` and without widening BacktestEngine's
 * public API. Mirrors helpers/risk-engine-test-access.ts (B5/B6) and
 * helpers/trading-engine-test-access.ts (B7/B8).
 *
 * NOTE: `BacktestEngineTestAccess` mirrors the private members of
 * `src/backtesting/backtest-engine.ts` that tests touch. If one of those
 * members is renamed, tsc will NOT catch the drift here (the view is a
 * cast) — but the tests exercising it will fail, which is the same
 * guarantee `as any` gave.
 */
import type { OHLCV } from '../../indicators/technical';
import type { Signal } from '../../strategies/signal-processor';
import type {
  BacktestEngine,
  BacktestMetrics,
  BacktestPosition,
  BacktestTrade,
  EvGateStats,
} from '../../backtesting/backtest-engine';
import type { BacktestExitReason } from '../../backtesting/exit-reasons';

/**
 * A trade on the `closedTrades` book: the engine always stamps the exit
 * fields before pushing, so the optionals of `BacktestTrade` are required
 * here (saves a `!` at every assertion site).
 */
export type ClosedBacktestTrade = BacktestTrade & {
  exitPrice: number;
  exitTimestamp: Date;
  pnl: number;
  pnlPercent: number;
  exitReason: BacktestExitReason;
};

/** Result shape of BacktestEngine's private `evaluateEntryEv`. */
export interface EvGateDecision {
  allowed: boolean;
  record?: NonNullable<BacktestTrade['evGate']>;
}

/** Structural window onto the BacktestEngine internals the tests drive directly. */
export interface BacktestEngineTestAccess {
  // Bar clock + cash book
  barIndex: number;
  currentBarTime: Date | null;
  capital: number;
  // Open/closed books. `positions.get` is typed non-optional for test
  // convenience — the suites only look up products they just opened.
  positions: {
    readonly size: number;
    get(product: string): BacktestPosition;
    values(): IterableIterator<BacktestPosition>;
  };
  pendingFills: { readonly size: number; clear(): void };
  closedTrades: ClosedBacktestTrade[];
  // Counters surfaced by calculateMetrics()
  evGateStats: EvGateStats;
  shortBlocked: number;
  sellSignalExits: number;
  atrFilterRejects: number;
  exitsIgnoredMinHold: number;
  trailUnavailableNoAtr: number;
  // Private lifecycle + signal path
  initializeSignalProcessor(): void;
  processTimeSteps(): Promise<void>;
  closeAllPositions(reason: BacktestExitReason): void;
  calculateMetrics(): BacktestMetrics;
  handleSignal(signal: Signal): void;
  openPositionAt(
    signal: Signal,
    fillPrice: number,
    fillTimestamp: Date,
    stopLossOverride?: number,
    takeProfitOverride?: number
  ): void;
  closePosition(product: string, rawExitPrice: number, timestamp: Date, reason: BacktestExitReason): void;
  checkExitConditions(product: string, candle: OHLCV, timestamp: Date): void;
  evaluateEntryEv(
    signal: Signal,
    fillPrice: number,
    stopLoss: number,
    takeProfit: number,
    size: number
  ): EvGateDecision;
}

/** View an engine through its test-access window (type-level unlock only; no runtime effect). */
export const backtestEngineInternals = (engine: BacktestEngine): BacktestEngineTestAccess =>
  engine as unknown as BacktestEngineTestAccess;
