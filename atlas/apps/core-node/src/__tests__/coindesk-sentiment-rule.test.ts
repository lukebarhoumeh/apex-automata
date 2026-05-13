/**
 * Unit tests for the coindesk_sentiment soft-weight rule on MetaFilter.
 *
 * Asserts:
 *   - Rule is OFF by default (no rule appears in rulesEvaluated).
 *   - When ON without payload, rule abstains (neutral contribution).
 *   - When ON with positive sentiment, contribution shifts upward by ≤ bound.
 *   - When ON with negative sentiment, contribution shifts downward by ≤ bound.
 *   - SELL signals invert sentiment alignment (negative news = good for SELL).
 *   - Stale articles abstain.
 *   - 0-article aggregates abstain.
 *   - Rule never blocks a signal (allowed always reflects threshold logic only).
 *   - Symbol allowlist is honored (non-allowed symbol abstains).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MetaFilter, MetaFilterConfig } from '../strategies/meta-filter';
import { Signal } from '../strategies/signal-processor';
import { Logger } from '../core/logger';

const mockLogger: Logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

function buildSignal(overrides: Partial<Signal> = {}): Signal {
  return {
    id: `sig-${Math.random().toString(36).slice(2)}`,
    timestamp: new Date(),
    symbol: 'BTC-USD',
    strategy: 'momentum',
    direction: 'buy',
    strength: 0.6,
    price: 50_000,
    stopLoss: 49_000,
    takeProfit: 52_000,
    metadata: { indicators: {}, reason: 'test' },
    ...overrides,
  };
}

const SENTIMENT_ON: Partial<MetaFilterConfig> = {
  enabled: true,
  // Disable noisy rules so we can isolate the sentiment contribution.
  coldStreakEnabled: false,
  strengthFilterEnabled: false,
  volumeConfirmEnabled: false,
  timeFilterEnabled: false,
  crossConfirmEnabled: false,
  // Lower threshold so a single rule can pass.
  minQualityScore: 0.0,
  coindeskSentimentEnabled: true,
  coindeskSentimentLookbackMinutes: 60,
  coindeskSentimentStaleThresholdMs: 30 * 60 * 1000,
  coindeskSentimentWeightDeltaBound: 0.25,
  coindeskSentimentRuleWeight: 1.0,
  coindeskSentimentEnabledSymbols: ['BTC-USD', 'ETH-USD', 'SOL-USD'],
};

function findRule(result: ReturnType<MetaFilter['filter']>, name: string) {
  return result.rulesEvaluated.find((r) => r.rule === name);
}

describe('MetaFilter coindesk_sentiment rule — feature flag OFF', () => {
  it('does not include the rule in evaluation when disabled', () => {
    const mf = new MetaFilter(
      { coldStreakEnabled: false, minQualityScore: 0, coindeskSentimentEnabled: false },
      mockLogger
    );
    const result = mf.filter(buildSignal());
    expect(findRule(result, 'coindesk_sentiment')).toBeUndefined();
  });
});

describe('MetaFilter coindesk_sentiment rule — feature flag ON', () => {
  let mf: MetaFilter;

  beforeEach(() => {
    mf = new MetaFilter(SENTIMENT_ON, mockLogger);
  });

  it('abstains (neutral) when no sentiment payload is provided', () => {
    const result = mf.filter(buildSignal());
    const rule = findRule(result, 'coindesk_sentiment');
    expect(rule).toBeDefined();
    expect(rule!.passed).toBe(true);
    // Neutral contribution = 0.5 * weight (rule_weight = 1.0 here).
    expect(rule!.contribution).toBeCloseTo(0.5, 5);
    expect(rule!.reason).toMatch(/no sentiment payload/i);
  });

  it('abstains when articleCount = 0', () => {
    const result = mf.filter(buildSignal(), {
      coindeskSentiment: { score: 0, articleCount: 0, freshnessMs: Infinity },
    });
    const rule = findRule(result, 'coindesk_sentiment');
    expect(rule!.contribution).toBeCloseTo(0.5, 5);
    expect(rule!.reason).toMatch(/no articles/i);
  });

  it('abstains when freshness exceeds stale threshold', () => {
    const result = mf.filter(buildSignal(), {
      coindeskSentiment: { score: 0.8, articleCount: 5, freshnessMs: 60 * 60 * 1000 }, // 1h > 30m
    });
    const rule = findRule(result, 'coindesk_sentiment');
    expect(rule!.contribution).toBeCloseTo(0.5, 5);
    expect(rule!.reason).toMatch(/stale/i);
  });

  it('positive sentiment on a BUY signal nudges contribution UP by ≤ bound', () => {
    const result = mf.filter(buildSignal({ direction: 'buy' }), {
      coindeskSentiment: { score: 0.8, articleCount: 5, freshnessMs: 60_000 },
    });
    const rule = findRule(result, 'coindesk_sentiment');
    // delta = 0.8 * 0.25 = 0.20; contribution = 0.5 + 0.20 = 0.70
    expect(rule!.contribution).toBeCloseTo(0.5 + 0.8 * 0.25, 5);
    expect(rule!.contribution).toBeGreaterThan(0.5);
    expect(rule!.contribution).toBeLessThanOrEqual(0.5 + 0.25);
  });

  it('negative sentiment on a BUY signal nudges contribution DOWN by ≤ bound', () => {
    const result = mf.filter(buildSignal({ direction: 'buy' }), {
      coindeskSentiment: { score: -0.6, articleCount: 5, freshnessMs: 60_000 },
    });
    const rule = findRule(result, 'coindesk_sentiment');
    // delta = -0.6 * 0.25 = -0.15; contribution = 0.5 - 0.15 = 0.35
    expect(rule!.contribution).toBeCloseTo(0.5 + -0.6 * 0.25, 5);
    expect(rule!.contribution).toBeLessThan(0.5);
    expect(rule!.contribution).toBeGreaterThanOrEqual(0.5 - 0.25);
  });

  it('inverts polarity for SELL signals — negative news boosts a short', () => {
    const result = mf.filter(buildSignal({ direction: 'sell' }), {
      coindeskSentiment: { score: -0.8, articleCount: 5, freshnessMs: 60_000 },
    });
    const rule = findRule(result, 'coindesk_sentiment');
    // SELL inverts: directional = +0.8 → contribution > 0.5
    expect(rule!.contribution).toBeGreaterThan(0.5);
    expect(rule!.contribution).toBeCloseTo(0.5 + 0.8 * 0.25, 5);
  });

  it('clamps extreme positive scores to the configured bound', () => {
    const result = mf.filter(buildSignal({ direction: 'buy' }), {
      coindeskSentiment: { score: 5, articleCount: 5, freshnessMs: 0 }, // out of [-1, 1]
    });
    const rule = findRule(result, 'coindesk_sentiment');
    expect(rule!.contribution).toBeCloseTo(0.5 + 0.25, 5);
  });

  it('NEVER blocks a signal — passed is always true', () => {
    for (const score of [-1, -0.5, 0, 0.5, 1]) {
      const result = mf.filter(buildSignal(), {
        coindeskSentiment: { score, articleCount: 5, freshnessMs: 0 },
      });
      const rule = findRule(result, 'coindesk_sentiment');
      expect(rule!.passed).toBe(true);
    }
  });

  it('honors enabled_symbols allowlist — non-allowed symbol abstains', () => {
    const restricted = new MetaFilter(
      {
        ...SENTIMENT_ON,
        coindeskSentimentEnabledSymbols: ['BTC-USD'],
      },
      mockLogger
    );
    const result = restricted.filter(buildSignal({ symbol: 'XRP-USD' }), {
      coindeskSentiment: { score: 0.8, articleCount: 5, freshnessMs: 0 },
    });
    const rule = findRule(result, 'coindesk_sentiment');
    expect(rule!.contribution).toBeCloseTo(0.5, 5);
    expect(rule!.reason).toMatch(/not in coindesk allowlist/);
  });

  it('matches allowlist entries by base asset (BTC-PERP-INTX → BTC)', () => {
    const result = mf.filter(buildSignal({ symbol: 'BTC-PERP-INTX' }), {
      coindeskSentiment: { score: 0.8, articleCount: 5, freshnessMs: 60_000 },
    });
    const rule = findRule(result, 'coindesk_sentiment');
    expect(rule!.contribution).toBeGreaterThan(0.5);
  });
});

describe('MetaFilter coindesk_sentiment rule — accessors', () => {
  it('exposes the configured lookback window', () => {
    const mf = new MetaFilter(
      { coindeskSentimentEnabled: true, coindeskSentimentLookbackMinutes: 90 },
      mockLogger
    );
    expect(mf.getCoinDeskLookbackMinutes()).toBe(90);
    expect(mf.isCoinDeskSentimentEnabled()).toBe(true);
  });

  it('reports disabled when flag is off', () => {
    const mf = new MetaFilter({ coindeskSentimentEnabled: false }, mockLogger);
    expect(mf.isCoinDeskSentimentEnabled()).toBe(false);
  });
});
