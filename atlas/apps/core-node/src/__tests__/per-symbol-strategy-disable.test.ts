/**
 * Per-(symbol, strategy) disable — gate behaviour tests.
 *
 * Pins the F4 follow-up §8 invariants:
 *
 *   1. Pure helpers in `strategies/per-symbol-disable.ts`:
 *      - `buildPerSymbolDisabledStrategies` flattens per_symbol /
 *        perps_symbols / hyperliquid_symbols `disabled_strategies` lists
 *        into a single `Record<symbol, string[]>` map.
 *      - `isSymbolStrategyDisabled` returns true iff `(symbol, strategy)`
 *        is in that map.
 *
 *   2. YAML state — `guardrails.yaml` carries `disabled_strategies:
 *      [momentum]` on BOTH `perps_symbols.{ETH,BTC}-PERP-INTX` AND nothing
 *      on the spot `per_symbol.*` blocks. Since E2-MOM-ISO (2026-09-11)
 *      spot momentum is shelved via the GLOBAL `disabled_strategies` list
 *      instead, so the per-symbol blocks stay untouched (one-line undo).
 *
 *   3. SignalProcessor.processSignal end-to-end gate — a `momentum` signal
 *      on `ETH-PERP-INTX` is rejected with the structured-log
 *      `stage='per_symbol_disable', reason='symbol_strategy_disabled'`
 *      checkpoint, while:
 *        a. `momentum` on `ETH-USD` (spot) passes the gate (no spillover).
 *        b. `trend_follow` on `ETH-PERP-INTX` passes the gate (only the
 *           explicitly-listed strategy is rejected).
 *
 * Any regression here either silently reactivates momentum on perps or
 * accidentally disables a strategy on a spot symbol — both are loud bugs.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'node:path';
import { register } from 'prom-client';
import { Logger } from '../core/logger';
import { loadGuardrails } from '../config/loadGuardrails';
import {
  buildPerSymbolDisabledStrategies,
  isSymbolStrategyDisabled,
  PerSymbolDisabledStrategies,
} from '../strategies/per-symbol-disable';
import { Signal, SignalProcessor, SignalProcessorConfig } from '../strategies/signal-processor';
import { __resetSignalFilteredCounter } from '../strategies/signal-filter-telemetry';

// Mock supabase so processSignal doesn't try to hit the network.
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: () => ({
      insert: () => ({ error: null }),
    }),
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
    strategy: (overrides.strategy ?? 'momentum') as Signal['strategy'],
    direction: overrides.direction ?? 'buy',
    strength: overrides.strength ?? 0.5,
    price: overrides.price ?? 100,
    stopLoss: overrides.stopLoss ?? 99,
    takeProfit: overrides.takeProfit ?? 102,
    metadata: overrides.metadata ?? { indicators: {}, reason: 'test' },
  };
}

/**
 * Read the live count for a specific (stage, symbol, strategy) labelset
 * out of the `atlas_signal_filtered_total` counter.
 */
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

