/**
 * Donchian Daily S3 (in20/out10) — card PAPER-S3-DONCHIAN-v0.
 *
 * STATUS: HOLD — infra only, DEFAULT OFF, NOT a GO. Ships in
 * `guardrails.disabled_strategies` (desk pin, config-drift LIST_PINS), in
 * `cfm_symbols.*.disabled_strategies`, and as `enabled: false` in the
 * strategies.json mirror. The StrategyRegistry refuses to register it while it
 * is on the kill list, so nothing routes a signal from it in paper or live.
 * Research verdict: docs/research/2026-09-22_s3-donchian-breakout-replication.md
 * (pooled full-sample passes the desk bar; recency and per-product FAIL). The
 * only way to run it today is the backtest harness with
 * `--strategy donchian_daily_s3 --include-disabled donchian_daily_s3`.
 *
 * THE RULE (§1.1 / §1.2 of the research doc, ported from `sim_brk`):
 *
 *   Long-only, daily bars (UTC), one position per product.
 *   ENTER on the first daily close ABOVE the prior `entryLookback` (20) closing
 *     high — rolling max of the PREVIOUS 20 closes, current bar EXCLUDED —
 *     → emit `buy`. The engine fills next bar open (`backtest.next_bar_fill`);
 *     paper fills at market.
 *   EXIT  on the first daily close BELOW the prior `exitLookback` (10) closing
 *     low — rolling min of the PREVIOUS 10 closes, current bar EXCLUDED —
 *     → emit `sell`. Spot routing treats a sell against an open long as an
 *     EXIT (api/server.ts, backtest-engine.handleSignal); a short is never
 *     emitted (the sell is only emitted while the rule state is IN).
 *   After an exit the earliest re-entry signal is the next completed bar
 *     (`sim_brk` `i += 2`). The fill bar (the bar after the entry signal) is
 *     not checked for an exit (`sim_brk` mechanics, §1.2) — the first exit
 *     check is two completed bars after the entry signal.
 *   Strict inequalities: close == prior high is NOT an entry; close == prior
 *     low is NOT an exit.
 *
 * DEVIATIONS FROM THE PRIMARY RULE (documented on purpose):
 *
 *   - The primary S3 rule has NO stop and NO take-profit (desk condition §7:
 *     close-evaluated exits only, no venue-side stop-market). This plugin
 *     still stamps `stopLoss = close − stopAtr × ATR(atrPeriod)` because the
 *     engine sizes positions from stop distance (`computeRiskBasedSize`) and
 *     `PositionMonitor` needs a stop level. `stopAtr` defaults to 3.0 — wide
 *     on purpose, a SOFTWARE sizing anchor, not the rule. In the backtest it
 *     is a hard intrabar stop with overshoot; in paper it is
 *     `PositionMonitor.stop_loss` (close-evaluated on ticks). This can cut a
 *     trade the primary rule would have held; the harness report must be
 *     read with that in mind.
 *   - "No take-profit" cannot be expressed as 0 / Infinity: both
 *     `BacktestEngine.resolveTakeProfit` and `PositionMonitor` replace a
 *     non-finite or ≤ 0 take-profit with a 4 % / 3 % fallback, which would
 *     truncate the right tail the rule lives on. `takeProfitAtr: 0` (default)
 *     therefore emits a FAR FINITE sentinel, `close × NO_TAKE_PROFIT_PRICE_MULTIPLE`
 *     (100× the entry price — unreachable within a trade, fits NUMERIC(20,8)).
 *     Consequence: the fee-adjusted EV gate sees a huge reward and effectively
 *     default-allows every entry of this strategy; it is not a meaningful
 *     filter here.
 *
 * DATA SOURCE (decided per call, see `resolveDailySeries`):
 *
 *   1. `context.mtfCandles.d1` when present and long enough — the future
 *      daily-candle feed for the paper runtime (not wired yet; follow-up).
 *   2. else `context.candles` when they are daily-spaced (median spacing
 *      within ±10 % of 86 400 000 ms) — the `--bar-minutes 1440` backtest
 *      path, where the engine's base series IS the daily series.
 *   3. otherwise REFUSE (`validateContext` → `insufficient daily history`).
 *   Daily bars are never rebuilt from the 1m buffer: SignalProcessor keeps
 *   500 × 1m candles (≈ 8 h), far short of the 21+ days the rule needs.
 *   Candle `time` is epoch MILLISECONDS everywhere in this codebase
 *   (data-loader multiplies fixture seconds by 1000; SignalProcessor's
 *   aggregation floors by `periodMs`).
 *
 * KNOWN LIMITATIONS:
 *
 *   - Paper runtime: 1m candles, no d1 rollup, buffer too short → the plugin
 *     refuses on every bar and emits nothing until a daily-candle feed is
 *     wired into `mtfCandles.d1` (follow-up). The feed must present COMPLETED
 *     daily bars only; the plugin evaluates the last element of the series as
 *     the just-closed bar.
 *   - Rule state lives in memory. On process restart every symbol is OUT: the
 *     plugin will not emit the rule exit for a position it does not remember
 *     (the router's exit path still handles PositionMonitor stops for real
 *     open positions). Follow-up: hydrate IN/OUT from open positions at boot.
 *   - The ATR is computed in-plugin from the daily series
 *     (`ValidatedIndicators.ATR`), not from `context.indicators.atr`, which is
 *     1m-based in the paper runtime; `requiredIndicators` is therefore empty.
 */

