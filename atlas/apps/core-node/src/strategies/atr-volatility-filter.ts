/**
 * ATR volatility filter (`guardrails.filters.atr_volatility_min/max`) — pure
 * single source of truth for (a) the ATR a canonical signal carries and (b)
 * the pass / reject decision the router stage `atr_vol` makes from it.
 *
 * TF-ATR-FILTER-PARITY (2026-09-22): the live router read ONLY
 * `signal.metadata.indicators.atr`, but `trend_follow` stamped its ATR at
 * `signal.metadata.atr` (it passed `metadata: { atr }` to
 * `BaseStrategy.createSignal`, never `indicators: { atr }`), so for every
 * trend_follow entry the filter saw "no ATR" and let sub-floor (< 0.5%)
 * entries through in the paper soak. The backtest's `atr_vol` mirror had the
 * identical blind spot. Two fixes ship together:
 *
 *   1. The plugin now stamps BOTH paths (`indicators.atr` is canonical;
 *      `metadata.atr` stays for existing readers), and
 *   2. every `atr_vol` site resolves the ATR through {@link resolveSignalAtr}
 *      (canonical path first, legacy path second) and decides through
 *      {@link evaluateAtrVolatilityFilter}, so live and backtest can never
 *      disagree on what "the signal's ATR" is again.
 *
 * Semantics are unchanged otherwise: a signal with no usable ATR is NOT
 * rejected (`no_atr`), exactly as before — the outcome is merely surfaced so
 * callers can log the skip instead of failing silently.
 */

/** Loose `signal.metadata` shape — both stamp paths are optional/untyped upstream. */
export type SignalMetadataLike =
  | { indicators?: unknown; atr?: unknown; [key: string]: unknown }
  | null
  | undefined;

/** Where the resolved ATR came from. */
export type SignalAtrSource = 'indicators' | 'metadata';

/**
 * Resolve the ATR a signal carries with its provenance.
 *
 * Reads `metadata.indicators.atr` (canonical — what momentum / breakout /
 * vwap_mr and, since TF-ATR-FILTER-PARITY, trend_follow write) and falls back
 * to `metadata.atr` (trend_follow's legacy stamp). Only positive finite numbers
 * count; anything else resolves to `null`.
 */
export function resolveSignalAtrWithSource(
  metadata: SignalMetadataLike,
): { atr: number; source: SignalAtrSource } | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const indicators = metadata.indicators as Record<string, unknown> | undefined;
  const candidates: Array<[unknown, SignalAtrSource]> = [
    [indicators && typeof indicators === 'object' ? indicators.atr : undefined, 'indicators'],
    [metadata.atr, 'metadata'],
  ];
  for (const [candidate, source] of candidates) {
    if (typeof candidate === 'number' && Number.isFinite(candidate) && candidate > 0) {
      return { atr: candidate, source };
    }
  }
  return null;
}

/** ATR a signal carries (`indicators.atr` → `metadata.atr`), or `null` when absent / unusable. */
export function resolveSignalAtr(metadata: SignalMetadataLike): number | null {
  return resolveSignalAtrWithSource(metadata)?.atr ?? null;
}

/** Funnel stage slug the filter reports under (`SignalFilterStage`, `signals.reason` prefix). */
export const ATR_VOL_STAGE = 'atr_vol' as const;

/** Reason slug when ATR% is under `atr_volatility_min`. */
export const ATR_BELOW_MIN = 'atr_below_min' as const;
/** Reason slug when ATR% is over `atr_volatility_max`. */
export const ATR_ABOVE_MAX = 'atr_above_max' as const;

export type AtrVolatilityVerdict =
  /** ATR% inside `[atrMin, atrMax]` — entry may proceed. */
  | { outcome: 'pass'; atrPct: number; atr: number; atrSource: SignalAtrSource }
  /** Signal carries no usable ATR — filter not applicable, entry proceeds (legacy behaviour). */
  | { outcome: 'no_atr' }
  /** ATR% outside the band — reject with the funnel reason slug in `outcome`. */
  | { outcome: typeof ATR_BELOW_MIN | typeof ATR_ABOVE_MAX; atrPct: number; atr: number; atrSource: SignalAtrSource };

export interface AtrVolatilityCheck {
  /** `signal.metadata` — either stamp path is honoured. */
  metadata: SignalMetadataLike;
  /** Reference price the ATR is normalised against (the signal / entry price). */
  price: number;
  /** `guardrails.filters.atr_volatility_min` (decimal, e.g. 0.005 = 0.5%). Omit to skip the floor. */
  atrMin?: number;
  /** `guardrails.filters.atr_volatility_max` (decimal). Omit to skip the ceiling. */
  atrMax?: number;
}

/**
 * Decide the `atr_vol` stage for a signal.
 *
 * `atrPct = atr / price`; rejected when `atrPct < atrMin` or `atrPct > atrMax`
 * (strict, matching the historical router inequality). A non-positive price
 * or a signal without a usable ATR yields `no_atr` (the filter cannot be
 * applied and, as before, does not block).
 */
export function evaluateAtrVolatilityFilter(check: AtrVolatilityCheck): AtrVolatilityVerdict {
  const resolved = resolveSignalAtrWithSource(check.metadata);
  if (!resolved || !(check.price > 0)) {
    return { outcome: 'no_atr' };
  }
  const atrPct = resolved.atr / check.price;
  const base = { atrPct, atr: resolved.atr, atrSource: resolved.source };
  if (typeof check.atrMin === 'number' && atrPct < check.atrMin) {
    return { outcome: ATR_BELOW_MIN, ...base };
  }
  if (typeof check.atrMax === 'number' && atrPct > check.atrMax) {
    return { outcome: ATR_ABOVE_MAX, ...base };
  }
  return { outcome: 'pass', ...base };
}

/**
 * Blotter text for a rejection — identical to the pre-fix router format
 * (`"atr_below_min (atrPct=0.00300)"`) so `signals.reason` stays
 * `"atr_vol: atr_below_min (atrPct=0.00300)"` for the FE.
 */
export function describeAtrVolatilityReject(
  verdict: Extract<AtrVolatilityVerdict, { outcome: typeof ATR_BELOW_MIN | typeof ATR_ABOVE_MAX }>,
): string {
  return `${verdict.outcome} (atrPct=${verdict.atrPct.toFixed(5)})`;
}
