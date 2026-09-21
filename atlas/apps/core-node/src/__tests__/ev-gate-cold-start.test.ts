/**
 * Tier-A P0 (DESK GO 2026-09-21) — EV gate cold start.
 *
 * Root cause of "allowed=true signals, 0 paper orders" since 2026-05-18:
 * `MetaFilter.filter()` seeds a `{ totalTrades: 0, winRate: 0 }` record for a
 * strategy the first time it sees one of its signals — BEFORE the router runs
 * the EV gate. The router read `perf.winRate` (0, not null) and the gate priced
 * `p = 0`, so `EV = -L - fees < 0` rejected every signal; no trade closed, `p`
 * never moved. The pure-math tests in risk-ev-gate.test.ts only ever exercised
 * `winRate: null`, so the integration gap was invisible.
 *
 * Pins:
 *   - observedWinRate(): null until a trade has closed, the win rate afterwards.
 *   - evaluateEvGate(): an explicit `sampleSize: 0` is not an observation
 *     (default-allow, distinct reason); `sampleSize` undefined keeps legacy
 *     semantics; the live prior branch is unchanged.
 *   - Integration: a real MetaFilter that has just filtered a signal feeds the
 *     gate through observedWinRate() and the signal is ALLOWED, while the
 *     pre-fix read (`perf.winRate`) is REJECTED — on the exact four signals of
 *     paper session sess_1790007063812_cbimxk.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  evaluateEvGate,
  observedWinRate,
  LIVE_WIN_RATE_PRIOR,
  type EvGateInputs,
} from '../trading/risk/ev-gate';
import { computeRiskBasedSize } from '../trading/risk/position-sizing';
import { FeeModel } from '../core/fee-model';
import type { FeesConfig } from '../config/loadGuardrails';
import { MetaFilter } from '../strategies/meta-filter';
import type { Signal } from '../strategies/signal-processor';
import type { Logger } from '../core/logger';

function makeLogger(): Logger {
  return { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
}

// guardrails.yaml -> fees (2026-09-21)
const YAML_FEES: FeesConfig = {
  coinbase: {
    spot: { maker_bps: 25, taker_bps: 40 },
    perps_intx: { maker_bps: 0, taker_bps: 5 },
  },
  hyperliquid: {
    perps: { maker_bps: -1.5, taker_bps: 4.5 },
  },
};
const FEE_MODEL = new FeeModel(YAML_FEES);

function baseInputs(overrides: Partial<EvGateInputs> = {}): EvGateInputs {
  return {
    symbol: 'ETH-USD',
    strategy: 'trend_follow',
    direction: 'buy',
    entryPrice: 2752.31,
    stopPrice: 2740.29,   // 2.5 x ATR(4.81)
    takeProfit: 2781.16,  // 6.0 x ATR
    size: 0.482131,
    winRate: null,
    feeModel: FEE_MODEL,
    minEvThreshold: 0,
    venue: 'coinbase',
    ...overrides,
  };
}

describe('observedWinRate()', () => {
  it('is null for a missing record', () => {
    expect(observedWinRate(undefined)).toBeNull();
    expect(observedWinRate(null)).toBeNull();
  });

  it('is null for the MetaFilter seed record (0 trades, winRate 0)', () => {
    expect(observedWinRate({ totalTrades: 0, winRate: 0 })).toBeNull();
  });

  it('is null when totalTrades is not a positive finite number', () => {
    expect(observedWinRate({ totalTrades: -1, winRate: 0.5 })).toBeNull();
    expect(observedWinRate({ totalTrades: Number.NaN, winRate: 0.5 })).toBeNull();
  });

  it('returns the win rate once at least one trade has closed — including a genuine 0', () => {
    expect(observedWinRate({ totalTrades: 1, winRate: 0 })).toBe(0);
    expect(observedWinRate({ totalTrades: 12, winRate: 0.5 })).toBe(0.5);
  });

  it('is null when the win rate itself is not finite', () => {
    expect(observedWinRate({ totalTrades: 3, winRate: Number.NaN })).toBeNull();
  });
});

describe('evaluateEvGate() — zero-sample win rate (legacy / paper branch)', () => {
  it('default-allows winRate 0 with an explicit sampleSize 0, with an auditable reason', () => {
    const logger = makeLogger();
    const result = evaluateEvGate(baseInputs({ winRate: 0, sampleSize: 0 }), logger);
    expect(result.allowed).toBe(true);
    expect(result.reason).toBe('zero_sample_win_rate_default_allow');
    expect(result.p).toBe(0);
    expect(result.feeUsd).toBeGreaterThan(0);
    expect(logger.warn).toHaveBeenCalledWith(
      'EV gate: no MetaFilter win-rate — default-allow',
      expect.objectContaining({ symbol: 'ETH-USD', strategy: 'trend_follow', winRate: 0, sampleSize: 0 }),
    );
  });

  it('keeps the null-win-rate reason for winRate null + sampleSize 0', () => {
    const result = evaluateEvGate(baseInputs({ winRate: null, sampleSize: 0 }), makeLogger());
    expect(result.allowed).toBe(true);
    expect(result.reason).toBe('missing_win_rate_default_allow');
  });

  it('still prices winRate 0 when sampleSize is left undefined (legacy semantics preserved)', () => {
    const result = evaluateEvGate(baseInputs({ winRate: 0 }), makeLogger());
    expect(result.allowed).toBe(false);
    expect(result.p).toBe(0);
    expect(result.pSource).toBe('observed');
  });

  it('prices a genuine winRate 0 backed by trades (sampleSize > 0) — and rejects it', () => {
    const result = evaluateEvGate(baseInputs({ winRate: 0, sampleSize: 5 }), makeLogger());
    expect(result.allowed).toBe(false);
    expect(result.pSource).toBe('observed');
  });

  it('live prior branch: winRate 0 + sampleSize 0 still falls back to p0 (unchanged)', () => {
    const result = evaluateEvGate(
      baseInputs({ winRate: 0, sampleSize: 0, winRatePrior: LIVE_WIN_RATE_PRIOR, realizedPayoffRatio: 3 }),
      makeLogger(),
    );
    expect(result.p).toBe(LIVE_WIN_RATE_PRIOR.p0);
    expect(result.pSource).toBe('prior');
    expect(result.reason ?? '').not.toContain('default_allow');
  });
});

/**
 * The exact production sequence: MetaFilter.filter() seeds the strategy's
 * performance record, then the router asks getStrategyPerformance() and feeds
 * the EV gate. Runs against the four signals of sess_1790007063812_cbimxk
 * (values from signals.features + guardrails.yaml on 2026-09-21).
 */