import { BaseStrategy } from '../base-strategy';
import { ValidatedIndicators } from '../../../indicators/validated-indicators';
import { OHLCV } from '../../../indicators/technical';
import {
  MarketContext,
  StrategySignal,
  StrategyConfigSchema,
  RegimeCompatibility,
  IndicatorRequirement,
} from '../types';

/** One daily bar in epoch milliseconds (candle `time` unit in this codebase). */
export const DAILY_BAR_MS = 86_400_000;

/** Median spacing must be within this fraction of a day to count as daily. */
export const DAILY_SPACING_TOLERANCE = 0.10;

/**
 * "No take-profit" sentinel: the emitted take-profit is `close × this`. Must be
 * a finite positive number (see header — 0 / Infinity fall back to 4 % / 3 %
 * targets downstream) and small enough to fit NUMERIC(20,8) for any product.
 */
export const NO_TAKE_PROFIT_PRICE_MULTIPLE = 100;

export type DonchianRuleState = 'IN' | 'OUT';

export interface DonchianSymbolState {
  state: DonchianRuleState;
  /** Bar time (ms) of the last bar this plugin processed for the symbol. */
  lastBarTime: number | null;
  /** Bar time (ms) of the bar the current/last entry signal fired on. */
  entrySignalBarTime: number | null;
  /** Completed bars processed since the entry signal bar (0 on that bar). */
  barsSinceEntrySignal: number;
  /** Bar time (ms) of the last exit signal, for audit. */
  lastExitSignalBarTime: number | null;
}

export type DonchianDailySource = 'd1' | 'candles';

interface ResolvedDailySeries {
  source: DonchianDailySource;
  candles: OHLCV[];
}

/** Median spacing (ms) between consecutive candles; null when < 2 bars. */
export function medianSpacingMs(candles: readonly OHLCV[]): number | null {
  if (candles.length < 2) return null;
  const gaps: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const gap = candles[i].time - candles[i - 1].time;
    if (Number.isFinite(gap) && gap > 0) gaps.push(gap);
  }
  if (gaps.length === 0) return null;
  gaps.sort((a, b) => a - b);
  const mid = Math.floor(gaps.length / 2);
  return gaps.length % 2 === 0 ? (gaps[mid - 1] + gaps[mid]) / 2 : gaps[mid];
}

/** True when the series' median spacing is a day (±DAILY_SPACING_TOLERANCE). */
export function isDailySpaced(candles: readonly OHLCV[]): boolean {
  const median = medianSpacingMs(candles);
  if (median === null) return false;
  return Math.abs(median - DAILY_BAR_MS) <= DAILY_BAR_MS * DAILY_SPACING_TOLERANCE;
}

export class DonchianDailyS3Strategy extends BaseStrategy {
  readonly id = 'donchian_daily_s3';
  readonly name = 'Donchian Daily S3 (in20/out10)';
  readonly description =
    'Long-only daily Donchian channel rule: enter on the first close above the prior 20-day closing high, ' +
    'exit on the first close below the prior 10-day closing low (card PAPER-S3-DONCHIAN-v0, HOLD, default OFF)';
  readonly version = '0.1.0';
  readonly author = 'AtlasBot';
  readonly category = 'trend' as const;
  readonly tags = ['donchian', 'daily', 'breakout', 's3', 'long-only', 'close-evaluated', 'hold'];

