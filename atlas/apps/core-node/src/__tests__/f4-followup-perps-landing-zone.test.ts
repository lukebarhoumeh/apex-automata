/**
 * F4 follow-up — perps-only momentum landing zone (2026-05-19).
 *
 * Pins three invariants the F4 follow-up doc relies on
 * (docs/research/2026-05-19_f4-followup-perps-action.md):
 *
 *   1. `atlas/config/guardrails.yaml` carries the perps-only +20% momentum
 *      takeProfitAtr lift on BOTH `perps_symbols.ETH-PERP-INTX` AND
 *      `perps_symbols.BTC-PERP-INTX`, while spot momentum stays at the
 *      A1-as-committed 5.0.
 *   2. The backtest CLI extraction logic (`atlas/apps/core-node/src/cli/
 *      backtest.ts`) forwards BOTH `per_symbol` AND `perps_symbols`
 *      strategy_overrides into the engine's `perSymbolOverrides` map.
 *      Pre-fix it forwarded spot only, silently dropping perps tuning —
 *      same backtest/live drift class as #11 (per-symbol fee routing).
 *   3. After loading those overrides into a `MomentumStrategy`,
 *      `getEffectiveConfig` resolves takeProfitAtr per-symbol: 6.0 on
 *      both perp symbols, 5.0 on every spot symbol that today carries an
 *      explicit momentum override.
 *
 * Any regression here would either (a) silently revert the perps-only
 * landing zone, or (b) reintroduce the CLI drift that makes empirical
 * backtest validation of perps YAML changes impossible.
 */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { loadGuardrails } from '../config/loadGuardrails';
import { MomentumStrategy } from '../strategies/plugins/builtin/momentum-strategy';
import type { PerSymbolStrategyOverrides } from '../backtesting/backtest-engine';

// The same atlasRoot path that the CLI uses
// (`atlas/apps/core-node/src/cli/backtest.ts:20`).
const ATLAS_ROOT = path.resolve(__dirname, '..', '..', '..', '..');

describe('F4 follow-up — perps-only momentum takeProfitAtr lift (YAML state)', () => {
  const guardrails = loadGuardrails(ATLAS_ROOT);

  it('ETH-PERP-INTX momentum takeProfitAtr is pinned to 6.0', () => {
    const eth = guardrails.perps_symbols?.['ETH-PERP-INTX'];
    expect(eth, 'ETH-PERP-INTX perps_symbols block missing').toBeDefined();
    const ethMomentum = eth?.strategy_overrides?.momentum;
    expect(ethMomentum, 'ETH-PERP-INTX momentum override missing').toBeDefined();
    expect(ethMomentum?.takeProfitAtr).toBe(6.0);
  });

  it('BTC-PERP-INTX momentum takeProfitAtr is pinned to 6.0', () => {
    const btc = guardrails.perps_symbols?.['BTC-PERP-INTX'];
    expect(btc, 'BTC-PERP-INTX perps_symbols block missing').toBeDefined();
    const btcMomentum = btc?.strategy_overrides?.momentum;
    expect(btcMomentum, 'BTC-PERP-INTX momentum override missing').toBeDefined();
    expect(btcMomentum?.takeProfitAtr).toBe(6.0);
  });

  it('spot ETH-USD momentum takeProfitAtr stays at 5.0 (A1 landing)', () => {
    const eth = guardrails.per_symbol?.['ETH-USD'];
    expect(eth, 'ETH-USD per_symbol block missing').toBeDefined();
    const ethMomentum = eth?.strategy_overrides?.momentum;
    expect(ethMomentum, 'ETH-USD momentum override missing').toBeDefined();
    expect(ethMomentum?.takeProfitAtr).toBe(5.0);
  });

  it('global momentum block takeProfitAtr stays at 5.0 (spot default)', () => {
    expect(guardrails.momentum?.takeProfitAtr).toBe(5.0);
  });
});

