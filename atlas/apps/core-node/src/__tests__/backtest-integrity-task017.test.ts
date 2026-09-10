/**
 * TASK_017 — Backtest integrity.
 *
 *   1. Missing bars ⇒ DATA_UNAVAILABLE (no synthetic) unless allowSynthetic.
 *   2. Spot run produces zero short entries (venue capability, B2).
 *   3. EV gate rejects a known negative-EV fixture at 120 bps, allows at 0 bps (B3).
 *   4. Sizing uses current equity after a loss (B4).
 *   5. Hold-time metric is bar-clock based and never negative (B5).
 *   6. Committed real fixtures load with provenance (CI gate data source).
 */
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BacktestEngine, BacktestConfig } from '../backtesting/backtest-engine';
import {
  HistoricalDataLoader,
  DataUnavailableError,
  isDataUnavailableError,
  inferBarMinutes,
} from '../backtesting/data-loader';
import { estimateWinRateWithPrior, DEFAULT_WIN_RATE_PRIOR } from '../trading/risk/ev-gate';
import { computeRiskBasedSize } from '../trading/risk/position-sizing';
import { isShortingAllowed, venueForSymbol } from '../trading/execution/venue-capabilities';
import { OHLCV } from '../indicators/technical';
import type { Signal } from '../strategies/signal-processor';

function makeLogger() {
  return { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as any;
}

function buildSyntheticCandles(count: number, seed = 1, barMs = 900_000): OHLCV[] {
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
    const high = Math.max(open, close) + next() * 100;
    const low = Math.min(open, close) - next() * 100;
    candles.push({ time: 1_700_000_000_000 + i * barMs, open, high, low, close, volume: 100 + next() * 50 });
    price = close;
  }
  return candles;
}

function baseConfig(overrides: Partial<BacktestConfig> = {}): BacktestConfig {
  return {
    startDate: new Date('2024-01-01'),
    endDate: new Date('2024-01-02'),
    initialCapital: 10_000,
    commission: 0.0005,
    products: ['BTC-USD'],
    signals: {
      breakout: { enabled: true, parameters: {} },
      vwapMeanReversion: { enabled: true, parameters: {} },
      momentum: { enabled: true, parameters: {} },
      trendFollow: { enabled: true, parameters: {} },
    },
    risk: { maxPositionSize: 3_000, maxTotalExposure: 30_000, stopLossPercent: 0.02, takeProfitPercent: 0.04 },
    account: { equityUsd: 10_000, riskPerTrade: 0.005, maxPositionExposurePct: 0.30, minNotionalBuffer: 1.1 },
    disabledStrategies: ['vwap_mr', 'breakout'],
    perSymbolOverrides: {},
    realism: { nextBarFill: true, entrySlippageBps: 5, stopOvershootBarRangePct: 0.20, stopOvershootMinBps: 5, sizeDecimals: 6 },
    ...overrides,
  };
}

function fakeSignal(direction: 'buy' | 'sell', price: number, stopLoss: number, takeProfit: number): Signal {
  return {
    id: `sig-${direction}-${price}`,
    timestamp: new Date('2030-01-01T00:00:00Z'), // deliberately wall-clock-ish: engine must ignore it
    symbol: 'BTC-USD',
    strategy: 'momentum',
    direction,
    strength: 0.8,
    price,
    stopLoss,
    takeProfit,
    metadata: { indicators: {}, reason: 'test' },
  } as Signal;
}

const FIXTURE_DIR = path.resolve(__dirname, '../../fixtures/bars');

