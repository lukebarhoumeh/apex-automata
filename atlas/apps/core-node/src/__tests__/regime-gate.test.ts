/**
 * Regime-conditional ENTRY gate (A6, 2026-05-29; TF-REGIME-GATE, 2026-09-22).
 *
 * Pins the shipped paper gate:
 *
 *   1. Pure helpers in `strategies/regime-gate.ts`:
 *      - `venueForSymbol` maps `*-PERP-INTX` → 'PERP', else 'spot'.
 *      - `buildRegimeGateConfig(yaml, mode)` normalises the snake_case block
 *        and resolves `enabled` for ONE execution mode: `paper_only` (default
 *        true) makes `live` and `backtest` resolve DISABLED.
 *      - `classifySignalIntent` — a signal opposing the open position on its
 *        symbol is an `exit`; everything else is an `entry`.
 *      - `evaluateRegimeGate` blocks iff enabled AND intent is entry AND a
 *        rule matches the (strategy, venue, symbol) tuple AND the regime is in
 *        `blockRegimes`. Exits / unknown regime / no match → not blocked. A
 *        block carries the FE deny reason.
 *
 *   2. YAML state — `guardrails.yaml.regime_gates` is ENABLED, `paper_only`,
 *      and its trend_follow rule blocks BOTH `weak_trend` and `choppy` (the
 *      RegimeDetector's exact labels; "chop" = `choppy`). Resolved for `live`
 *      the gate is inert (live untouched); `paper_only` is a `pnpm check:config`
 *      desk pin.
 *
 *   3. Router contract — the gate is NOT applied inside SignalProcessor (a
 *      trend_follow signal stamped weak_trend reaches `signal:generated`), so
 *      the router can persist the verdict; a blocked entry maps to the blotter
 *      row `{ allowed: false, routed_exchange: null, reason: "regime_gate: …" }`
 *      the FE renders as REJECTED with that note.
 *
 *   4. Backtest wiring — `buildBacktestConfig` resolves the gate for the
 *      `backtest` mode (disabled while paper_only), `forceRegimeConditionalGates`
 *      flips ONLY the run's copy, independent of the RegimeFilter `regimeGates`
 *      on|off toggle that shares the "regime gate" name.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'node:path';
import { register } from 'prom-client';
import { Logger } from '../core/logger';
import { loadGuardrails } from '../config/loadGuardrails';
import { SCALAR_PINS } from '../config/config-drift';
import {
  buildRegimeGateConfig,
  classifySignalIntent,
  describeRegimeGateBlock,
  evaluateRegimeGate,
  venueForSymbol,
  REGIME_GATE_REASON_CODE,
  REGIME_GATE_STAGE,
  RegimeGateConfig,
} from '../strategies/regime-gate';
import { Signal, SignalProcessor, SignalProcessorConfig } from '../strategies/signal-processor';
import { __resetSignalFilteredCounter } from '../strategies/signal-filter-telemetry';
import { routeRejected, signalRouteColumns } from '../exchanges/signal-route';
import { buildBacktestConfig, buildFeeModel, resolveFeeTier } from '../backtesting/backtest-cli-config';
import { BacktestEngine, type BacktestConfig, type BacktestPosition } from '../backtesting/backtest-engine';

/** Private engine surface the harness drives (mirrors backtest-engine-parity-filters.test.ts). */
interface EngineInternals {
  initializeSignalProcessor(): void;
  currentBarTime: Date;
  barIndex: number;
  handleSignal(signal: Signal): void;
  pendingFills: Map<string, unknown>;
  positions: Map<string, BacktestPosition>;
}

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

/** The shipped TF rule, as the router sees it in paper. */
const TF_PAPER: RegimeGateConfig = {
  enabled: true,
  paperOnly: true,
  mode: 'paper',
  rules: [{ strategy: 'trend_follow', blockRegimes: ['weak_trend', 'choppy'] }],
};

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

