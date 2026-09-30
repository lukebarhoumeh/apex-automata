/**
 * `--meta-filter on|off` — run-scoped harness toggle for the rule-based
 * MetaFilter (2026-09-29, round-3 task I).
 *
 * Why: the round-2 donchian book-reconcile harness run showed the return
 * delta dominated by the position-blind cold-streak rule (10 consecutive
 * losses → 5 min pause; it blocked 11 rule exits). There was no switch to
 * isolate it: `--regime-gates` toggles the RegimeFilter and
 * `--regime-conditional-gates` the guardrails `regime_gates` policy, but the
 * MetaFilter always ran.
 *
 * Pins:
 *   1. `buildBacktestConfig` default (flag absent or `on`) is byte-identical
 *      to before — no `metaFilter` key at all — so every existing caller
 *      (pnpm backtest, E4 harness, tests) is unchanged.
 *   2. `metaFilter: false` sets exactly one key on the run's in-memory config
 *      and nothing else; guardrails.yaml is never touched.
 *   3. Engine level: with the default config a seeded 10+ loss streak blocks
 *      the next signal at the meta stage (`Meta filter: Cold streak …`); with
 *      `metaFilter: false` the same signal reaches `signal:generated`, the
 *      MetaFilter reports `enabled: false`, and the engine logs a warn banner.
 *      Outcomes are still recorded either way (EV gate / win-rate parity).
 *   4. Report: the text report carries a `Meta-filter:` line that names the
 *      flag when off.
 *   5. The flag lives on `BacktestConfig` only — `api/server.ts` never imports
 *      the backtest config builder (paper/live cannot see it).
 */