describe('integration — MetaFilter seed record → router → EV gate', () => {
  const EQUITY = 10_000;
  const EXPOSURE_CAP = EQUITY * 0.30;
  const MIN_NOTIONAL = EQUITY * 0.005 * 1.1;

  const SESSION_SIGNALS = [
    { symbol: 'ETH-USD', price: 2752.31, atr: 4.808896129955382, riskPerTrade: 0.005, multiplier: 0.4513519304034682 },
    { symbol: 'ETH-PERP-INTX', price: 2752.31, atr: 4.808896129955382, riskPerTrade: 0.015, multiplier: 0.4513519304034682 },
    { symbol: 'BTC-USD', price: 85842.4, atr: 90.42595735095654, riskPerTrade: 0.005, multiplier: 0.4919020471636201 },
    { symbol: 'BTC-PERP-INTX', price: 85848.0, atr: 91.6586594834088, riskPerTrade: 0.005, multiplier: 0.5001669894141114 },
  ] as const;

  function makeSignal(symbol: string, price: number, atr: number): Signal {
    return {
      id: `00000000-0000-4000-8000-${symbol.length.toString().padStart(12, '0')}`,
      timestamp: new Date('2026-09-21T16:15:00Z'),
      symbol,
      strategy: 'trend_follow',
      direction: 'buy',
      strength: 0.6,
      price,
      stopLoss: price - atr * 2.5,
      takeProfit: price + atr * 6.0,
      metadata: { indicators: {}, reason: 'Bullish EMA crossover (12/15) with price confirmation', atr },
    };
  }

  function sizeLikeTheRouter(entryPrice: number, stopPrice: number, riskPerTrade: number, multiplier: number): number {
    const raw = computeRiskBasedSize({
      equity: EQUITY, riskPerTrade, entryPrice, stopPrice,
      maxPositionExposureUsd: EXPOSURE_CAP, minNotionalUsd: MIN_NOTIONAL, sizeDecimals: 6,
    }).size;
    return parseFloat((raw * multiplier).toFixed(6));
  }

  it('MetaFilter.filter() seeds a { totalTrades: 0, winRate: 0 } record — the value the router used to pass through', () => {
    const metaFilter = new MetaFilter({ logDecisions: false }, makeLogger());
    expect(metaFilter.getStrategyPerformance('trend_follow')).toBeUndefined();

    const s = SESSION_SIGNALS[0];
    const decision = metaFilter.filter(makeSignal(s.symbol, s.price, s.atr), { regime: 'weak_trend' });
    expect(decision.allowed).toBe(true);

    const perf = metaFilter.getStrategyPerformance('trend_follow');
    expect(perf).toBeDefined();
    expect(perf!.totalTrades).toBe(0);
    expect(perf!.winRate).toBe(0);
    // Before the fix: `strategyPerf?.winRate ?? null` === 0. After: null.
    expect(perf!.winRate ?? null).toBe(0);
    expect(observedWinRate(perf)).toBeNull();
  });

  it('all four session signals: pre-fix read (perf.winRate) rejects at ev_gate; observedWinRate() allows', () => {
    const metaFilter = new MetaFilter({ logDecisions: false }, makeLogger());

    for (const s of SESSION_SIGNALS) {
      const signal = makeSignal(s.symbol, s.price, s.atr);
      expect(metaFilter.filter(signal, { regime: 'weak_trend' }).allowed).toBe(true);
      const perf = metaFilter.getStrategyPerformance('trend_follow');
      const size = sizeLikeTheRouter(signal.price, signal.stopLoss, s.riskPerTrade, s.multiplier);
      expect(size).toBeGreaterThan(0);

      const common = {
        symbol: s.symbol,
        strategy: 'trend_follow',
        direction: 'buy' as const,
        entryPrice: signal.price,
        stopPrice: signal.stopLoss,
        takeProfit: signal.takeProfit,
        size,
        feeModel: FEE_MODEL,
        minEvThreshold: 0,
      };

      // What server.ts did on main (5e56974): winRate 0 treated as observed.
      const preFix = evaluateEvGate({ ...common, winRate: perf?.winRate ?? null }, makeLogger());
      expect(preFix.allowed).toBe(false);
      expect(preFix.p).toBe(0);
      expect(preFix.ev).toBeLessThan(0);

      // What server.ts does now.
      const postFix = evaluateEvGate(
        { ...common, winRate: observedWinRate(perf), sampleSize: perf?.totalTrades ?? 0 },
        makeLogger(),
      );
      expect(postFix.allowed).toBe(true);
      expect(postFix.reason).toBe('missing_win_rate_default_allow');
    }
  });

  it('once trades have closed the gate prices the observed win rate again (no permanent bypass)', () => {
    const metaFilter = new MetaFilter({ logDecisions: false }, makeLogger());
    const s = SESSION_SIGNALS[1]; // ETH-PERP-INTX: 5 bps taker, so a 50% WR at 2.4R is positive EV
    const signal = makeSignal(s.symbol, s.price, s.atr);
    metaFilter.filter(signal, { regime: 'weak_trend' });

    const outcome = (kind: 'win' | 'loss', pnl: number) => ({
      signalId: signal.id, strategy: 'trend_follow', symbol: s.symbol, direction: 'buy' as const,
      signalStrength: 0.6, entryTime: new Date(), exitTime: new Date(), pnl, outcome: kind,
      hourOfDay: 16, dayOfWeek: 1, filtersPassed: [], filtersBlocked: [],
    });
    metaFilter.recordTradeOutcome(outcome('win', 30), false);
    metaFilter.recordTradeOutcome(outcome('loss', -12), false);

    const perf = metaFilter.getStrategyPerformance('trend_follow')!;
    expect(perf.totalTrades).toBe(2);
    expect(observedWinRate(perf)).toBe(0.5);

    const size = sizeLikeTheRouter(signal.price, signal.stopLoss, s.riskPerTrade, s.multiplier);
    const priced = evaluateEvGate({
      symbol: s.symbol, strategy: 'trend_follow', direction: 'buy',
      entryPrice: signal.price, stopPrice: signal.stopLoss, takeProfit: signal.takeProfit, size,
      winRate: observedWinRate(perf), sampleSize: perf.totalTrades, feeModel: FEE_MODEL, minEvThreshold: 0,
    }, makeLogger());
    expect(priced.pSource).toBe('observed');
    expect(priced.p).toBe(0.5);
    expect(priced.reason).toBeUndefined();
    expect(priced.allowed).toBe(true);
  });
});
