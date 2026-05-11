/**
 * Trend Follow Strategy Plugin
 * 
 * Higher-timeframe trend-following strategy designed to capture multi-day moves.
 * Uses EMA crossovers on 15m/1h timeframes with trailing stops for extended holds.
 * 
 * Entry Conditions:
 * - Fast EMA crosses above Slow EMA (bullish) or below (bearish)
 * - Price above/below both EMAs for confirmation
 * - Optional: ADX confirms trend strength
 * - Optional: Higher timeframe alignment (1h trend matches 15m signal)
 * 
 * Exit:
 * - Trailing stop based on ATR
 * - Optional: EMA re-cross exit
 * - Time-based exit after max hold period
 * 
 * Best suited for: strong_trend regime
 * Not suited for: choppy, ranging markets
 */

import { BaseStrategy } from '../base-strategy';
import { ValidatedIndicators } from '../../../indicators/validated-indicators';
import {
  MarketContext,
  StrategySignal,
  StrategyConfigSchema,
  RegimeCompatibility,
  IndicatorRequirement,
} from '../types';

// strategy-tuning (Bug A, 2026-05):
//   This plugin used to emit on every bar for up to `crossoverLookback` (=10)
//   bars after a single EMA12/EMA15 crossover, and its `requireMtfAlignment`
//   gate read `context.regime.trendDirection` — a 1m DI proxy from the regime
//   detector — instead of an actual 1h EMA alignment. Result in the live paper
//   run: ~3.6 signals/minute/symbol in a `regime: ranging` market with
//   `mtfAligned: true`. See fix/strategy-tuning. Fixes:
//
//     1. Default `crossoverLookback` lowered to 0 — emit ONLY on the bar AT
//        which the cross occurs. Ops can dial it up if their bar cadence
//        ever needs lookback, but the plugin will never silently re-emit by
//        default. Downstream `StrategyRegistry.deduplicateSignals` and
//        `SignalProcessor.lastSignals` 5-minute windows still apply on top.
//     2. `ranging` and `choppy` compatibility moved from `neutral` to
//        `incompatible` so the StrategyRegistry gates them out before
//        `generateSignals` is even called. Trend-following has negative
//        expected value in those regimes; the audit's verdict ("stays silent
//        for hours") is the correct behaviour.
//     3. When `requireMtfAlignment` is true, the gate now reads
//        `context.mtfCandles.h1` (real 1h candles aggregated by
//        SignalProcessor) and computes EMA(emaFast/emaSlow) on h1 closes.
//        If h1 history is insufficient (< emaSlow + 5 bars) the plugin
//        refuses to emit rather than lying about `mtfAligned: true`.

export class TrendFollowStrategy extends BaseStrategy {
  readonly id = 'trend_follow';
  readonly name = 'EMA Trend Follow';
  readonly description = 'Higher-timeframe trend following using EMA crossovers with trailing stops';
  readonly version = '1.0.0';
  readonly author = 'AtlasBot';
  readonly category = 'trend' as const;
  readonly tags = ['trend', 'ema', 'crossover', 'swing', 'higher-timeframe'];

  constructor(config?: Record<string, unknown>) {
    super(config);
    this.initializeWithConfig();
  }