import { describe, it, expect, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { BacktestEngine, type BacktestConfig, type BacktestResult } from '../backtesting/backtest-engine';
import { BacktestRunner, describeMetaFilter } from '../backtesting/backtest-runner';
import { buildBacktestConfig, buildFeeModel, resolveFeeTier } from '../backtesting/backtest-cli-config';
import { loadGuardrails } from '../config/loadGuardrails';
import type { OHLCV } from '../indicators/technical';
import type { Signal } from '../strategies/signal-processor';
import type { TradeOutcome } from '../strategies/meta-filter';
import type { Logger } from '../core/logger';

// src/__tests__ -> src -> core-node -> apps -> atlas -> repo root
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..');
const ATLAS_ROOT = path.join(REPO_ROOT, 'atlas');

function makeLogger(): Logger & { warn: ReturnType<typeof vi.fn> } {
  return {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger & { warn: ReturnType<typeof vi.fn> };
}

/** Deterministic LCG candles (same helper shape as backtest-trade-outcomes.test.ts). */
function buildSyntheticCandles(count: number, seed = 1): OHLCV[] {
  let state = seed >>> 0;
  const next = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return (state >>> 8) / 0x01000000;
  };
  const candles: OHLCV[] = [];
  let price = 30_000;
  for (let i = 0; i < count; i++) {
    const drift = (next() - 0.5) * 200;
    const open = price;
    const close = price + drift;
    candles.push({
      time: 1_700_000_000_000 + i * 60_000,
      open,
      high: Math.max(open, close) + next() * 100,
      low: Math.min(open, close) - next() * 100,
      close,
      volume: 100 + next() * 50,
    });
    price = close;
  }
  return candles;
}

/** Hand-rolled engine config: momentum stays registered so a synthetic momentum signal is a valid probe. */
function engineConfig(overrides: Partial<BacktestConfig> = {}): BacktestConfig {
  return {
    startDate: new Date('2024-01-01'),
    endDate: new Date('2024-01-02'),
    initialCapital: 10_000,
    commission: 0.0005,
    products: ['BTC-USD'],
    signals: {
      breakout: { enabled: false, parameters: {} },
      vwapMeanReversion: { enabled: false, parameters: {} },
      momentum: { enabled: true, parameters: {} },
      trendFollow: { enabled: false, parameters: {} },
    },
    risk: { maxPositionSize: 3_000, maxTotalExposure: 30_000, stopLossPercent: 0.02, takeProfitPercent: 0.04 },
    account: { equityUsd: 10_000, riskPerTrade: 0.005, maxPositionExposurePct: 0.3, minNotionalBuffer: 1.1 },
    disabledStrategies: ['vwap_mr', 'breakout'],
    perSymbolOverrides: {},
    // RegimeFilter off so the probe below isolates the META stage.
    regimeGates: false,
    realism: { nextBarFill: true, entrySlippageBps: 5, stopOvershootBarRangePct: 0.2, stopOvershootMinBps: 5, sizeDecimals: 6 },
    ...overrides,
  };
}

const LOSS: TradeOutcome = {
  signalId: 'seed-loss',
  strategy: 'momentum',
  symbol: 'BTC-USD',
  direction: 'buy',
  signalStrength: 0.5,
  entryTime: new Date(0),
  exitTime: new Date(0),
  pnl: -100,
  outcome: 'loss',
  hourOfDay: 14,
  dayOfWeek: 1,
  filtersPassed: [],
  filtersBlocked: [],
};

/**
 * Run the engine, seed a 12-loss momentum streak through the SAME public
 * `recordTradeOutcome` path the engine's closePosition uses, then push one
 * more momentum signal through the real `processSignal` pipeline (private,
 * reached via the instance) at a bar time well past the dedup window.
 */
async function probeAfterLossStreak(config: BacktestConfig, logger: Logger): Promise<{
  engine: BacktestEngine;
  result: BacktestResult;
  generated: Signal[];
  filtered: Array<{ signal: Signal; reason: string }>;
}> {
  const engine = new BacktestEngine(config, logger);
  const candles = buildSyntheticCandles(60, 3);
  await engine.loadHistoricalData(async () => candles);
  const result = await engine.run();
  const sp = engine.getSignalProcessor();
  expect(sp).not.toBeNull();

  for (let i = 0; i < 12; i++) {
    sp!.recordTradeOutcome({ ...LOSS, signalId: `seed-loss-${i}` });
  }
  expect(sp!.getStrategyPerformance('momentum')?.consecutiveLosses).toBeGreaterThanOrEqual(10);

  const generated: Signal[] = [];
  const filtered: Array<{ signal: Signal; reason: string }> = [];
  sp!.on('signal:generated', (s: Signal) => generated.push(s));
  sp!.on('signal:filtered', (s: Signal, reason: string) => filtered.push({ signal: s, reason }));

  const nowMs = candles[candles.length - 1].time + 24 * 60 * 60 * 1000;
  const probe: Signal = {
    id: 'probe-after-streak',
    timestamp: new Date(nowMs),
    symbol: 'BTC-USD',
    strategy: 'momentum',
    direction: 'buy',
    strength: 0.8,
    price: 30_000,
    stopLoss: 29_400,
    takeProfit: 31_200,
    metadata: { indicators: { atr: 300 }, reason: 'probe' },
  };
  await (sp as unknown as { processSignal: (s: Signal, nowMs: number) => Promise<void> }).processSignal(probe, nowMs);
  return { engine, result, generated, filtered };
}

describe('buildBacktestConfig — metaFilter input (run-scoped)', () => {
  const guardrails = loadGuardrails(ATLAS_ROOT);
  const base = {
    startDate: new Date('2024-09-01T00:00:00Z'),
    endDate: new Date('2026-08-31T00:00:00Z'),
    initialCapital: 10_000,
    products: ['BTC-USD', 'ETH-USD', 'SOL-USD'],
    strategy: 'donchian_daily_s3',
    feeModel: buildFeeModel(guardrails, resolveFeeTier(undefined, guardrails.fees.coinbase.spot)),
    evGateMode: 'enforce' as const,
    regimeGates: true,
    includeDisabled: ['donchian_daily_s3'],
  };

  it('default (flag absent) and `on` are byte-identical to today: no metaFilter key at all', () => {
    const absent = buildBacktestConfig(base, guardrails);
    const on = buildBacktestConfig({ ...base, metaFilter: true }, guardrails);
    expect('metaFilter' in absent).toBe(false);
    expect('metaFilter' in on).toBe(false);
    expect(on).toEqual(absent);
  });

  it('`off` sets exactly `metaFilter: false` and changes nothing else; guardrails.yaml untouched', () => {
    const on = buildBacktestConfig(base, guardrails);
    const off = buildBacktestConfig({ ...base, metaFilter: false }, guardrails);
    expect(off.metaFilter).toBe(false);
    const { metaFilter: _omit, ...rest } = off;
    expect(rest).toEqual(on);
    // The run flag never reaches the YAML source of truth (paper/live read it directly).
    expect(loadGuardrails(ATLAS_ROOT)).toEqual(guardrails);
  });
});

describe('BacktestEngine — metaFilter: false disables the rule-based MetaFilter for the run', () => {
  it('default: a seeded 10+ loss streak blocks the next signal at the meta stage (cold streak)', async () => {
    const logger = makeLogger();
    const { engine, generated, filtered } = await probeAfterLossStreak(engineConfig(), logger);
    expect(engine.getSignalProcessor()!.getMetaFilterStats().enabled).toBe(true);
    expect(generated).toHaveLength(0);
    expect(filtered).toHaveLength(1);
    expect(filtered[0].reason).toMatch(/^Meta filter: Cold streak: \d+ consecutive losses/);
    expect(engine.getSignalProcessor()!.getLastMetaFilterResult('BTC-USD')?.coldStreakActive).toBe(true);
    expect(logger.warn).not.toHaveBeenCalledWith(
      expect.stringContaining('MetaFilter DISABLED for this backtest run only'),
      expect.anything(),
    );
  });

  it('metaFilter: false — the same streak does not block the next signal; banner logged; outcomes still recorded', async () => {
    const logger = makeLogger();
    const { engine, result, generated, filtered } = await probeAfterLossStreak(engineConfig({ metaFilter: false }), logger);
    const sp = engine.getSignalProcessor()!;
    expect(sp.getMetaFilterStats().enabled).toBe(false);
    expect(filtered).toHaveLength(0);
    expect(generated).toHaveLength(1);
    expect(generated[0].id).toBe('probe-after-streak');
    expect(generated[0].metadata.metaQualityScore).toBe(1);
    expect(sp.getLastMetaFilterResult('BTC-USD')?.reason).toBe('Meta filtering disabled');
    // Strategy-performance tracking (EV-gate observed win rate) is unaffected by the toggle.
    expect(sp.getStrategyPerformance('momentum')?.losses).toBeGreaterThanOrEqual(12);
    expect(result.config.metaFilter).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Rule-based MetaFilter DISABLED for this backtest run only — paper/live untouched'),
      expect.objectContaining({ source: '--meta-filter off' }),
    );
  });
});

