import { describe, test, expect, beforeEach, vi } from 'vitest';
import { TradeOutcomeCollector } from '../ml/trade-outcome-collector';
import type { Position } from '../trading/position-tracker';
import type { RegimeState } from '../strategies/regime-detector';

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

let lastInsertPayload: Record<string, unknown> | null = null;
let nextInsertError: { message: string } | null = null;

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: (_: string) => ({
      insert: (record: Record<string, unknown>) => {
        lastInsertPayload = record;
        return Promise.resolve({ error: nextInsertError });
      },
    }),
  }),
}));

const baseRegime: RegimeState = {
  regime: 'weak_trend',
  confidence: 0.75,
  adx: 28,
  plusDI: 22,
  minusDI: 12,
  atrPercent: 0.012,
  bbWidth: 0.04,
  choppiness: 38,
  trendDirection: 'up',
  directionConsistency: 0.8,
  mtfAlignment: 0.7,
  lastUpdated: new Date(),
  regimeSince: new Date(),
};

const baseIndicators = {
  rsi: 55.2,
  macd: 0.4,
  macdSignal: 0.3,
  macdHistogram: 0.1,
  ema12: 76700,
  ema15: 76680,
  atr: 50,
};

function makeSignal(overrides: Partial<{
  id: string; symbol: string; strategy: string; direction: 'buy' | 'sell';
  price: number; stopLoss: number; takeProfit: number; timestamp: Date;
  strength: number;
}> = {}) {
  return {
    id: overrides.id ?? 'sig-001',
    symbol: overrides.symbol ?? 'BTC-USD',
    strategy: overrides.strategy ?? 'trend_follow',
    direction: overrides.direction ?? ('buy' as const),
    strength: overrides.strength ?? 0.9,
    price: overrides.price ?? 76800,
    stopLoss: overrides.stopLoss ?? 76675,
    takeProfit: overrides.takeProfit ?? 77050,
    timestamp: overrides.timestamp ?? new Date('2026-04-27T20:05:00Z'),
    metadata: { reason: 'EMA cross' },
  };
}

function makeClosedPosition(overrides: Partial<Position> = {}): Position {
  const openedAt = overrides.openTime ?? new Date('2026-04-27T20:05:30Z');
  const closedAt = overrides.closedAt ?? new Date('2026-04-27T20:25:30Z');
  return {
    id: overrides.id ?? 'pos-001',
    symbol: overrides.symbol ?? 'BTC-USD',
    strategy: overrides.strategy ?? 'trend_follow',
    signalId: overrides.signalId,
    side: overrides.side ?? 'long',
    size: 0,
    averagePrice: overrides.averagePrice ?? 76820,
    marketPrice: overrides.marketPrice ?? 77020,
    unrealizedPnL: 0,
    realizedPnL: overrides.realizedPnL ?? 35,
    totalPnL: overrides.realizedPnL ?? 35,
    openTime: openedAt,
    closedAt,
    exitPrice: overrides.exitPrice ?? 77020,
    exitReason: overrides.exitReason,
    lastUpdateTime: closedAt,
    trades: [
      { id: 't1', orderId: 'o1', side: 'buy', size: 0.025, price: 76820, fee: 1.92, timestamp: openedAt },
      { id: 't2', orderId: 'o2', side: 'sell', size: 0.025, price: 77020, fee: 1.92, timestamp: closedAt },
    ],
    maxSize: 0.025,
    maxDrawdown: 5,
    metadata: {},
  };
}

