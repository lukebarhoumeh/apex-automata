/**
 * FE PR1 contract #3 — session-scoped per-strategy trade stats
 * (api/strategy-session-stats.ts).
 *
 * The dashboard rendered `/api/strategies[].stats.signalsGenerated` as "trades":
 * four momentum signals with zero fills showed "4 trades" next to a session with
 * 0 closed positions. These tests pin the locked shape
 * `{ strategyId, closedTrades, pnlToday, winRate }` — zeros (not null) at zero
 * closed trades, shelved ids listed with zeros, and no `signalsGenerated`
 * anywhere in the payload.
 */

import { describe, it, expect } from 'vitest';
import {
  STRATEGY_SESSION_STATS_NOTES,
  UNKNOWN_STRATEGY_ID,
  buildStrategySessionStats,
  utcRiskDay,
} from '../api/strategy-session-stats';

const NOW = Date.parse('2026-09-11T17:30:00.000Z');
const STARTED_AT_MS = Date.parse('2026-09-11T16:00:00.000Z');
const SESSION = { sessionId: 'sess_1757606400000_ab12cd', sessionStartedAt: STARTED_AT_MS, executionMode: 'paper' as const };
const STRATEGIES = [
  { id: 'momentum', name: 'Momentum', enabled: true, disabledByGuardrails: false },
  { id: 'trend_follow', name: 'Trend Follow', enabled: true, disabledByGuardrails: false },
  // shelved (guardrails disabled_strategies) — listed with zeros
  { id: 'breakout', name: 'Breakout', enabled: false, disabledByGuardrails: true },
  { id: 'vwap_mr', name: 'VWAP MR', enabled: false, disabledByGuardrails: true },
];

function trade(strategy: string | undefined, realizedPnl: number, exitTime: string, fees = 0.5) {
  const outcome = realizedPnl > 1 ? 'win' : realizedPnl < -1 ? 'loss' : 'breakeven';
  return { strategy, realizedPnl, fees, outcome: outcome as 'win' | 'loss' | 'breakeven', exitTime: new Date(exitTime) };
}