describe('regime-gate helpers — venue + config resolution', () => {
  it('venueForSymbol classifies perp vs spot', () => {
    expect(venueForSymbol('ETH-PERP-INTX')).toBe('PERP');
    expect(venueForSymbol('BTC-PERP-INTX')).toBe('PERP');
    expect(venueForSymbol('ETH-USD')).toBe('spot');
    expect(venueForSymbol('SOL-USD')).toBe('spot');
  });

  it('buildRegimeGateConfig returns a disabled, paper-only config when the block is absent', () => {
    expect(buildRegimeGateConfig({}, 'paper')).toEqual({ enabled: false, paperOnly: true, mode: 'paper', rules: [] });
    expect(buildRegimeGateConfig({}, 'live').enabled).toBe(false);
  });

  it('buildRegimeGateConfig normalises snake_case rules into typed config', () => {
    const cfg = buildRegimeGateConfig(
      {
        regime_gates: {
          enabled: true,
          paper_only: true,
          rules: [
            { strategy: 'trend_follow', block_regimes: ['weak_trend', 'choppy'] },
            { strategy: 'momentum', block_regimes: ['weak_trend'], venues: ['spot'], symbols: ['ETH-USD'] },
          ],
        },
      },
      'paper',
    );
    expect(cfg.enabled).toBe(true);
    expect(cfg.paperOnly).toBe(true);
    expect(cfg.mode).toBe('paper');
    expect(cfg.rules[0]).toEqual({ strategy: 'trend_follow', blockRegimes: ['weak_trend', 'choppy'] });
    expect(cfg.rules[1]).toEqual({
      strategy: 'momentum',
      blockRegimes: ['weak_trend'],
      venues: ['spot'],
      symbols: ['ETH-USD'],
    });
  });

  const paperOnlyYaml = {
    regime_gates: { enabled: true, paper_only: true, rules: [{ strategy: 'trend_follow', block_regimes: ['weak_trend'] }] },
  };

  it('paper_only: true → enabled for paper, DISABLED for live and backtest', () => {
    expect(buildRegimeGateConfig(paperOnlyYaml, 'paper').enabled).toBe(true);
    expect(buildRegimeGateConfig(paperOnlyYaml, 'live').enabled).toBe(false);
    expect(buildRegimeGateConfig(paperOnlyYaml, 'backtest').enabled).toBe(false);
  });

  it('paper_only defaults to TRUE when the YAML omits it (live can never be reached by accident)', () => {
    const yaml = { regime_gates: { enabled: true, rules: [{ strategy: 'trend_follow', block_regimes: ['weak_trend'] }] } };
    expect(buildRegimeGateConfig(yaml, 'paper').paperOnly).toBe(true);
    expect(buildRegimeGateConfig(yaml, 'paper').enabled).toBe(true);
    expect(buildRegimeGateConfig(yaml, 'live').enabled).toBe(false);
  });

  it('paper_only: false requires an explicit opt-in and then applies to every mode', () => {
    const yaml = {
      regime_gates: { enabled: true, paper_only: false, rules: [{ strategy: 'trend_follow', block_regimes: ['weak_trend'] }] },
    };
    expect(buildRegimeGateConfig(yaml, 'paper').enabled).toBe(true);
    expect(buildRegimeGateConfig(yaml, 'live').enabled).toBe(true);
    expect(buildRegimeGateConfig(yaml, 'backtest').enabled).toBe(true);
  });

  it('enabled: false is disabled in every mode regardless of paper_only', () => {
    const yaml = {
      regime_gates: { enabled: false, paper_only: false, rules: [{ strategy: 'trend_follow', block_regimes: ['weak_trend'] }] },
    };
    for (const mode of ['paper', 'live', 'backtest'] as const) {
      expect(buildRegimeGateConfig(yaml, mode).enabled).toBe(false);
    }
  });
});