describe('TradeOutcomeCollector', () => {
  let collector: TradeOutcomeCollector;

  beforeEach(() => {
    vi.clearAllMocks();
    lastInsertPayload = null;
    nextInsertError = null;
    collector = new TradeOutcomeCollector(
      {
        supabaseUrl: 'http://localhost:54321',
        supabaseKey: 'test-key',
        sessionId: 'test-session',
        enabled: true,
        profitThreshold: 0,
      },
      mockLogger as any,
    );
  });

  test('happy path: signalId on position links to captured context and writes a row', async () => {
    const signal = makeSignal();
    collector.captureSignalContext(signal, baseRegime, baseIndicators);

    const position = makeClosedPosition({ signalId: signal.id });
    await collector.recordOutcome(position, 'take_profit');

    expect(lastInsertPayload).not.toBeNull();
    expect(lastInsertPayload).toMatchObject({
      signal_id: 'sig-001',
      session_id: 'test-session',
      symbol: 'BTC-USD',
      strategy: 'trend_follow',
      signal_direction: 'buy',
      regime: 'weak_trend',
      outcome_label: 'profitable',
      exit_reason: 'take_profit',
    });
    expect(lastInsertPayload!.indicators_snapshot).toMatchObject({ rsi: 55.2 });
    expect(lastInsertPayload!.r_multiple).toBeTypeOf('number');
    expect(lastInsertPayload!.fees).toBe(3.84);
    expect(collector.getStats().outcomesSuccessful).toBe(1);
  });

  test('closedAt-only path: position with no signalId still resolves via single-pending fallback', async () => {
    const signal = makeSignal({ id: 'sig-only' });
    collector.captureSignalContext(signal, baseRegime, baseIndicators);

    const position = makeClosedPosition(); // signalId undefined
    await collector.recordOutcome(position, 'stop_loss');

    expect(lastInsertPayload).not.toBeNull();
    expect(lastInsertPayload!.signal_id).toBe('sig-only');
  });

  test('multi-pending: prefers directional match whose timestamp predates open', async () => {
    // Two longs and a short for the same symbol; only the latest pre-open long is correct
    const old = makeSignal({ id: 'sig-old', timestamp: new Date('2026-04-27T19:00:00Z') });
    const correct = makeSignal({ id: 'sig-correct', timestamp: new Date('2026-04-27T20:05:00Z') });
    const wrongDir = makeSignal({ id: 'sig-short', direction: 'sell', timestamp: new Date('2026-04-27T20:05:10Z') });
    collector.captureSignalContext(old, baseRegime, baseIndicators);
    collector.captureSignalContext(correct, baseRegime, baseIndicators);
    collector.captureSignalContext(wrongDir, baseRegime, baseIndicators);

    const position = makeClosedPosition({ side: 'long' });
    await collector.recordOutcome(position, 'take_profit');

    expect(lastInsertPayload).not.toBeNull();
    expect(lastInsertPayload!.signal_id).toBe('sig-correct');
  });

  test('drops outcome when no context found and increments dropped counter', async () => {
    const position = makeClosedPosition({ signalId: 'never-captured' });
    await collector.recordOutcome(position);

    expect(lastInsertPayload).toBeNull();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('No signal context found'),
      expect.objectContaining({ positionSignalId: 'never-captured' }),
    );
  });

  test('outcome_label labels reflect realized PnL relative to threshold', async () => {
    const sigA = makeSignal({ id: 'sig-a' });
    const sigB = makeSignal({ id: 'sig-b' });
    collector.captureSignalContext(sigA, baseRegime, baseIndicators);
    collector.captureSignalContext(sigB, baseRegime, baseIndicators);

    await collector.recordOutcome(makeClosedPosition({ signalId: 'sig-a', realizedPnL: 25 }));
    expect(lastInsertPayload!.outcome_label).toBe('profitable');

    await collector.recordOutcome(makeClosedPosition({ signalId: 'sig-b', realizedPnL: -25 }));
    expect(lastInsertPayload!.outcome_label).toBe('unprofitable');
  });

  test('insert error is logged and outcomesFailed counter increments', async () => {
    const signal = makeSignal();
    collector.captureSignalContext(signal, baseRegime, baseIndicators);
    nextInsertError = { message: 'simulated DB error' };

    const position = makeClosedPosition({ signalId: signal.id });
    await collector.recordOutcome(position);

    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.stringContaining('Failed to write outcome'),
      expect.objectContaining({ error: 'simulated DB error' }),
    );
    expect(collector.getStats().outcomesFailed).toBe(1);
  });

  test('signal context is removed after successful outcome (no double-write)', async () => {
    const signal = makeSignal();
    collector.captureSignalContext(signal, baseRegime, baseIndicators);
    const position = makeClosedPosition({ signalId: signal.id });

    await collector.recordOutcome(position);
    expect(collector.getStats().outcomesSuccessful).toBe(1);

    // Second call for the same position should drop (context already removed)
    lastInsertPayload = null;
    await collector.recordOutcome(position);
    expect(lastInsertPayload).toBeNull();
  });
});
