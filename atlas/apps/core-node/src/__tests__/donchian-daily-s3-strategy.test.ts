/**
 * donchian_daily_s3 — card PAPER-S3-DONCHIAN-v0 (HOLD, default OFF, NOT a GO).
 *
 * Pins:
 *   1. The rule: entry fires exactly on the FIRST daily close strictly above
 *      the prior-20 closing high (current bar excluded; equality is not an
 *      entry); no re-entry while IN; exit fires on the FIRST close strictly
 *      below the prior-10 closing low while IN; never a sell while OUT
 *      (long-only); one signal per completed bar; re-entry only on a later bar.
 *   2. Data source: refuses on insufficient history and on 1m-spaced candles
 *      without `mtfCandles.d1`; uses `d1` when provided; uses daily-spaced
 *      `context.candles` (the `--bar-minutes 1440` backtest path).
 *   3. Stamps: `metadata.indicators.atr` (ATR-floor parity), `metadata.regime`,
 *      `metadata.intent`, `ruleState`, `barTime`; the far finite "no
 *      take-profit" sentinel.
 *   4. Registry / config: `createBuiltinStrategies()` includes it, a registry
 *      built from `guardrails.disabled_strategies` refuses it, config-drift is
 *      clean and pins it, strategies.json mirrors it.
 *   5. Backtest hook: `--include-disabled` lifts ONLY the listed ids for the
 *      run's config; without it `--strategy donchian_daily_s3` runs nothing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import {
  DonchianDailyS3Strategy,
  DAILY_BAR_MS,
  NO_TAKE_PROFIT_PRICE_MULTIPLE,
  isDailySpaced,
  medianSpacingMs,
} from '../strategies/plugins/builtin/donchian-daily-s3-strategy';
import { createBuiltinStrategies, getBuiltinStrategyIds } from '../strategies/plugins/builtin';
import { StrategyRegistry } from '../strategies/plugins/strategy-registry';
import { MarketContext } from '../strategies/plugins/types';
import { OHLCV } from '../indicators/technical';
import { RegimeState, MarketRegime } from '../strategies/regime-detector';
import { Logger } from '../core/logger';
import { loadGuardrails } from '../config/loadGuardrails';
import { checkConfigDrift, LIST_PINS, STRATEGIES_JSON_REPO_PATH } from '../config/config-drift';
import {
  buildBacktestConfig,
  buildFeeModel,
  resolveFeeTier,
  stripDisabledForRun,
} from '../backtesting/backtest-cli-config';
import { BacktestEngine } from '../backtesting/backtest-engine';
import { resolveSignalAtr } from '../strategies/atr-volatility-filter';

// src/__tests__ -> src -> core-node -> apps -> atlas -> repo root
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..');
const ATLAS_ROOT = path.join(REPO_ROOT, 'atlas');

const mockLogger: Logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

const T0 = Date.UTC(2024, 0, 1); // 2024-01-01T00:00:00Z, epoch ms

/** Daily candles from a close series: open = prev close, ±1% range around close. */
function dailyFromCloses(closes: number[], startMs = T0, spacingMs = DAILY_BAR_MS): OHLCV[] {
  return closes.map((close, i) => {
    const open = i === 0 ? close : closes[i - 1];
    return {
      time: startMs + i * spacingMs,
      open,
      high: Math.max(open, close) * 1.01,
      low: Math.min(open, close) * 0.99,
      close,
      volume: 1000,
    };
  });
}

function regime(r: MarketRegime = 'ranging'): RegimeState {
  return {
    regime: r,
    confidence: 0.8,
    adx: 20,
    chopIndex: 50,
    volatility: 0.02,
    trend: 0,
    mtfAlignment: 0.5,
    timestamp: new Date(),
    history: [],
  } as unknown as RegimeState;
}

function ctx(candles: OHLCV[], opts: { symbol?: string; d1?: OHLCV[]; regime?: MarketRegime } = {}): MarketContext {
  const latestCandle = candles[candles.length - 1];
  const previousCandle = candles[candles.length - 2] ?? latestCandle;
  return {
    symbol: opts.symbol ?? 'BTC-USD',
    timestamp: new Date(latestCandle.time),
    candles,
    mtfCandles: opts.d1 ? { d1: opts.d1 } : undefined,
    indicators: {},
    latestIndicators: {},
    latestCandle,
    previousCandle,
    regime: regime(opts.regime),
  };
}

/**
 * 30 flat closes at 100 (with tiny wiggle so ATR > 0 and max/min are exact),
 * then the caller appends the bars under test.
 */