describe('report lines', () => {
  it('describeMetaFilter + generateReport name the flag when off and say ON otherwise', async () => {
    expect(describeMetaFilter({ metaFilter: false })).toBe('OFF (this run only, --meta-filter off)');
    expect(describeMetaFilter({})).toBe('ON (rule-based MetaFilter, live parity)');
    expect(describeMetaFilter({ metaFilter: true })).toBe('ON (rule-based MetaFilter, live parity)');

    const logger = makeLogger();
    const runner = new BacktestRunner({ resultsPath: '/dev/null' }, logger);
    const off = new BacktestEngine(engineConfig({ metaFilter: false }), logger);
    await off.loadHistoricalData(async () => buildSyntheticCandles(60, 3));
    const offReport = runner.generateReport(await off.run());
    expect(offReport).toContain('Meta-filter: OFF (this run only, --meta-filter off)');

    const on = new BacktestEngine(engineConfig(), logger);
    await on.loadHistoricalData(async () => buildSyntheticCandles(60, 3));
    const onReport = runner.generateReport(await on.run());
    expect(onReport).toContain('Meta-filter: ON (rule-based MetaFilter, live parity)');
    expect(onReport).not.toContain('--meta-filter off');
  });
});

describe('isolation — the paper/live SignalProcessor construction path cannot see the flag', () => {
  it('api/server.ts does not import the backtest config builder or read a metaFilter run flag', () => {
    const server = fs.readFileSync(path.join(__dirname, '..', 'api', 'server.ts'), 'utf8');
    expect(server).not.toMatch(/backtest-cli-config/);
    expect(server).not.toMatch(/buildBacktestConfig/);
    expect(server).not.toMatch(/meta-filter off|metaFilter: false/);
  });
});