  /** Per-symbol IN/OUT state machine (mirrors `sim_brk`'s `pos`). */
  private symbolState: Map<string, DonchianSymbolState> = new Map();

  constructor(config?: Record<string, unknown>) {
    super(config);
    this.initializeWithConfig();
  }

  readonly configSchema: StrategyConfigSchema = {
    parameters: [
      {
        key: 'entryLookback',
        name: 'Entry Lookback (days)',
        description: 'Enter on the first close above the max of the previous N closes (current bar excluded). S3 = 20.',
        type: 'number',
        default: 20,
        min: 2,
        max: 400,
        step: 1,
      },
      {
        key: 'exitLookback',
        name: 'Exit Lookback (days)',
        description: 'Exit on the first close below the min of the previous N closes (current bar excluded). S3 = 10.',
        type: 'number',
        default: 10,
        min: 2,
        max: 400,
        step: 1,
      },
      {
        key: 'atrPeriod',
        name: 'ATR Period (days)',
        description: 'ATR period on the daily series, used only for the software stop anchor and the ATR stamp.',
        type: 'number',
        default: 14,
        min: 2,
        max: 100,
        step: 1,
      },
      {
        key: 'stopAtr',
        name: 'Software Stop ATR Multiplier',
        description:
          'SOFTWARE sizing anchor, NOT the S3 rule (which has no stop): stopLoss = close − stopAtr × ATR. ' +
          'The engine sizes from stop distance and PositionMonitor needs a stop. Kept wide on purpose.',
        type: 'number',
        default: 3.0,
        min: 0.5,
        max: 20,
        step: 0.5,
      },
      {
        key: 'takeProfitAtr',
        name: 'Take Profit ATR Multiplier (0 = none)',
        description:
          '0 (default) = no take-profit, expressed downstream as a far finite sentinel (close × 100) because ' +
          'the engine and PositionMonitor replace 0 / Infinity with a 4 % / 3 % fallback target. > 0 = close + N × ATR.',
        type: 'number',
        default: 0,
        min: 0,
        max: 1000,
        step: 0.5,
      },
      {
        key: 'minStrength',
        name: 'Minimum Signal Strength',
        description: 'Minimum strength to emit (0 = off; the S3 rule has no strength concept).',
        type: 'number',
        default: 0,
        min: 0,
        max: 1.0,
        step: 0.05,
      },
    ],
  };

  /**
   * Empty on purpose: the ATR is computed in-plugin from the daily series so
   * it agrees with the bars the rule evaluates (the SignalProcessor's
   * `indicators.atr` is 1m-based in paper).
   */
  readonly requiredIndicators: IndicatorRequirement[] = [];

  /**
   * The S3 rule is pre-registered WITHOUT a regime filter: every regime is
   * `compatible` at multiplier 1.0 so the StrategyRegistry never self-gates it.
   * The desk can add a `regime_gates` rule for `donchian_daily_s3` later.
   */
  readonly regimeCompatibility: RegimeCompatibility[] = [
    { regime: 'strong_trend', compatibility: 'compatible', positionMultiplier: 1.0, notes: 'Pre-registered rule: no regime filter (desk may add a regime_gates rule later)' },
    { regime: 'weak_trend', compatibility: 'compatible', positionMultiplier: 1.0, notes: 'Pre-registered rule: no regime filter' },
    { regime: 'ranging', compatibility: 'compatible', positionMultiplier: 1.0, notes: 'Pre-registered rule: no regime filter (the rule has its own whipsaw exposure by design)' },
    { regime: 'choppy', compatibility: 'compatible', positionMultiplier: 1.0, notes: 'Pre-registered rule: no regime filter' },
  ];

  // ============ Config helpers ============

  private readConfig(symbol?: string) {
    return {
      entryLookback: Math.max(2, Math.floor(this.getConfig<number>('entryLookback', 20, symbol))),
      exitLookback: Math.max(2, Math.floor(this.getConfig<number>('exitLookback', 10, symbol))),
      atrPeriod: Math.max(2, Math.floor(this.getConfig<number>('atrPeriod', 14, symbol))),
      stopAtr: this.getConfig<number>('stopAtr', 3.0, symbol),
      takeProfitAtr: this.getConfig<number>('takeProfitAtr', 0, symbol),
      minStrength: this.getConfig<number>('minStrength', 0, symbol),
    };
  }