function flatBase(n = 30, level = 100): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(level + (i % 2 === 0 ? 0 : -0.5));
  return out;
}

/** Feed candles one completed bar at a time, collecting signals per bar. */
function replay(strategy: DonchianDailyS3Strategy, candles: OHLCV[], minBars: number, symbol = 'BTC-USD') {
  const perBar: Array<{ i: number; signals: ReturnType<DonchianDailyS3Strategy['generateSignals']> }> = [];
  for (let i = minBars; i <= candles.length; i++) {
    const c = ctx(candles.slice(0, i), { symbol });
    const v = strategy.validateContext(c);
    perBar.push({ i: i - 1, signals: v.valid ? strategy.generateSignals(c) : [] });
  }
  return perBar;
}

describe('DonchianDailyS3Strategy — metadata and schema', () => {
  it('has the card identity, defaults mirrored in schema, and all-compatible regimes', () => {
    const s = new DonchianDailyS3Strategy();
    expect(s.id).toBe('donchian_daily_s3');
    expect(s.name).toBe('Donchian Daily S3 (in20/out10)');
    expect(s.category).toBe('trend');
    expect(s.version).toBe('0.1.0');
    expect(s.tags).toEqual(expect.arrayContaining(['donchian', 'daily', 'breakout', 's3']));
    expect(s.config.entryLookback).toBe(20);
    expect(s.config.exitLookback).toBe(10);
    expect(s.config.atrPeriod).toBe(14);
    expect(s.config.stopAtr).toBe(3.0);
    expect(s.config.takeProfitAtr).toBe(0);
    expect(s.config.minStrength).toBe(0);
    expect(s.requiredIndicators).toEqual([]);
    expect(s.regimeCompatibility).toHaveLength(4);
    for (const rc of s.regimeCompatibility) {
      expect(rc.compatibility).toBe('compatible');
      expect(rc.positionMultiplier).toBe(1.0);
    }
    expect(s.requiredDailyBars()).toBe(21);
  });

  it('accepts custom lookbacks and reports the required history accordingly', () => {
    const s = new DonchianDailyS3Strategy({ entryLookback: 5, exitLookback: 3, atrPeriod: 4 });
    expect(s.config.entryLookback).toBe(5);
    expect(s.requiredDailyBars()).toBe(6);
  });
});

