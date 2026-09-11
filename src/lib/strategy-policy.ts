import type { BackendStrategyPolicy } from "@/services/apexDashboardApi";
import type { StrategyDisabledBy } from "@/types/strategy";

/** Minimal shape shared by the /api/strategies entries the hooks consume. */
export interface RegisteredStrategyLike {
  id: string;
  name: string;
  description?: string;
  category?: string;
  enabled: boolean;
}

export interface MergedStrategy<T extends RegisteredStrategyLike> {
  id: string;
  name: string;
  description: string;
  category: string;
  enabled: boolean;
  disabledBy?: StrategyDisabledBy;
  /** The runtime registration when the plugin is registered; null otherwise. */
  registered: T | null;
}

/**
 * Overlay the guardrails policy (single source of truth) on the runtime's
 * registered strategy list so every built-in strategy is shown once:
 *
 * - registered + enabled            → enabled
 * - registered + disabled           → disabled by runtime
 * - in `disabled_strategies`        → killed by guardrails (SoT wins, even if
 *                                     a stale runtime somehow still lists it)
 * - known built-in, not registered  → engine offline (state unknown)
 *
 * With no policy (endpoint unavailable) the registered list passes through
 * unchanged, so an older backend degrades to today's behaviour.
 */
export function mergeStrategyPolicy<T extends RegisteredStrategyLike>(
  registered: readonly T[],
  policy: BackendStrategyPolicy | null | undefined,
): MergedStrategy<T>[] {
  const killed = new Set(policy?.disabledStrategies ?? []);
  const seen = new Set<string>();
  const out: MergedStrategy<T>[] = [];

  for (const s of registered) {
    seen.add(s.id);
    const isKilled = killed.has(s.id);
    out.push({
      id: s.id,
      name: s.name,
      description: s.description ?? "",
      category: s.category ?? "",
      enabled: isKilled ? false : s.enabled,
      disabledBy: isKilled ? "guardrails" : s.enabled ? undefined : "runtime",
      registered: s,
    });
  }

  for (const p of policy?.strategies ?? []) {
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    const isKilled = p.disabledByGuardrails || killed.has(p.id);
    out.push({
      id: p.id,
      name: p.name,
      description: p.description,
      category: p.category,
      enabled: false,
      disabledBy: isKilled ? "guardrails" : "engine-offline",
      registered: null,
    });
  }

  return out;
}