  /** Bars the daily series must hold: the longest lookback plus the current bar. */
  public requiredDailyBars(symbol?: string): number {
    const { entryLookback, exitLookback, atrPeriod } = this.readConfig(symbol);
    return Math.max(entryLookback, exitLookback, atrPeriod) + 1;
  }

  // ============ Data source ============

  /**
   * Pick the daily series for this context (see header): `mtfCandles.d1`
   * first, then daily-spaced `context.candles`; null when neither qualifies.
   */
  public resolveDailySeries(context: MarketContext): ResolvedDailySeries | null {
    const required = this.requiredDailyBars(context.symbol);
    const d1 = context.mtfCandles?.d1;
    if (d1 && d1.length >= required) {
      return { source: 'd1', candles: d1 };
    }
    const base = context.candles;
    if (base && base.length >= required && isDailySpaced(base)) {
      return { source: 'candles', candles: base };
    }
    return null;
  }

  validateContext(context: MarketContext): { valid: boolean; reason?: string } {
    const required = this.requiredDailyBars(context.symbol);
    if (this.resolveDailySeries(context)) {
      return { valid: true };
    }
    const d1Len = context.mtfCandles?.d1?.length ?? 0;
    const baseLen = context.candles?.length ?? 0;
    const baseSpacing = medianSpacingMs(context.candles ?? []);
    return {
      valid: false,
      reason:
        `insufficient daily history for ${this.id}: need ${required} completed daily bars; ` +
        `mtfCandles.d1=${d1Len} bars, candles=${baseLen} bars at median spacing ` +
        `${baseSpacing === null ? 'n/a' : `${Math.round(baseSpacing / 60_000)}m`} (daily-spaced=${isDailySpaced(context.candles ?? [])})`,
    };
  }

  // ============ Signal generation ============

  generateSignals(context: MarketContext): StrategySignal[] {
    const signals: StrategySignal[] = [];
    const { symbol } = context;
    const cfg = this.readConfig(symbol);

    const resolved = this.resolveDailySeries(context);
    if (!resolved) {
      return signals; // validateContext already refused; defence in depth.
    }
    const daily = resolved.candles;
    const current = daily[daily.length - 1];
    const barTime = current.time;
    if (!Number.isFinite(barTime)) {
      return signals;
    }

    const state = this.getOrInitState(symbol);

    // One evaluation per completed bar per symbol (no duplicate on the same bar).
    if (state.lastBarTime !== null && barTime <= state.lastBarTime) {
      return signals;
    }
    state.lastBarTime = barTime;
    if (state.state === 'IN') {
      state.barsSinceEntrySignal += 1;
    }

    const closes = daily.map((c) => c.close);
    const close = current.close;
    // Prior windows EXCLUDE the current bar (sim_brk: c.slice(i - n, i)).
    const priorEntryWindow = closes.slice(-1 - cfg.entryLookback, -1);
    const priorExitWindow = closes.slice(-1 - cfg.exitLookback, -1);
    if (priorEntryWindow.length < cfg.entryLookback || priorExitWindow.length < cfg.exitLookback) {
      return signals;
    }
    const donchianHigh = Math.max(...priorEntryWindow);
    const donchianLow = Math.min(...priorExitWindow);

    const atrSeries = ValidatedIndicators.ATR(daily, cfg.atrPeriod);
    const atr = atrSeries.length > 0 ? atrSeries[atrSeries.length - 1] : NaN;
    if (!Number.isFinite(atr) || atr <= 0) {
      // Without a usable ATR there is no stop distance to size from — refuse
      // rather than emit a signal the engine would size to 0 or PositionMonitor
      // would give a fallback 2 % stop.
      return signals;
    }

    const stampedIndicators: Record<string, number> = {
      atr,
      donchianHigh,
      donchianLow,
      close,
    };
    const baseMetadata = {
      regime: context.regime.regime,
      barTime,
      dailySource: resolved.source,
      entryLookback: cfg.entryLookback,
      exitLookback: cfg.exitLookback,
      // Legacy reader path kept in step with trend_follow (TF-ATR-FILTER-PARITY).
      atr,
    };

    if (state.state === 'OUT') {
      // ENTRY: first close strictly ABOVE the prior entryLookback closing high.
      if (close > donchianHigh) {
        const strength = this.computeStrength((close - donchianHigh) / atr);
        if (strength < cfg.minStrength) {
          return signals;
        }
        const stopLoss = close - cfg.stopAtr * atr;
        const takeProfit = cfg.takeProfitAtr > 0
          ? close + cfg.takeProfitAtr * atr
          : close * NO_TAKE_PROFIT_PRICE_MULTIPLE;

        state.state = 'IN';
        state.entrySignalBarTime = barTime;
        state.barsSinceEntrySignal = 0;

        signals.push(
          this.createSignal({
            context,
            direction: 'buy',
            strength,
            stopLoss,
            takeProfit,
            reason:
              `S3 entry: daily close ${close} > prior ${cfg.entryLookback}-day closing high ${donchianHigh} ` +
              `(software stop ${cfg.stopAtr}×ATR, ${cfg.takeProfitAtr > 0 ? `TP ${cfg.takeProfitAtr}×ATR` : 'no take-profit'})`,
            indicators: stampedIndicators,
            metadata: {
              ...baseMetadata,
              intent: 'entry',
              ruleState: state.state,
              softwareStopAtr: cfg.stopAtr,
              takeProfitAtr: cfg.takeProfitAtr,
              noTakeProfit: cfg.takeProfitAtr <= 0,
            },
          }),
        );
      }
      return signals;
    }

    // IN: the fill bar (first bar after the entry signal) is not checked for
    // an exit — sim_brk mechanics (§1.2). First exit check is the bar after.
    if (state.barsSinceEntrySignal < 2) {
      return signals;
    }

    // EXIT: first close strictly BELOW the prior exitLookback closing low.
    if (close < donchianLow) {
      const strength = this.computeStrength((donchianLow - close) / atr);
      // An exit is never withheld on strength: leaving a position the rule
      // says to leave must not depend on a confidence heuristic.
      state.state = 'OUT';
      state.lastExitSignalBarTime = barTime;
      state.barsSinceEntrySignal = 0;

      signals.push(
        this.createSignal({
          context,
          direction: 'sell',
          strength,
          // Stamped for shape only — a sell against an open long is routed as an
          // EXIT (spot) and these levels are never used for a short.
          stopLoss: close + cfg.stopAtr * atr,
          takeProfit: cfg.takeProfitAtr > 0
            ? close - cfg.takeProfitAtr * atr
            : close / NO_TAKE_PROFIT_PRICE_MULTIPLE,
          reason:
            `S3 exit: daily close ${close} < prior ${cfg.exitLookback}-day closing low ${donchianLow} ` +
            '(close-evaluated rule exit; long-only — routed as exit of the open long)',
          indicators: stampedIndicators,
          metadata: {
            ...baseMetadata,
            intent: 'exit',
            ruleState: state.state,
            entrySignalBarTime: state.entrySignalBarTime,
            barsSinceEntrySignal: state.barsSinceEntrySignal,
          },
        }),
      );
    }

    return signals;
  }

