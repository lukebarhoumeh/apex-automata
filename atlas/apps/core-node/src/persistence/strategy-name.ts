/**
 * `public.strategy_name` enum normalisation for persisted rows.
 *
 * `orders.strategy`, `positions.strategy` and `signals.strategy` are typed with
 * the Postgres enum `strategy_name`. A value outside the enum fails the whole
 * row write with 22P02 (invalid input value for enum), and for `positions` that
 * includes the CLOSE write — the row would then stay open forever. Every
 * persisted strategy label therefore goes through one mapping:
 *
 *   - an enum value (case-insensitive) passes through unchanged;
 *   - the legacy display name `VWAPMeanReversion` maps to `vwap_mr`;
 *   - anything else — empty, non-string, an unknown id, and any strategy id
 *     the enum does not have yet — becomes `system`, the neutral tag added by
 *     migration 20260427161412 for engine-originated activity. NEVER a real
 *     strategy: `syncPositionToSupabase` used to default to `breakout`, a
 *     killed strategy, so every context-less position polluted its audit
 *     trail (finding 7, docs/research/2026-09-28_paper-persistence-verification.md §2).
 *
 * `donchian_daily_s3` (plugin PAPER-S3-DONCHIAN-v0, default OFF) is NOT in the
 * enum today and is therefore persisted as `system` too. Adding it needs an
 * `ALTER TYPE strategy_name ADD VALUE` migration — a separate desk decision;
 * when it lands, add the id to `STRATEGY_NAME_ENUM_VALUES` in the same PR.
 *
 * Pure: the caller decides whether a fallback is worth a log line.
 */

/**
 * Values of `public.strategy_name` as deployed. Last confirmed against the
 * migrations on 2026-09-29: 20251013054024 (breakout, vwap_mr, obi_scalper),
 * 20251016192352 (momentum), 20260303175729 (trend_follow),
 * 20260427161412 (system). Any addition here needs a matching ALTER TYPE.
 */
export const STRATEGY_NAME_ENUM_VALUES = [
  'breakout',
  'vwap_mr',
  'obi_scalper',
  'momentum',
  'trend_follow',
  'system',
] as const;

export type StrategyNameEnum = (typeof STRATEGY_NAME_ENUM_VALUES)[number];

/** Neutral enum value for engine-originated or unattributed activity. */
export const STRATEGY_NAME_FALLBACK: StrategyNameEnum = 'system';

/** Legacy display names that map onto an enum value. */
const STRATEGY_NAME_ALIASES: Readonly<Record<string, StrategyNameEnum>> = {
  vwapmeanreversion: 'vwap_mr',
};

export interface ResolvedStrategyName {
  /** The value safe to write into a `strategy_name` column. */
  value: StrategyNameEnum;
  /** True when `received` was empty / not a string (nothing to attribute). */
  empty: boolean;
  /** True when `received` was a non-empty string the enum does not know (worth auditing). */
  unknown: boolean;
  /** What the caller handed in, for the audit log line. */
  received: unknown;
}

/**
 * Map a runtime strategy label onto the deployed `strategy_name` enum.
 *
 * @param received Strategy id / name as carried on the engine object (`ManagedOrder.strategy`,
 *   `Position.strategy`); any type is accepted.
 */
export function resolveStrategyName(received: unknown): ResolvedStrategyName {
  const candidate = typeof received === 'string' ? received.trim().toLowerCase() : '';
  if (candidate.length === 0) {
    return { value: STRATEGY_NAME_FALLBACK, empty: true, unknown: false, received };
  }
  if ((STRATEGY_NAME_ENUM_VALUES as ReadonlyArray<string>).includes(candidate)) {
    return { value: candidate as StrategyNameEnum, empty: false, unknown: false, received };
  }
  const alias = STRATEGY_NAME_ALIASES[candidate];
  if (alias) {
    return { value: alias, empty: false, unknown: false, received };
  }
  return { value: STRATEGY_NAME_FALLBACK, empty: false, unknown: true, received };
}

/**
 * The `positions.strategy` value for a tracker `Position`: the same mapping as
 * orders, defaulting to `system` (never `breakout`) for a context-less position.
 *
 * @param position Any object carrying `PositionTracker`'s optional `strategy`.
 */
export function resolvePositionStrategy(position: { strategy?: unknown } | null | undefined): ResolvedStrategyName {
  return resolveStrategyName(position?.strategy);
}
