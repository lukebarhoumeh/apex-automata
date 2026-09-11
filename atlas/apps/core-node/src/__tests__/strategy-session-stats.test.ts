/**
 * FE contract #3 — session-scoped per-strategy trade stats
 * (api/strategy-session-stats.ts).
 *
 * The dashboard rendered `/api/strategies[].stats.signalsGenerated` as "trades":
 * four momentum signals with zero fills showed "4 trades" next to a session with
 * 0 closed positions. These tests pin the honest fields (`closedTrades`,
 * `pnlToday`, `winRate`) and that `signalsGenerated` is mirrored, never mixed in.
 */

import { describe, it, expect } from 'vitest';
import {
  STRATEGY_SESSION_STATS_NOTES,
  UNKNOWN_STRATEGY_ID,
  buildStrategySessionStats,
  utcRiskDay,
} from '../api/strategy-session-stats';

const NOW = Date.parse('2026-09-11T17:30:00.000Z');
const SESSION = { sessionId: 'sess_1757606400000_ab12cd', sessionStartedAt: Date.parse('2026-09-11T16:00:00.000Z'), executionMode: 'paper' as const };
const STRATEGIES = [
  { id: 'momentum', name: 'Momentum', enabled: true, signalsGenerated: 4 },
  { id: 'trend_follow', name: 'Trend Follow', enabled: true, signalsGenerated: 0 },
];

function trade(strategy: string | undefined, realizedPnl: number, exitTime: string, fees = 0.5) {
  const outcome = realizedPnl > 1 ? 'win' : realizedPnl < -1 ? 'loss' : 'breakeven';
  return { strategy, realizedPnl, fees, outcome: outcome as 'win' | 'loss' | 'breakeven', exitTime: new Date(exitTime) };
}