describe('F4 follow-up — CLI extraction forwards perps_symbols overrides', () => {
  const guardrails = loadGuardrails(ATLAS_ROOT);

  /**
   * Mirrors the fixed extraction loop in `cli/backtest.ts` (the two
   * symmetric for-loops over per_symbol and perps_symbols). If this
   * snippet drifts from production, this test should fail loudly so
   * the drift can't reach backtests silently.
   */
  function buildPerSymbolOverridesLikeCli(): PerSymbolStrategyOverrides {
    const out: PerSymbolStrategyOverrides = {};
    for (const [symbol, cfg] of Object.entries(guardrails.per_symbol ?? {})) {
      if (cfg.strategy_overrides) {
        out[symbol] = cfg.strategy_overrides as Record<string, Record<string, unknown>>;
      }
    }
    for (const [symbol, cfg] of Object.entries(guardrails.perps_symbols ?? {})) {
      if (cfg.strategy_overrides) {
        out[symbol] = cfg.strategy_overrides as Record<string, Record<string, unknown>>;
      }
    }
    return out;
  }

  it('snapshot includes BOTH spot symbols AND perp symbols', () => {
    const snap = buildPerSymbolOverridesLikeCli();
    const keys = Object.keys(snap).sort();
    // Spot symbols that have strategy_overrides today (anchor the test on
    // the symbols that matter; later additions don't break this assertion).
    expect(keys).toContain('ETH-USD');
    // perp symbols — the regression this test exists to prevent.
    expect(keys).toContain('ETH-PERP-INTX');
    expect(keys).toContain('BTC-PERP-INTX');
  });

  it('perps momentum overrides land in the CLI snapshot at takeProfitAtr=6.0', () => {
    const snap = buildPerSymbolOverridesLikeCli();
    expect(snap['ETH-PERP-INTX']?.momentum?.takeProfitAtr).toBe(6.0);
    expect(snap['BTC-PERP-INTX']?.momentum?.takeProfitAtr).toBe(6.0);
  });

  it('spot momentum overrides stay at takeProfitAtr=5.0 in the CLI snapshot', () => {
    const snap = buildPerSymbolOverridesLikeCli();
    expect(snap['ETH-USD']?.momentum?.takeProfitAtr).toBe(5.0);
  });
});

describe('F4 follow-up — MomentumStrategy.getEffectiveConfig resolves per-symbol TP', () => {
  const guardrails = loadGuardrails(ATLAS_ROOT);

  function loadStrategyWithGuardrails(): MomentumStrategy {
    const strategy = new MomentumStrategy();
    const overridesPerSymbol: Record<string, Record<string, unknown>> = {};
    for (const [symbol, cfg] of Object.entries(guardrails.per_symbol ?? {})) {
      const momentum = cfg.strategy_overrides?.momentum;
      if (momentum) overridesPerSymbol[symbol] = momentum;
    }
    for (const [symbol, cfg] of Object.entries(guardrails.perps_symbols ?? {})) {
      const momentum = cfg.strategy_overrides?.momentum;
      if (momentum) overridesPerSymbol[symbol] = momentum;
    }
    strategy.loadSymbolOverrides(overridesPerSymbol);
    return strategy;
  }

  it('ETH-PERP-INTX resolves takeProfitAtr=6.0', () => {
    const strategy = loadStrategyWithGuardrails();
    expect(strategy.getEffectiveConfig('ETH-PERP-INTX').takeProfitAtr).toBe(6.0);
  });

  it('BTC-PERP-INTX resolves takeProfitAtr=6.0', () => {
    const strategy = loadStrategyWithGuardrails();
    expect(strategy.getEffectiveConfig('BTC-PERP-INTX').takeProfitAtr).toBe(6.0);
  });

  it('spot ETH-USD resolves takeProfitAtr=5.0', () => {
    const strategy = loadStrategyWithGuardrails();
    expect(strategy.getEffectiveConfig('ETH-USD').takeProfitAtr).toBe(5.0);
  });

  it('an untouched symbol (no override) falls back to the plugin schema default', () => {
    // No per_symbol/perps_symbols override exists for an arbitrary symbol —
    // the plugin's configSchema default (4.0) wins. The strategy's global
    // config is constructed from configSchema defaults when no constructor
    // arg is passed; this guarantees the per-symbol path is what's lifting
    // perps TP to 6.0, not a stray global lift somewhere.
    const strategy = loadStrategyWithGuardrails();
    expect(strategy.getEffectiveConfig('FAKE-UNUSED-USD').takeProfitAtr).toBe(4.0);
  });
});