describe('TASK_017 §1 — fail-closed data loader', () => {
  it('throws DATA_UNAVAILABLE naming symbol + window when no real data exists', async () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-bars-empty-'));
    const loader = new HistoricalDataLoader({ fixtureDir: emptyDir }, makeLogger());
    const start = new Date('2026-09-03T00:00:00Z');
    const end = new Date('2026-09-10T00:00:00Z');

    await expect(loader.loadCandles('SOL-USD', start, end, 900)).rejects.toMatchObject({
      code: 'DATA_UNAVAILABLE',
      symbol: 'SOL-USD',
    });
    try {
      await loader.loadCandles('SOL-USD', start, end, 900);
    } catch (err) {
      expect(isDataUnavailableError(err)).toBe(true);
      expect(err).toBeInstanceOf(DataUnavailableError);
      expect((err as Error).message).toContain('SOL-USD');
      expect((err as Error).message).toContain('2026-09-03T00:00:00.000Z');
      expect((err as Error).message).toContain('2026-09-10T00:00:00.000Z');
    }
  });

  it('never falls through to synthetic without allowSynthetic — and stamps it when allowed', async () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-bars-empty-'));
    const logger = makeLogger();
    const loader = new HistoricalDataLoader({ fixtureDir: emptyDir }, logger);
    const start = new Date('2026-09-03T00:00:00Z');
    const end = new Date('2026-09-04T00:00:00Z');

    // No Supabase client configured + no fixture → hard fail, zero candles produced.
    await expect(loader.loadCandles('ETH-USD', start, end, 900)).rejects.toBeInstanceOf(DataUnavailableError);

    const smoke = await loader.loadCandles('ETH-USD', start, end, 900, { allowSynthetic: true });
    expect(smoke.source).toBe('synthetic');
    expect(smoke.provenance.source).toBe('synthetic');
    expect(smoke.candles.length).toBe(97); // 24h of 15m bars, inclusive
    // The engine must surface this as a VOID run.
    const engine = new BacktestEngine(baseConfig({ products: ['ETH-USD'] }), makeLogger());
    await engine.loadHistoricalData(async () => smoke);
    const result = await engine.run();
    expect(result.dataStamp).toBe('SYNTHETIC');
    expect(result.dataProvenance['ETH-USD'].source).toBe('synthetic');
  });

  it('a fixture that does not cover the window is DATA_UNAVAILABLE (coverage floor)', async () => {
    const loader = new HistoricalDataLoader({ fixtureDir: FIXTURE_DIR }, makeLogger());
    // Fixture covers 2026-09-03..10; ask for a 30-day window → ~23% coverage < 50% floor.
    await expect(
      loader.loadCandles('BTC-USD', new Date('2026-08-11T00:00:00Z'), new Date('2026-09-10T00:00:00Z'), 900),
    ).rejects.toMatchObject({ code: 'DATA_UNAVAILABLE' });
    // Window entirely outside the fixture → zero bars → DATA_UNAVAILABLE even with minCoverage 0.
    await expect(
      loader.loadCandles('BTC-USD', new Date('2025-01-01T00:00:00Z'), new Date('2025-01-02T00:00:00Z'), 900, { minCoverage: 0 }),
    ).rejects.toMatchObject({ code: 'DATA_UNAVAILABLE' });
  });
});

describe('TASK_017 §6 — committed real fixtures (CI gate data source)', () => {
  it('loads BTC-USD and ETH-USD 15m fixtures with full coverage and REAL provenance', async () => {
    const loader = new HistoricalDataLoader({ fixtureDir: FIXTURE_DIR }, makeLogger());
    const start = new Date('2026-09-03T00:00:00Z');
    const end = new Date('2026-09-10T00:00:00Z');
    for (const symbol of ['BTC-USD', 'ETH-USD']) {
      const res = await loader.loadCandles(symbol, start, end, 900);
      expect(res.source).toBe('fixture');
      expect(res.candles.length).toBe(673);
      expect(res.provenance.coverage).toBeCloseTo(1, 6);
      expect(res.provenance.inferredBarMinutes).toBe(15);
      expect(res.provenance.fixtureSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(res.provenance.firstBarTime).toBe('2026-09-03T00:00:00.000Z');
      expect(res.provenance.lastBarTime).toBe('2026-09-10T00:00:00.000Z');
      // Strictly increasing, no duplicates, sane prices.
      for (let i = 1; i < res.candles.length; i++) {
        expect(res.candles[i].time).toBeGreaterThan(res.candles[i - 1].time);
      }
      expect(Math.min(...res.candles.map((c) => c.low))).toBeGreaterThan(0);
    }
    expect(inferBarMinutes(buildSyntheticCandles(10, 1, 900_000))).toBe(15);
  });

  it('fixture files declare real provenance metadata (not synthetic)', () => {
    for (const symbol of ['BTC-USD', 'ETH-USD']) {
      const file = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, `${symbol}.json`), 'utf8'));
      expect(file.symbol).toBe(symbol);
      expect(file.source).toBe('coinbase-advanced-trade-public');
      expect(file.granularitySeconds).toBe(900);
      expect(file.candles.length).toBe(673);
      expect(file.source).not.toMatch(/synthetic/i);
    }
  });
});