describe('classifySignalIntent — entry vs exit from the router position view', () => {
  it('a sell against an open long is an exit; a buy against an open short is an exit', () => {
    expect(classifySignalIntent('sell', 'long')).toBe('exit');
    expect(classifySignalIntent('buy', 'short')).toBe('exit');
  });

  it('same-side adds and flat books are entries', () => {
    expect(classifySignalIntent('buy', 'long')).toBe('entry');
    expect(classifySignalIntent('sell', 'short')).toBe('entry');
    expect(classifySignalIntent('buy', 'flat')).toBe('entry');
    expect(classifySignalIntent('sell', undefined)).toBe('entry');
    expect(classifySignalIntent('buy', null)).toBe('entry');
  });
});

describe('evaluateRegimeGate — trend_follow entries in weak_trend / choppy', () => {
  it('BLOCKS a trend_follow entry in weak_trend', () => {
    const d = evaluateRegimeGate(TF_PAPER, { strategy: 'trend_follow', symbol: 'ETH-USD', regime: 'weak_trend' });
    expect(d.blocked).toBe(true);
    expect(d.rule?.strategy).toBe('trend_follow');
  });

  it('BLOCKS a trend_follow entry in choppy ("chop")', () => {
    const d = evaluateRegimeGate(TF_PAPER, { strategy: 'trend_follow', symbol: 'ETH-USD', regime: 'choppy' });
    expect(d.blocked).toBe(true);
  });

  it('blocks on every venue when the rule is unscoped (spot and PERP)', () => {
    expect(
      evaluateRegimeGate(TF_PAPER, { strategy: 'trend_follow', symbol: 'ETH-PERP-INTX', regime: 'weak_trend' }).blocked,
    ).toBe(true);
    expect(
      evaluateRegimeGate(TF_PAPER, { strategy: 'trend_follow', symbol: 'SOL-USD', regime: 'choppy' }).blocked,
    ).toBe(true);
  });

  it('ALLOWS a trend_follow entry in the approved regimes (strong_trend, ranging)', () => {
    expect(
      evaluateRegimeGate(TF_PAPER, { strategy: 'trend_follow', symbol: 'ETH-USD', regime: 'strong_trend' }).blocked,
    ).toBe(false);
    expect(
      evaluateRegimeGate(TF_PAPER, { strategy: 'trend_follow', symbol: 'ETH-USD', regime: 'ranging' }).blocked,
    ).toBe(false);
  });

  it('an explicit `intent: entry` is gated exactly like the default', () => {
    expect(
      evaluateRegimeGate(TF_PAPER, { strategy: 'trend_follow', symbol: 'ETH-USD', regime: 'weak_trend', intent: 'entry' })
        .blocked,
    ).toBe(true);
  });

  it('EXITS are never gated — a sell closing a long in weak_trend passes', () => {
    const intent = classifySignalIntent('sell', 'long');
    const d = evaluateRegimeGate(TF_PAPER, { strategy: 'trend_follow', symbol: 'ETH-USD', regime: 'weak_trend', intent });
    expect(intent).toBe('exit');
    expect(d.blocked).toBe(false);
    expect(d.reason).toBeUndefined();
  });

  it('EXITS are never gated — a buy covering a short in choppy passes', () => {
    const intent = classifySignalIntent('buy', 'short');
    const d = evaluateRegimeGate(TF_PAPER, { strategy: 'trend_follow', symbol: 'ETH-PERP-INTX', regime: 'choppy', intent });
    expect(d.blocked).toBe(false);
  });

  it('a same-side add against an open position is still an entry and is blocked', () => {
    const intent = classifySignalIntent('buy', 'long');
    expect(
      evaluateRegimeGate(TF_PAPER, { strategy: 'trend_follow', symbol: 'ETH-USD', regime: 'weak_trend', intent }).blocked,
    ).toBe(true);
  });

  it('non-trend_follow strategies are unaffected in the gated regimes', () => {
    for (const strategy of ['momentum', 'breakout', 'vwap_mr']) {
      for (const regime of ['weak_trend', 'choppy']) {
        expect(
          evaluateRegimeGate(TF_PAPER, { strategy, symbol: 'ETH-USD', regime }).blocked,
          `${strategy} in ${regime} must pass`,
        ).toBe(false);
      }
    }
  });

  it('is a no-op when disabled (the live-resolved shape)', () => {
    const live: RegimeGateConfig = { ...TF_PAPER, enabled: false, mode: 'live' };
    expect(evaluateRegimeGate(live, { strategy: 'trend_follow', symbol: 'ETH-USD', regime: 'weak_trend' }).blocked).toBe(false);
    expect(evaluateRegimeGate(live, { strategy: 'trend_follow', symbol: 'ETH-USD', regime: 'choppy' }).blocked).toBe(false);
  });

  it('is a no-op when config is undefined', () => {
    expect(
      evaluateRegimeGate(undefined, { strategy: 'trend_follow', symbol: 'ETH-USD', regime: 'weak_trend' }).blocked,
    ).toBe(false);
  });

  it('never blocks an absent/unknown regime (data gap must not block entries)', () => {
    expect(
      evaluateRegimeGate(TF_PAPER, { strategy: 'trend_follow', symbol: 'ETH-USD', regime: undefined }).blocked,
    ).toBe(false);
    expect(
      evaluateRegimeGate(TF_PAPER, { strategy: 'trend_follow', symbol: 'ETH-USD', regime: 'unknown' }).blocked,
    ).toBe(false);
  });

  it('honours the venue scope', () => {
    const cfg: RegimeGateConfig = {
      ...TF_PAPER,
      rules: [{ strategy: 'trend_follow', blockRegimes: ['weak_trend'], venues: ['PERP'] }],
    };
    expect(
      evaluateRegimeGate(cfg, { strategy: 'trend_follow', symbol: 'ETH-PERP-INTX', regime: 'weak_trend' }).blocked,
    ).toBe(true);
    expect(
      evaluateRegimeGate(cfg, { strategy: 'trend_follow', symbol: 'ETH-USD', regime: 'weak_trend' }).blocked,
    ).toBe(false);
  });

  it('honours the symbol scope', () => {
    const cfg: RegimeGateConfig = {
      ...TF_PAPER,
      rules: [{ strategy: 'momentum', blockRegimes: ['weak_trend'], symbols: ['ETH-USD'] }],
    };
    expect(
      evaluateRegimeGate(cfg, { strategy: 'momentum', symbol: 'ETH-USD', regime: 'weak_trend' }).blocked,
    ).toBe(true);
    expect(
      evaluateRegimeGate(cfg, { strategy: 'momentum', symbol: 'BTC-USD', regime: 'weak_trend' }).blocked,
    ).toBe(false);
  });

  it('a block carries a clear, FE-ready deny reason', () => {
    const d = evaluateRegimeGate(TF_PAPER, { strategy: 'trend_follow', symbol: 'ETH-USD', regime: 'weak_trend' });
    expect(d.reason).toBe(
      'trend_follow new entry blocked: regime=weak_trend (paper-only regime gate blocks weak_trend|choppy)',
    );
  });

  it('describeRegimeGateBlock drops the paper-only tag when the gate is not paper-scoped', () => {
    const text = describeRegimeGateBlock(
      { paperOnly: false },
      { strategy: 'trend_follow', regime: 'choppy' },
      { strategy: 'trend_follow', blockRegimes: ['weak_trend', 'choppy'] },
    );
    expect(text).toBe('trend_follow new entry blocked: regime=choppy (regime gate blocks weak_trend|choppy)');
  });
});