describe('per-symbol-disable helpers — pure unit tests', () => {
  it('isSymbolStrategyDisabled returns false for an undefined map', () => {
    expect(isSymbolStrategyDisabled(undefined, 'ETH-PERP-INTX', 'momentum')).toBe(false);
  });

  it('isSymbolStrategyDisabled returns false when the symbol has no entry', () => {
    const map: PerSymbolDisabledStrategies = { 'ETH-PERP-INTX': ['momentum'] };
    expect(isSymbolStrategyDisabled(map, 'BTC-USD', 'momentum')).toBe(false);
  });

  it('isSymbolStrategyDisabled returns false when the entry is empty', () => {
    const map: PerSymbolDisabledStrategies = { 'ETH-PERP-INTX': [] };
    expect(isSymbolStrategyDisabled(map, 'ETH-PERP-INTX', 'momentum')).toBe(false);
  });

  it('isSymbolStrategyDisabled returns true for an exact (symbol, strategy) match', () => {
    const map: PerSymbolDisabledStrategies = { 'ETH-PERP-INTX': ['momentum'] };
    expect(isSymbolStrategyDisabled(map, 'ETH-PERP-INTX', 'momentum')).toBe(true);
  });

  it('isSymbolStrategyDisabled does NOT match a different strategy on the same symbol', () => {
    const map: PerSymbolDisabledStrategies = { 'ETH-PERP-INTX': ['momentum'] };
    expect(isSymbolStrategyDisabled(map, 'ETH-PERP-INTX', 'trend_follow')).toBe(false);
  });

  it('buildPerSymbolDisabledStrategies merges per_symbol + perps_symbols + hyperliquid_symbols', () => {
    const flat = buildPerSymbolDisabledStrategies({
      per_symbol: { 'BTC-USD': { disabled_strategies: ['breakout'] } },
      perps_symbols: {
        'ETH-PERP-INTX': { disabled_strategies: ['momentum'] },
        'BTC-PERP-INTX': { disabled_strategies: ['momentum'] },
      },
      hyperliquid_symbols: { 'ETH-USD': { disabled_strategies: ['vwap_mr'] } },
    });
    expect(flat).toEqual({
      'BTC-USD': ['breakout'],
      'ETH-PERP-INTX': ['momentum'],
      'BTC-PERP-INTX': ['momentum'],
      'ETH-USD': ['vwap_mr'],
    });
  });

  it('buildPerSymbolDisabledStrategies skips symbols with no disabled_strategies key', () => {
    const flat = buildPerSymbolDisabledStrategies({
      perps_symbols: {
        'ETH-PERP-INTX': { disabled_strategies: ['momentum'] },
        'BTC-PERP-INTX': {}, // no key at all
      },
    });
    expect(flat).toEqual({ 'ETH-PERP-INTX': ['momentum'] });
  });

  it('buildPerSymbolDisabledStrategies skips empty arrays', () => {
    const flat = buildPerSymbolDisabledStrategies({
      perps_symbols: {
        'ETH-PERP-INTX': { disabled_strategies: [] }, // explicit empty
      },
    });
    expect(flat).toEqual({});
  });
});

// ────────────────────────────────────────────────────────────────────────
// 2. YAML state regression tests
// ────────────────────────────────────────────────────────────────────────

describe('guardrails.yaml — disabled_strategies state (F4 follow-up §8)', () => {
  const guardrails = loadGuardrails(ATLAS_ROOT);

  it('ETH-PERP-INTX disables momentum', () => {
    expect(guardrails.perps_symbols?.['ETH-PERP-INTX']?.disabled_strategies).toEqual(['momentum']);
  });

  it('BTC-PERP-INTX disables momentum', () => {
    expect(guardrails.perps_symbols?.['BTC-PERP-INTX']?.disabled_strategies).toEqual(['momentum']);
  });

  it('spot ETH-USD has no per-symbol disable list (spot momentum is shelved globally, not per-symbol)', () => {
    const eth = guardrails.per_symbol?.['ETH-USD'];
    expect(eth, 'ETH-USD per_symbol block missing').toBeDefined();
    expect(eth?.disabled_strategies).toBeUndefined();
  });

  it('spot BTC-USD has no per-symbol disable list', () => {
    expect(guardrails.per_symbol?.['BTC-USD']?.disabled_strategies).toBeUndefined();
  });

  it('spot SOL-USD has no per-symbol disable list', () => {
    expect(guardrails.per_symbol?.['SOL-USD']?.disabled_strategies).toBeUndefined();
  });

  it('global disabled_strategies contains the Phase-3 kills plus momentum (E2-MOM-ISO KILL)', () => {
    expect(new Set(guardrails.disabled_strategies)).toEqual(new Set(['vwap_mr', 'breakout', 'momentum']));
  });

  it('buildPerSymbolDisabledStrategies(guardrails) flattens to exactly the two perp symbols', () => {
    expect(buildPerSymbolDisabledStrategies(guardrails)).toEqual({
      'ETH-PERP-INTX': ['momentum'],
      'BTC-PERP-INTX': ['momentum'],
    });
  });
});