describe('TASK_017 §2 — spot is long-only by venue capability', () => {
  it('venue capability table: spot never shorts, perps may', () => {
    expect(venueForSymbol('BTC-USD')).toBe('spot');
    expect(venueForSymbol('ETH-PERP-INTX')).toBe('perps');
    expect(isShortingAllowed(true, 'spot')).toBe(false);
    expect(isShortingAllowed(true, 'perps')).toBe(true);
    expect(isShortingAllowed(false, 'perps')).toBe(false);
  });

  it('a spot run opens zero short positions even with allow_short=true; SELLs are exit-only', async () => {
    const engine = new BacktestEngine(
      baseConfig({ products: ['BTC-USD'], allowShort: true, evGate: { mode: 'off' } }),
      makeLogger(),
    );
    await engine.loadHistoricalData(async () => buildSyntheticCandles(400, 42));
    const result = await engine.run();

    expect(result.venueBySymbol['BTC-USD']).toBe('spot');
    expect(result.metrics.shortEntries).toBe(0);
    for (const trade of result.trades) {
      expect(trade.side).toBe('BUY');
      expect(trade.venue).toBe('spot');
    }
    // The strategies DID emit sells on this series — they were routed to
    // exit-only / blocked instead of opening shorts.
    expect(result.metrics.shortBlocked + result.metrics.sellSignalExits).toBeGreaterThan(0);
    expect(result.metrics.longEntries).toBe(result.metrics.totalTrades);
  });

  it('the same series on a perps venue is allowed to short (capability, not the flag, decides)', async () => {
    const engine = new BacktestEngine(
      baseConfig({ products: ['BTC-USD'], venueOverride: 'perps', allowShort: true, evGate: { mode: 'off' } }),
      makeLogger(),
    );
    await engine.loadHistoricalData(async () => buildSyntheticCandles(400, 42));
    const result = await engine.run();
    expect(result.venueBySymbol['BTC-USD']).toBe('perps');
    expect(result.metrics.shortBlocked).toBe(0);
    expect(result.metrics.shortEntries).toBeGreaterThan(0);
  });

  it('handleSignal drops a spot SELL with no position and closes an open long on SELL', () => {
    const engine = new BacktestEngine(baseConfig({ evGate: { mode: 'off' } }), makeLogger());
    const eng = engine as any;
    eng.initializeSignalProcessor();
    eng.currentBarTime = new Date('2024-01-01T00:00:00Z');

    eng.handleSignal(fakeSignal('sell', 100, 102, 95));
    expect(eng.positions.size).toBe(0);
    expect(eng.pendingFills.size).toBe(0);
    expect(eng.shortBlocked).toBe(1);

    eng.openPositionAt(fakeSignal('buy', 100, 98, 106), 100, new Date('2024-01-01T00:15:00Z'));
    expect(eng.positions.get('BTC-USD')?.side).toBe('long');

    eng.currentBarTime = new Date('2024-01-01T01:00:00Z');
    eng.handleSignal(fakeSignal('sell', 101, 103, 96));
    expect(eng.positions.size).toBe(0);
    expect(eng.sellSignalExits).toBe(1);
    const closed = eng.closedTrades[0];
    expect(closed.exitReason).toBe('signal');
    // Exit stamped on the BAR clock, not the signal's wall-clock timestamp (B5).
    expect(closed.exitTimestamp.toISOString()).toBe('2024-01-01T01:00:00.000Z');
    expect(closed.exitTimestamp.getTime()).toBeGreaterThanOrEqual(closed.timestamp.getTime());
  });
});

