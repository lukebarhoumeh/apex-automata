import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { TradeAnalytics, TradeAnalyticsConfig } from '../trading/trade-analytics';
import type { Logger } from '../core/logger';

// Mock logger
const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

// Mock Supabase client
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

describe('TradeAnalytics', () => {
  let analytics: TradeAnalytics;

  const config: TradeAnalyticsConfig = {
    supabaseUrl: 'http://localhost:54321',
    supabaseKey: 'test-key',
    userId: 'test-user',
    initialEquity: 10000,
    mode: 'paper',
    equitySampleIntervalMs: 60000,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    analytics = new TradeAnalytics(config, mockLogger as any);
  });

  afterEach(async () => {
    await analytics.stop();
  });

  test('initializes with correct session state', () => {
    const stats = analytics.getSessionStats();
    
    expect(stats.mode).toBe('paper');
    expect(stats.totalTrades).toBe(0);
    expect(stats.totalPnl).toBe(0);
    expect(stats.winRate).toBe(0);
    expect(stats.sessionId).toBeDefined();
  });

  test('records trade entry and exit with correct P&L', () => {
    // Record entry
    analytics.recordEntry({
      tradeId: 'trade-1',
      symbol: 'BTC-USD',
      side: 'long',
      entryPrice: 50000,
      size: 0.1,
      strategy: 'breakout',
      reasonCode: 'donchian_breakout',
    });

    let openTrades = analytics.getOpenTrades();
    expect(openTrades).toHaveLength(1);
    expect(openTrades[0].symbol).toBe('BTC-USD');
    expect(openTrades[0].side).toBe('long');

    // Record exit with profit
    analytics.recordExit({
      tradeId: 'trade-1',
      exitPrice: 51000,
      realizedPnl: 100, // 0.1 * (51000 - 50000) = 100
      fees: 2,
      exitReason: 'take_profit',
    });

    openTrades = analytics.getOpenTrades();
    expect(openTrades).toHaveLength(0);

    const stats = analytics.getSessionStats();
    expect(stats.totalTrades).toBe(1);
    expect(stats.winningTrades).toBe(1);
    expect(stats.losingTrades).toBe(0);
    expect(stats.winRate).toBe(1);
    expect(stats.totalPnl).toBe(100);
    expect(stats.grossProfit).toBe(100);
    expect(stats.grossLoss).toBe(0);
  });

  test('calculates win rate and profit factor correctly', () => {
    // Win: +100
    analytics.recordEntry({
      tradeId: 'trade-1',
      symbol: 'BTC-USD',
      side: 'long',
      entryPrice: 50000,
      size: 0.1,
    });
    analytics.recordExit({
      tradeId: 'trade-1',
      exitPrice: 51000,
      realizedPnl: 100,
      fees: 0,
    });

    // Loss: -50
    analytics.recordEntry({
      tradeId: 'trade-2',
      symbol: 'ETH-USD',
      side: 'long',
      entryPrice: 3000,
      size: 1,
    });
    analytics.recordExit({
      tradeId: 'trade-2',
      exitPrice: 2950,
      realizedPnl: -50,
      fees: 0,
    });

    // Win: +75
    analytics.recordEntry({
      tradeId: 'trade-3',
      symbol: 'BTC-USD',
      side: 'short',
      entryPrice: 50000,
      size: 0.15,
    });
    analytics.recordExit({
      tradeId: 'trade-3',
      exitPrice: 49500,
      realizedPnl: 75,
      fees: 0,
    });

    const stats = analytics.getSessionStats();
    
    expect(stats.totalTrades).toBe(3);
    expect(stats.winningTrades).toBe(2);
    expect(stats.losingTrades).toBe(1);
    expect(stats.winRate).toBeCloseTo(2/3, 4);
    expect(stats.grossProfit).toBe(175); // 100 + 75
    expect(stats.grossLoss).toBe(50);
    expect(stats.profitFactor).toBeCloseTo(3.5, 4); // 175 / 50
    expect(stats.totalPnl).toBe(125); // 100 - 50 + 75
  });

  test('tracks slippage in basis points', () => {
    // Entry with slippage (expected 50000, got 50010 = +2 bps unfavorable for long)
    analytics.recordEntry({
      tradeId: 'trade-1',
      symbol: 'BTC-USD',
      side: 'long',
      entryPrice: 50010,
      size: 0.1,
      expectedPrice: 50000,
    });

    const openTrades = analytics.getOpenTrades();
    expect(openTrades[0].slippageBps).toBeCloseTo(2, 1);
  });

  test('calculates average metrics correctly', () => {
    // Trade 1: Win +100, duration 60s
    analytics.recordEntry({
      tradeId: 'trade-1',
      symbol: 'BTC-USD',
      side: 'long',
      entryPrice: 50000,
      size: 0.1,
    });
    
    // Simulate time passing
    const trade1 = analytics.getOpenTrades()[0];
    (trade1 as any).entryTime = new Date(Date.now() - 60000);
    
    analytics.recordExit({
      tradeId: 'trade-1',
      exitPrice: 51000,
      realizedPnl: 100,
      fees: 0,
    });

    // Trade 2: Loss -50, duration 120s
    analytics.recordEntry({
      tradeId: 'trade-2',
      symbol: 'ETH-USD',
      side: 'long',
      entryPrice: 3000,
      size: 1,
    });
    
    const trade2 = analytics.getOpenTrades()[0];
    (trade2 as any).entryTime = new Date(Date.now() - 120000);
    
    analytics.recordExit({
      tradeId: 'trade-2',
      exitPrice: 2950,
      realizedPnl: -50,
      fees: 0,
    });

    const stats = analytics.getSessionStats();
    
    expect(stats.avgWin).toBe(100);
    expect(stats.avgLoss).toBe(50);
    expect(stats.avgTrade).toBe(25); // (100 - 50) / 2
    expect(stats.expectancy).toBeCloseTo(25, 4); // (0.5 * 100) - (0.5 * 50)
  });

  test('tracks equity curve and drawdown', () => {
    // Initial equity: 10000
    // Win +100 -> equity 10100
    analytics.recordEntry({
      tradeId: 'trade-1',
      symbol: 'BTC-USD',
      side: 'long',
      entryPrice: 50000,
      size: 0.1,
    });
    analytics.recordExit({
      tradeId: 'trade-1',
      exitPrice: 51000,
      realizedPnl: 100,
      fees: 0,
    });

    let stats = analytics.getSessionStats();
    expect(stats.highWaterMark).toBeCloseTo(10100, 0);

    // Loss -150 -> equity 9950, drawdown 150
    analytics.recordEntry({
      tradeId: 'trade-2',
      symbol: 'ETH-USD',
      side: 'long',
      entryPrice: 3000,
      size: 1,
    });
    analytics.recordExit({
      tradeId: 'trade-2',
      exitPrice: 2850,
      realizedPnl: -150,
      fees: 0,
    });

    stats = analytics.getSessionStats();
    expect(stats.maxDrawdown).toBeCloseTo(150, 0);
  });

  test('records order latency', () => {
    analytics.recordOrderLatency(25, 'market');
    analytics.recordOrderLatency(35, 'limit');
    analytics.recordOrderLatency(30, 'market');

    const stats = analytics.getSessionStats();
    expect(stats.avgOrderLatencyMs).toBe(30); // (25 + 35 + 30) / 3
  });

  test('returns recent trades in correct order', () => {
    for (let i = 1; i <= 5; i++) {
      analytics.recordEntry({
        tradeId: `trade-${i}`,
        symbol: 'BTC-USD',
        side: 'long',
        entryPrice: 50000 + i * 100,
        size: 0.1,
      });
      analytics.recordExit({
        tradeId: `trade-${i}`,
        exitPrice: 50000 + i * 100 + 50,
        realizedPnl: 5,
        fees: 0,
      });
    }

    const recentTrades = analytics.getRecentTrades(3);
    expect(recentTrades).toHaveLength(3);
    // Most recent trades (by array position, not necessarily time)
    expect(recentTrades[2].id).toBe('trade-5');
    expect(recentTrades[1].id).toBe('trade-4');
    expect(recentTrades[0].id).toBe('trade-3');
  });

  test('handles breakeven trades correctly', () => {
    analytics.recordEntry({
      tradeId: 'trade-1',
      symbol: 'BTC-USD',
      side: 'long',
      entryPrice: 50000,
      size: 0.1,
    });
    analytics.recordExit({
      tradeId: 'trade-1',
      exitPrice: 50000,
      realizedPnl: 0,
      fees: 0,
    });

    const stats = analytics.getSessionStats();
    expect(stats.totalTrades).toBe(1);
    expect(stats.breakEvenTrades).toBe(1);
    expect(stats.winningTrades).toBe(0);
    expect(stats.losingTrades).toBe(0);
  });

  test('getClosedTrades returns every closed trade oldest-first and does not expose internal state', () => {
    for (let i = 1; i <= 3; i++) {
      analytics.recordEntry({ tradeId: `trade-${i}`, symbol: 'ETH-USD', side: 'long', entryPrice: 2000, size: 1, strategy: 'momentum' });
      analytics.recordExit({ tradeId: `trade-${i}`, exitPrice: 2010, realizedPnl: 10, fees: 0 });
    }

    const closed = analytics.getClosedTrades();
    expect(closed.map((t) => t.id)).toEqual(['trade-1', 'trade-2', 'trade-3']);
    expect(closed.every((t) => t.strategy === 'momentum')).toBe(true);

    closed.pop();
    expect(analytics.getClosedTrades()).toHaveLength(3);
  });

  test('carried-over entry: real entryTime drives duration, counted in totals and carriedOverClosed; re-seed is idempotent', () => {
    const openedAt = new Date(Date.now() - 3_600_000);
    const seed = { tradeId: 'carried-1', symbol: 'ETH-USD', side: 'long' as const, entryPrice: 2000, size: 1, strategy: 'trend_follow', entryTime: openedAt, carriedOver: true };
    analytics.recordEntry(seed);
    analytics.recordEntry(seed);
    expect(analytics.getOpenTrades()).toHaveLength(1);
    expect(analytics.getSessionStats()).toMatchObject({ carriedOverOpen: 1, carriedOverClosed: 0, totalTrades: 0 });

    analytics.recordExit({ tradeId: 'carried-1', exitPrice: 2010, realizedPnl: 10, fees: 0 });
    const [closed] = analytics.getClosedTrades();
    expect(closed.carriedOver).toBe(true);
    expect(closed.entryTime).toBe(openedAt);
    expect(closed.duration).toBeGreaterThanOrEqual(3600);
    expect(analytics.getSessionStats()).toMatchObject({ totalTrades: 1, carriedOverClosed: 1, carriedOverOpen: 0, winningTrades: 1 });
  });

  test('an exit with no entry at all still warns and is not counted', () => {
    analytics.recordExit({ tradeId: 'ghost', exitPrice: 1, realizedPnl: 1, fees: 0 });
    expect(mockLogger.warn).toHaveBeenCalledWith('Trade not found for exit', { tradeId: 'ghost' });
    expect(analytics.getSessionStats().totalTrades).toBe(0);
  });

  test('strategy / signalId backfill fills only missing attribution on an open record', () => {
    analytics.recordEntry({ tradeId: 'carried-2', symbol: 'BTC-USD', side: 'long', entryPrice: 50000, size: 0.1, carriedOver: true });
    analytics.backfillAttribution('carried-2', { strategy: 'trend_follow', signalId: 'sig-1' });
    analytics.backfillAttribution('carried-2', { strategy: 'momentum', signalId: 'sig-2' });
    expect(analytics.getOpenTrades()[0]).toMatchObject({ strategy: 'trend_follow', signalId: 'sig-1' });
    analytics.backfillAttribution('unknown-id', { strategy: 'trend_follow' });
  });
});