  readonly configSchema: StrategyConfigSchema = {
    parameters: [
      {
        key: 'emaFast',
        name: 'Fast EMA Period',
        description: 'Period for the fast EMA',
        type: 'number',
        default: 12,
        min: 3,
        max: 50,
      },
      {
        key: 'emaSlow',
        name: 'Slow EMA Period',
        description: 'Period for the slow EMA',
        type: 'number',
        default: 15,
        min: 10,
        max: 100,
      },
      {
        key: 'atrPeriod',
        name: 'ATR Period',
        description: 'Period for ATR calculation (used for trailing stop)',
        type: 'number',
        default: 14,
        min: 5,
        max: 50,
      },
      {
        key: 'stopAtr',
        name: 'Stop Loss ATR Multiplier',
        description: 'Multiplier for ATR-based trailing stop distance',
        type: 'number',
        default: 2.5,
        min: 1.0,
        max: 5.0,
        step: 0.5,
      },
      {
        key: 'takeProfitAtr',
        name: 'Take Profit ATR Multiplier',
        description: 'Take profit distance as multiple of ATR',
        type: 'number',
        default: 5.0,
        min: 1.5,
        max: 10.0,
        step: 0.5,
      },
      {
        key: 'minAdx',
        name: 'Minimum ADX',
        description: 'Minimum ADX value to confirm trend strength (0 to disable)',
        type: 'number',
        default: 0,
        min: 0,
        max: 50,
      },
      {
        key: 'requireMtfAlignment',
        name: 'Require MTF Alignment',
        description:
          'Require real 1h EMA(emaFast/emaSlow) alignment on aggregated h1 candles. When true and h1 history is insufficient (< emaSlow + 5 bars), the plugin refuses to emit.',
        type: 'boolean',
        default: false,
      },
      {
        key: 'crossoverLookback',
        name: 'Crossover Lookback',
        description:
          'Bars after a crossover within which the plugin is still allowed to emit. 0 = emit only on the bar where the cross occurs (recommended; one signal per crossover event). Higher values cause re-emission per bar.',
        type: 'number',
        default: 0,
        min: 0,
        max: 20,
      },
      {
        key: 'minStrength',
        name: 'Minimum Signal Strength',
        description: 'Minimum strength threshold for signal generation',
        type: 'number',
        default: 0.5,
        min: 0.1,
        max: 1.0,
        step: 0.1,
      },
    ],
  };

  readonly requiredIndicators: IndicatorRequirement[] = [
    { name: 'ema12', required: true, description: 'Fast EMA (12-period by default)' },
    { name: 'ema15', required: true, description: 'Slow EMA (15-period by default)' },
    { name: 'atr', required: true, description: 'ATR for stop/target calculation' },
    { name: 'adx', required: false, description: 'ADX for trend strength confirmation' },
  ];

  readonly regimeCompatibility: RegimeCompatibility[] = [
    {
      regime: 'strong_trend',
      compatibility: 'optimal',
      positionMultiplier: 1.0,
      notes: 'Ideal conditions - trend following excels in strong trends',
    },
    {
      regime: 'weak_trend',
      compatibility: 'compatible',
      positionMultiplier: 0.7,
      notes: 'Workable but reduced position size due to weaker momentum',
    },
    {
      regime: 'ranging',
      // strategy-tuning: trend-following has negative expected value in
      // ranging conditions (audit + Phase 3 backtest). StrategyRegistry
      // gates 'incompatible' regimes before generateSignals runs.
      compatibility: 'incompatible',
      positionMultiplier: 0,
      notes: 'Trend-following has negative EV in ranging markets — refuse to emit',
    },
    {
      regime: 'choppy',
      compatibility: 'incompatible',
      positionMultiplier: 0,
      notes: 'Whipsaw kills trend-following P&L — refuse to emit',
    },
  ];