describe('DonchianDailyS3Strategy — the rule on synthetic daily candles', () => {
  let s: DonchianDailyS3Strategy;
  beforeEach(() => {
    s = new DonchianDailyS3Strategy();
  });

  it('enters exactly on the FIRST close strictly above the prior-20 high, not on equality, and not twice', () => {
    // 30 flat bars (max close = 100), then: 100 (equal → no entry), 101
    // (first break → entry), 105 (still above, already IN → nothing).
    const closes = [...flatBase(30), 100, 101, 105];
    const candles = dailyFromCloses(closes);
    const bars = replay(s, candles, 21);
    const fired = bars.filter((b) => b.signals.length > 0);
    expect(fired).toHaveLength(1);
    expect(fired[0].i).toBe(31); // index of the 101 close
    const sig = fired[0].signals[0];
    expect(sig.direction).toBe('buy');
    expect(sig.metadata.intent).toBe('entry');
    expect(sig.metadata.ruleState).toBe('IN');
    expect(sig.metadata.indicators.donchianHigh).toBe(100);
    expect(sig.metadata.indicators.close).toBe(101);
    expect(sig.metadata.barTime).toBe(candles[31].time);
    expect(s.getSymbolState('BTC-USD').state).toBe('IN');
  });

  it('exits on the FIRST close strictly below the prior-10 low while IN (equality is not an exit), then is OUT', () => {
    // Break out at bar 30 (close 110) and hold 110 for 12 bars so the prior-10
    // window (current bar excluded) is entirely 110 → low = 110. Then:
    // 110 (equal → NO exit), 109.9 (first strict undercut → exit at bar 43),
    // 90 (already OUT → nothing).
    const closes = [...flatBase(30), ...Array.from({ length: 12 }, () => 110), 110, 109.9, 90];
    const candles = dailyFromCloses(closes);
    const bars = replay(s, candles, 21);
    const fired = bars.filter((b) => b.signals.length > 0);
    expect(fired.map((b) => [b.i, b.signals[0].direction])).toEqual([[30, 'buy'], [43, 'sell']]);
    const exit = fired[1].signals[0];
    expect(exit.metadata.intent).toBe('exit');
    expect(exit.metadata.ruleState).toBe('OUT');
    expect(candles[fired[1].i].close).toBe(109.9);
    expect(exit.metadata.indicators.donchianLow).toBe(110);
    // The further drop to 90 while OUT emits nothing (long-only: never a naked sell).
    expect(bars[bars.length - 1].signals).toHaveLength(0);
    expect(s.getSymbolState('BTC-USD').state).toBe('OUT');
  });

  it('never emits a sell while OUT (long-only) even on a deep undercut', () => {
    const closes = [...flatBase(30), 50, 40, 30];
    const bars = replay(s, dailyFromCloses(closes), 21);
    expect(bars.flatMap((b) => b.signals)).toHaveLength(0);
  });

  it('does not check the fill bar for an exit (sim_brk mechanics) but does the bar after', () => {
    // Entry at bar 30 (101). Bar 31 (fill bar) crashes to 50 — far below the
    // prior-10 low (99.5) but NOT checked. Bar 32 at 49 < prior-10 low (now
    // 50, the fill bar's close) → exit fires here.
    const closes = [...flatBase(30), 101, 50, 49];
    const bars = replay(s, dailyFromCloses(closes), 21);
    const fired = bars.filter((b) => b.signals.length > 0);
    expect(fired.map((b) => [b.i, b.signals[0].direction])).toEqual([[30, 'buy'], [32, 'sell']]);
  });

  it('re-enters only on a later completed bar after an exit, never the same bar', () => {
    // Entry at 101 (bar 30); bars 31..: keep IN, then undercut to exit, then a
    // fresh breakout above the new prior-20 high.
    const closes = [...flatBase(30), 101, 101, 101, 60, 60, 60];
    // Prior-20 high after the drop still 101 → 102 is a new breakout.
    closes.push(102);
    const candles = dailyFromCloses(closes);
    const bars = replay(s, candles, 21);
    const fired = bars.filter((b) => b.signals.length > 0).map((b) => [b.i, b.signals[0].direction]);
    expect(fired).toEqual([[30, 'buy'], [33, 'sell'], [36, 'buy']]);
  });

  it('emits at most one signal per completed bar and nothing when the same bar is re-evaluated', () => {
    const closes = [...flatBase(30), 101];
    const candles = dailyFromCloses(closes);
    const c = ctx(candles);
    expect(s.generateSignals(c)).toHaveLength(1);
    expect(s.generateSignals(c)).toHaveLength(0); // same barTime → no duplicate
    expect(s.generateSignals(ctx(candles.slice(0, -1)))).toHaveLength(0); // older bar → ignored
  });

  it('keeps per-symbol state independent and supports getState / resetState', () => {
    const closes = [...flatBase(30), 101];
    const candles = dailyFromCloses(closes);
    expect(s.generateSignals(ctx(candles, { symbol: 'BTC-USD' }))).toHaveLength(1);
    expect(s.generateSignals(ctx(candles, { symbol: 'ETH-USD' }))).toHaveLength(1);
    const state = s.getState() as { symbols: Record<string, { state: string; lastBarTime: number | null }> };
    expect(state.symbols['BTC-USD'].state).toBe('IN');
    expect(state.symbols['ETH-USD'].state).toBe('IN');
    expect(state.symbols['BTC-USD'].lastBarTime).toBe(candles[30].time);
    s.resetState('BTC-USD');
    expect(s.getSymbolState('BTC-USD').state).toBe('OUT');
    expect(s.getSymbolState('ETH-USD').state).toBe('IN');
    // After a reset the same bar fires again (state is not persisted).
    expect(s.generateSignals(ctx(candles, { symbol: 'BTC-USD' }))).toHaveLength(1);
    s.resetState();
    expect((s.getState() as { symbols: Record<string, unknown> }).symbols).toEqual({});
  });

  it('honours minStrength for entries only', () => {
    const strict = new DonchianDailyS3Strategy({ minStrength: 0.99 });
    const closes = [...flatBase(30), 100.01];
    expect(strict.generateSignals(ctx(dailyFromCloses(closes)))).toHaveLength(0);
    expect(strict.getSymbolState('BTC-USD').state).toBe('OUT');
  });
});

