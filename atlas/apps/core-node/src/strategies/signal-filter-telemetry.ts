/**
 * Signal Filter Telemetry — unified per-stage rejection counters + funnel.
 *
 * Goal: a single `atlas_signal_filtered_total{stage,...}` Prometheus
 * counter so a 24h paper session can answer "which gate is rejecting the
 * most signals?" in a single PromQL query, plus a structured log line per
 * rejection so the same question is grep-able from JSON logs.
 *
 * Every stage that can drop a signal between strategy plugin emission and
 * order placement MUST call {@link recordSignalFiltered}, otherwise the
 * funnel will under-count and the silent-rejection bug from May 2026
 * resurfaces.
 *
 * Stages (in execution order along the live signal pipeline):
 *
 *   Inside signal-processor.ts (BEFORE the canonical "Signal generated"):
 *     1. disabled_strategy — kill-list reject in `processSignal`
 *     2. dedup             — 5-min intra-strategy/symbol/direction dedup
 *     3. regime            — RegimeFilter (regime-strategy compatibility, MTF)
 *     4. meta              — MetaFilter (cold streak, strength, hourly perf)
 *     5. meta_label        — ML meta-label below configured threshold
 *
 *   Inside api/server.ts signal:generated handler (AFTER the canonical log):
 *     6. disabled_strategy — defense-in-depth reject at the router
 *     7. runtime_state     — paused / dailyStop / killSwitch suppression
 *     8. routing           — exit-signal short-circuits when shorts disabled
 *     9. cross_venue       — SignalArbitrator (intra-window dedup + netting)
 *    10. time              — allowed_hours_utc gate
 *    11. atr_vol           — ATR volatility band gate
 *    12. funding_bias      — perps funding-rate exclusion
 *    13. sizing            — guardrail-sized order is zero/invalid
 *
 * The funnel-success companion counter `atlas_signal_funnel_total{stage}`
 * counts the survivors at the three checkpoints that bracket the rejection
 * stages (canonical_emitted, sized, order_placed) so the full funnel is
 * observable end-to-end without having to subtract rejections from
 * generations.
 */

import { Counter } from 'prom-client';
import type { Logger } from '../core/logger';

export type SignalFilterStage =
  | 'regime'
  | 'meta'
  | 'cross_venue'
  | 'time'
  | 'atr_vol'
  // Stages added 2026-05-11 to close the silent-funnel gap discovered when a
  // 10-min paper run produced 24 canonical signals → 12 sized orders with
  // zero `signal:filtered` log lines. The five original stages above were
  // correctly instrumented but did not fire in that run; the silent drops
  // were happening at the stages below.
  | 'disabled_strategy'
  | 'dedup'
  | 'meta_label'
  | 'runtime_state'
  | 'routing'
  | 'funding_bias'
  | 'sizing'
  // Added 2026-05-19 (F4 follow-up §8) — per-(symbol, strategy) disable
  // narrower than the global `disabled_strategy` kill list. Reason slug
  // 'symbol_strategy_disabled' indicates the specific (symbol, strategy)
  // pair is policy-disabled via guardrails.{per_symbol,perps_symbols,
  // hyperliquid_symbols}.<sym>.disabled_strategies. Checked at three sites:
  // signal-processor.processSignal, backtest-engine.handleSignal, and
  // api/server signal:generated handler (defense in depth).
  | 'per_symbol_disable';

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

/**
 * Funnel-success stages (the survivors at each checkpoint between strategy
 * plugin emission and order placement). Pairing these with
 * `atlas_signal_filtered_total{stage}` gives a complete picture of the
 * plugin → canonical → sized → placed funnel. Strategy-plugin emission
 * itself is already counted by `atlas_strategy_signals_total` over in
 * `strategy-registry.ts`; we pick up from the canonical event onward.
 */
export type SignalFunnelStage =
  | 'canonical_emitted'
  | 'sized'
  | 'order_placed';

const signalFunnelCounter = new Counter({
  name: 'atlas_signal_funnel_total',
  help: 'Signals reaching each checkpoint of the canonical→sized→placed funnel',
  labelNames: ['stage', 'symbol', 'strategy', 'direction'],
});

export interface SignalFunnelEvent {
  stage: SignalFunnelStage;
  symbol: string;
  strategy: string;
  direction: 'buy' | 'sell';
}

/**
 * Increment the per-checkpoint funnel counter. No log line — the existing
 * "Signal generated" / "Sizing order from signal" / "Order placed from
 * signal" log lines already cover the human-readable side; this is purely
 * for `/metrics` so a PromQL query can answer the funnel question without
 * log scraping.
 */
export function recordSignalFunnel(evt: SignalFunnelEvent): void {
  signalFunnelCounter.inc({
    stage: evt.stage,
    symbol: evt.symbol,
    strategy: evt.strategy,
    direction: evt.direction,
  });
}

/** Test-only: reset the underlying counters. */
export function __resetSignalFilteredCounter(): void {
  signalFilteredCounter.reset();
}

export function __resetSignalFunnelCounter(): void {
  signalFunnelCounter.reset();
}
