/**
 * Live-parity execution rules added to the backtest engine for the E4 card:
 *
 *   1. `execution.minHoldBars` — an opposite-direction signal may not close a
 *      position held for fewer than N BARS (bar clock). Live analog:
 *      `strategy.trade_cooldown_min` (`exit_position_too_young`). Stops/TPs
 *      bypass it. Default 0 = pre-E4 behaviour.
 *   2. `filters.atrVolatilityMin/Max` — live pre-entry ATR% filter
 *      (`atr_vol` / `atr_below_min` / `atr_above_max`). Absent = no filter.
 *   3. The shared CLI config builder wires the guardrails filter by default
 *      (parity) and leaves minHoldBars off unless asked.
 */
import { describe, it, expect, vi } from 'vitest';
import path from 'node:path';
import { BacktestEngine, type BacktestConfig } from '../backtesting/backtest-engine';
import { buildBacktestConfig, buildFeeModel, resolveFeeTier } from '../backtesting/backtest-cli-config';
import { loadGuardrails } from '../config/loadGuardrails';
import type { Signal } from '../strategies/signal-processor';

function makeLogger() {
  return { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as any;
}

function cfg(overrides: Partial<BacktestConfig> = {}): BacktestConfig {
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
    ...overrides,
  };
}

function signal(direction: 'buy' | 'sell', price: number, stop: number, tp: number, atr?: number): Signal {
  return {
    id: `sig-${direction}-${price}-${Math.random()}`,
    timestamp: new Date('2030-01-01T00:00:00Z'),
    symbol: 'BTC-USD',
    strategy: 'trend_follow',
    direction,
    strength: 0.7,
    price,
    stopLoss: stop,
    takeProfit: tp,
    metadata: { indicators: atr === undefined ? {} : { atr }, reason: 'test' },
  } as Signal;
}

describe('engine parity — execution.minHoldBars (cooldown in bars)', () => {
  it('default 0: an opposite signal on the entry bar closes the position (pre-E4 behaviour)', () => {
    const engine = new BacktestEngine(cfg(), makeLogger());
    const eng = engine as any;
    eng.initializeSignalProcessor();
    eng.barIndex = 10;
    eng.currentBarTime = new Date('2024-01-01T10:00:00Z');
    eng.openPositionAt(signal('buy', 100, 98, 106), 100, eng.currentBarTime);
    expect(eng.positions.get('BTC-USD')?.entryBarIndex).toBe(10);
    eng.handleSignal(signal('sell', 101, 103, 96));
    expect(eng.positions.size).toBe(0);
    expect(eng.exitsIgnoredMinHold).toBe(0);
  });

  it('minHoldBars=1: the same-bar opposite signal is ignored (exit_position_too_young), the next bar may exit', () => {
    const logger = makeLogger();
    const engine = new BacktestEngine(cfg({ execution: { minHoldBars: 1 } }), logger);
    const eng = engine as any;
    eng.initializeSignalProcessor();
    eng.barIndex = 10;
    eng.currentBarTime = new Date('2024-01-01T10:00:00Z');
    eng.openPositionAt(signal('buy', 100, 98, 106), 100, eng.currentBarTime);

    eng.handleSignal(signal('sell', 101, 103, 96)); // barsHeld = 0 < 1
    expect(eng.positions.size).toBe(1);
    expect(eng.exitsIgnoredMinHold).toBe(1);
    const filtered = logger.info.mock.calls.find((c: any[]) => c[0] === 'signal:filtered' && c[1]?.extra?.reason === 'exit_position_too_young')
      ?? logger.info.mock.calls.find((c: any[]) => JSON.stringify(c).includes('exit_position_too_young'));
    expect(filtered).toBeDefined();

    eng.barIndex = 11;
    eng.currentBarTime = new Date('2024-01-01T11:00:00Z');
    eng.handleSignal(signal('sell', 101, 103, 96)); // barsHeld = 1 ≥ 1
    expect(eng.positions.size).toBe(0);
    expect(eng.closedTrades[0].exitReason).toBe('signal');
    expect(eng.exitsIgnoredMinHold).toBe(1);
    expect(engine['calculateMetrics']().exitsIgnoredMinHold).toBe(1);
  });

  it('stops and take-profits bypass the min hold (same as live position monitor)', () => {
    const engine = new BacktestEngine(cfg({ execution: { minHoldBars: 5 } }), makeLogger());
    const eng = engine as any;
    eng.initializeSignalProcessor();
    eng.barIndex = 3;
    eng.currentBarTime = new Date('2024-01-01T03:00:00Z');
    eng.openPositionAt(signal('buy', 100, 98, 106), 100, eng.currentBarTime);
    eng.checkExitConditions('BTC-USD', { time: Date.UTC(2024, 0, 1, 3), open: 100, high: 100.5, low: 97, close: 97.5, volume: 1 }, eng.currentBarTime);
    expect(eng.positions.size).toBe(0);
    expect(eng.closedTrades[0].exitReason).toBe('stop_loss');
    expect(eng.exitsIgnoredMinHold).toBe(0);
  });
});