/**
 * Review round (carryover repair, finding "live equity double count"): in live,
 * `initialEquity` is the account snapshot, which already marks a carried-over
 * position at the snapshot mark and holds its prior-session realized P&L. The
 * equity curve / HWM / maxDrawdown must only move by the in-session part of
 * that round trip; closedTrades / totalPnl keep the full round trip (desk
 * decision 2026-09-30). Paper (no marks: yaml constant) is unchanged.
 */
describe('TradeAnalytics — carried-over equity anchor (live snapshot marks)', () => {
  const liveConfig: TradeAnalyticsConfig = {
    supabaseUrl: 'http://localhost:54321',
    supabaseKey: 'test-key',
    userId: 'test-user',
    initialEquity: 10000,
    mode: 'live',
    equitySampleIntervalMs: 60000,
    initialEquityMarks: { 'BTC-USD': 52000 },
  };
  const seed = {
    tradeId: 'carried-live',
    symbol: 'BTC-USD',
    side: 'long' as const,
    entryPrice: 50000,
    size: 0.1,
    entryTime: new Date(Date.now() - 3_600_000),
    carriedOver: true,
  };
  let analytics: TradeAnalytics;

  afterEach(async () => {
    await analytics.stop();
  });

  test('closed at the snapshot mark: full round trip counted, equity / HWM / maxDrawdown do not move', () => {
    analytics = new TradeAnalytics(liveConfig, mockLogger as unknown as Logger);
    analytics.recordEntry(seed);
    analytics.recordExit({ tradeId: 'carried-live', exitPrice: 52000, realizedPnl: 200, fees: 0 });

    const stats = analytics.getSessionStats();
    expect(stats.totalPnl).toBe(200);
    expect(stats.totalTrades).toBe(1);
    expect(analytics.getClosedTrades()[0].realizedPnl).toBe(200);
    expect(stats.highWaterMark).toBe(10000);
    expect(stats.maxDrawdown).toBe(0);
    expect(analytics.getEquityCurve().at(-1)!.equity).toBe(10000);
  });

  test('closed below the snapshot mark: equity falls by the in-session move only', () => {
    analytics = new TradeAnalytics(liveConfig, mockLogger as unknown as Logger);
    analytics.recordEntry(seed);
    analytics.recordExit({ tradeId: 'carried-live', exitPrice: 51000, realizedPnl: 100, fees: 0 });

    const stats = analytics.getSessionStats();
    expect(stats.totalPnl).toBe(100);
    expect(analytics.getEquityCurve().at(-1)!.equity).toBeCloseTo(9900, 6);
    expect(stats.maxDrawdown).toBeCloseTo(100, 6);
    expect(stats.highWaterMark).toBe(10000);
  });

  test('prior-session realized P&L carried on the position is already in the snapshot equity', () => {
    analytics = new TradeAnalytics(liveConfig, mockLogger as unknown as Logger);
    analytics.recordEntry({ ...seed, priorRealizedPnl: 30 });
    analytics.recordExit({ tradeId: 'carried-live', exitPrice: 52000, realizedPnl: 230, fees: 0 });
    expect(analytics.getSessionStats().totalPnl).toBe(230);
    expect(analytics.getEquityCurve().at(-1)!.equity).toBeCloseTo(10000, 6);
  });

  test('a short carried-over trade uses the mirrored mark move', () => {
    analytics = new TradeAnalytics(liveConfig, mockLogger as unknown as Logger);
    analytics.recordEntry({ ...seed, side: 'short' });
    // Short from 50000, snapshot mark 52000 (−200 already in equity), closed at 51000 (−100 round trip).
    analytics.recordExit({ tradeId: 'carried-live', exitPrice: 51000, realizedPnl: -100, fees: 0 });
    expect(analytics.getEquityCurve().at(-1)!.equity).toBeCloseTo(10100, 6);
  });

  test('in-session trades are unaffected by the marks (full P&L into equity)', () => {
    analytics = new TradeAnalytics(liveConfig, mockLogger as unknown as Logger);
    analytics.recordEntry({ tradeId: 'fresh', symbol: 'BTC-USD', side: 'long', entryPrice: 50000, size: 0.1 });
    analytics.recordExit({ tradeId: 'fresh', exitPrice: 52000, realizedPnl: 200, fees: 0 });
    expect(analytics.getEquityCurve().at(-1)!.equity).toBe(10200);
  });

  test('no mark for the symbol: full P&L into equity and a warn names the trade', () => {
    analytics = new TradeAnalytics({ ...liveConfig, initialEquityMarks: {} }, mockLogger as unknown as Logger);
    analytics.recordEntry(seed);
    analytics.recordExit({ tradeId: 'carried-live', exitPrice: 52000, realizedPnl: 200, fees: 0 });
    expect(analytics.getEquityCurve().at(-1)!.equity).toBe(10200);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('no initial-equity mark'),
      expect.objectContaining({ tradeId: 'carried-live', symbol: 'BTC-USD' }),
    );
  });

  test('paper (no initialEquityMarks): a carried-over round trip moves equity by its full P&L, as before', () => {
    analytics = new TradeAnalytics({ ...liveConfig, mode: 'paper', initialEquityMarks: undefined }, mockLogger as unknown as Logger);
    analytics.recordEntry(seed);
    analytics.recordExit({ tradeId: 'carried-live', exitPrice: 52000, realizedPnl: 200, fees: 0 });
    expect(analytics.getEquityCurve().at(-1)!.equity).toBe(10200);
    expect(analytics.getSessionStats().highWaterMark).toBe(10200);
  });
});

