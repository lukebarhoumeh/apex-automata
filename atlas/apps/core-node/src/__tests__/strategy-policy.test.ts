/**
 * TASK_016 P4 — strategy policy snapshot served at GET /api/strategies/policy.
 *
 * The UI needs one engine-independent view of "which built-in strategies are
 * killed by guardrails.yaml", because killed plugins are never registered and
 * therefore never appear in /api/strategies.
 */

import { describe, it, expect } from 'vitest';
import path from 'path';
import { buildStrategyPolicy, STRATEGY_POLICY_SOURCE } from '../strategies/strategy-policy';
import { getBuiltinStrategyIds } from '../strategies/plugins/builtin';
import { loadGuardrails } from '../config/loadGuardrails';

const FAKE_BUILTINS = [
  { id: 'trend_follow', name: 'Trend Follow', description: 'tf', category: 'trend' },
  { id: 'momentum', name: 'Momentum', description: 'mom', category: 'momentum' },
];

describe('buildStrategyPolicy', () => {
  it('flags ids listed in disabled_strategies and leaves the rest enabled', () => {
    const policy = buildStrategyPolicy({ disabled_strategies: ['momentum', 'momentum'] }, FAKE_BUILTINS);
    expect(policy.source).toBe(STRATEGY_POLICY_SOURCE);
    expect(policy.disabledStrategies).toEqual(['momentum']); // de-duplicated
    expect(policy.strategies).toEqual([
      { id: 'trend_follow', name: 'Trend Follow', description: 'tf', category: 'trend', disabledByGuardrails: false },
      { id: 'momentum', name: 'Momentum', description: 'mom', category: 'momentum', disabledByGuardrails: true },
    ]);
  });

  it('flattens per-symbol disable lists from every symbol block', () => {
    const policy = buildStrategyPolicy(
      {
        disabled_strategies: [],
        per_symbol: { 'BTC-USD': { disabled_strategies: ['breakout'] } },
        perps_symbols: { 'ETH-PERP-INTX': { disabled_strategies: ['momentum'] }, 'BTC-PERP-INTX': {} },
      },
      FAKE_BUILTINS,
    );
    expect(policy.perSymbolDisabledStrategies).toEqual({
      'BTC-USD': ['breakout'],
      'ETH-PERP-INTX': ['momentum'],
    });
  });

  it('tolerates a guardrails object without any disable lists', () => {
    const policy = buildStrategyPolicy({}, FAKE_BUILTINS);
    expect(policy.disabledStrategies).toEqual([]);
    expect(policy.perSymbolDisabledStrategies).toEqual({});
    expect(policy.strategies.every((s) => !s.disabledByGuardrails)).toBe(true);
  });

  it('covers every real built-in plugin using the real guardrails.yaml (SoT drift guard)', () => {
    const guardrails = loadGuardrails(path.resolve(__dirname, '../../../..'));
    const policy = buildStrategyPolicy(guardrails);

    expect(policy.strategies.map((s) => s.id).sort()).toEqual([...getBuiltinStrategyIds()].sort());

    const killed = policy.strategies.filter((s) => s.disabledByGuardrails).map((s) => s.id).sort();
    expect(killed).toEqual([...guardrails.disabled_strategies].sort());
    // E2-MOM-ISO KILL (#55) + Phase-3 verdict: momentum must NOT look enabled.
    expect(killed).toEqual(expect.arrayContaining(['momentum', 'vwap_mr', 'breakout']));
    expect(policy.strategies.find((s) => s.id === 'trend_follow')?.disabledByGuardrails).toBe(false);
    expect(policy.perSymbolDisabledStrategies['ETH-PERP-INTX']).toEqual(['momentum']);
  });
});
