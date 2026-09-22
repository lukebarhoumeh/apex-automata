/**
 * Regime-conditional gate (A6, 2026-05-29; TF-REGIME-GATE, 2026-09-22) — pure helpers.
 *
 * A surgical, config-driven gate that blocks a strategy's NEW ENTRIES when the
 * market regime is one in which that strategy has empirically negative edge
 * (see docs/research/2026-05-29_a6-regime-conditional-gates.md).
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
 *     (snake_case) block into a typed config for ONE execution mode;
 *     `evaluateRegimeGate` is the O(rules) per-signal check.
 *   - PAPER-ONLY BY DEFAULT (`regime_gates.paper_only`, schema default true).
 *     The resolved config is `enabled: false` for `live` and `backtest` unless
 *     the YAML explicitly says `paper_only: false`, so live behaviour is
 *     byte-for-byte unchanged by flipping `enabled`. Backtests measure the
 *     gate with `pnpm backtest --regime-conditional-gates` (the CLI's
 *     `--regime-gates on|off` is the unrelated RegimeFilter toggle).
 *   - ENTRIES ONLY. A signal that opposes an open position on the same
 *     symbol is an exit / reversal (`intent: 'exit'`) and is never gated —
 *     the gate must never trap a position inside a regime it dislikes. The
 *     caller classifies intent with {@link classifySignalIntent} because only
 *     the router / backtest engine have position visibility.
 *   - Keys on the regime the caller supplies (`signal.metadata.regime`, which
 *     the trend_follow plugin stamps from the detector on every signal; the
 *     router falls back to the live detector state). An absent/unknown
 *     regime is never gated — a data gap must not silently block entries.
 *   - Enforced at the ROUTER stage (api/server.ts `signal:generated`), AFTER
 *     the canonical `signals` row is inserted, so a blocked entry is persisted
 *     with `allowed = false` and `reason = "regime_gate: …"` for the FE blotter
 *     — the same contract every other router-stage gate (time, atr_vol,
 *     ev_gate …) honours. Not enforced inside SignalProcessor: that site is
 *     position-blind and pre-persist, so it would block exits and hide the
 *     deny reason.
 */

import type { MarketRegime } from './regime-detector';

/** Trading venue bucket derived from the symbol id. */
export type GateVenue = 'spot' | 'PERP';

/**
 * Execution mode the gate config is resolved for. `paper_only` rules are
 * active for `paper` only; `live` and `backtest` resolve to a disabled gate
 * (backtests opt in per run via `forceRegimeConditionalGates`).
 */
export type RegimeGateExecutionMode = 'paper' | 'live' | 'backtest';

/** Whether a signal would open/add to a position (`entry`) or close/reverse one (`exit`). */
export type SignalIntent = 'entry' | 'exit';

/** Funnel stage slug the gate reports under (`SignalFilterStage`, `signals.reason` prefix). */
export const REGIME_GATE_STAGE = 'regime_gate' as const;

/** Funnel reason slug for a blocked entry (Prometheus `reason` label). */
export const REGIME_GATE_REASON_CODE = 'regime_blocked' as const;

/**
 * One regime-gate rule. A signal is blocked when its `(strategy, venue,
 * symbol)` matches a rule AND its regime is in `blockRegimes`.
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
  /** Effective switch for `mode`: YAML `enabled` AND (`!paperOnly` OR `mode === 'paper'`). */
  enabled: boolean;
  /** YAML `paper_only` (default true). Carried for banners / audit context. */
  paperOnly: boolean;
  /** Execution mode this config was resolved for. */
  mode: RegimeGateExecutionMode;
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
    paper_only?: boolean;
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
 * {@link RegimeGateConfig} for `mode`. Absent block → disabled, no rules.
 *
 * `paper_only` defaults to TRUE when the YAML omits it: the gate can only
 * ever reach live execution through an explicit `paper_only: false`.
 *
 * @param guardrails Parsed guardrails (or any object carrying `regime_gates`).
 * @param mode Execution mode the caller runs in (`paper` | `live` | `backtest`).
 */