describe('TASK_017 §3 — EV gate in the backtest engine', () => {
  it('Beta-prior p estimator: p0 with no history, moves with outcomes', () => {
    expect(estimateWinRateWithPrior(null)).toBeCloseTo(0.40, 9);
    expect(DEFAULT_WIN_RATE_PRIOR).toEqual({ p0: 0.40, n0: 30 });
    // 30 wins / 0 losses: (30 + 12) / 60 = 0.70 — history counts, prior still anchors.
    expect(estimateWinRateWithPrior({ wins: 30, losses: 0 })).toBeCloseTo(0.70, 9);
    expect(estimateWinRateWithPrior({ wins: 0, losses: 30 })).toBeCloseTo(0.20, 9);
  });

  it('rejects a known negative-EV fixture at 120 bps and allows it at 0 bps', () => {
    // Fixture: entry 3000, stop 2985 (−0.5%), TP 3037.5 (+1.25%), size 0.5.
    // p = 0.40 (cold-start prior): EV(0 bps) = 0.4·18.75 − 0.6·7.5 = +$3.00.
    // Round trip at 120 bps taker = 2 · 0.012 · $1500 = $36 → EV = −$33.00.
    const signal = fakeSignal('buy', 3000, 2985, 3037.5);

    const strict = new BacktestEngine(baseConfig({ commission: 0.012, evGate: { mode: 'enforce' } }), makeLogger());
    (strict as any).initializeSignalProcessor();
    const rejected = (strict as any).evaluateEntryEv(signal, 3000, 2985, 3037.5, 0.5);
    expect(rejected.allowed).toBe(false);
    expect(rejected.record.ev).toBeCloseTo(-33, 6);
    expect(rejected.record.p).toBeCloseTo(0.4, 9);
    expect(rejected.record.feeUsd).toBeCloseTo(36, 6);
    expect((strict as any).evGateStats.rejected).toBe(1);
    expect((strict as any).evGateStats.rejectedByStrategy.momentum).toBe(1);

    const free = new BacktestEngine(baseConfig({ commission: 0, evGate: { mode: 'enforce' } }), makeLogger());
    (free as any).initializeSignalProcessor();
    const allowed = (free as any).evaluateEntryEv(signal, 3000, 2985, 3037.5, 0.5);
    expect(allowed.allowed).toBe(true);
    expect(allowed.record.ev).toBeCloseTo(3, 6);
    expect(allowed.record.feeUsd).toBe(0);
  });

  it('shadow mode allows the negative-EV entry but counts it; off mode does not evaluate', () => {
    const signal = fakeSignal('buy', 3000, 2985, 3037.5);
    const shadow = new BacktestEngine(baseConfig({ commission: 0.012, evGate: { mode: 'shadow' } }), makeLogger());
    (shadow as any).initializeSignalProcessor();
    const res = (shadow as any).evaluateEntryEv(signal, 3000, 2985, 3037.5, 0.5);
    expect(res.allowed).toBe(true);
    expect(res.record.shadowWouldReject).toBe(true);
    expect((shadow as any).evGateStats.shadowWouldReject).toBe(1);
    expect((shadow as any).evGateStats.rejected).toBe(0);

    const off = new BacktestEngine(baseConfig({ commission: 0.012, evGate: { mode: 'off' } }), makeLogger());
    (off as any).initializeSignalProcessor();
    expect((off as any).evaluateEntryEv(signal, 3000, 2985, 3037.5, 0.5)).toEqual({ allowed: true });
    expect((off as any).evGateStats.evaluated).toBe(0);
  });

  it('end-to-end: enforce at 120 bps opens no more trades than at 0 bps and reports rejects', async () => {
    const candles = buildSyntheticCandles(400, 7);
    const run = async (commission: number) => {
      const engine = new BacktestEngine(baseConfig({ commission, evGate: { mode: 'enforce' } }), makeLogger());
      await engine.loadHistoricalData(async () => candles);
      return engine.run();
    };
    const expensive = await run(0.012);
    const free = await run(0);
    expect(expensive.metrics.evGate.mode).toBe('enforce');
    expect(expensive.metrics.evGate.rejected).toBeGreaterThan(0);
    expect(free.metrics.evGate.rejected).toBe(0);
    expect(expensive.metrics.totalTrades).toBeLessThanOrEqual(free.metrics.totalTrades);
  });
});

