/**
 * G1/G3/G5 exit-parity infra (2026-09-10) — backtest engine wiring of the two
 * guardrails exit knobs that were dead for the backtest (TASK_017 B7):
 *
 *   G1  `execution.trailAtrMultiplier` / `execution.timeStopBars` fire in the
 *       bar loop (guardrails `strategy.stop_trail_atr` / `time_stop_bars`).
 *   G3  The trail is a REAL ATR trail: distance = multiplier × entry ATR,
 *       ratcheting from the high-water mark — not the live file's
 *       `highWaterMark × 0.01` approximation.
 *   G5  Exits carry the live `PositionMonitor` labels (`trailing_stop`,
 *       `time_stop`) and reports print an exit-reason breakdown.
 *
 * Infra only — NOT an E5 GO: `pnpm backtest` keeps the rules OFF unless
 * `--exit-parity on`, and the shared config builder leaves `execution`
 * untouched unless `applyExitParity` is set.
 */
import { describe, it, expect, vi } from 'vitest';
import path from 'node:path';
import { BacktestEngine, type BacktestConfig, type BacktestResult } from '../backtesting/backtest-engine';
import { BacktestRunner, describeExitReasons, describeExitRules } from '../backtesting/backtest-runner';
import { buildBacktestConfig, buildFeeModel, resolveFeeTier } from '../backtesting/backtest-cli-config';
import {
  BACKTEST_EXIT_REASONS,
  LIVE_MONITOR_EXIT_TYPES,
  isMarketExit,
  type BacktestExitReason,
  type LiveMonitorExitType,
} from '../backtesting/exit-reasons';
import { loadGuardrails, type GuardrailConfig } from '../config/loadGuardrails';
import { PositionMonitor, type PositionExitCondition } from '../trading/position-monitor';
import { PositionTracker, type Position } from '../trading/position-tracker';
import type { Signal } from '../strategies/signal-processor';
import type { OHLCV } from '../indicators/technical';

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          single: () => Promise.resolve({ data: null, error: null }),
          maybeSingle: () => Promise.resolve({ data: null, error: null }),
        }),
      }),
      insert: () => Promise.resolve({ error: null }),
      upsert: () => Promise.resolve({ error: null }),
    }),
  }),
}));

