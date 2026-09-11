/**
 * Exit-reason vocabulary for backtest trades (G1/G3/G5 exit-parity infra,
 * 2026-09-10).
 *
 * The four monitor-driven labels are tied at the TYPE level to the live
 * `PositionMonitor` (`PositionExitCondition['type']` in
 * `trading/position-monitor.ts`) so the backtest cannot invent a label live
 * does not emit, nor miss one live adds — `pnpm tsc --noEmit` fails on
 * drift in either direction. The import is type-only: nothing from the live
 * exit path is executed here.
 *
 * Mapping to the Supabase `trade_exit_reason` enum (for anyone joining
 * backtest output against `positions.exit_reason`):
 *   stop_loss     → stop_loss
 *   take_profit   → take_profit
 *   time_stop     → time_stop
 *   trailing_stop → stop_loss   (live `mapExitReason` collapses it; the enum
 *                                has no `trailing_stop` value — reports keep
 *                                the raw label so trail exits stay visible)
 *   signal        → signal_exit
 *   end_of_data   → session_end (backtest-only: forced flat at the last bar)
 */
import type { PositionExitCondition } from '../trading/position-monitor';

/** Exit types the live `PositionMonitor` emits. */
export type LiveMonitorExitType = PositionExitCondition['type'];

// `Record<Union, true>` with an object literal is checked in both directions:
// a label live adds shows up as a missing key, a label live drops as an
// excess property. Order here is the report order.
const LIVE_MONITOR_EXIT_TYPE_SET: Record<LiveMonitorExitType, true> = {
  stop_loss: true,
  take_profit: true,
  trailing_stop: true,
  time_stop: true,
};

/** Runtime list of the live monitor exit types (report order). */
export const LIVE_MONITOR_EXIT_TYPES: readonly LiveMonitorExitType[] = Object.keys(
  LIVE_MONITOR_EXIT_TYPE_SET,
) as LiveMonitorExitType[];

/** Backtest-only exit labels (no live monitor analogue). */
export type BacktestOnlyExitReason = 'signal' | 'end_of_data';

/** Every label a `BacktestTrade.exitReason` may carry. */
export type BacktestExitReason = LiveMonitorExitType | BacktestOnlyExitReason;

/** All backtest exit labels, in report order. */
export const BACKTEST_EXIT_REASONS: readonly BacktestExitReason[] = [
  ...LIVE_MONITOR_EXIT_TYPES,
  'signal',
  'end_of_data',
];

/**
 * Exits filled as a market order at the bar close (symmetric slippage, like
 * entries). Stop-type exits (`stop_loss`, `trailing_stop`) instead carry the
 * pessimistic overshoot model and `take_profit` fills at the level.
 */
export const MARKET_EXIT_REASONS: readonly BacktestExitReason[] = ['signal', 'time_stop', 'end_of_data'];

/** True when `reason` is filled as a market order at the bar close. */
export function isMarketExit(reason: BacktestExitReason): boolean {
  return MARKET_EXIT_REASONS.includes(reason);
}