describe('buildStrategySessionStats', () => {
  it('"4 signals, 0 trades": closedTrades/pnlToday/winRate are 0 and the payload has no signalsGenerated', () => {
    const report = buildStrategySessionStats({ closedTrades: [], strategies: STRATEGIES, session: SESSION, engineRunning: true, now: NOW });

    const momentum = report.strategies.find((s) => s.strategyId === 'momentum')!;
    expect(momentum).toMatchObject({
      strategyId: 'momentum',
      closedTrades: 0,
      pnlToday: 0,
      winRate: 0,
      name: 'Momentum',
      enabled: true,
      disabledByGuardrails: false,
      openTrades: 0,
      signalsTaken: 0,
      realizedPnl: 0,
      avgTrade: 0,
      lastTradeAt: null,
    });
    expect(momentum).not.toHaveProperty('signalsGenerated');
    expect(JSON.stringify(report)).not.toMatch(/signalsGenerated/);
    expect(report.totals).toMatchObject({ closedTrades: 0, winRate: 0, realizedPnl: 0, pnlToday: 0 });
    expect(report).toMatchObject({
      sessionId: SESSION.sessionId,
      sessionStartedAt: '2026-09-11T16:00:00.000Z',
      executionMode: 'paper',
      engineRunning: true,
      riskDay: '2026-09-11',
      generatedAt: '2026-09-11T17:30:00.000Z',
    });
    expect(report.notes).toEqual(STRATEGY_SESSION_STATS_NOTES);
  });

  it('lists shelved ids with zeros and disabledByGuardrails=true, in the given order', () => {
    const report = buildStrategySessionStats({ closedTrades: [], strategies: STRATEGIES, session: SESSION, engineRunning: true, now: NOW });

    expect(report.strategies.map((s) => s.strategyId)).toEqual(['momentum', 'trend_follow', 'breakout', 'vwap_mr']);
    const breakout = report.strategies.find((s) => s.strategyId === 'breakout')!;
    expect(breakout).toMatchObject({ closedTrades: 0, pnlToday: 0, winRate: 0, enabled: false, disabledByGuardrails: true });
  });

  it('aggregates closed trades per strategy: counts, outcomes, realized, fees, winRate, avg, lastTradeAt, signalsTaken', () => {
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
      signalsTaken: 4,
      wins: 1,
      losses: 1,
      breakeven: 1,
      winRate: 1 / 3,
      realizedPnl: 15.2,
      pnlToday: 15.2,
      closedTradesToday: 3,
      avgTrade: 15.2 / 3,
      fees: 1.5,
      lastTradeAt: '2026-09-11T17:00:00.000Z',
    });
    const trend = report.strategies.find((s) => s.strategyId === 'trend_follow')!;
    expect(trend).toMatchObject({ closedTrades: 1, openTrades: 1, signalsTaken: 2, wins: 1, winRate: 1, realizedPnl: 40, fees: 1.25 });

    expect(report.totals).toEqual({
      closedTrades: 4,
      openTrades: 2,
      signalsTaken: 6,
      wins: 2,
      losses: 1,
      breakeven: 1,
      winRate: 0.5,
      realizedPnl: 55.2,
      pnlToday: 55.2,
      fees: 2.75,
    });
  });

  it('pnlToday only counts exits on the current UTC day (session spanning midnight)', () => {
    const closedTrades = [
      trade('momentum', 100, '2026-09-10T23:59:00.000Z'), // yesterday UTC
      trade('momentum', -30, '2026-09-11T00:01:00.000Z'), // today UTC
    ];

    const report = buildStrategySessionStats({ closedTrades, strategies: STRATEGIES, session: SESSION, engineRunning: true, now: NOW });

    const momentum = report.strategies.find((s) => s.strategyId === 'momentum')!;
    expect(momentum.realizedPnl).toBe(70);
    expect(momentum.pnlToday).toBe(-30);
    expect(momentum.closedTradesToday).toBe(1);
    expect(momentum.closedTrades).toBe(2);
  });

  it('buckets untagged trades under "unknown" and lists trade-only strategies after listed ones', () => {
    const closedTrades = [
      trade(undefined, 5, '2026-09-11T16:20:00.000Z'),
      trade('   ', -5, '2026-09-11T16:25:00.000Z'),
      trade('obi_scalper', 7, '2026-09-11T16:30:00.000Z'),
    ];

    const report = buildStrategySessionStats({ closedTrades, strategies: STRATEGIES, session: SESSION, engineRunning: true, now: NOW });

    expect(report.strategies.map((s) => s.strategyId)).toEqual(['momentum', 'trend_follow', 'breakout', 'vwap_mr', 'obi_scalper', UNKNOWN_STRATEGY_ID]);
    const unknown = report.strategies.find((s) => s.strategyId === UNKNOWN_STRATEGY_ID)!;
    expect(unknown).toMatchObject({ name: null, enabled: null, disabledByGuardrails: false, closedTrades: 2 });
    const obi = report.strategies.find((s) => s.strategyId === 'obi_scalper')!;
    expect(obi).toMatchObject({ enabled: null, closedTrades: 1, realizedPnl: 7 });
  });

  it('de-duplicates descriptors by id (first wins)', () => {
    const report = buildStrategySessionStats({
      closedTrades: [],
      strategies: [
        { id: 'momentum', name: 'Momentum (registered)', enabled: true },
        { id: 'momentum', name: 'Momentum (policy)', enabled: false },
      ],
      session: SESSION,
      engineRunning: true,
      now: NOW,
    });
    expect(report.strategies).toHaveLength(1);
    expect(report.strategies[0].name).toBe('Momentum (registered)');
  });

  it('tolerates non-finite / missing numbers and unparsable exit times without inventing values', () => {
    const closedTrades = [
      { strategy: 'momentum', realizedPnl: Number.NaN, fees: undefined, outcome: 'win' as const, exitTime: 'not-a-date' },
      { strategy: 'momentum', realizedPnl: 12, fees: null, outcome: null, exitTime: null },
    ];

    const report = buildStrategySessionStats({ closedTrades, strategies: STRATEGIES, session: SESSION, engineRunning: true, now: NOW });

    const momentum = report.strategies.find((s) => s.strategyId === 'momentum')!;
    expect(momentum).toMatchObject({ closedTrades: 2, wins: 1, breakeven: 1, realizedPnl: 12, fees: 0, pnlToday: 0, closedTradesToday: 0, lastTradeAt: null, avgTrade: 6 });
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
    expect(report.totals.winRate).toBe(0);
  });

  it('utcRiskDay is the UTC calendar day', () => {
    expect(utcRiskDay(Date.parse('2026-09-11T23:59:59.999Z'))).toBe('2026-09-11');
    expect(utcRiskDay(Date.parse('2026-09-12T00:00:00.000Z'))).toBe('2026-09-12');
  });
});
