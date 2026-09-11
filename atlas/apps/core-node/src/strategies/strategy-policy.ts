/**
 * Strategy policy snapshot — guardrails.yaml as the single source of truth
 * for which built-in strategies are killed (TASK_016 P4).
 *
 * Killed strategies are refused at StrategyRegistry registration, so
 * `/api/strategies` never lists them and the UI could not tell "killed by
 * SoT" apart from "does not exist". This module builds a complete, engine-
 * independent view (works while the signal processor is not running) that
 * the API serves at `GET /api/strategies/policy`.
 */

import { getBuiltinStrategyMetadata } from './plugins/builtin';
import {
  buildPerSymbolDisabledStrategies,
  type PerSymbolDisableSourceConfig,
  type PerSymbolDisabledStrategies,
} from './per-symbol-disable';

/** Relative path shown to the UI so operators know where to look. */
export const STRATEGY_POLICY_SOURCE = 'atlas/config/guardrails.yaml';

export interface StrategyPolicyEntry {
  id: string;
  name: string;
  description: string;
  category: string;
  /** True when the id is in the global `disabled_strategies` list. */
  disabledByGuardrails: boolean;
}

export interface StrategyPolicy {
  source: string;
  disabledStrategies: string[];
  perSymbolDisabledStrategies: PerSymbolDisabledStrategies;
  strategies: StrategyPolicyEntry[];
}

/** Subset of the guardrails shape this module reads. */
export interface StrategyPolicySourceConfig extends PerSymbolDisableSourceConfig {
  disabled_strategies?: string[];
}

export interface BuiltinStrategyDescriptor {
  id: string;
  name: string;
  description: string;
  category: string;
}

let builtinMetadataCache: BuiltinStrategyDescriptor[] | null = null;

/**
 * Built-in plugin descriptors. Instantiating the plugins only to read their
 * metadata is cheap but not free, so the result is memoised for the process.
 */
function builtinMetadata(): BuiltinStrategyDescriptor[] {
  if (!builtinMetadataCache) {
    builtinMetadataCache = getBuiltinStrategyMetadata().map(({ id, name, description, category }) => ({
      id,
      name,
      description,
      category,
    }));
  }
  return builtinMetadataCache;
}

/**
 * Build the policy snapshot from a loaded guardrails object.
 *
 * @param guardrails - Validated guardrails config (or any object carrying the
 *   `disabled_strategies` / per-symbol blocks).
 * @param builtins - Optional descriptor override for tests; defaults to the
 *   real built-in plugin metadata.
 */
export function buildStrategyPolicy(
  guardrails: StrategyPolicySourceConfig,
  builtins: BuiltinStrategyDescriptor[] = builtinMetadata(),
): StrategyPolicy {
  const disabled = Array.isArray(guardrails.disabled_strategies)
    ? [...new Set(guardrails.disabled_strategies)]
    : [];
  const disabledSet = new Set(disabled);

  return {
    source: STRATEGY_POLICY_SOURCE,
    disabledStrategies: disabled,
    perSymbolDisabledStrategies: buildPerSymbolDisabledStrategies(guardrails),
    strategies: builtins.map((b) => ({
      id: b.id,
      name: b.name,
      description: b.description,
      category: b.category,
      disabledByGuardrails: disabledSet.has(b.id),
    })),
  };
}
