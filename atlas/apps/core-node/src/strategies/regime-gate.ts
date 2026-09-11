/**
 * Regime-conditional gate (A6, 2026-05-29) — pure helpers.
 *
 * A surgical, config-driven gate that blocks a strategy's signals when the
 * CONFIDENTLY-classified market regime is one in which that strategy has
 * empirically negative edge (see docs/research/2026-05-29_a6-regime-conditional-gates.md).
 *
 * Why this exists when the system is already regime-aware:
 *   - Strategy plugins declare `regimeCompatibility`; `StrategyRegistry` already
 *     refuses to emit `trend_follow` in ranging/choppy (it self-gates there).
 *   - `RegimeFilter` blocks counter-trend trades and incompatible-regime
 *     signals (compat < minCompatibilityScore).
 *   This gate is the *empirically-derived* layer ON TOP of those: the A6
 *   diagnostic found edge that the static plugin matrix misses (e.g.
 *   trend_follow's weak_trend bleed at PF ~0.80 across 90d AND 12m windows).
 *
 * Design (mirrors ./per-symbol-disable.ts so consumers stay uniform):
 *   - Pure functions, no I/O. `buildRegimeGateConfig` normalises the YAML
 *     (snake_case) block into a typed config; `evaluateRegimeGate` is the
 *     O(rules) per-signal check used at every evaluation site.
 *   - DISABLED BY DEFAULT. `evaluateRegimeGate` is a no-op unless
 *     `config.enabled === true`, so live/paper behaviour is UNCHANGED until a
 *     human flips `guardrails.regime_gates.enabled` (or passes
 *     `pnpm backtest --regime-conditional-gates` for measurement; the
 *     CLI's `--regime-gates on|off` is the unrelated RegimeFilter toggle).
 *   - Keys on the *stamped* regime (`signal.metadata.regime`), which is only
 *     present for a confidently-classified regime. Signals admitted via the
 *     RegimeFilter low-confidence bypass carry no stamped regime; the A6
 *     diagnostic showed those ('unknown') trades are NOT the bleeders, so an
 *     absent/unknown regime is never gated.
 */

import type { MarketRegime } from './regime-detector';

/** Trading venue bucket derived from the symbol id. */
export type GateVenue = 'spot' | 'PERP';

/**
 * One regime-gate rule. A signal is blocked when its `(strategy, venue,
 * symbol)` matches a rule AND its stamped regime is in `blockRegimes`.
 * `venues` / `symbols` are optional scopes — absent = applies to all.
 */
export interface RegimeGateRule {
  strategy: string;
  blockRegimes: MarketRegime[];
  venues?: GateVenue[];
  symbols?: string[];
}

/** Normalised regime-gate configuration consumed by the pipeline. */
export interface RegimeGateConfig {
  enabled: boolean;
  rules: RegimeGateRule[];
}

/**
 * Loose subset of the guardrails shape this helper reads. Snake_case to match
 * the on-disk YAML; loose-typed so it works from both the strict config layer
 * (`GuardrailConfig`) and from tests.
 */
export interface RegimeGateSourceConfig {
  regime_gates?: {
    enabled?: boolean;
    rules?: Array<{
      strategy: string;
      block_regimes?: string[];
      venues?: string[];
      symbols?: string[];
    }>;
  };
}

/** Spot vs perp bucket. Mirrors the venue split used across the engine. */
export function venueForSymbol(symbol: string): GateVenue {
  return /PERP/i.test(symbol) ? 'PERP' : 'spot';
}

/**
 * Normalise the `guardrails.regime_gates` block into a typed
 * {@link RegimeGateConfig}. Absent block → disabled, no rules.
 */
export function buildRegimeGateConfig(guardrails: RegimeGateSourceConfig): RegimeGateConfig {
  const block = guardrails.regime_gates;
  if (!block) {
    return { enabled: false, rules: [] };
  }
  const rules: RegimeGateRule[] = (block.rules ?? []).map((r) => ({
    strategy: r.strategy,
    blockRegimes: [...((r.block_regimes ?? []) as MarketRegime[])],
    ...(r.venues ? { venues: [...(r.venues as GateVenue[])] } : {}),
    ...(r.symbols ? { symbols: [...r.symbols] } : {}),
  }));
  return { enabled: Boolean(block.enabled), rules };
}

export interface RegimeGateCheck {
  strategy: string;
  symbol: string;
  /** The stamped regime from `signal.metadata.regime`; undefined = low-confidence. */
  regime: string | undefined;
}

export interface RegimeGateDecision {
  blocked: boolean;
  rule?: RegimeGateRule;
}

/**
 * O(rules) per-signal gate check. Returns `{ blocked: false }` when the gate
 * is disabled, the regime is absent/unknown, or no rule matches.
 */
export function evaluateRegimeGate(
  config: RegimeGateConfig | undefined,
  check: RegimeGateCheck,
): RegimeGateDecision {
  if (!config || !config.enabled || config.rules.length === 0) {
    return { blocked: false };
  }
  const { strategy, symbol, regime } = check;
  // Only act on a confidently-classified regime (see module header).
  if (!regime || regime === 'unknown') {
    return { blocked: false };
  }
  const venue = venueForSymbol(symbol);
  for (const rule of config.rules) {
    if (rule.strategy !== strategy) continue;
    if (rule.venues && !rule.venues.includes(venue)) continue;
    if (rule.symbols && !rule.symbols.includes(symbol)) continue;
    if (rule.blockRegimes.includes(regime as MarketRegime)) {
      return { blocked: true, rule };
    }
  }
  return { blocked: false };
}