describe('TASK_017 §4/§5 — equity-based sizing and hold time', () => {
  it('sizes the next trade from current cash equity after a loss', () => {
    const engine = new BacktestEngine(baseConfig({ commission: 0.001, evGate: { mode: 'off' } }), makeLogger());
    const eng = engine as any;
    eng.initializeSignalProcessor();

    const t0 = new Date('2024-01-01T00:00:00Z');
    eng.openPositionAt(fakeSignal('buy', 100, 98, 106), 100, t0);
    const first = eng.positions.get('BTC-USD');
    expect(first).toBeDefined();
    expect(first.trades[0].equityAtEntry).toBe(10_000);
    const expectedFirst = computeRiskBasedSize({
      equity: 10_000, riskPerTrade: 0.005, entryPrice: 100, stopPrice: 98,
      maxPositionExposureUsd: Math.min(10_000 * 0.30, 3_000), minNotionalUsd: 10_000 * 0.005 * 1.1, sizeDecimals: 6,
    }).size;
    expect(first.size).toBeCloseTo(expectedFirst, 6);

    // Lose: close at 90.
    eng.closePosition('BTC-USD', 90, new Date('2024-01-01T02:00:00Z'), 'signal');
    const capitalAfterLoss = eng.capital;
    expect(capitalAfterLoss).toBeLessThan(10_000);

    eng.openPositionAt(fakeSignal('buy', 100, 98, 106), 100, new Date('2024-01-01T03:00:00Z'));
    const second = eng.positions.get('BTC-USD');
    expect(second.trades[0].equityAtEntry).toBeCloseTo(capitalAfterLoss, 9);
    const expectedSecond = computeRiskBasedSize({
      equity: capitalAfterLoss, riskPerTrade: 0.005, entryPrice: 100, stopPrice: 98,
      maxPositionExposureUsd: Math.min(capitalAfterLoss * 0.30, 3_000), minNotionalUsd: capitalAfterLoss * 0.005 * 1.1, sizeDecimals: 6,
    }).size;
    expect(second.size).toBeCloseTo(expectedSecond, 6);
    expect(second.size).toBeLessThan(first.size);
    // Static account.equityUsd is NOT what sizing used.
    expect(second.size * 2).toBeLessThan(10_000 * 0.005);
  });

  it('hold time is bar-clock based and non-negative on a full run', async () => {
    const engine = new BacktestEngine(baseConfig({ evGate: { mode: 'off' } }), makeLogger());
    await engine.loadHistoricalData(async () => buildSyntheticCandles(400, 42));
    const result = await engine.run();
    expect(result.metrics.totalTrades).toBeGreaterThan(0);
    expect(result.metrics.averageHoldTime).toBeGreaterThanOrEqual(0);
    for (const t of result.trades) {
      expect(t.exitTimestamp!.getTime()).toBeGreaterThanOrEqual(t.timestamp.getTime());
      // Entry stamps come from the bar timeline (2023-11), never the plugin's wall clock.
      expect(t.timestamp.getTime()).toBeLessThan(new Date('2024-06-01T00:00:00Z').getTime());
    }
  });

  it('multi-product series are aligned by timestamp, not array index', async () => {
    // Second product starts 100 bars later — index alignment would pair
    // bars from different times and truncate the first product.
    const a = buildSyntheticCandles(300, 3);
    const b = buildSyntheticCandles(300, 5).slice(100);
    const engine = new BacktestEngine(baseConfig({ products: ['BTC-USD', 'ETH-USD'], evGate: { mode: 'off' } }), makeLogger());
    await engine.loadHistoricalData(async (product) => (product === 'BTC-USD' ? a : b));
    const result = await engine.run();
    // Equity curve spans the union timeline (300 unique bar times).
    expect(result.equityCurve.length).toBe(300);
    expect(result.equityCurve[0].timestamp.getTime()).toBe(a[0].time);
    expect(result.equityCurve[299].timestamp.getTime()).toBe(a[299].time);
  });
});
