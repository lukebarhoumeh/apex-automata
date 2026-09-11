/**
 * Regime-conditional gate (A6, 2026-05-29) — gate behaviour tests.
 *
 * Pins the A6 invariants:
 *
 *   1. Pure helpers in `strategies/regime-gate.ts`:
 *      - `venueForSymbol` maps `*-PERP-INTX` → 'PERP', else 'spot'.
 *      - `buildRegimeGateConfig` normalises the snake_case YAML block into a
 *        typed { enabled, rules } config; absent block → disabled.
 *      - `evaluateRegimeGate` blocks iff enabled AND a rule matches the
 *        (strategy, venue, symbol) tuple AND the stamped regime is in
 *        `blockRegimes`. Disabled / unknown-regime / no-match → not blocked.
 *
 *   2. YAML state — `guardrails.yaml.regime_gates` exists, is DISABLED by
 *      default (`enabled: false`), and carries the data-derived
 *      `trend_follow / weak_trend` rule. Live behaviour must stay unchanged.
 *
 *   3. SignalProcessor.processSignal end-to-end gate — with the gate ENABLED,
 *      a `trend_follow` signal stamped `weak_trend` is rejected at
 *      `stage='regime_gate', reason='regime_blocked'`, while a strong_trend
 *      trend_follow signal, an un-targeted momentum signal, a venue-scoped
 *      miss, and an unknown-regime signal all pass the gate. With the gate
 *      DISABLED (the shipped default) nothing is blocked.
 *
 *   4. Backtest wiring — `buildBacktestConfig` (shared by `pnpm backtest` and
 *      the E4 harness) carries the YAML gate as `regimeConditionalGates`
 *      (disabled by default), `forceRegimeConditionalGates` flips ONLY the
 *      run's copy, and it is independent of the RegimeFilter `regimeGates`
 *      on|off toggle that shares the "regime gate" name.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'node:path';
import { register } from 'prom-client';
import { Logger } from '../core/logger';
import { loadGuardrails } from '../config/loadGuardrails';
import {
  buildRegimeGateConfig,
  evaluateRegimeGate,
  venueForSymbol,
  RegimeGateConfig,
} from '../strategies/regime-gate';
import { Signal, SignalProcessor, SignalProcessorConfig } from '../strategies/signal-processor';
import { __resetSignalFilteredCounter } from '../strategies/signal-filter-telemetry';
import { buildBacktestConfig, buildFeeModel, resolveFeeTier } from '../backtesting/backtest-cli-config';

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: () => ({ insert: () => ({ error: null }) }),
  }),
}));

const ATLAS_ROOT = path.resolve(__dirname, '..', '..', '..', '..');

const mockLogger: Logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

function makeSignal(overrides: Partial<Signal> = {}): Signal {
  return {
    id: overrides.id ?? `sig-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: overrides.timestamp ?? new Date(),
    symbol: overrides.symbol ?? 'BTC-USD',
    strategy: (overrides.strategy ?? 'trend_follow') as Signal['strategy'],
    direction: overrides.direction ?? 'buy',
    strength: overrides.strength ?? 0.6,
    price: overrides.price ?? 100,
    stopLoss: overrides.stopLoss ?? 99,
    takeProfit: overrides.takeProfit ?? 102,
    metadata: overrides.metadata ?? { indicators: {}, reason: 'test' },
  };
}

async function filteredCount(
  stage: string,
  opts: { symbol?: string; strategy?: string; reason?: string } = {},
): Promise<number> {
  const metric = register.getSingleMetric('atlas_signal_filtered_total');
  if (!metric) return 0;
  const data = await metric.get();
  let total = 0;
  for (const v of data.values) {
    const labels = v.labels as Record<string, string>;
    if (labels.stage !== stage) continue;
    if (opts.symbol && labels.symbol !== opts.symbol) continue;
    if (opts.strategy && labels.strategy !== opts.strategy) continue;
    if (opts.reason && labels.reason !== opts.reason) continue;
    total += v.value;
  }
  return total;
}

// ────────────────────────────────────────────────────────────────────────
// 1. Pure helper tests
// ────────────────────────────────────────────────────────────────────────

describe('regime-gate helpers — pure unit tests', () => {
  it('venueForSymbol classifies perp vs spot', () => {
    expect(venueForSymbol('ETH-PERP-INTX')).toBe('PERP');
    expect(venueForSymbol('BTC-PERP-INTX')).toBe('PERP');
    expect(venueForSymbol('ETH-USD')).toBe('spot');
    expect(venueForSymbol('SOL-USD')).toBe('spot');
  });

  it('buildRegimeGateConfig returns disabled config when the block is absent', () => {
    expect(buildRegimeGateConfig({})).toEqual({ enabled: false, rules: [] });
  });

  it('buildRegimeGateConfig normalises snake_case rules into typed config', () => {
    const cfg = buildRegimeGateConfig({
      regime_gates: {
        enabled: true,
        rules: [
          { strategy: 'trend_follow', block_regimes: ['weak_trend'] },
          { strategy: 'momentum', block_regimes: ['weak_trend'], venues: ['spot'], symbols: ['ETH-USD'] },
        ],
      },
    });
    expect(cfg.enabled).toBe(true);
    expect(cfg.rules[0]).toEqual({ strategy: 'trend_follow', blockRegimes: ['weak_trend'] });
    expect(cfg.rules[1]).toEqual({
      strategy: 'momentum',
      blockRegimes: ['weak_trend'],
      venues: ['spot'],
      symbols: ['ETH-USD'],
    });
  });

  const baseRule: RegimeGateConfig = {
    enabled: true,
    rules: [{ strategy: 'trend_follow', blockRegimes: ['weak_trend'] }],
  };

  it('evaluateRegimeGate is a no-op when disabled', () => {
    const cfg: RegimeGateConfig = { ...baseRule, enabled: false };
    expect(
      evaluateRegimeGate(cfg, { strategy: 'trend_follow', symbol: 'ETH-USD', regime: 'weak_trend' }).blocked,
    ).toBe(false);
  });

  it('evaluateRegimeGate is a no-op when config is undefined', () => {
    expect(
      evaluateRegimeGate(undefined, { strategy: 'trend_follow', symbol: 'ETH-USD', regime: 'weak_trend' }).blocked,
    ).toBe(false);
  });

  it('evaluateRegimeGate blocks an exact (strategy, regime) match', () => {
    const d = evaluateRegimeGate(baseRule, { strategy: 'trend_follow', symbol: 'ETH-USD', regime: 'weak_trend' });
    expect(d.blocked).toBe(true);
    expect(d.rule?.strategy).toBe('trend_follow');
  });

  it('evaluateRegimeGate does NOT block a non-listed regime (strong_trend allowed)', () => {
    expect(
      evaluateRegimeGate(baseRule, { strategy: 'trend_follow', symbol: 'ETH-USD', regime: 'strong_trend' }).blocked,
    ).toBe(false);
  });

  it('evaluateRegimeGate does NOT block a different strategy', () => {
    expect(
      evaluateRegimeGate(baseRule, { strategy: 'momentum', symbol: 'ETH-USD', regime: 'weak_trend' }).blocked,
    ).toBe(false);
  });

  it('evaluateRegimeGate never blocks an absent/unknown regime', () => {
    expect(
      evaluateRegimeGate(baseRule, { strategy: 'trend_follow', symbol: 'ETH-USD', regime: undefined }).blocked,
    ).toBe(false);
    expect(
      evaluateRegimeGate(baseRule, { strategy: 'trend_follow', symbol: 'ETH-USD', regime: 'unknown' }).blocked,
    ).toBe(false);
  });

  it('evaluateRegimeGate honours the venue scope', () => {
    const cfg: RegimeGateConfig = {
      enabled: true,
      rules: [{ strategy: 'trend_follow', blockRegimes: ['weak_trend'], venues: ['PERP'] }],
    };
    expect(
      evaluateRegimeGate(cfg, { strategy: 'trend_follow', symbol: 'ETH-PERP-INTX', regime: 'weak_trend' }).blocked,
    ).toBe(true);
    expect(
      evaluateRegimeGate(cfg, { strategy: 'trend_follow', symbol: 'ETH-USD', regime: 'weak_trend' }).blocked,
    ).toBe(false);
  });

  it('evaluateRegimeGate honours the symbol scope', () => {
    const cfg: RegimeGateConfig = {
      enabled: true,
      rules: [{ strategy: 'momentum', blockRegimes: ['weak_trend'], symbols: ['ETH-USD'] }],
    };
    expect(
      evaluateRegimeGate(cfg, { strategy: 'momentum', symbol: 'ETH-USD', regime: 'weak_trend' }).blocked,
    ).toBe(true);
    expect(
      evaluateRegimeGate(cfg, { strategy: 'momentum', symbol: 'BTC-USD', regime: 'weak_trend' }).blocked,
    ).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────
// 2. YAML state regression tests — gate must ship DISABLED
// ────────────────────────────────────────────────────────────────────────

describe('guardrails.yaml — regime_gates state (A6)', () => {
  const guardrails = loadGuardrails(ATLAS_ROOT);

  it('regime_gates block exists and is DISABLED by default (live unchanged)', () => {
    expect(guardrails.regime_gates).toBeDefined();
    expect(guardrails.regime_gates?.enabled).toBe(false);
  });

  it('carries the data-derived trend_follow / weak_trend rule', () => {
    const rules = guardrails.regime_gates?.rules ?? [];
    const tf = rules.find((r) => r.strategy === 'trend_follow');
    expect(tf, 'trend_follow rule missing').toBeDefined();
    expect(tf?.block_regimes).toContain('weak_trend');
  });

  it('buildRegimeGateConfig(guardrails) is disabled so the live pipeline no-ops', () => {
    expect(buildRegimeGateConfig(guardrails).enabled).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────
// 3. SignalProcessor end-to-end gate tests
// ────────────────────────────────────────────────────────────────────────

function makeProcessor(regimeConditionalGates?: RegimeGateConfig): SignalProcessor {
  const config: SignalProcessorConfig = {
    supabaseUrl: 'http://localhost:54321',
    supabaseKey: 'test-key',
    strategies: {
      breakout: { enabled: false, period: 20, atrPeriod: 14, atrMultiplier: 1.5, volumeThreshold: 1.5 },
      vwapMeanReversion: { enabled: false, deviationEntry: 2, deviationExit: 0.5, minVolume: 1000 },
      momentum: { enabled: false, rsiPeriod: 14, rsiOverbought: 70, rsiOversold: 30, macdFast: 12, macdSlow: 26, macdSignal: 9 },
    },
    metaLabeling: { enabled: false, threshold: 0.5 },
    disabledStrategies: [],
    ...(regimeConditionalGates ? { regimeConditionalGates } : {}),
  };
  return new SignalProcessor(config, mockLogger as unknown as Logger);
}

const callProcess = (sp: SignalProcessor, sig: Signal) =>
  (sp as unknown as { processSignal(s: Signal): Promise<void> }).processSignal(sig);

describe('SignalProcessor.processSignal — regime_gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetSignalFilteredCounter();
  });

  it('does NOT block when the gate is disabled (shipped default)', async () => {
    const sp = makeProcessor({ enabled: false, rules: [{ strategy: 'trend_follow', blockRegimes: ['weak_trend'] }] });
    const sig = makeSignal({ strategy: 'trend_follow' as Signal['strategy'], symbol: 'ETH-USD', metadata: { indicators: {}, reason: 't', regime: 'weak_trend' } });
    await callProcess(sp, sig);
    expect(await filteredCount('regime_gate')).toBe(0);
  });

  it('blocks trend_follow stamped weak_trend with stage=regime_gate, reason=regime_blocked', async () => {
    const sp = makeProcessor({ enabled: true, rules: [{ strategy: 'trend_follow', blockRegimes: ['weak_trend'] }] });
    const sig = makeSignal({ strategy: 'trend_follow' as Signal['strategy'], symbol: 'ETH-USD', metadata: { indicators: {}, reason: 't', regime: 'weak_trend' } });
    await callProcess(sp, sig);
    expect(
      await filteredCount('regime_gate', { symbol: 'ETH-USD', strategy: 'trend_follow', reason: 'regime_blocked' }),
    ).toBe(1);
  });

  it('does NOT block trend_follow stamped strong_trend (the edge regime is allowed)', async () => {
    const sp = makeProcessor({ enabled: true, rules: [{ strategy: 'trend_follow', blockRegimes: ['weak_trend'] }] });
    const sig = makeSignal({ strategy: 'trend_follow' as Signal['strategy'], symbol: 'ETH-USD', metadata: { indicators: {}, reason: 't', regime: 'strong_trend' } });
    await callProcess(sp, sig);
    expect(await filteredCount('regime_gate')).toBe(0);
  });

  it('does NOT block a strategy that is not targeted by any rule (momentum)', async () => {
    const sp = makeProcessor({ enabled: true, rules: [{ strategy: 'trend_follow', blockRegimes: ['weak_trend'] }] });
    const sig = makeSignal({ strategy: 'momentum', symbol: 'ETH-USD', metadata: { indicators: {}, reason: 't', regime: 'weak_trend' } });
    await callProcess(sp, sig);
    expect(await filteredCount('regime_gate')).toBe(0);
  });

  it('honours venue scope: a PERP-only rule does not block the spot symbol', async () => {
    const sp = makeProcessor({ enabled: true, rules: [{ strategy: 'trend_follow', blockRegimes: ['weak_trend'], venues: ['PERP'] }] });
    const sig = makeSignal({ strategy: 'trend_follow' as Signal['strategy'], symbol: 'ETH-USD', metadata: { indicators: {}, reason: 't', regime: 'weak_trend' } });
    await callProcess(sp, sig);
    expect(await filteredCount('regime_gate')).toBe(0);
  });

  it('does NOT block a signal with no stamped regime (low-confidence bypass)', async () => {
    const sp = makeProcessor({ enabled: true, rules: [{ strategy: 'trend_follow', blockRegimes: ['weak_trend'] }] });
    const sig = makeSignal({ strategy: 'trend_follow' as Signal['strategy'], symbol: 'ETH-USD', metadata: { indicators: {}, reason: 't' } });
    await callProcess(sp, sig);
    expect(await filteredCount('regime_gate')).toBe(0);
  });

  it('emits signal:filtered with a Regime gate reason when it blocks', async () => {
    const sp = makeProcessor({ enabled: true, rules: [{ strategy: 'trend_follow', blockRegimes: ['weak_trend'] }] });
    const sig = makeSignal({ strategy: 'trend_follow' as Signal['strategy'], symbol: 'ETH-USD', metadata: { indicators: {}, reason: 't', regime: 'weak_trend' } });
    const events: Array<{ reason: string }> = [];
    sp.on('signal:filtered', (_s: Signal, reason: string) => events.push({ reason }));
    await callProcess(sp, sig);
    expect(events).toHaveLength(1);
    expect(events[0].reason).toMatch(/Regime gate/);
  });
});

// ────────────────────────────────────────────────────────────────────────
// 4. Backtest wiring — shared CLI/E4 config builder
// ────────────────────────────────────────────────────────────────────────

describe('buildBacktestConfig — regimeConditionalGates wiring (A6)', () => {
  const guardrails = loadGuardrails(ATLAS_ROOT);
  const base = {
    startDate: new Date('2025-12-05T00:00:00Z'),
    endDate: new Date('2026-03-05T00:00:00Z'),
    initialCapital: 10_000,
    products: ['ETH-USD'],
    strategy: 'all',
    feeModel: buildFeeModel(guardrails, resolveFeeTier(undefined, guardrails.fees.coinbase.spot)),
    evGateMode: 'enforce' as const,
    regimeGates: true,
  };

  it('carries the YAML rules but stays DISABLED by default (pnpm backtest + E4 harness parity)', () => {
    const cfg = buildBacktestConfig(base, guardrails);
    expect(cfg.regimeConditionalGates).toBeDefined();
    expect(cfg.regimeConditionalGates?.enabled).toBe(false);
    expect(cfg.regimeConditionalGates?.rules).toEqual([{ strategy: 'trend_follow', blockRegimes: ['weak_trend'] }]);
    expect(
      evaluateRegimeGate(cfg.regimeConditionalGates, { strategy: 'trend_follow', symbol: 'ETH-USD', regime: 'weak_trend' }).blocked,
    ).toBe(false);
  });

  it('forceRegimeConditionalGates enables the run copy without mutating the loaded guardrails', () => {
    const cfg = buildBacktestConfig({ ...base, forceRegimeConditionalGates: true }, guardrails);
    expect(cfg.regimeConditionalGates?.enabled).toBe(true);
    expect(
      evaluateRegimeGate(cfg.regimeConditionalGates, { strategy: 'trend_follow', symbol: 'ETH-USD', regime: 'weak_trend' }).blocked,
    ).toBe(true);
    expect(guardrails.regime_gates?.enabled).toBe(false);
    expect(buildBacktestConfig(base, guardrails).regimeConditionalGates?.enabled).toBe(false);
  });

  it('is independent of the RegimeFilter `regimeGates` on|off toggle', () => {
    const filterOff = buildBacktestConfig({ ...base, regimeGates: false }, guardrails);
    expect(filterOff.regimeGates).toBe(false);
    expect(filterOff.regimeConditionalGates?.enabled).toBe(false);

    const forced = buildBacktestConfig({ ...base, regimeGates: false, forceRegimeConditionalGates: true }, guardrails);
    expect(forced.regimeGates).toBe(false);
    expect(forced.regimeConditionalGates?.enabled).toBe(true);
  });
});
