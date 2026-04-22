import { describe, test, expect, beforeEach, vi } from 'vitest';
import { SignalArbitrator, extractBaseAsset } from '../strategies/signal-arbitrator';
import type { Signal } from '../strategies/signal-processor';
import type { Position } from '../trading/position-tracker';

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

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

function makePosition(overrides: Partial<Position> = {}): Position {
  const size = overrides.size ?? 1;
  return {
    id: overrides.id ?? `pos-${Math.random().toString(36).slice(2, 8)}`,
    symbol: overrides.symbol ?? 'BTC-USD',
    strategy: overrides.strategy,
    side: overrides.side ?? 'long',
    size,
    averagePrice: overrides.averagePrice ?? 100,
    marketPrice: overrides.marketPrice ?? 100,
    unrealizedPnL: 0,
    realizedPnL: 0,
    totalPnL: 0,
    openTime: overrides.openTime ?? new Date(),
    lastUpdateTime: new Date(),
    trades: [],
    maxSize: size,
    maxDrawdown: 0,
  };
}

describe('SignalArbitrator', () => {
  let arbiter: SignalArbitrator;

  beforeEach(() => {
    vi.clearAllMocks();
    arbiter = new SignalArbitrator(mockLogger as any);
  });

  describe('cross-venue netting', () => {
    test('rejects opposite-direction on same symbol', () => {
      const open = [makePosition({ symbol: 'BTC-USD', side: 'long' })];
      const sig = makeSignal({ symbol: 'BTC-USD', direction: 'sell', strength: 0.5 });
      const decision = arbiter.arbitrate(sig, open);
      expect(decision.allow).toBe(false);
      expect(decision.reason).toBe('cross_venue_opposing_position');
    });

    test('rejects opposite-direction across venues: ETH-USD long ↔ ETH-PERP-INTX short', () => {
      const open = [makePosition({ symbol: 'ETH-USD', side: 'long' })];
      const sig = makeSignal({ symbol: 'ETH-PERP-INTX', direction: 'sell', strength: 0.5 });
      const decision = arbiter.arbitrate(sig, open);
      expect(decision.allow).toBe(false);
      expect(decision.reason).toBe('cross_venue_opposing_position');
    });

    test('regression: ETH-PERP-INTX short blocks ETH-USD buy signal (the actual session pattern)', () => {
      const open = [makePosition({ symbol: 'ETH-PERP-INTX', side: 'short' })];
      const sig = makeSignal({ symbol: 'ETH-USD', direction: 'buy', strength: 0.5 });
      const decision = arbiter.arbitrate(sig, open);
      expect(decision.allow).toBe(false);
      expect(decision.reason).toBe('cross_venue_opposing_position');
    });

    test('allows same-direction signal across venues (sizing up the same thesis)', () => {
      const open = [makePosition({ symbol: 'BTC-USD', side: 'long' })];
      const sig = makeSignal({ symbol: 'BTC-PERP-INTX', direction: 'buy', strength: 0.5 });
      const decision = arbiter.arbitrate(sig, open);
      expect(decision.allow).toBe(true);
    });

    test('different base asset is independent (BTC long doesn’t block ETH short)', () => {
      const open = [makePosition({ symbol: 'BTC-USD', side: 'long' })];
      const sig = makeSignal({ symbol: 'ETH-USD', direction: 'sell', strength: 0.5 });
      const decision = arbiter.arbitrate(sig, open);
      expect(decision.allow).toBe(true);
    });

    test('allows reversal when BOTH strength > threshold AND metadata.reversalIntent === true', () => {
      const open = [makePosition({ symbol: 'BTC-USD', side: 'long' })];
      const sig = makeSignal({
        symbol: 'BTC-USD',
        direction: 'sell',
        strength: 0.95,
        metadata: { indicators: {}, reason: 'regime flip', reversalIntent: true },
      });
      const decision = arbiter.arbitrate(sig, open);
      expect(decision.allow).toBe(true);
      // Reversal should be loudly logged
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('allowing explicit reversal'),
        expect.objectContaining({ reversalIntent: true }),
      );
    });

    test('regression: rejects opposing signal even at strength 0.99 if reversalIntent flag missing', () => {
      // Lifted from the live verification on sess_1776886953034_nc1yrw:
      // momentum fired ETH-USD BUY at strength=0.9952 while an ETH-PERP-INTX
      // SHORT was already open. Pre-tightening (Option A), the 0.8 strength
      // threshold alone let it through and we ended the session with
      // opposing exposure on the same base — exactly the case P0 was meant
      // to prevent. With Option A, no reversalIntent → rejected.
      const open = [makePosition({ symbol: 'ETH-PERP-INTX', side: 'short' })];
      const sig = makeSignal({
        symbol: 'ETH-USD',
        direction: 'buy',
        strength: 0.9952,
        // no reversalIntent flag set
      });
      const decision = arbiter.arbitrate(sig, open);
      expect(decision.allow).toBe(false);
      expect(decision.reason).toBe('cross_venue_opposing_position');
      expect(decision.context?.reversalIntentSet).toBe(false);
    });

    test('rejects reversal when strength == threshold (strict greater-than) even with reversalIntent set', () => {
      const open = [makePosition({ symbol: 'BTC-USD', side: 'long' })];
      const sig = makeSignal({
        symbol: 'BTC-USD',
        direction: 'sell',
        strength: 0.9, // == default threshold, must be STRICTLY greater
        metadata: { indicators: {}, reason: 'test', reversalIntent: true },
      });
      const decision = arbiter.arbitrate(sig, open);
      expect(decision.allow).toBe(false);
    });

    test('rejects reversal when reversalIntent missing, even with strength above threshold', () => {
      const open = [makePosition({ symbol: 'BTC-USD', side: 'long' })];
      const sig = makeSignal({
        symbol: 'BTC-USD',
        direction: 'sell',
        strength: 0.95,
        metadata: { indicators: {}, reason: 'high-strength but no flag' },
      });
      const decision = arbiter.arbitrate(sig, open);
      expect(decision.allow).toBe(false);
      expect(decision.reason).toBe('cross_venue_opposing_position');
    });

    test('rejects reversal when reversalIntent set but strength too low', () => {
      const open = [makePosition({ symbol: 'BTC-USD', side: 'long' })];
      const sig = makeSignal({
        symbol: 'BTC-USD',
        direction: 'sell',
        strength: 0.5,
        metadata: { indicators: {}, reason: 'flag set but weak signal', reversalIntent: true },
      });
      const decision = arbiter.arbitrate(sig, open);
      expect(decision.allow).toBe(false);
      expect(decision.reason).toBe('cross_venue_opposing_position');
    });

    test('honors a custom reversalStrengthThreshold (with reversalIntent flag)', () => {
      arbiter = new SignalArbitrator(mockLogger as any, { reversalStrengthThreshold: 0.5 });
      const open = [makePosition({ symbol: 'BTC-USD', side: 'long' })];
      const sig = makeSignal({
        symbol: 'BTC-USD',
        direction: 'sell',
        strength: 0.6,
        metadata: { indicators: {}, reason: 'test', reversalIntent: true },
      });
      const decision = arbiter.arbitrate(sig, open);
      expect(decision.allow).toBe(true);
    });

    test('reversalIntent === "true" (string) does NOT count — must be the boolean true', () => {
      const open = [makePosition({ symbol: 'BTC-USD', side: 'long' })];
      const sig = makeSignal({
        symbol: 'BTC-USD',
        direction: 'sell',
        strength: 0.95,
        metadata: { indicators: {}, reason: 'test', reversalIntent: 'true' as unknown as boolean },
      });
      const decision = arbiter.arbitrate(sig, open);
      expect(decision.allow).toBe(false);
    });

    test('ignores flat positions when computing opposition', () => {
      const open = [makePosition({ symbol: 'BTC-USD', side: 'flat', size: 0 })];
      const sig = makeSignal({ symbol: 'BTC-USD', direction: 'sell' });
      const decision = arbiter.arbitrate(sig, open);
      expect(decision.allow).toBe(true);
    });

    test('ignores zero-size positions even with non-flat side', () => {
      const open = [makePosition({ symbol: 'BTC-USD', side: 'long', size: 0 })];
      const sig = makeSignal({ symbol: 'BTC-USD', direction: 'sell' });
      const decision = arbiter.arbitrate(sig, open);
      expect(decision.allow).toBe(true);
    });
  });

  describe('intra-window dedup', () => {
    test('rejects duplicate (strategy+symbol+side) within window', () => {
      const sig1 = makeSignal({ id: 'a', symbol: 'BTC-USD', direction: 'buy', strategy: 'momentum' });
      const sig2 = makeSignal({ id: 'b', symbol: 'BTC-USD', direction: 'buy', strategy: 'momentum' });
      expect(arbiter.arbitrate(sig1, []).allow).toBe(true);
      const second = arbiter.arbitrate(sig2, []);
      expect(second.allow).toBe(false);
      expect(second.reason).toBe('intra_window_dedup');
      expect(second.context?.previousSignalId).toBe('a');
    });

    test('different strategy bypasses dedup', () => {
      const sig1 = makeSignal({ symbol: 'BTC-USD', direction: 'buy', strategy: 'momentum' });
      const sig2 = makeSignal({ symbol: 'BTC-USD', direction: 'buy', strategy: 'breakout' });
      arbiter.arbitrate(sig1, []);
      expect(arbiter.arbitrate(sig2, []).allow).toBe(true);
    });

    test('different direction bypasses dedup (handled by netting if a position exists)', () => {
      const sig1 = makeSignal({ symbol: 'BTC-USD', direction: 'buy', strategy: 'momentum' });
      const sig2 = makeSignal({ symbol: 'BTC-USD', direction: 'sell', strategy: 'momentum' });
      arbiter.arbitrate(sig1, []);
      expect(arbiter.arbitrate(sig2, []).allow).toBe(true);
    });

    test('different symbol bypasses dedup', () => {
      const sig1 = makeSignal({ symbol: 'BTC-USD', direction: 'buy', strategy: 'momentum' });
      const sig2 = makeSignal({ symbol: 'ETH-USD', direction: 'buy', strategy: 'momentum' });
      arbiter.arbitrate(sig1, []);
      expect(arbiter.arbitrate(sig2, []).allow).toBe(true);
    });

    test('dedup window expires after configured ms', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-04-22T12:00:00Z'));
      arbiter = new SignalArbitrator(mockLogger as any, { dedupWindowMs: 100 });
      arbiter.arbitrate(makeSignal({ id: 'a' }), []);
      vi.advanceTimersByTime(150);
      expect(arbiter.arbitrate(makeSignal({ id: 'b' }), []).allow).toBe(true);
      vi.useRealTimers();
    });

    test('regression: BUY then SELL on ETH-PERP-INTX same second — dedup misses, netting catches', () => {
      // Production observation 2026-04-22 03:00–03:31 UTC: momentum fired
      // BUY (RSI 39.7) and SELL (RSI 56.7) on ETH-PERP-INTX within the same
      // second. Different directions → dedup keys differ → dedup MUST NOT fire
      // on the second one. The cross-venue netting check is the one that catches it
      // (once the BUY has filled into a long position).
      const sigBuy = makeSignal({ symbol: 'ETH-PERP-INTX', direction: 'buy', strength: 0.5 });
      const sigSell = makeSignal({ symbol: 'ETH-PERP-INTX', direction: 'sell', strength: 0.5 });

      expect(arbiter.arbitrate(sigBuy, []).allow).toBe(true);

      const openLong = [makePosition({ symbol: 'ETH-PERP-INTX', side: 'long' })];
      const sellDecision = arbiter.arbitrate(sigSell, openLong);
      expect(sellDecision.allow).toBe(false);
      expect(sellDecision.reason).toBe('cross_venue_opposing_position');
    });
  });

  describe('housekeeping', () => {
    test('cleanup() drops decisions older than maxAge', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-04-22T12:00:00Z'));
      arbiter = new SignalArbitrator(mockLogger as any);
      arbiter.arbitrate(makeSignal({ id: 'a' }), []);
      expect(arbiter.size()).toBe(1);
      vi.advanceTimersByTime(10 * 60 * 1000);
      arbiter.cleanup(5 * 60 * 1000);
      expect(arbiter.size()).toBe(0);
      vi.useRealTimers();
    });

    test('reset() clears all dedup state', () => {
      arbiter.arbitrate(makeSignal({ id: 'a' }), []);
      arbiter.arbitrate(makeSignal({ id: 'b', symbol: 'ETH-USD' }), []);
      arbiter.reset();
      expect(arbiter.size()).toBe(0);
    });

    test('approved decisions log nothing at warn-level (only rejections shout)', () => {
      arbiter.arbitrate(makeSignal({}), []);
      expect(mockLogger.warn).not.toHaveBeenCalled();
    });
  });

  describe('extractBaseAsset', () => {
    test.each([
      ['BTC-USD', 'BTC'],
      ['ETH-USD', 'ETH'],
      ['SOL-USD', 'SOL'],
      ['BTC-PERP-INTX', 'BTC'],
      ['ETH-PERP-INTX', 'ETH'],
      ['BTC-USDT', 'BTC'],
    ])('%s → %s', (input, expected) => {
      expect(extractBaseAsset(input)).toBe(expected);
    });
  });
});