describe('engine parity — filters.atrVolatilityMin/Max (live atr_vol stage)', () => {
  it('rejects an entry whose ATR% is below the min or above the max; passes inside the band or without ATR', () => {
    const engine = new BacktestEngine(cfg({ filters: { atrVolatilityMin: 0.005, atrVolatilityMax: 0.05 } }), makeLogger());
    const eng = engine as any;
    eng.initializeSignalProcessor();
    eng.currentBarTime = new Date('2024-01-01T00:00:00Z');

    eng.handleSignal(signal('buy', 100, 98, 106, 0.3)); // 0.3% < 0.5%
    expect(eng.pendingFills.size).toBe(0);
    expect(eng.atrFilterRejects).toBe(1);

    eng.handleSignal(signal('buy', 100, 98, 106, 6)); // 6% > 5%
    expect(eng.pendingFills.size).toBe(0);
    expect(eng.atrFilterRejects).toBe(2);

    eng.handleSignal(signal('buy', 100, 98, 106, 2)); // 2% inside band
    expect(eng.pendingFills.size).toBe(1);
    eng.pendingFills.clear();

    eng.handleSignal(signal('buy', 100, 98, 106)); // no ATR ⇒ passes (live behaviour)
    expect(eng.pendingFills.size).toBe(1);
    expect(eng.atrFilterRejects).toBe(2);
    expect(engine['calculateMetrics']().atrFilterRejects).toBe(2);
  });

  it('no `filters` block ⇒ no filtering (pre-E4 behaviour)', () => {
    const engine = new BacktestEngine(cfg(), makeLogger());
    const eng = engine as any;
    eng.initializeSignalProcessor();
    eng.currentBarTime = new Date('2024-01-01T00:00:00Z');
    eng.handleSignal(signal('buy', 100, 98, 106, 0.1));
    expect(eng.pendingFills.size).toBe(1);
    expect(eng.atrFilterRejects).toBe(0);
  });
});

describe('shared CLI config builder — parity wiring', () => {
  const guardrails = loadGuardrails(path.resolve(__dirname, '../../../..'));
  const base = {
    startDate: new Date('2025-03-01T00:00:00Z'),
    endDate: new Date('2026-03-01T00:00:00Z'),
    initialCapital: 1000,
    products: ['BTC-USD'],
    strategy: 'trend_follow',
    feeModel: buildFeeModel(guardrails, resolveFeeTier(undefined, guardrails.fees.coinbase.spot)),
    evGateMode: 'enforce' as const,
    regimeGates: true,
  };

  it('wires guardrails.filters by default, can be switched off, and only sets execution.minHoldBars when asked', () => {
    const dflt = buildBacktestConfig(base, guardrails);
    expect(dflt.filters).toEqual({ atrVolatilityMin: guardrails.filters.atr_volatility_min, atrVolatilityMax: guardrails.filters.atr_volatility_max });
    expect(dflt.filters?.atrVolatilityMin).toBe(0.005);
    expect(dflt.execution).toBeUndefined();
    expect(buildBacktestConfig({ ...base, applyAtrVolatilityFilter: false }, guardrails).filters).toBeUndefined();
    expect(buildBacktestConfig({ ...base, minHoldBars: 1 }, guardrails).execution).toEqual({ minHoldBars: 1 });
    expect(buildBacktestConfig({ ...base, minHoldBars: 0 }, guardrails).execution).toBeUndefined();
  });
});