export function buildRegimeGateConfig(
  guardrails: RegimeGateSourceConfig,
  mode: RegimeGateExecutionMode,
): RegimeGateConfig {
  const block = guardrails.regime_gates;
  if (!block) {
    return { enabled: false, paperOnly: true, mode, rules: [] };
  }
  const rules: RegimeGateRule[] = (block.rules ?? []).map((r) => ({
    strategy: r.strategy,
    blockRegimes: [...((r.block_regimes ?? []) as MarketRegime[])],
    ...(r.venues ? { venues: [...(r.venues as GateVenue[])] } : {}),
    ...(r.symbols ? { symbols: [...r.symbols] } : {}),
  }));
  const paperOnly = block.paper_only ?? true;
  const enabled = Boolean(block.enabled) && (!paperOnly || mode === 'paper');
  return { enabled, paperOnly, mode, rules };
}

/**
 * Classify a signal as an entry or an exit from the caller's position view.
 *
 * A signal that opposes an open position on the SAME symbol (sell vs long,
 * buy vs short) closes or reverses it and is an `exit`; everything else —
 * flat, same-side add, or a position on a different instrument — is an
 * `entry`. Cross-venue netting (ETH-USD vs ETH-PERP-INTX) is deliberately
 * NOT an exit here: a perp short cannot close a spot long.
 *
 * @param direction Signal direction.
 * @param openPositionSide Side of the open position on the signal's symbol, if any.
 */
export function classifySignalIntent(
  direction: 'buy' | 'sell',
  openPositionSide: 'long' | 'short' | 'flat' | null | undefined,
): SignalIntent {
  if (direction === 'sell' && openPositionSide === 'long') return 'exit';
  if (direction === 'buy' && openPositionSide === 'short') return 'exit';
  return 'entry';
}

export interface RegimeGateCheck {
  strategy: string;
  symbol: string;
  /** Regime the signal was emitted in (`signal.metadata.regime`); undefined = unknown. */
  regime: string | undefined;
  /** Entry vs exit as classified by the caller; defaults to `entry` (gate applies). */
  intent?: SignalIntent;
}

export interface RegimeGateDecision {
  blocked: boolean;
  rule?: RegimeGateRule;
  /**
   * Human-readable deny reason for the blotter (`signals.reason` carries
   * `"regime_gate: <reason>"`). Only set when `blocked`.
   */
  reason?: string;
}

/**
 * Deny reason shown to operators / the FE for a blocked entry, e.g.
 * `trend_follow new entry blocked: regime=weak_trend (paper-only regime gate blocks weak_trend|choppy)`.
 */
export function describeRegimeGateBlock(
  config: Pick<RegimeGateConfig, 'paperOnly'>,
  check: Pick<RegimeGateCheck, 'strategy' | 'regime'>,
  rule: RegimeGateRule,
): string {
  const scope = config.paperOnly ? 'paper-only ' : '';
  return (
    `${check.strategy} new entry blocked: regime=${check.regime} ` +
    `(${scope}regime gate blocks ${rule.blockRegimes.join('|')})`
  );
}

/**
 * O(rules) per-signal gate check. Returns `{ blocked: false }` when the gate
 * is disabled, the signal is an exit, the regime is absent/unknown, or no
 * rule matches.
 */
export function evaluateRegimeGate(
  config: RegimeGateConfig | undefined,
  check: RegimeGateCheck,
): RegimeGateDecision {
  if (!config || !config.enabled || config.rules.length === 0) {
    return { blocked: false };
  }
  // Exits / reversals are never gated (see module header).
  if (check.intent === 'exit') {
    return { blocked: false };
  }
  const { strategy, symbol, regime } = check;
  // Only act on a known regime (see module header).
  if (!regime || regime === 'unknown') {
    return { blocked: false };
  }
  const venue = venueForSymbol(symbol);
  for (const rule of config.rules) {
    if (rule.strategy !== strategy) continue;
    if (rule.venues && !rule.venues.includes(venue)) continue;
    if (rule.symbols && !rule.symbols.includes(symbol)) continue;
    if (rule.blockRegimes.includes(regime as MarketRegime)) {
      return { blocked: true, rule, reason: describeRegimeGateBlock(config, check, rule) };
    }
  }
  return { blocked: false };
}