/**
 * FE contract #2 — analytics bound to the API server's session. When the engine
 * passes the minted `trading_sessions.session_id` + open time, TradeAnalytics
 * reports THAT id (so `/api/analytics/session.sessionId === /api/status.sessionId`)
 * and leaves the `trading_sessions` row to the server (no summary upsert on stop).
 */
describe('TradeAnalytics — externally owned session', () => {
  const baseConfig: TradeAnalyticsConfig = {
    supabaseUrl: 'http://localhost:54321',
    supabaseKey: 'test-key',
    userId: 'test-user',
    initialEquity: 10000,
    mode: 'paper',
    equitySampleIntervalMs: 60000,
  };
  const SESSION_ID = 'sess_1757606400000_ab12cd';
  const STARTED_AT = Date.parse('2026-09-11T16:00:00.000Z');

  test('uses the supplied session id and start time in getSessionStats()', async () => {
    const analytics = new TradeAnalytics({ ...baseConfig, sessionId: SESSION_ID, sessionStartedAt: STARTED_AT }, mockLogger as unknown as Logger);
    try {
      const stats = analytics.getSessionStats();
      expect(stats.sessionId).toBe(SESSION_ID);
      expect(analytics.getSessionId()).toBe(SESSION_ID);
      expect(stats.startTime.getTime()).toBe(STARTED_AT);
      expect(stats.sessionId).not.toMatch(/^paper-\d{8}-\d{6}-/);
    } finally {
      await analytics.stop();
    }
  });

  test('falls back to a self-generated id and construction time without a supplied session', async () => {
    const before = Date.now();
    const analytics = new TradeAnalytics(baseConfig, mockLogger as unknown as Logger);
    try {
      const stats = analytics.getSessionStats();
      expect(stats.sessionId).toMatch(/^paper-\d{8}-\d{6}-[a-z0-9]{4}$/);
      expect(stats.startTime.getTime()).toBeGreaterThanOrEqual(before);
    } finally {
      await analytics.stop();
    }
  });

  test('stop() skips the trading_sessions summary upsert for an externally owned session', async () => {
    const analytics = new TradeAnalytics({ ...baseConfig, sessionId: SESSION_ID, sessionStartedAt: STARTED_AT }, mockLogger as unknown as Logger);
    const persistSpy = vi.spyOn(analytics, 'persistSessionSummary');

    await analytics.stop();

    expect(persistSpy).not.toHaveBeenCalled();
    expect(mockLogger.info).toHaveBeenCalledWith(
      'TradeAnalytics stopped',
      expect.objectContaining({ sessionId: SESSION_ID, externalSession: true }),
    );
  });

  test('stop() still persists the summary for a self-owned session', async () => {
    const analytics = new TradeAnalytics(baseConfig, mockLogger as unknown as Logger);
    const persistSpy = vi.spyOn(analytics, 'persistSessionSummary');

    await analytics.stop();

    expect(persistSpy).toHaveBeenCalledTimes(1);
  });
});

