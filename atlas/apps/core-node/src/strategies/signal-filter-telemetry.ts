/**
 * Signal Filter Telemetry — unified per-stage rejection counters.
 *
 * Goal: a single `atlas_signal_filtered_total{stage,...}` Prometheus
 * counter so a 24h paper session can answer "which gate is rejecting the
 * most signals?" in a single PromQL query, plus a structured log line per
 * rejection so the same question is grep-able from JSON logs.
 *
 * The five stages mirror the live signal pipeline (in execution order):
 *   1. regime     — RegimeFilter (regime-strategy compatibility, MTF, etc.)
 *   2. meta       — MetaFilter   (cold streak, strength, hourly perf, ...)
 *   3. cross-venue — SignalArbitrator (cross-venue netting + dedup)
 *   4. time       — api/server.ts time-of-day gate on `allowed_hours_utc`
 *   5. atr-vol    — api/server.ts ATR volatility band gate
 *
 * All call sites should use {@link recordSignalFiltered} so the counter
 * cardinality stays bounded and the log shape stays consistent.
 */

import { Counter } from 'prom-client';
import type { Logger } from '../core/logger';

export type SignalFilterStage =
  | 'regime'
  | 'meta'
  | 'cross_venue'
  | 'time'
  | 'atr_vol';

const signalFilteredCounter = new Counter({
  name: 'atlas_signal_filtered_total',
  help: 'Signals rejected by the signal pipeline, labeled by rejection stage',
  labelNames: ['stage', 'symbol', 'strategy', 'reason'],
});

export interface SignalFilteredEvent {
  stage: SignalFilterStage;
  reason: string;
  symbol: string;
  strategy: string;
  signalId?: string;
  direction?: 'buy' | 'sell';
  strength?: number;
  /** Optional structured context (regime name, ATR pct, hour, etc.) */
  context?: Record<string, unknown>;
}

/**
 * Increment the per-stage counter and emit a structured log line at INFO.
 * Pass a short `reason` slug (e.g. 'incompatible_regime') as the metric
 * label and a human-readable longer-form reason via context if needed.
 */
export function recordSignalFiltered(logger: Logger, evt: SignalFilteredEvent): void {
  signalFilteredCounter.inc({
    stage: evt.stage,
    symbol: evt.symbol,
    strategy: evt.strategy,
    reason: evt.reason,
  });
  logger.info('signal:filtered', {
    stage: evt.stage,
    reason: evt.reason,
    symbol: evt.symbol,
    strategy: evt.strategy,
    signalId: evt.signalId,
    direction: evt.direction,
    strength: evt.strength,
    ...(evt.context ?? {}),
  });
}

/** Test-only: reset the underlying counter. */
export function __resetSignalFilteredCounter(): void {
  signalFilteredCounter.reset();
}