function makeLogger() {
  return { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as any;
}

/**
 * Zero slippage / zero overshoot so exit prices land exactly on the level
 * under test. Sizing: $10k × 0.5% = $50 risk / $25 stop distance = 2 units.
 */
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
    realism: {
      nextBarFill: true,
      entrySlippageBps: 0,
      stopOvershootBarRangePct: 0,
      stopOvershootMinBps: 0,
      sizeDecimals: 6,
    },
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

const T0 = Date.UTC(2024, 0, 1, 0, 0);
const BAR_MS = 15 * 60_000;
const t = (i: number) => T0 + i * BAR_MS;

function bar(time: number, open: number, high: number, low: number, close: number): OHLCV {
  return { time, open, high, low, close, volume: 1 };
}

/** Engine with the signal processor initialised and a long opened at `entry` on bar 10. */
function openLong(config: BacktestConfig, sig: Signal, entry = 1000) {
  const engine = new BacktestEngine(config, makeLogger());
  const eng = engine as any;
  eng.initializeSignalProcessor();
  eng.barIndex = 10;
  eng.currentBarTime = new Date(t(10));
  eng.openPositionAt(sig, entry, eng.currentBarTime);
  expect(eng.positions.size).toBe(1);
  return { engine, eng, position: eng.positions.get('BTC-USD') };
}

const LONG = () => signal('buy', 1000, 975, 1060, 10); // stop 2.5 × ATR, TP 6 × ATR, ATR 10

describe('G3 — ATR trailing stop (multiplier × entry ATR, not HWM × 0.01)', () => {
  it('arms on the first HWM improvement at HWM − mult × ATR and exits at that level with label trailing_stop', () => {
    const { eng, position } = openLong(cfg({ execution: { trailAtrMultiplier: 1.0 } }), LONG());
    expect(position.highWaterMark).toBe(1000);
    expect(position.trailingStop).toBeNull();
    expect(position.entryAtr).toBe(10);

    // Bar A rallies to 1030: HWM 1030, trail = 1030 − 1.0 × 10 = 1020.
    // The live file's approximation would put it at 1030 × 0.99 = 1019.7.
    eng.checkExitConditions('BTC-USD', bar(t(11), 1000, 1030, 995, 1025), new Date(t(11)));
    expect(eng.positions.size).toBe(1);
    expect(position.highWaterMark).toBe(1030);
    expect(position.trailingStop).toBe(1020);

    // Bar B: low 1019.8 crosses the ATR trail (1020) but NOT a 1%-of-HWM stop (1019.7).
    eng.checkExitConditions('BTC-USD', bar(t(12), 1024, 1028, 1019.8, 1022), new Date(t(12)));
    expect(eng.positions.size).toBe(0);
    const trade = eng.closedTrades[0];
    expect(trade.exitReason).toBe('trailing_stop');
    expect(trade.exitPrice).toBe(1020);
    expect(1030 - trade.exitPrice).toBe(10); // exactly mult × ATR behind the HWM
    expect(trade.stopLoss).toBe(975); // hard stop geometry untouched
    expect(trade.exitTimestamp.getTime()).toBe(t(12));
    expect(trade.pnl).toBeCloseTo((1020 - 1000) * 2, 6);
  });

  it('ratchets only in the favourable direction and never loosens', () => {
    const { eng, position } = openLong(cfg({ execution: { trailAtrMultiplier: 1.0 } }), LONG());
    eng.checkExitConditions('BTC-USD', bar(t(11), 1000, 1030, 995, 1025), new Date(t(11)));
    expect(position.trailingStop).toBe(1020);

    // Lower high, low above the trail: nothing moves.
    eng.checkExitConditions('BTC-USD', bar(t(12), 1025, 1027, 1021, 1022), new Date(t(12)));
    expect(eng.positions.size).toBe(1);
    expect(position.highWaterMark).toBe(1030);
    expect(position.trailingStop).toBe(1020);

    // New high 1050: trail ratchets to 1040 (the low 1021 was checked against 1020 first).
    eng.checkExitConditions('BTC-USD', bar(t(13), 1022, 1050, 1021, 1045), new Date(t(13)));
    expect(eng.positions.size).toBe(1);
    expect(position.trailingStop).toBe(1040);

    eng.checkExitConditions('BTC-USD', bar(t(14), 1044, 1046, 1039, 1040), new Date(t(14)));
    expect(eng.positions.size).toBe(0);
    expect(eng.closedTrades[0].exitReason).toBe('trailing_stop');
    expect(eng.closedTrades[0].exitPrice).toBe(1040);
  });

  it('mirrors for shorts: HWM is the lowest low, trail sits mult × ATR above it', () => {
    const { eng, position } = openLong(
      cfg({ execution: { trailAtrMultiplier: 1.0 }, venueOverride: 'perps' }),
      signal('sell', 1000, 1025, 940, 10),
    );
    expect(position.side).toBe('short');
    eng.checkExitConditions('BTC-USD', bar(t(11), 1000, 1005, 970, 975), new Date(t(11)));
    expect(eng.positions.size).toBe(1);
    expect(position.highWaterMark).toBe(970);
    expect(position.trailingStop).toBe(980);

    eng.checkExitConditions('BTC-USD', bar(t(12), 978, 980.2, 972, 979), new Date(t(12)));
    expect(eng.positions.size).toBe(0);
    const trade = eng.closedTrades[0];
    expect(trade.exitReason).toBe('trailing_stop');
    expect(trade.exitPrice).toBe(980);
    expect(trade.pnl).toBeCloseTo((1000 - 980) * 2, 6);
  });

  it('keeps the stop_loss label when the trail is not armed or the hard stop is the binding level', () => {
    // Not armed: no bar improved the HWM before the hard stop was hit.
    const a = openLong(cfg({ execution: { trailAtrMultiplier: 1.0 } }), LONG());
    a.eng.checkExitConditions('BTC-USD', bar(t(11), 1000, 1000, 970, 972), new Date(t(11)));
    expect(a.eng.closedTrades[0].exitReason).toBe('stop_loss');
    expect(a.eng.closedTrades[0].exitPrice).toBe(975);

    // Armed but looser than the hard stop (10 × ATR = 100 below the HWM): the hard stop binds.
    const b = openLong(cfg({ execution: { trailAtrMultiplier: 10 } }), LONG());
    b.eng.checkExitConditions('BTC-USD', bar(t(11), 1000, 1030, 995, 1025), new Date(t(11)));
    expect(b.position.trailingStop).toBe(930);
    b.eng.checkExitConditions('BTC-USD', bar(t(12), 1020, 1025, 970, 980), new Date(t(12)));
    expect(b.eng.closedTrades[0].exitReason).toBe('stop_loss');
    expect(b.eng.closedTrades[0].exitPrice).toBe(975);
  });

  it('caps a gap-through trigger at the bar open and applies the stop overshoot model to it', () => {
    const { eng } = openLong(
      cfg({
        execution: { trailAtrMultiplier: 1.0 },
        realism: { nextBarFill: true, entrySlippageBps: 0, stopOvershootBarRangePct: 0.2, stopOvershootMinBps: 0, sizeDecimals: 6 },
      }),
      LONG(),
    );
    eng.checkExitConditions('BTC-USD', bar(t(11), 1000, 1030, 995, 1025), new Date(t(11)));
    expect(eng.positions.get('BTC-USD').trailingStop).toBe(1020);

    // Opens at 1012, already through the stale 1020 trail: trigger = 1012, overshoot = 0.2 × (1015 − 1008).
    eng.checkExitConditions('BTC-USD', bar(t(12), 1012, 1015, 1008, 1010), new Date(t(12)));
    const trade = eng.closedTrades[0];
    expect(trade.exitReason).toBe('trailing_stop');
    expect(trade.exitPrice).toBeCloseTo(1012 - 0.2 * 7, 9);
  });

  it('never arms when the entry signal carries no usable ATR, and counts it', () => {
    const { engine, eng, position } = openLong(cfg({ execution: { trailAtrMultiplier: 1.0 } }), signal('buy', 1000, 975, 1060));
    expect(position.entryAtr).toBeNull();
    expect(eng.trailUnavailableNoAtr).toBe(1);

    eng.checkExitConditions('BTC-USD', bar(t(11), 1000, 1030, 995, 1025), new Date(t(11)));
    expect(position.highWaterMark).toBe(1030);
    expect(position.trailingStop).toBeNull();
    eng.checkExitConditions('BTC-USD', bar(t(12), 1024, 1028, 1015, 1022), new Date(t(12)));
    expect(eng.positions.size).toBe(1); // only the 975 hard stop protects this trade

    const metrics = engine['calculateMetrics']();
    expect(metrics.exitRules).toEqual({ trailAtrMultiplier: 1, timeStopBars: null, trailUnavailableNoAtr: 1 });
  });

  it('is OFF by default: the same bars leave the position open and no trail is ever set', () => {
    const { engine, eng, position } = openLong(cfg(), LONG());
    eng.checkExitConditions('BTC-USD', bar(t(11), 1000, 1030, 995, 1025), new Date(t(11)));
    eng.checkExitConditions('BTC-USD', bar(t(12), 1024, 1028, 1019.8, 1022), new Date(t(12)));
    expect(eng.positions.size).toBe(1);
    expect(position.trailingStop).toBeNull();
    expect(engine['calculateMetrics']().exitRules).toEqual({ trailAtrMultiplier: null, timeStopBars: null, trailUnavailableNoAtr: 0 });
  });
});

describe('G1 — time stop (completed bars of the symbol, entry bar included)', () => {
  const flat = (i: number) => bar(t(i), 1000, 1005, 998, 1002);

  it('exits at the close of the N-th completed bar with label time_stop (market exit, symmetric slippage)', () => {
    const { eng, position } = openLong(
      cfg({ execution: { timeStopBars: 3 }, realism: { nextBarFill: true, entrySlippageBps: 5, stopOvershootBarRangePct: 0, stopOvershootMinBps: 0, sizeDecimals: 6 } }),
      LONG(),
    );
    eng.checkExitConditions('BTC-USD', flat(10), new Date(t(10))); // entry bar completes → 1
    expect(position.barsInTrade).toBe(1);
    eng.checkExitConditions('BTC-USD', flat(11), new Date(t(11))); // 2
    expect(eng.positions.size).toBe(1);
    eng.checkExitConditions('BTC-USD', flat(12), new Date(t(12))); // 3 ≥ 3 → exit
    expect(eng.positions.size).toBe(0);

    const trade = eng.closedTrades[0];
    expect(trade.exitReason).toBe('time_stop');
    expect(trade.exitTimestamp.getTime()).toBe(t(12));
    expect(trade.exitPrice).toBeCloseTo(1002 * (1 - 5 / 10_000), 9); // close, long pays 5 bps
  });

  it('is OFF by default: 200 flat bars leave the position open', () => {
    const { eng } = openLong(cfg(), LONG());
    for (let i = 10; i < 210; i++) eng.checkExitConditions('BTC-USD', flat(i), new Date(t(i)));
    expect(eng.positions.size).toBe(1);
    expect(eng.positions.get('BTC-USD').barsInTrade).toBe(200);
  });

  it('bypasses execution.minHoldBars exactly like stops do', () => {
    const { engine, eng } = openLong(cfg({ execution: { timeStopBars: 1, minHoldBars: 5 } }), LONG());
    eng.checkExitConditions('BTC-USD', flat(10), new Date(t(10)));
    expect(eng.positions.size).toBe(0);
    expect(eng.closedTrades[0].exitReason).toBe('time_stop');
    expect(engine['calculateMetrics']().exitsIgnoredMinHold).toBe(0);
  });

  it('ranks below intrabar stop / take-profit on the same bar (live check order)', () => {
    const a = openLong(cfg({ execution: { timeStopBars: 1 } }), LONG());
    a.eng.checkExitConditions('BTC-USD', bar(t(10), 1000, 1005, 970, 1002), new Date(t(10)));
    expect(a.eng.closedTrades[0].exitReason).toBe('stop_loss');

    const b = openLong(cfg({ execution: { timeStopBars: 1 } }), LONG());
    b.eng.checkExitConditions('BTC-USD', bar(t(10), 1000, 1065, 998, 1050), new Date(t(10)));
    expect(b.eng.closedTrades[0].exitReason).toBe('take_profit');
  });
});

describe('G1/G3 — through the bar loop (processTimeSteps on fixture candles)', () => {
  /** Ten 15m bars; a buy is injected at bar 1's close so it fills at bar 2's open. */
  async function runWith(config: BacktestConfig, candles: OHLCV[]): Promise<{ result: BacktestResult; eng: any }> {
    const engine = new BacktestEngine(config, makeLogger());
    const eng = engine as any;
    await engine.loadHistoricalData(async () => candles);
    eng.initializeSignalProcessor();
    const processor = engine.getSignalProcessor()!;
    vi.spyOn(processor, 'addCandle').mockImplementation((_symbol: string, candle: OHLCV) => {
      if (candle.time === candles[1].time) {
        processor.emit('signal:generated', signal('buy', candle.close, candle.close - 25, candle.close + 60, 10));
      }
    });
    await eng.processTimeSteps();
    eng.closeAllPositions('end_of_data');
    const metrics = eng.calculateMetrics();
    const result = { config, trades: eng.closedTrades, metrics } as unknown as BacktestResult;
    return { result, eng };
  }

  const trailCandles: OHLCV[] = [
    bar(t(0), 1000, 1002, 998, 1000),
    bar(t(1), 1000, 1002, 998, 1000), // signal here → pending fill
    bar(t(2), 1000, 1030, 995, 1025), // fill @1000 open; HWM 1030 → trail 1020
    bar(t(3), 1024, 1050, 1021, 1045), // low 1021 > 1020; HWM 1050 → trail 1040
    bar(t(4), 1044, 1046, 1039, 1040), // low 1039 ≤ 1040 → trailing_stop @1040
    bar(t(5), 1040, 1041, 1039, 1040),
    bar(t(6), 1040, 1041, 1039, 1040),
    bar(t(7), 1040, 1041, 1039, 1040),
    bar(t(8), 1040, 1041, 1039, 1040),
    bar(t(9), 1040, 1041, 1039, 1040),
  ];

  it('ATR trail: fills next-bar open, ratchets across bars, exits trailing_stop; metrics carry the breakdown', async () => {
    const { result } = await runWith(cfg({ execution: { trailAtrMultiplier: 1.0, timeStopBars: 96 } }), trailCandles);
    expect(result.trades).toHaveLength(1);
    const trade = result.trades[0];
    expect(trade.entryPrice).toBe(1000);
    expect(trade.timestamp.getTime()).toBe(t(2));
    expect(trade.exitReason).toBe('trailing_stop');
    expect(trade.exitPrice).toBe(1040);
    expect(trade.exitTimestamp!.getTime()).toBe(t(4));
    expect(trade.pnl).toBeCloseTo(40 * 2, 6);

    expect(result.metrics.exitReasons).toEqual({
      stop_loss: 0, take_profit: 0, trailing_stop: 1, time_stop: 0, signal: 0, end_of_data: 0,
    });
    expect(result.metrics.exitRules).toEqual({ trailAtrMultiplier: 1, timeStopBars: 96, trailUnavailableNoAtr: 0 });
    expect(result.metrics.averageHoldTime).toBe(30);
  });

  it('same candles with exit parity off: the trade rides to end_of_data (legacy behaviour preserved)', async () => {
    const { result } = await runWith(cfg(), trailCandles);
    expect(result.trades).toHaveLength(1);
    expect(result.trades[0].exitReason).toBe('end_of_data');
    expect(result.metrics.exitReasons.trailing_stop).toBe(0);
    expect(result.metrics.exitReasons.end_of_data).toBe(1);
  });

  it('time stop: exits at the close of the N-th completed bar after a next-bar-open fill', async () => {
    const flatCandles: OHLCV[] = Array.from({ length: 10 }, (_, i) => bar(t(i), 1000, 1003, 998, 1001));
    const { result } = await runWith(cfg({ execution: { timeStopBars: 3 } }), flatCandles);
    expect(result.trades).toHaveLength(1);
    const trade = result.trades[0];
    expect(trade.timestamp.getTime()).toBe(t(2)); // fill bar
    expect(trade.exitReason).toBe('time_stop');
    expect(trade.exitTimestamp!.getTime()).toBe(t(4)); // bars 2, 3, 4 completed
    expect(trade.exitPrice).toBe(1001);
    expect(result.metrics.exitReasons.time_stop).toBe(1);
    expect(result.metrics.averageHoldTime).toBe(30);
  });

  it('reports print the exit rules and a zero-filled by-reason breakdown', async () => {
    const { result } = await runWith(cfg({ execution: { trailAtrMultiplier: 1.0, timeStopBars: 96 } }), trailCandles);
    const full: BacktestResult = {
      ...result,
      equityCurve: [],
      dailyReturns: [],
      dataProvenance: {},
      dataStamp: 'REAL',
      venueBySymbol: { 'BTC-USD': 'spot' },
      regimeGate: { enabled: true, minCompatibilityScore: 0.5, minRegimeConfidence: 0.5, requireMTFAlignment: false },
      fees: { routing: 'flat-override', flatRate: 0, perVenue: {}, exchange: 'coinbase' },
    };
    const report = new BacktestRunner({ resultsPath: '/tmp/unused' }, makeLogger()).generateReport(full);
    expect(report).toContain('Exits:');
    expect(report).toContain('Rules: hard stop + take profit (signal geometry); ATR trail 1 × entry ATR; time stop 96 bars; opposite-signal exits on');
    expect(report).toContain('By reason: stop_loss=0, take_profit=0, trailing_stop=1, time_stop=0, signal=0, end_of_data=0');
    expect(report).toContain('[trailing_stop]'); // trade log line

    expect(describeExitRules(undefined)).toBe('hard stop + take profit (signal geometry); ATR trail off; time stop off; opposite-signal exits on');
    expect(describeExitRules({ trailAtrMultiplier: 1, timeStopBars: 96, trailUnavailableNoAtr: 2 })).toContain('(2 entries without ATR → no trail)');
    expect(describeExitReasons({ time_stop: 3 })).toBe('stop_loss=0, take_profit=0, trailing_stop=0, time_stop=3, signal=0, end_of_data=0');
  });
});

describe('G5 — exit labels are the live PositionMonitor vocabulary', () => {
  it('backtest label set = live monitor types + backtest-only signal/end_of_data; time_stop is a market exit, trailing_stop is not', () => {
    expect([...LIVE_MONITOR_EXIT_TYPES]).toEqual(['stop_loss', 'take_profit', 'trailing_stop', 'time_stop']);
    expect([...BACKTEST_EXIT_REASONS]).toEqual(['stop_loss', 'take_profit', 'trailing_stop', 'time_stop', 'signal', 'end_of_data']);
    expect(isMarketExit('time_stop')).toBe(true);
    expect(isMarketExit('signal')).toBe(true);
    expect(isMarketExit('end_of_data')).toBe(true);
    expect(isMarketExit('trailing_stop')).toBe(false);
    expect(isMarketExit('stop_loss')).toBe(false);
    expect(isMarketExit('take_profit')).toBe(false);
    // Type-level tie: a live type is assignable to the backtest union and vice versa for monitor labels.
    const live: LiveMonitorExitType = 'trailing_stop';
    const bt: BacktestExitReason = live;
    expect(bt).toBe('trailing_stop');
  });

  it('the strings the engine stamps are exactly what a live PositionMonitor emits for the same rules', async () => {
    const guardrails = {
      strategy: {
        mode: 'momentum_futures', donchian_len: 20, ema_len_1h: 100, atr_len_15m: 20, atr_entry_band: [0.005, 0.025],
        stop_init_atr: 1.5, stop_trail_atr: 1.0, time_stop_bars: 3, allow_short: true, trade_cooldown_min: 15,
      },
    } as unknown as GuardrailConfig;
    const tracker = new PositionTracker({
      supabaseUrl: 'http://localhost:54321', supabaseKey: 'test-key', updateInterval: 5000, pnlCalculationMethod: 'fifo',
      maxPositionValueUsd: 5000, maxUnrealizedLossUsd: 500, drawdownWarningPct: 5, drawdownCriticalPct: 10,
    }, makeLogger());
    const position: Position = {
      id: 'pos-1', symbol: 'BTC-USD', side: 'long', size: 0.1, averagePrice: 50_000, marketPrice: 50_000,
      unrealizedPnL: 0, realizedPnL: 0, totalPnL: 0, openTime: new Date(), lastUpdateTime: new Date(), trades: [], maxSize: 0.1, maxDrawdown: 0,
    };
    vi.spyOn(tracker, 'getPosition').mockReturnValue(position);

    const liveLabels: LiveMonitorExitType[] = [];
    const drive = async (setup: (m: PositionMonitor) => void): Promise<void> => {
      const monitor = new PositionMonitor({ guardrails, checkIntervalMs: 10 }, makeLogger(), tracker);
      const seen: PositionExitCondition[] = [];
      monitor.on('exit:triggered', (c) => seen.push(c));
      monitor.registerPosition(position, 49_000, 55_000);
      monitor.start();
      setup(monitor);
      await new Promise((r) => setTimeout(r, 60));
      monitor.stop();
      expect(seen.length).toBeGreaterThan(0);
      liveLabels.push(seen[0].type);
    };
    try {
      // Live trail: HWM 51,000 → 51,000 × 0.99 = 50,490; 50,400 crosses it, not the 49,000 stop.
      await drive((m) => { m.updatePrice('BTC-USD', 51_000); m.updatePrice('BTC-USD', 50_400); });
      // Live time stop: 3 completed bars at time_stop_bars = 3.
      await drive((m) => { m.updatePrice('BTC-USD', 50_500); for (let i = 0; i < 3; i++) m.incrementBarCount('BTC-USD'); });
    } finally {
      tracker.stopUpdateLoop();
    }

    // Backtest: the same two rules on the engine.
    const trail = openLong(cfg({ execution: { trailAtrMultiplier: 1.0 } }), LONG());
    trail.eng.checkExitConditions('BTC-USD', bar(t(11), 1000, 1030, 995, 1025), new Date(t(11)));
    trail.eng.checkExitConditions('BTC-USD', bar(t(12), 1024, 1028, 1019.8, 1022), new Date(t(12)));
    const time = openLong(cfg({ execution: { timeStopBars: 3 } }), LONG());
    for (let i = 10; i < 13; i++) time.eng.checkExitConditions('BTC-USD', bar(t(i), 1000, 1005, 998, 1002), new Date(t(i)));

    const backtestLabels = [trail.eng.closedTrades[0].exitReason, time.eng.closedTrades[0].exitReason];
    expect(liveLabels).toEqual(['trailing_stop', 'time_stop']);
    expect(backtestLabels).toEqual(liveLabels);
    for (const label of backtestLabels) expect(LIVE_MONITOR_EXIT_TYPES).toContain(label);
  });
});

describe('shared CLI config builder — guardrails knobs behind applyExitParity (default off)', () => {
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

  it('leaves execution undefined by default (E1/E2 cards unchanged) and wires stop_trail_atr / time_stop_bars when asked', () => {
    expect(buildBacktestConfig(base, guardrails).execution).toBeUndefined();
    expect(buildBacktestConfig({ ...base, applyExitParity: false }, guardrails).execution).toBeUndefined();

    const on = buildBacktestConfig({ ...base, applyExitParity: true }, guardrails);
    expect(on.execution).toEqual({
      trailAtrMultiplier: guardrails.strategy.stop_trail_atr,
      timeStopBars: guardrails.strategy.time_stop_bars,
    });
    expect(on.execution).toEqual({ trailAtrMultiplier: 1.0, timeStopBars: 96 }); // SoT values today

    expect(buildBacktestConfig({ ...base, applyExitParity: true, minHoldBars: 1 }, guardrails).execution).toEqual({
      minHoldBars: 1,
      trailAtrMultiplier: 1.0,
      timeStopBars: 96,
    });
    expect(buildBacktestConfig({ ...base, minHoldBars: 1 }, guardrails).execution).toEqual({ minHoldBars: 1 });
  });

  it('the engine reads the wired knobs into its exit rules', () => {
    const engine = new BacktestEngine(buildBacktestConfig({ ...base, applyExitParity: true }, guardrails), makeLogger());
    expect(engine['describeExitRules']()).toEqual({ trailAtrMultiplier: 1.0, timeStopBars: 96, trailUnavailableNoAtr: 0 });
  });
});