// ────────────────────────────────────────────────────────────────────────
// 3. SignalProcessor end-to-end gate tests
// ────────────────────────────────────────────────────────────────────────

/**
 * Build a SignalProcessor with all sub-strategies disabled (we don't need
 * them to fire — we feed signals directly via processSignal). The
 * `disabledStrategies` global is empty here so the only gate that should
 * trigger is the new `per_symbol_disable` one.
 */
function makeProcessor(
  perSymbolDisabledStrategies: PerSymbolDisabledStrategies,
): SignalProcessor {
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
    perSymbolDisabledStrategies,
  };
  return new SignalProcessor(config, mockLogger as unknown as Logger);
}

describe('SignalProcessor.processSignal — per_symbol_disable gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetSignalFilteredCounter();
  });

  it('rejects momentum on ETH-PERP-INTX with stage=per_symbol_disable, reason=symbol_strategy_disabled', async () => {
    const sp = makeProcessor({ 'ETH-PERP-INTX': ['momentum'] });
    const sig = makeSignal({ strategy: 'momentum', symbol: 'ETH-PERP-INTX' });
    await (sp as unknown as { processSignal(s: Signal): Promise<void> }).processSignal(sig);

    expect(
      await filteredCount('per_symbol_disable', {
        symbol: 'ETH-PERP-INTX',
        strategy: 'momentum',
        reason: 'symbol_strategy_disabled',
      }),
    ).toBe(1);
  });

  it('does NOT reject momentum on ETH-USD (no global spillover)', async () => {
    // Disable map only covers ETH-PERP-INTX; spot ETH-USD should sail
    // through the per_symbol_disable gate unchanged.
    const sp = makeProcessor({ 'ETH-PERP-INTX': ['momentum'] });
    const sig = makeSignal({ strategy: 'momentum', symbol: 'ETH-USD' });
    await (sp as unknown as { processSignal(s: Signal): Promise<void> }).processSignal(sig);

    expect(
      await filteredCount('per_symbol_disable', { symbol: 'ETH-USD' }),
    ).toBe(0);
  });

  it('does NOT reject trend_follow on ETH-PERP-INTX (only momentum is in the list)', async () => {
    const sp = makeProcessor({ 'ETH-PERP-INTX': ['momentum'] });
    const sig = makeSignal({
      strategy: 'trend_follow' as Signal['strategy'],
      symbol: 'ETH-PERP-INTX',
    });
    await (sp as unknown as { processSignal(s: Signal): Promise<void> }).processSignal(sig);

    expect(
      await filteredCount('per_symbol_disable', {
        symbol: 'ETH-PERP-INTX',
        strategy: 'trend_follow',
      }),
    ).toBe(0);
  });

  it('emits signal:filtered event when the per-symbol gate rejects', async () => {
    const sp = makeProcessor({ 'ETH-PERP-INTX': ['momentum'] });
    const sig = makeSignal({ strategy: 'momentum', symbol: 'ETH-PERP-INTX' });
    const filteredEvents: Array<{ signal: Signal; reason: string }> = [];
    sp.on('signal:filtered', (filteredSignal: Signal, reason: string) => {
      filteredEvents.push({ signal: filteredSignal, reason });
    });
    await (sp as unknown as { processSignal(s: Signal): Promise<void> }).processSignal(sig);

    expect(filteredEvents).toHaveLength(1);
    expect(filteredEvents[0].signal.symbol).toBe('ETH-PERP-INTX');
    expect(filteredEvents[0].reason).toMatch(/Per-symbol disable/);
  });
});