describe('DonchianDailyS3Strategy — stamps', () => {
  it('stamps indicators.atr (ATR-floor parity), regime, intent, and the far no-TP sentinel', () => {
    const s = new DonchianDailyS3Strategy();
    const candles = dailyFromCloses([...flatBase(30), 101]);
    const [sig] = s.generateSignals(ctx(candles, { regime: 'weak_trend' }));
    expect(sig).toBeDefined();
    expect(sig.strategy).toBe('donchian_daily_s3');
    expect(sig.metadata.regime).toBe('weak_trend');
    expect(sig.metadata.intent).toBe('entry');
    expect(sig.metadata.dailySource).toBe('candles');
    const atr = sig.metadata.indicators.atr;
    expect(Number.isFinite(atr) && atr > 0).toBe(true);
    // The router's atr_vol floor and the backtest trail read this path.
    expect(resolveSignalAtr(sig.metadata)).toBe(atr);
    expect(sig.metadata.indicators.donchianLow).toBeDefined();
    expect(sig.stopLoss).toBeCloseTo(101 - 3.0 * atr, 8);
    // No take-profit → far finite sentinel (0 / Infinity would fall back to a 4 % / 3 % target downstream).
    expect(sig.takeProfit).toBe(101 * NO_TAKE_PROFIT_PRICE_MULTIPLE);
    expect(Number.isFinite(sig.takeProfit)).toBe(true);
    expect(sig.metadata.noTakeProfit).toBe(true);
    expect(sig.timestamp.getTime()).toBe(candles[30].time);
    expect(typeof sig.metadata.reason).toBe('string');
  });

  it('uses close + takeProfitAtr × ATR when a take-profit multiple is configured', () => {
    const s = new DonchianDailyS3Strategy({ takeProfitAtr: 4 });
    const [sig] = s.generateSignals(ctx(dailyFromCloses([...flatBase(30), 101])));
    const atr = sig.metadata.indicators.atr;
    expect(sig.takeProfit).toBeCloseTo(101 + 4 * atr, 8);
    expect(sig.metadata.noTakeProfit).toBe(false);
  });
});

describe('DonchianDailyS3Strategy — data source', () => {
  it('refuses on insufficient daily history', () => {
    const s = new DonchianDailyS3Strategy();
    const c = ctx(dailyFromCloses(flatBase(20))); // need 21
    const v = s.validateContext(c);
    expect(v.valid).toBe(false);
    expect(v.reason).toMatch(/insufficient daily history/);
    expect(s.generateSignals(c)).toHaveLength(0);
  });

  it('refuses 1m-spaced candles without mtfCandles.d1 (never rebuilds daily bars from the 1m buffer)', () => {
    const s = new DonchianDailyS3Strategy();
    const oneMin = dailyFromCloses([...flatBase(30), 101], T0, 60_000);
    expect(isDailySpaced(oneMin)).toBe(false);
    expect(medianSpacingMs(oneMin)).toBe(60_000);
    const c = ctx(oneMin);
    const v = s.validateContext(c);
    expect(v.valid).toBe(false);
    expect(v.reason).toMatch(/daily-spaced=false/);
    expect(s.generateSignals(c)).toHaveLength(0);
  });

  it('uses mtfCandles.d1 when provided, even when the base candles are 1m', () => {
    const s = new DonchianDailyS3Strategy();
    const oneMin = dailyFromCloses(flatBase(60), T0, 60_000);
    const d1 = dailyFromCloses([...flatBase(30), 101]);
    const c = ctx(oneMin, { d1 });
    expect(s.validateContext(c).valid).toBe(true);
    expect(s.resolveDailySeries(c)?.source).toBe('d1');
    const sigs = s.generateSignals(c);
    expect(sigs).toHaveLength(1);
    expect(sigs[0].metadata.dailySource).toBe('d1');
    expect(sigs[0].metadata.barTime).toBe(d1[30].time);
    expect(sigs[0].metadata.indicators.close).toBe(101);
  });

  it('prefers d1 over daily-spaced base candles, and falls back to base when d1 is too short', () => {
    const s = new DonchianDailyS3Strategy();
    const base = dailyFromCloses([...flatBase(30), 101]);
    const shortD1 = dailyFromCloses(flatBase(5));
    expect(s.resolveDailySeries(ctx(base, { d1: shortD1 }))?.source).toBe('candles');
    expect(s.resolveDailySeries(ctx(base, { d1: base }))?.source).toBe('d1');
  });

  it('accepts daily spacing within ±10 % tolerance and rejects 4h bars', () => {
    expect(isDailySpaced(dailyFromCloses(flatBase(5), T0, DAILY_BAR_MS * 1.05))).toBe(true);
    expect(isDailySpaced(dailyFromCloses(flatBase(5), T0, 4 * 3_600_000))).toBe(false);
    expect(isDailySpaced([])).toBe(false);
  });
});

