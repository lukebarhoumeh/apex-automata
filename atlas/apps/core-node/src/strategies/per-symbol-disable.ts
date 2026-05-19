/**
 * Per-(symbol, strategy) disable gate — pure helpers.
 *
 * Added 2026-05-19 to support disabling `momentum` on `*-PERP-INTX` symbols
 * without touching spot (F4 follow-up §8). The schema field
 * `PerpsSymbolLimitSchema.disabled_strategies` (also on `PerSymbolLimitSchema`
 * and `HyperliquidSymbolLimitSchema` for symmetry) carries the list. This
 * module turns that YAML data into a flat `Record<string, string[]>` map
 * that every consumer (backtest engine, signal processor, API server signal
 * handler) can index by `(symbol, strategy)` in O(1).
 *
 * Design notes:
 *   - Keep the data structure flat so consumers don't need to know about the
 *     per_symbol / perps_symbols / hyperliquid_symbols partitions.
 *   - Same merge precedence as `signal-processor.loadPerSymbolOverridesFromGuardrails`
 *     (api/server.ts:1631-1644 calls it twice — once per block — and the per-
 *     symbol keys never overlap, so collisions don't occur in practice).
 *   - Strictly additive vs the global `disabled_strategies` list. A signal
 *     is rejected if EITHER the global list OR the per-symbol list contains
 *     its strategy id.
 */

/**
 * Flat per-symbol disable map. Key: symbol id (e.g. `ETH-PERP-INTX`).
 * Value: list of strategy ids disabled on that symbol (e.g. `['momentum']`).
 */
export type PerSymbolDisabledStrategies = Record<string, string[]>;

/**
 * Subset of the guardrails shape this helper consumes. Loose-typed on
 * purpose so the helper can be used both from the strict-typed config layer
 * (`GuardrailConfig`) and from looser places (tests, the live API server
 * which has the full validated guardrails object in scope).
 */
export interface PerSymbolDisableSourceConfig {
  per_symbol?: Record<string, { disabled_strategies?: string[] }>;
  perps_symbols?: Record<string, { disabled_strategies?: string[] }>;
  hyperliquid_symbols?: Record<string, { disabled_strategies?: string[] }>;
}

/**
 * Flatten the per-symbol disable lists from the three guardrails blocks
 * into a single `Record<symbol, string[]>` map.
 *
 * - Symbols without a `disabled_strategies` key are omitted entirely (caller
 *   can distinguish "no per-symbol policy" from "empty policy" by key
 *   presence, though the gate check below treats both identically).
 * - When the same symbol appears in two blocks (shouldn't happen in
 *   practice — `per_symbol` is spot, `perps_symbols` is coinbase perp,
 *   `hyperliquid_symbols` is HL routing), the last block wins. This matches
 *   the live `loadPerSymbolOverridesFromGuardrails` semantics in
 *   api/server.ts:1631-1644.
 */
export function buildPerSymbolDisabledStrategies(
  guardrails: PerSymbolDisableSourceConfig,
): PerSymbolDisabledStrategies {
  const out: PerSymbolDisabledStrategies = {};
  const blocks: Array<Record<string, { disabled_strategies?: string[] }> | undefined> = [
    guardrails.per_symbol,
    guardrails.perps_symbols,
    guardrails.hyperliquid_symbols,
  ];
  for (const block of blocks) {
    if (!block) continue;
    for (const [symbol, cfg] of Object.entries(block)) {
      const disabled = cfg?.disabled_strategies;
      if (Array.isArray(disabled) && disabled.length > 0) {
        out[symbol] = [...disabled];
      }
    }
  }
  return out;
}

/**
 * O(1) gate check used at every signal-evaluation site. Returns true iff
 * the `(symbol, strategy)` pair is in the per-symbol disable list.
 *
 * Callers should still apply the GLOBAL `disabled_strategies` check
 * separately — this helper does not subsume that gate. The global list is
 * a hard kill (Phase-3 verdict); this is the surgical per-symbol scope.
 *
 * NOTE: Pass the per-symbol map either as the result of
 * `buildPerSymbolDisabledStrategies` or as `undefined` (no per-symbol
 * policy). Treats `undefined`, missing-key, and empty-array all as
 * "not disabled".
 */
export function isSymbolStrategyDisabled(
  map: PerSymbolDisabledStrategies | undefined,
  symbol: string,
  strategy: string,
): boolean {
  if (!map) return false;
  const disabled = map[symbol];
  if (!disabled || disabled.length === 0) return false;
  return disabled.includes(strategy);
}