  generateSignals(context: MarketContext): StrategySignal[] {
    const signals: StrategySignal[] = [];
    const { symbol } = context;

    // Get config (with per-symbol overrides from guardrails.yaml)
    const emaFast = this.getConfig<number>('emaFast', 12, symbol);
    const emaSlow = this.getConfig<number>('emaSlow', 15, symbol);
    const stopAtr = this.getConfig<number>('stopAtr', 2.5, symbol);
    const takeProfitAtr = this.getConfig<number>('takeProfitAtr', 5.0, symbol);
    const minAdx = this.getConfig<number>('minAdx', 0, symbol);
    const requireMtfAlignment = this.getConfig<boolean>('requireMtfAlignment', false, symbol);
    // Inline fallback intentionally matches the schema default (0 = current bar
    // only). This was 10 previously and was the proximate cause of the per-bar
    // re-emission documented in fix/strategy-tuning.
    const crossoverLookback = this.getConfig<number>('crossoverLookback', 0, symbol);
    const minStrength = this.getConfig<number>('minStrength', 0.5, symbol);

    // Use dynamic indicator names based on config
    const fastEmaKey = `ema${emaFast}`;
    const slowEmaKey = `ema${emaSlow}`;
    
    const fastEma = context.indicators[fastEmaKey] || context.indicators.ema9;
    const slowEma = context.indicators[slowEmaKey] || context.indicators.ema21;
    const atr = context.indicators.atr;
    const adx = context.indicators.adx;

    // Validate required data
    if (!fastEma || !slowEma || !atr) {
      return signals;
    }

    // Need at least 2 EMA samples to detect a cross between prev/curr bar.
    // The optional lookback then needs `crossoverLookback` additional bars on
    // top of those two — guard accordingly.
    if (
      fastEma.length < crossoverLookback + 2 ||
      slowEma.length < crossoverLookback + 2
    ) {
      return signals;
    }

    const currentFastEma = fastEma[fastEma.length - 1];
    const currentSlowEma = slowEma[slowEma.length - 1];
    const prevFastEma = fastEma[fastEma.length - 2];
    const prevSlowEma = slowEma[slowEma.length - 2];
    const currentAtr = atr[atr.length - 1];
    const currentAdx = adx?.[adx.length - 1];
    const price = context.latestCandle.close;

    // Check ADX filter if enabled
    if (minAdx > 0 && currentAdx !== undefined && currentAdx < minAdx) {
      return signals; // Trend not strong enough
    }

    // Detect crossover within lookback period
    let bullishCrossover = false;
    let bearishCrossover = false;
    let crossoverBarsAgo = 0;

    for (let i = 1; i <= crossoverLookback; i++) {
      const idx = fastEma.length - 1 - i;
      if (idx < 1) break;

      const prevFast = fastEma[idx - 1];
      const prevSlow = slowEma[idx - 1];
      const currFast = fastEma[idx];
      const currSlow = slowEma[idx];

      // Bullish crossover: fast crosses above slow
      if (prevFast <= prevSlow && currFast > currSlow) {
        bullishCrossover = true;
        crossoverBarsAgo = i;
        break;
      }

      // Bearish crossover: fast crosses below slow
      if (prevFast >= prevSlow && currFast < currSlow) {
        bearishCrossover = true;
        crossoverBarsAgo = i;
        break;
      }
    }

    // Also check current bar for crossover
    if (!bullishCrossover && !bearishCrossover) {
      if (prevFastEma <= prevSlowEma && currentFastEma > currentSlowEma) {
        bullishCrossover = true;
        crossoverBarsAgo = 0;
      } else if (prevFastEma >= prevSlowEma && currentFastEma < currentSlowEma) {
        bearishCrossover = true;
        crossoverBarsAgo = 0;
      }
    }

    if (!bullishCrossover && !bearishCrossover) {
      return signals; // No crossover detected
    }

    // Price confirmation: should be on the right side of both EMAs
    const priceAboveBothEmas = price > currentFastEma && price > currentSlowEma;
    const priceBelowBothEmas = price < currentFastEma && price < currentSlowEma;

    // Check MTF alignment if required.
    //
    // Pre-fix this branch read `context.regime.trendDirection`, which the
    // RegimeDetector derives from the 1m +DI / -DI difference. That is NOT
    // a 1h alignment check — it's a 1m DI proxy that frequently disagrees
    // with actual hourly EMA stack. Real fix: read aggregated 1h candles
    // from `context.mtfCandles.h1` (populated by SignalProcessor's
    // `updateMultiTimeframeCandles`) and compute EMA(emaFast/emaSlow) on
    // 1h closes. If h1 history is insufficient, refuse to emit rather than
    // claiming `mtfAligned: true`.
    //
    // mtfAlignedReport is what we put in the signal metadata:
    //   - undefined        → gate disabled (`requireMtfAlignment === false`)
    //   - true             → real 1h check passed
    //   - 'insufficient'   → blocked (never reaches emission, kept for tests
    //                        and debugging in earlier exits)
    let mtfAlignedReport: true | 'insufficient' | undefined;
    if (requireMtfAlignment) {
      const h1Candles = context.mtfCandles?.h1;
      const minH1Bars = emaSlow + 5;
      if (!h1Candles || h1Candles.length < minH1Bars) {
        // Required gate has no data — REFUSE to emit. Previously the plugin
        // would have fallen through to `mtfAligned = true`, which is the
        // exact lie the audit flagged.
        return signals;
      }
      const h1Closes = h1Candles.map(c => c.close);
      const h1Fast = ValidatedIndicators.EMA(h1Closes, emaFast);
      const h1Slow = ValidatedIndicators.EMA(h1Closes, emaSlow);
      if (h1Fast.length === 0 || h1Slow.length === 0) {
        return signals;
      }
      const h1FastLatest = h1Fast[h1Fast.length - 1];
      const h1SlowLatest = h1Slow[h1Slow.length - 1];
      const h1Bullish = h1FastLatest > h1SlowLatest;
      const h1Bearish = h1FastLatest < h1SlowLatest;
      if (bullishCrossover && !h1Bullish) {
        return signals;
      }
      if (bearishCrossover && !h1Bearish) {
        return signals;
      }
      mtfAlignedReport = true;
    }

    // Calculate signal strength
    let strength = 0.5;

    // Boost for recent crossover
    strength += (crossoverLookback - crossoverBarsAgo) * 0.05;

    // Boost for strong ADX
    if (currentAdx !== undefined) {
      if (currentAdx > 30) strength += 0.15;
      else if (currentAdx > 25) strength += 0.1;
      else if (currentAdx > 20) strength += 0.05;
    }

    // Boost for price confirmation
    if ((bullishCrossover && priceAboveBothEmas) || (bearishCrossover && priceBelowBothEmas)) {
      strength += 0.1;
    }

    // Boost for MTF alignment — only credit when the gate actually ran and
    // passed (not when the gate is disabled).
    if (mtfAlignedReport === true) {
      strength += 0.1;
    }

    // Boost for strong regime
    if (context.regime.regime === 'strong_trend') {
      strength += 0.1;
    }

    // Clamp strength
    strength = Math.min(1.0, Math.max(0.1, strength));

    // Check minimum strength
    if (strength < minStrength) {
      return signals;
    }

    // Generate signal
    const stopDistance = currentAtr * stopAtr;
    const targetDistance = currentAtr * takeProfitAtr;

    // Reported metadata for downstream dashboards/audit logs: explicit
    // tristate so consumers can tell "gate disabled" from "gate passed".
    const metadataMtf: {
      mtfRequired: boolean;
      mtfAligned: boolean | 'disabled';
    } = {
      mtfRequired: requireMtfAlignment,
      mtfAligned: requireMtfAlignment ? mtfAlignedReport === true : 'disabled',
    };

    if (bullishCrossover && priceAboveBothEmas) {
      const stopLoss = price - stopDistance;
      const takeProfit = price + targetDistance;

      signals.push(
        this.createSignal({
          context,
          direction: 'buy',
          strength,
          stopLoss,
          takeProfit,
          reason: `Bullish EMA crossover (${emaFast}/${emaSlow}) with price confirmation`,
          metadata: {
            fastEma: currentFastEma,
            slowEma: currentSlowEma,
            atr: currentAtr,
            adx: currentAdx,
            crossoverBarsAgo,
            ...metadataMtf,
            regime: context.regime.regime,
          },
        })
      );
    } else if (bearishCrossover && priceBelowBothEmas) {
      const stopLoss = price + stopDistance;
      const takeProfit = price - targetDistance;

      signals.push(
        this.createSignal({
          context,
          direction: 'sell',
          strength,
          stopLoss,
          takeProfit,
          reason: `Bearish EMA crossover (${emaFast}/${emaSlow}) with price confirmation`,
          metadata: {
            fastEma: currentFastEma,
            slowEma: currentSlowEma,
            atr: currentAtr,
            adx: currentAdx,
            crossoverBarsAgo,
            ...metadataMtf,
            regime: context.regime.regime,
          },
        })
      );
    }

    return signals;
  }

  validateContext(context: MarketContext): { valid: boolean; reason?: string } {
    const emaFast = this.getConfig<number>('emaFast', 12);
    const emaSlow = this.getConfig<number>('emaSlow', 15);
    // Fallbacks must match analyze() (ema9 / ema21) — the previous fallback to
    // ema15 was always undefined when the requested key was, leaving slowEma
    // null and gating every signal at validateContext.
    const fastEma = context.indicators[`ema${emaFast}`] || context.indicators.ema9;
    const slowEma = context.indicators[`ema${emaSlow}`] || context.indicators.ema21;
    const atr = context.indicators.atr;

    if (!fastEma || fastEma.length < 25) {
      return { valid: false, reason: 'Insufficient fast EMA data (need 25+ candles)' };
    }

    if (!slowEma || slowEma.length < 25) {
      return { valid: false, reason: 'Insufficient slow EMA data (need 25+ candles)' };
    }

    if (!atr || atr.length < 15) {
      return { valid: false, reason: 'Insufficient ATR data (need 15+ candles)' };
    }

    return { valid: true };
  }
}
