/**
 * Shared typed test access for the RiskEngine suites (lint batches B5/B6).
 *
 * The risk tests drive RiskEngine internals that are private at type-level
 * only (historically `(engine as any).checkKillSwitches()` style pokes).
 * This module gives those pokes a precise structural type so they stay
 * compile-checked without `any` and without widening RiskEngine's public API.
 *
 * NOTE: `RiskEngineTestAccess` mirrors the private members of
 * `src/trading/risk-engine.ts` that tests touch. If one of those members is
 * renamed, tsc will NOT catch the drift here (the view is a cast) — but the
 * tests exercising it will fail, which is the same guarantee `as any` gave.
 */
import type { OrderRequest } from '../../exchanges/coinbase';
import type { RiskEngine, RiskMetrics } from '../../trading/risk-engine';
import type { Position } from '../../trading/position-tracker';
import type { RiskStateMachine } from '../../trading/risk-state';

/** Result shape of RiskEngine's private `simulatePositionAfterOrder`. */
export interface SimulatedPositionAfterOrder {
  currentSide: Position['side'];
  currentSize: number;
  currentAbsNotional: number;
  newSide: Position['side'];
  newSize: number;
  newAbsNotional: number;
  opensNewPosition: boolean;
  isReduceOnly: boolean;
}

/** Structural window onto the RiskEngine internals the tests drive directly. */
export interface RiskEngineTestAccess {
  /** Private halt state machine; tests read halt status via its public getStatus(). */
  riskStateMachine: Pick<RiskStateMachine, 'getStatus'>;
  killSwitchActive: boolean;
  metrics: RiskMetrics;
  dailyStartEquity: number;
  weeklyStartEquity: number;
  checkKillSwitches(): void;
  updateMetrics(): Promise<void>;
  persistMetrics(): Promise<void>;
  enforceLossGuardrails(currentEquity: number): void;
  simulatePositionAfterOrder(
    position: Position | undefined,
    order: OrderRequest,
    currentPrice: number
  ): SimulatedPositionAfterOrder;
}

/** View an engine through its test-access window (type-level unlock only; no runtime effect). */
export const riskEngineInternals = (engine: RiskEngine): RiskEngineTestAccess =>
  engine as unknown as RiskEngineTestAccess;