// ────────────────────────────────────────────────────────────────────────
// 2. YAML state — the shipped paper gate
// ────────────────────────────────────────────────────────────────────────

describe('guardrails.yaml — regime_gates state (TF-REGIME-GATE)', () => {
  const guardrails = loadGuardrails(ATLAS_ROOT);

  it('regime_gates is ENABLED and PAPER-ONLY', () => {
    expect(guardrails.regime_gates).toBeDefined();
    expect(guardrails.regime_gates?.enabled).toBe(true);
    expect(guardrails.regime_gates?.paper_only).toBe(true);
  });

  it('the trend_follow rule blocks weak_trend AND choppy using the RegimeDetector labels', () => {
    const rules = guardrails.regime_gates?.rules ?? [];
    const tf = rules.find((r) => r.strategy === 'trend_follow');
    expect(tf, 'trend_follow rule missing').toBeDefined();
    expect(tf?.block_regimes).toEqual(expect.arrayContaining(['weak_trend', 'choppy']));
    for (const regime of tf?.block_regimes ?? []) {
      expect(['strong_trend', 'weak_trend', 'ranging', 'choppy']).toContain(regime);
    }
  });

  it('only trend_follow is gated — no rule targets another strategy', () => {
    const targets = (guardrails.regime_gates?.rules ?? []).map((r) => r.strategy);
    expect(targets).toEqual(['trend_follow']);
  });

  it('resolved for PAPER the gate is active and blocks TF entries in weak_trend + choppy', () => {
    const cfg = buildRegimeGateConfig(guardrails, 'paper');
    expect(cfg.enabled).toBe(true);
    expect(evaluateRegimeGate(cfg, { strategy: 'trend_follow', symbol: 'ETH-USD', regime: 'weak_trend' }).blocked).toBe(true);
    expect(evaluateRegimeGate(cfg, { strategy: 'trend_follow', symbol: 'ETH-USD', regime: 'choppy' }).blocked).toBe(true);
    expect(evaluateRegimeGate(cfg, { strategy: 'trend_follow', symbol: 'ETH-USD', regime: 'strong_trend' }).blocked).toBe(false);
  });

  it('resolved for LIVE the gate is INERT — live routing is untouched', () => {
    const cfg = buildRegimeGateConfig(guardrails, 'live');
    expect(cfg.enabled).toBe(false);
    expect(evaluateRegimeGate(cfg, { strategy: 'trend_follow', symbol: 'ETH-USD', regime: 'weak_trend' }).blocked).toBe(false);
    expect(evaluateRegimeGate(cfg, { strategy: 'trend_follow', symbol: 'ETH-USD', regime: 'choppy' }).blocked).toBe(false);
  });

  it('resolved for BACKTEST the gate is inert unless forced per run', () => {
    expect(buildRegimeGateConfig(guardrails, 'backtest').enabled).toBe(false);
  });

  it('paper_only is a desk pin enforced by `pnpm check:config`', () => {
    expect(SCALAR_PINS).toContainEqual({ key: 'regime_gates.paper_only', expected: true });
  });
});