describe('buildStrategySessionStats', () => {
  it('"4 signals, 0 trades": closedTrades is 0 and winRate/avgTradeUsd are null while signalsGenerated stays 4', () => {
    const report = buildStrategySessionStats({ closedTrades: [], strategies: STRATEGIES, session: SESSION, engineRunning: true, now: NOW });

    const momentum = report.strategies.find((s) => s.strategyId === 'momentum')!;
    expect(momentum).toMatchObject({
      name: 'Momentum',
      enabled: true,
      closedTrades: 0,
      openTrades: 0,
      wins: 0,
      losses: 0,
      winRate: null,
      realizedPnlUsd: 0,
      pnlToday: 0,
      avgTradeUsd: null,
      lastTradeAt: null,
      signalsGenerated: 4,
    });
    expect(report.totals).toMatchObject({ closedTrades: 0, winRate: null, realizedPnlUsd: 0, pnlToday: 0 });
    expect(report).toMatchObject({ ...SESSION, engineRunning: true, riskDay: '2026-09-11', generatedAt: NOW });
    expect(report.notes).toEqual(STRATEGY_SESSION_STATS_NOTES);
  });

  it('aggregates closed trades per strategy: counts, outcomes, realized, fees, winRate, avg, lastTradeAt', () => {
    const closedTrades = [
      trade('momentum', 25, '2026-09-11T16:10:00.000Z'),
      trade('momentum', -10, '2026-09-11T16:40:00.000Z'),
      trade('momentum', 0.2, '2026-09-11T17:00:00.000Z'),
      trade('trend_follow', 40, '2026-09-11T17:10:00.000Z', 1.25),
    ];
    const openTrades = [{ strategy: 'trend_follow' }, { strategy: 'momentum' }];

    const report = buildStrategySessionStats({ closedTrades, openTrades, strategies: STRATEGIES, session: SESSION, engineRunning: true, now: NOW });

    const momentum = report.strategies.find((s) => s.strategyId === 'momentum')!;
    expect(momentum).toMatchObject({
      closedTrades: 3,
      openTrades: 1,
      wins: 1,
      losses: 1,
      breakeven: 1,
      winRate: 1 / 3,
      realizedPnlUsd: 15.2,
      pnlToday: 15.2,
      closedTradesToday: 3,
      avgTradeUsd: 15.2 / 3,
      feesUsd: 1.5,
      lastTradeAt: Date.parse('2026-09-11T17:00:00.000Z'),
    });
    const trend = report.strategies.find((s) => s.strategyId === 'trend_follow')!;
    expect(trend).toMatchObject({ closedTrades: 1, openTrades: 1, wins: 1, winRate: 1, realizedPnlUsd: 40, feesUsd: 1.25, signalsGenerated: 0 });

    expect(report.totals).toEqual({
      closedTrades: 4,
      openTrades: 2,
      wins: 2,
      losses: 1,
      breakeven: 1,
      winRate: 0.5,
      realizedPnlUsd: 55.2,
      pnlToday: 55.2,
      feesUsd: 2.75,
    });
  });

  it('pnlToday only counts exits on the current UTC day (session spanning midnight)', () => {
    const closedTrades = [
      trade('momentum', 100, '2026-09-10T23:59:00.000Z'), // yesterday UTC
      trade('momentum', -30, '2026-09-11T00:01:00.000Z'), // today UTC
    ];

    const report = buildStrategySessionStats({ closedTrades, strategies: STRATEGIES, session: SESSION, engineRunning: true, now: NOW });

    const momentum = report.strategies.find((s) => s.strategyId === 'momentum')!;
    expect(momentum.realizedPnlUsd).toBe(70);
    expect(momentum.pnlToday).toBe(-30);
    expect(momentum.closedTradesToday).toBe(1);
    expect(momentum.closedTrades).toBe(2);
  });

  it('buckets untagged trades under "unknown" and lists trade-only strategies after registered ones', () => {
    const closedTrades = [
      trade(undefined, 5, '2026-09-11T16:20:00.000Z'),
      trade('   ', -5, '2026-09-11T16:25:00.000Z'),
      trade('vwap_mr', 7, '2026-09-11T16:30:00.000Z'),
    ];

    const report = buildStrategySessionStats({ closedTrades, strategies: STRATEGIES, session: SESSION, engineRunning: true, now: NOW });

    expect(report.strategies.map((s) => s.strategyId)).toEqual(['momentum', 'trend_follow', UNKNOWN_STRATEGY_ID, 'vwap_mr']);
    const unknown = report.strategies.find((s) => s.strategyId === UNKNOWN_STRATEGY_ID)!;
    expect(unknown).toMatchObject({ name: null, enabled: null, closedTrades: 2, signalsGenerated: null });
    const vwap = report.strategies.find((s) => s.strategyId === 'vwap_mr')!;
    expect(vwap).toMatchObject({ enabled: null, closedTrades: 1, realizedPnlUsd: 7 });
  });

  it('tolerates non-finite / missing numbers and unparsable exit times without inventing values', () => {
    const closedTrades = [
      { strategy: 'momentum', realizedPnl: Number.NaN, fees: undefined, outcome: 'win' as const, exitTime: 'not-a-date' },
      { strategy: 'momentum', realizedPnl: 12, fees: null, outcome: null, exitTime: null },
    ];

    const report = buildStrategySessionStats({ closedTrades, strategies: STRATEGIES, session: SESSION, engineRunning: true, now: NOW });

    const momentum = report.strategies.find((s) => s.strategyId === 'momentum')!;
    expect(momentum).toMatchObject({ closedTrades: 2, wins: 1, breakeven: 1, realizedPnlUsd: 12, feesUsd: 0, pnlToday: 0, closedTradesToday: 0, lastTradeAt: null });
    expect(Number.isFinite(momentum.avgTradeUsd!)).toBe(true);
  });

  it('is empty-but-honest when no engine session is open', () => {
    const report = buildStrategySessionStats({
      closedTrades: [],
      strategies: [],
      session: { sessionId: null, sessionStartedAt: null, executionMode: null },
      engineRunning: false,
      now: NOW,
    });

    expect(report).toMatchObject({ sessionId: null, sessionStartedAt: null, executionMode: null, engineRunning: false, strategies: [] });
    expect(report.totals.closedTrades).toBe(0);
    expect(report.totals.winRate).toBeNull();
  });

  it('utcRiskDay is the UTC calendar day', () => {
    expect(utcRiskDay(Date.parse('2026-09-11T23:59:59.999Z'))).toBe('2026-09-11');
    expect(utcRiskDay(Date.parse('2026-09-12T00:00:00.000Z'))).toBe('2026-09-12');
  });
});