describe('donchian_daily_s3 — registry integration and desk pins', () => {
  const guardrails = loadGuardrails(ATLAS_ROOT);

  it('createBuiltinStrategies() includes it; a registry built from guardrails.disabled_strategies refuses it', () => {
    expect(getBuiltinStrategyIds()).toContain('donchian_daily_s3');
    const built = createBuiltinStrategies();
    const plugin = built.find((p) => p.id === 'donchian_daily_s3');
    expect(plugin).toBeInstanceOf(DonchianDailyS3Strategy);

    const registry = new StrategyRegistry({ disabledStrategies: guardrails.disabled_strategies }, mockLogger);
    let registered = 0;
    for (const p of built) {
      if (registry.register(p)) registered += 1;
    }
    expect(registry.get('donchian_daily_s3')).toBeUndefined();
    expect(registry.getAll().map((p) => p.id)).not.toContain('donchian_daily_s3');
    // trend_follow is the only builtin not on the shelf today.
    expect(registered).toBe(1);
    expect(registry.getAll().map((p) => p.id)).toEqual(['trend_follow']);
  });

  it('is pinned OFF: guardrails, LIST_PINS, cfm_symbols and the strategies.json mirror all carry it; config-drift is clean', () => {
    expect(guardrails.disabled_strategies).toContain('donchian_daily_s3');
    const pin = LIST_PINS.find((p) => p.key === 'disabled_strategies');
    expect(pin?.mustInclude).toContain('donchian_daily_s3');
    for (const [, cfg] of Object.entries(guardrails.cfm_symbols ?? {})) {
      expect(cfg.disabled_strategies).toContain('donchian_daily_s3');
    }
    const mirror = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, STRATEGIES_JSON_REPO_PATH), 'utf8'));
    expect(mirror.strategies.donchian_daily_s3).toEqual({ enabled: false });
    expect(checkConfigDrift(REPO_ROOT).violations).toEqual([]);
  });

  it('a registry WITHOUT the kill list registers it and it can generate on daily candles (harness path)', () => {
    const registry = new StrategyRegistry({}, mockLogger);
    expect(registry.register(new DonchianDailyS3Strategy())).toBe(true);
    const candles = dailyFromCloses([...flatBase(30), 101]);
    const sigs = registry.generateSignals(ctx(candles, { regime: 'choppy' }));
    expect(sigs).toHaveLength(1);
    expect(sigs[0].strategy).toBe('donchian_daily_s3');
    // choppy is 'compatible' (not 'incompatible') so the registry never self-gates it.
    expect(sigs[0].metadata.regime).toBe('choppy');
  });
});