// ────────────────────────────────────────────────────────────────────────
// 3. Router contract — SignalProcessor passes, router persists the verdict
// ────────────────────────────────────────────────────────────────────────

function makeProcessor(): SignalProcessor {
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
  };
  return new SignalProcessor(config, mockLogger as unknown as Logger);
}

const callProcess = (sp: SignalProcessor, sig: Signal) =>
  (sp as unknown as { processSignal(s: Signal): Promise<void> }).processSignal(sig);

describe('router contract — the gate lives at the router, not in SignalProcessor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetSignalFilteredCounter();
  });

  it('SignalProcessor does NOT gate a trend_follow signal stamped weak_trend (it must reach the router)', async () => {
    const sp = makeProcessor();
    const generated: Signal[] = [];
    sp.on('signal:generated', (s: Signal) => generated.push(s));
    const sig = makeSignal({
      strategy: 'trend_follow' as Signal['strategy'],
      symbol: 'ETH-USD',
      metadata: { indicators: {}, reason: 't', regime: 'weak_trend' },
    });
    await callProcess(sp, sig);
    expect(await filteredCount(REGIME_GATE_STAGE)).toBe(0);
    expect(generated).toHaveLength(1);
    expect(generated[0].metadata.regime).toBe('weak_trend');
  });

  it('a blocked entry maps to the blotter row the FE renders as REJECTED with the deny reason', () => {
    const cfg = buildRegimeGateConfig(loadGuardrails(ATLAS_ROOT), 'paper');
    const decision = evaluateRegimeGate(cfg, {
      strategy: 'trend_follow',
      symbol: 'ETH-USD',
      regime: 'weak_trend',
      intent: classifySignalIntent('buy', undefined),
    });
    expect(decision.blocked).toBe(true);
    const verdict = routeRejected('coinbase', REGIME_GATE_STAGE, decision.reason ?? REGIME_GATE_REASON_CODE);
    expect(signalRouteColumns(verdict)).toEqual({
      allowed: false,
      routed_exchange: null,
      reason:
        'regime_gate: trend_follow new entry blocked: regime=weak_trend (paper-only regime gate blocks weak_trend|choppy)',
    });
  });

  it('the same signal as an EXIT (open long on the symbol) is not blocked by the gate', () => {
    const cfg = buildRegimeGateConfig(loadGuardrails(ATLAS_ROOT), 'paper');
    const decision = evaluateRegimeGate(cfg, {
      strategy: 'trend_follow',
      symbol: 'ETH-USD',
      regime: 'weak_trend',
      intent: classifySignalIntent('sell', 'long'),
    });
    expect(decision.blocked).toBe(false);
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

  it('carries the YAML rules but resolves DISABLED for backtests (paper_only; pnpm backtest + E4 harness baselines)', () => {
    const cfg = buildBacktestConfig(base, guardrails);
    expect(cfg.regimeConditionalGates).toBeDefined();
    expect(cfg.regimeConditionalGates?.enabled).toBe(false);
    expect(cfg.regimeConditionalGates?.paperOnly).toBe(true);
    expect(cfg.regimeConditionalGates?.mode).toBe('backtest');
    expect(cfg.regimeConditionalGates?.rules).toEqual([
      { strategy: 'trend_follow', blockRegimes: ['weak_trend', 'choppy'] },
    ]);
    expect(
      evaluateRegimeGate(cfg.regimeConditionalGates, { strategy: 'trend_follow', symbol: 'ETH-USD', regime: 'weak_trend' }).blocked,
    ).toBe(false);
  });

  it('forceRegimeConditionalGates enables the run copy (entries blocked, exits exempt) without mutating guardrails', () => {
    const cfg = buildBacktestConfig({ ...base, forceRegimeConditionalGates: true }, guardrails);
    expect(cfg.regimeConditionalGates?.enabled).toBe(true);
    expect(
      evaluateRegimeGate(cfg.regimeConditionalGates, { strategy: 'trend_follow', symbol: 'ETH-USD', regime: 'weak_trend' }).blocked,
    ).toBe(true);
    expect(
      evaluateRegimeGate(cfg.regimeConditionalGates, { strategy: 'trend_follow', symbol: 'ETH-USD', regime: 'choppy' }).blocked,
    ).toBe(true);
    expect(
      evaluateRegimeGate(cfg.regimeConditionalGates, {
        strategy: 'trend_follow',
        symbol: 'ETH-USD',
        regime: 'weak_trend',
        intent: 'exit',
      }).blocked,
    ).toBe(false);
    expect(guardrails.regime_gates?.enabled).toBe(true);
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

// ────────────────────────────────────────────────────────────────────────
// 5. Backtest engine — position-aware enforcement (forced on)
// ────────────────────────────────────────────────────────────────────────

function engineConfig(overrides: Partial<BacktestConfig> = {}): BacktestConfig {
  return {
    startDate: new Date('2024-01-01'),
    endDate: new Date('2024-01-02'),
    initialCapital: 10_000,
    commission: 0,
    products: ['BTC-USD'],
    signals: {
      breakout: { enabled: false, parameters: {} },
      vwapMeanReversion: { enabled: false, parameters: {} },
      momentum: { enabled: false, parameters: {} },
      trendFollow: { enabled: true, parameters: {} },
    },
    risk: { maxPositionSize: 3_000, maxTotalExposure: 30_000, stopLossPercent: 0.02, takeProfitPercent: 0.04 },
    account: { equityUsd: 10_000, riskPerTrade: 0.005, maxPositionExposurePct: 0.3, minNotionalBuffer: 1.1 },
    disabledStrategies: ['vwap_mr', 'breakout'],
    evGate: { mode: 'off' },
    regimeConditionalGates: { ...TF_PAPER, mode: 'backtest' },
    ...overrides,
  };
}

function engineSignal(direction: 'buy' | 'sell', regime: string, strategy = 'trend_follow'): Signal {
  return makeSignal({
    strategy: strategy as Signal['strategy'],
    symbol: 'BTC-USD',
    direction,
    price: 100,
    stopLoss: direction === 'buy' ? 98 : 102,
    takeProfit: direction === 'buy' ? 106 : 94,
    metadata: { indicators: { atr: 2 }, reason: 'test', regime },
  });
}

describe('BacktestEngine.handleSignal — regime entry gate blocks entries, exempts exits', () => {
  beforeEach(() => {
    __resetSignalFilteredCounter();
  });

  function boot(): EngineInternals {
    const engine = new BacktestEngine(engineConfig(), mockLogger);
    const eng = engine as unknown as EngineInternals;
    eng.initializeSignalProcessor();
    eng.currentBarTime = new Date('2024-01-01T00:00:00Z');
    return eng;
  }

  it('blocks a trend_follow ENTRY in weak_trend and in choppy (no pending fill, funnel counted)', async () => {
    const eng = boot();
    eng.handleSignal(engineSignal('buy', 'weak_trend'));
    eng.handleSignal(engineSignal('sell', 'choppy'));
    expect(eng.pendingFills.size).toBe(0);
    expect(await filteredCount(REGIME_GATE_STAGE, { strategy: 'trend_follow', reason: REGIME_GATE_REASON_CODE })).toBe(2);
  });

  it('admits a trend_follow ENTRY in strong_trend', async () => {
    const eng = boot();
    eng.handleSignal(engineSignal('buy', 'strong_trend'));
    expect(eng.pendingFills.size).toBe(1);
    expect(await filteredCount(REGIME_GATE_STAGE)).toBe(0);
  });

  it('a momentum ENTRY in weak_trend is unaffected', async () => {
    const eng = boot();
    eng.handleSignal(engineSignal('buy', 'weak_trend', 'momentum'));
    expect(eng.pendingFills.size).toBe(1);
    expect(await filteredCount(REGIME_GATE_STAGE)).toBe(0);
  });

  it('a sell against an open LONG in weak_trend is an EXIT: not gated, position closed', async () => {
    const eng = boot();
    eng.positions.set('BTC-USD', {
      product: 'BTC-USD',
      side: 'long',
      size: 1,
      entryPrice: 95,
      entryTimestamp: new Date('2023-12-31T00:00:00Z'),
      entryBarIndex: 0,
      barsInTrade: 5,
      highWaterMark: 101,
      trailingStop: null,
      entryAtr: 2,
      unrealizedPnl: 0,
      trades: [],
    });
    eng.barIndex = 10;
    eng.handleSignal(engineSignal('sell', 'weak_trend'));
    expect(await filteredCount(REGIME_GATE_STAGE)).toBe(0);
    expect(eng.positions.has('BTC-USD')).toBe(false);
  });
});