  /** 0.5 base plus up to +0.4 for the breakout margin in ATR units (0.2 per ATR). */
  private computeStrength(marginAtr: number): number {
    const bonus = Number.isFinite(marginAtr) && marginAtr > 0 ? Math.min(0.4, marginAtr * 0.2) : 0;
    return Math.min(1.0, Math.max(0.1, 0.5 + bonus));
  }

  // ============ State ============

  private getOrInitState(symbol: string): DonchianSymbolState {
    let s = this.symbolState.get(symbol);
    if (!s) {
      s = {
        state: 'OUT',
        lastBarTime: null,
        entrySignalBarTime: null,
        barsSinceEntrySignal: 0,
        lastExitSignalBarTime: null,
      };
      this.symbolState.set(symbol, s);
    }
    return s;
  }

  /** Rule state for one symbol (OUT / untouched when never evaluated). */
  public getSymbolState(symbol: string): DonchianSymbolState {
    return { ...this.getOrInitState(symbol) };
  }

  /** Base state plus the per-symbol IN/OUT machine (for dashboards / tests). */
  getState(): Record<string, unknown> {
    const symbols: Record<string, DonchianSymbolState> = {};
    for (const [symbol, s] of this.symbolState) {
      symbols[symbol] = { ...s };
    }
    return {
      ...super.getState(),
      symbols,
    };
  }

  /**
   * Forget rule state — for one symbol, or all. Tests use this; production
   * restarts get the same effect implicitly (see header: state is not
   * persisted, every symbol boots OUT).
   */
  public resetState(symbol?: string): void {
    if (symbol === undefined) {
      this.symbolState.clear();
    } else {
      this.symbolState.delete(symbol);
    }
  }
}