describe('backtest harness hook — --include-disabled (config + engine level)', () => {
  const guardrails = loadGuardrails(ATLAS_ROOT);
  const base = {
    startDate: new Date('2024-09-01T00:00:00Z'),
    endDate: new Date('2026-08-31T00:00:00Z'),
    initialCapital: 10_000,
    products: ['BTC-USD'],
    strategy: 'donchian_daily_s3',
    feeModel: buildFeeModel(guardrails, resolveFeeTier(undefined, guardrails.fees.coinbase.spot)),
    evGateMode: 'enforce' as const,
    regimeGates: true,
  };

  it('stripDisabledForRun lifts only the listed ids from the global and per-symbol lists (pure)', () => {
    const before = [...guardrails.disabled_strategies];
    const r = stripDisabledForRun(guardrails, ['donchian_daily_s3']);
    expect(r.disabledStrategies).not.toContain('donchian_daily_s3');
    expect(r.disabledStrategies).toEqual(expect.arrayContaining(['vwap_mr', 'breakout', 'momentum']));
    expect(r.forceEnabled).toEqual(['donchian_daily_s3']);
    expect(r.notDisabled).toEqual([]);
    for (const ids of Object.values(r.perSymbolDisabledStrategies)) {
      expect(ids).not.toContain('donchian_daily_s3');
    }
    // cfm symbol keeps the other four.
    expect(r.perSymbolDisabledStrategies['BIP-20DEC30-CDE']).toEqual(
      expect.arrayContaining(['trend_follow', 'momentum', 'vwap_mr', 'breakout']),
    );
    // Guardrails object untouched.
    expect(guardrails.disabled_strategies).toEqual(before);
    expect(guardrails.cfm_symbols?.['BIP-20DEC30-CDE']?.disabled_strategies).toContain('donchian_daily_s3');

    const noop = stripDisabledForRun(guardrails, ['trend_follow']);
    expect(noop.forceEnabled).toEqual(['trend_follow']); // lifted from the cfm per-symbol list only
    expect(noop.disabledStrategies).toEqual(before);
    const unknown = stripDisabledForRun(guardrails, ['not_a_strategy']);
    expect(unknown.forceEnabled).toEqual([]);
    expect(unknown.notDisabled).toEqual(['not_a_strategy']);
    expect(unknown.disabledStrategies).toEqual(before);
    expect(stripDisabledForRun(guardrails, undefined).disabledStrategies).toEqual(before);
  });

  it('without --include-disabled the run config keeps the guardrails kill list (today\'s semantics)', () => {
    const cfg = buildBacktestConfig(base, guardrails);
    expect(cfg.signals.donchianDailyS3?.enabled).toBe(true);
    expect(cfg.disabledStrategies).toContain('donchian_daily_s3');
    expect(cfg.forceEnabledStrategies).toBeUndefined();
    expect(cfg.perSymbolDisabledStrategies?.['BIP-20DEC30-CDE']).toContain('donchian_daily_s3');
    // Other selectors leave donchian's toggle off.
    expect(buildBacktestConfig({ ...base, strategy: 'trend_follow' }, guardrails).signals.donchianDailyS3?.enabled).toBe(false);
    expect(buildBacktestConfig({ ...base, strategy: 'all' }, guardrails).signals.donchianDailyS3?.enabled).toBe(true);
  });

  it('with --include-disabled donchian_daily_s3 the run config lifts exactly that id', () => {
    const cfg = buildBacktestConfig({ ...base, includeDisabled: ['donchian_daily_s3'] }, guardrails);
    expect(cfg.disabledStrategies).not.toContain('donchian_daily_s3');
    expect(cfg.disabledStrategies).toEqual(expect.arrayContaining(['vwap_mr', 'breakout', 'momentum']));
    expect(cfg.forceEnabledStrategies).toEqual(['donchian_daily_s3']);
    expect(cfg.perSymbolDisabledStrategies?.['BIP-20DEC30-CDE']).not.toContain('donchian_daily_s3');
    // guardrails.yaml itself is untouched (paper/live read it directly).
    expect(loadGuardrails(ATLAS_ROOT).disabled_strategies).toContain('donchian_daily_s3');
  });

  it('engine: not active without the flag; active (and trades the synthetic breakout) with it', async () => {
    // SignalProcessor.checkSignals only runs once the buffer holds ≥ 50
    // candles, so: 60 flat days at 100, breakout day, 12 days climbing, 10
    // days at the top, then a fall below the prior-10 low → one rule entry +
    // rule exit.
    const closes = [
      ...flatBase(60, 100),
      103,
      ...Array.from({ length: 12 }, (_, i) => 104 + i),
      ...Array.from({ length: 10 }, () => 116),
      100, 95, 90, 90, 90,
    ];
    const candles = dailyFromCloses(closes, Date.UTC(2025, 0, 1));

    const off = new BacktestEngine(buildBacktestConfig(base, guardrails), mockLogger);
    await off.loadHistoricalData(async () => candles);
    const offResult = await off.run();
    expect(offResult.metrics.activeStrategies).not.toContain('donchian_daily_s3');
    expect(offResult.metrics.activeStrategies).toEqual([]);
    expect(offResult.trades).toHaveLength(0);
    expect(offResult.config.forceEnabledStrategies).toBeUndefined();

    const warn = vi.fn();
    const logger = { ...mockLogger, warn } as unknown as Logger;
    const on = new BacktestEngine(buildBacktestConfig({ ...base, includeDisabled: ['donchian_daily_s3'] }, guardrails), logger);
    await on.loadHistoricalData(async () => candles);
    const onResult = await on.run();
    expect(onResult.metrics.activeStrategies).toEqual(['donchian_daily_s3']);
    expect(onResult.config.forceEnabledStrategies).toEqual(['donchian_daily_s3']);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('DISABLED strategy force-enabled for this backtest run only — paper/live untouched'),
      expect.objectContaining({ forceEnabledStrategies: ['donchian_daily_s3'] }),
    );
    expect(onResult.metrics.longEntries).toBeGreaterThanOrEqual(1);
    expect(onResult.metrics.shortEntries).toBe(0);
    for (const trade of onResult.trades) {
      expect(trade.strategy).toBe('donchian_daily_s3');
      expect(trade.side).toBe('BUY');
    }
  });
});
