/**
 * Agentic layer tests — full coverage of all components with mocked
 * Anthropic transport. Proves:
 *   1. size_multiplier can ONLY decrease (never > 1.0)
 *   2. Cost cap auto-disables all calls
 *   3. Feature flags gate every component
 *   4. Token accounting is accurate
 *   5. Parsing handles malformed responses gracefully
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AnthropicClient } from '../agentic/anthropic-client';
import type {
  AnthropicTransport,
  AnthropicRequest,
  AnthropicResponse,
  AnthropicBatchResponse,
} from '../agentic/anthropic-client';
import { CostTracker } from '../agentic/cost-tracker';
import { NewsFilter } from '../agentic/news-filter';
import {
  RegimeAdvisor,
  clampMultiplier,
  parseRegimeAdvisory,
} from '../agentic/regime-advisor';
import type { MarketSnapshot } from '../agentic/regime-advisor';
import { DailyRiskReview } from '../agentic/daily-risk-review';
import type { DailyReviewData } from '../agentic/daily-risk-review';
import { ResearchAgent } from '../agentic/research-agent';
import type { BacktestResult } from '../agentic/research-agent';
import { PRReviewer } from '../agentic/pr-reviewer';
import { MODEL_PRICING } from '../agentic/types';
import type { AgenticConfig } from '../config/loadGuardrails';
import type { Logger } from '../core/logger';

function makeLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function makeConfig(overrides: Partial<AgenticConfig> = {}): AgenticConfig {
  return {
    enabled: true,
    monthly_cost_cap_usd: 190,
    models: {
      news_filter: 'claude-haiku-5-5',
      regime_advisor: 'claude-opus-5-5',
      daily_review: 'claude-opus-5-5',
      research: 'claude-opus-5-5',
      pr_reviewer: 'claude-opus-5-5',
    },
    components: {
      news_filter: true,
      regime_advisor: true,
      daily_review: true,
      research: true,
      pr_reviewer: true,
    },
    regime_advisor_interval_min: 60,
    daily_review_hour_utc: 5,
    research_start_hour_utc: 6,
    research_max_sweeps: 10,
    ...overrides,
  };
}

function makeResponse(text: string, model = 'claude-opus-5-5'): AnthropicResponse {
  return {
    id: 'msg_test',
    content: [{ type: 'text', text }],
    model,
    stop_reason: 'end_turn',
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 10,
      cache_creation_input_tokens: 5,
    },
  };
}

function makeMockTransport(response?: AnthropicResponse): AnthropicTransport {
  return {
    createMessage: vi.fn().mockResolvedValue(response ?? makeResponse('test')),
    createBatch: vi.fn().mockResolvedValue({
      id: 'batch_test',
      type: 'message_batch',
      processing_status: 'in_progress',
      request_counts: { processing: 1, succeeded: 0, errored: 0, canceled: 0, expired: 0 },
      ended_at: null,
      results_url: null,
    } satisfies AnthropicBatchResponse),
    getBatch: vi.fn().mockResolvedValue({
      id: 'batch_test',
      type: 'message_batch',
      processing_status: 'ended',
      request_counts: { processing: 0, succeeded: 1, errored: 0, canceled: 0, expired: 0 },
      ended_at: '2026-10-19T00:00:00Z',
      results_url: 'https://api.anthropic.com/v1/messages/batches/batch_test/results',
    } satisfies AnthropicBatchResponse),
    getBatchResults: vi.fn().mockResolvedValue([{
      custom_id: 'daily-review-2026-10-19',
      result: {
        type: 'succeeded',
        message: makeResponse('# Daily Review\n\nAll good.'),
      },
    }]),
  };
}

// ==========================================================================
// clampMultiplier — the core safety invariant
// ==========================================================================
describe('clampMultiplier', () => {
  it('clamps values > 1 to exactly 1', () => {
    expect(clampMultiplier(1.5)).toBe(1.0);
    expect(clampMultiplier(100)).toBe(1.0);
    expect(clampMultiplier(1.0001)).toBe(1.0);
  });

  it('preserves values in (0, 1]', () => {
    expect(clampMultiplier(0.5)).toBe(0.5);
    expect(clampMultiplier(1.0)).toBe(1.0);
    expect(clampMultiplier(0.01)).toBe(0.01);
  });

  it('floors zero/negative/NaN to 0.01', () => {
    expect(clampMultiplier(0)).toBe(0.01);
    expect(clampMultiplier(-1)).toBe(0.01);
    expect(clampMultiplier(NaN)).toBe(0.01);
    expect(clampMultiplier(Infinity)).toBe(1.0);
    expect(clampMultiplier(-Infinity)).toBe(0.01);
  });
});

// ==========================================================================
// parseRegimeAdvisory
// ==========================================================================
describe('parseRegimeAdvisory', () => {
  it('parses valid JSON and clamps multiplier', () => {
    const json = JSON.stringify({
      regime: 'weak_trend',
      confidence: 0.8,
      size_multiplier: 0.7,
      pause_entries: false,
      reasoning: 'Test',
    });
    const result = parseRegimeAdvisory(json);
    expect(result).not.toBeNull();
    expect(result!.regime).toBe('weak_trend');
    expect(result!.size_multiplier).toBe(0.7);
    expect(result!.pause_entries).toBe(false);
  });

  it('clamps size_multiplier > 1 to 1', () => {
    const json = JSON.stringify({
      regime: 'strong_trend',
      confidence: 0.9,
      size_multiplier: 2.5,
      pause_entries: false,
      reasoning: 'Bullish',
    });
    const result = parseRegimeAdvisory(json);
    expect(result).not.toBeNull();
    expect(result!.size_multiplier).toBe(1.0);
  });

  it('clamps size_multiplier <= 0 to 0.01', () => {
    const json = JSON.stringify({
      regime: 'crisis',
      confidence: 0.95,
      size_multiplier: -0.5,
      pause_entries: true,
      reasoning: 'Panic',
    });
    const result = parseRegimeAdvisory(json);
    expect(result).not.toBeNull();
    expect(result!.size_multiplier).toBe(0.01);
  });

  it('returns null for invalid JSON', () => {
    expect(parseRegimeAdvisory('not json')).toBeNull();
    expect(parseRegimeAdvisory('')).toBeNull();
  });

  it('clamps confidence to [0, 1]', () => {
    const json = JSON.stringify({
      regime: 'ranging',
      confidence: 1.5,
      size_multiplier: 0.5,
      pause_entries: false,
      reasoning: 'Test',
    });
    const result = parseRegimeAdvisory(json);
    expect(result!.confidence).toBe(1.0);
  });
});

// ==========================================================================
// CostTracker
// ==========================================================================
describe('CostTracker', () => {
  it('computes cost for haiku correctly', () => {
    const logger = makeLogger();
    const tracker = new CostTracker(null, 190, logger);

    const cost = tracker.computeCost('claude-haiku-5-5', {
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    }, false);

    expect(cost).toBeCloseTo(0.10 + 0.50, 4);
  });

  it('computes cost for opus correctly', () => {
    const logger = makeLogger();
    const tracker = new CostTracker(null, 190, logger);

    const cost = tracker.computeCost('claude-opus-5-5', {
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    }, false);

    expect(cost).toBeCloseTo(4.0 + 20.0, 4);
  });

  it('applies batch discount', () => {
    const logger = makeLogger();
    const tracker = new CostTracker(null, 190, logger);

    const regular = tracker.computeCost('claude-opus-5-5', {
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    }, false);

    const batch = tracker.computeCost('claude-opus-5-5', {
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    }, true);

    expect(batch).toBeCloseTo(regular * 0.5, 4);
  });

  it('includes cache pricing', () => {
    const logger = makeLogger();
    const tracker = new CostTracker(null, 190, logger);

    const cost = tracker.computeCost('claude-opus-5-5', {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 1_000_000,
      cache_creation_input_tokens: 1_000_000,
    }, false);

    const pricing = MODEL_PRICING['claude-opus-5-5']!;
    expect(cost).toBeCloseTo(pricing.cache_read_per_mtok + pricing.cache_write_per_mtok, 4);
  });

  it('tracks monthly spend and enforces cap', async () => {
    const logger = makeLogger();
    const tracker = new CostTracker(null, 1.0, logger);

    expect(tracker.isCapReached()).toBe(false);

    await tracker.recordCall({
      component: 'news_filter',
      model: 'claude-opus-5-5',
      usage: {
        input_tokens: 1_000_000,
        output_tokens: 1_000_000,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
      durationMs: 100,
      isBatch: false,
    });

    expect(tracker.isCapReached()).toBe(true);
    expect(tracker.getMonthlySpend()).toBeGreaterThan(1.0);
  });

  it('does not count failed calls toward spend', async () => {
    const logger = makeLogger();
    const tracker = new CostTracker(null, 190, logger);

    await tracker.recordCall({
      component: 'news_filter',
      model: 'claude-haiku-5-5',
      usage: {
        input_tokens: 1_000_000,
        output_tokens: 1_000_000,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
      durationMs: 100,
      isBatch: false,
      error: 'API timeout',
    });

    expect(tracker.getMonthlySpend()).toBe(0);
  });
});

// ==========================================================================
// AnthropicClient
// ==========================================================================
describe('AnthropicClient', () => {
  it('returns null when cost cap is reached', async () => {
    const logger = makeLogger();
    const tracker = new CostTracker(null, 0, logger);
    await tracker.recordCall({
      component: 'news_filter',
      model: 'claude-haiku-5-5',
      usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      durationMs: 1,
      isBatch: false,
    });

    const transport = makeMockTransport();
    const client = new AnthropicClient(transport, tracker, logger);

    const result = await client.callModel('news_filter', {
      model: 'claude-haiku-5-5',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'test' }],
    });

    expect(result).toBeNull();
    expect(transport.createMessage).not.toHaveBeenCalled();
  });

  it('records usage after successful call', async () => {
    const logger = makeLogger();
    const tracker = new CostTracker(null, 190, logger);
    const spy = vi.spyOn(tracker, 'recordCall');

    const transport = makeMockTransport();
    const client = new AnthropicClient(transport, tracker, logger);

    await client.callModel('regime_advisor', {
      model: 'claude-opus-5-5',
      max_tokens: 512,
      messages: [{ role: 'user', content: 'test' }],
    });

    expect(spy).toHaveBeenCalledOnce();
    expect(spy.mock.calls[0]![0].component).toBe('regime_advisor');
    expect(spy.mock.calls[0]![0].error).toBeUndefined();
  });

  it('records error calls without cost', async () => {
    const logger = makeLogger();
    const tracker = new CostTracker(null, 190, logger);
    const spy = vi.spyOn(tracker, 'recordCall');

    const transport = makeMockTransport();
    (transport.createMessage as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('API error'));

    const client = new AnthropicClient(transport, tracker, logger);

    await expect(client.callModel('news_filter', {
      model: 'claude-haiku-5-5',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'test' }],
    })).rejects.toThrow('API error');

    expect(spy).toHaveBeenCalledOnce();
    expect(spy.mock.calls[0]![0].error).toBe('API error');
  });
});

// ==========================================================================
// NewsFilter
// ==========================================================================
describe('NewsFilter', () => {
  it('returns null when disabled', async () => {
    const logger = makeLogger();
    const config = makeConfig({ enabled: false });
    const tracker = new CostTracker(null, 190, logger);
    const transport = makeMockTransport();
    const client = new AnthropicClient(transport, tracker, logger);
    const filter = new NewsFilter(client, config, logger);

    const result = await filter.classifyHeadline('Bitcoin hits new ATH');
    expect(result).toBeNull();
  });

  it('classifies a headline successfully', async () => {
    const logger = makeLogger();
    const config = makeConfig();
    const tracker = new CostTracker(null, 190, logger);
    const response = makeResponse(
      JSON.stringify({
        relevance: 'high',
        severity: 'major',
        assets: ['BTC'],
        summary: 'New all-time high',
      }),
      'claude-haiku-5-5',
    );
    const transport = makeMockTransport(response);
    const client = new AnthropicClient(transport, tracker, logger);
    const filter = new NewsFilter(client, config, logger);

    const result = await filter.classifyHeadline('Bitcoin hits new all-time high of $200k');
    expect(result).not.toBeNull();
    expect(result!.relevance).toBe('high');
    expect(result!.severity).toBe('major');
    expect(result!.assets).toContain('BTC');
  });

  it('returns null for unparseable response', async () => {
    const logger = makeLogger();
    const config = makeConfig();
    const tracker = new CostTracker(null, 190, logger);
    const response = makeResponse('not valid json', 'claude-haiku-5-5');
    const transport = makeMockTransport(response);
    const client = new AnthropicClient(transport, tracker, logger);
    const filter = new NewsFilter(client, config, logger);

    const result = await filter.classifyHeadline('Some headline');
    expect(result).toBeNull();
  });
});

// ==========================================================================
// RegimeAdvisor
// ==========================================================================
describe('RegimeAdvisor', () => {
  const snapshot: MarketSnapshot = {
    symbol: 'BTC-USD',
    recentBars: Array.from({ length: 10 }, (_, i) => ({
      open: 60000 + i * 100,
      high: 60100 + i * 100,
      low: 59900 + i * 100,
      close: 60050 + i * 100,
      volume: 1000,
      timestamp: new Date(Date.now() - (10 - i) * 900_000).toISOString(),
    })),
    atr14: 1500,
    currentPrice: 61000,
    dailyChange: -0.02,
    volatility30d: 0.45,
  };

  it('returns null when disabled', async () => {
    const logger = makeLogger();
    const config = makeConfig({ enabled: false });
    const tracker = new CostTracker(null, 190, logger);
    const transport = makeMockTransport();
    const client = new AnthropicClient(transport, tracker, logger);
    const advisor = new RegimeAdvisor(client, config, logger);

    const result = await advisor.assess([snapshot]);
    expect(result).toBeNull();
  });

  it('parses a valid regime advisory', async () => {
    const logger = makeLogger();
    const config = makeConfig({ regime_advisor_interval_min: 0 });
    const tracker = new CostTracker(null, 190, logger);
    const response = makeResponse(JSON.stringify({
      regime: 'weak_trend',
      confidence: 0.75,
      size_multiplier: 0.6,
      pause_entries: false,
      reasoning: 'Weakening momentum',
    }));
    const transport = makeMockTransport(response);
    const client = new AnthropicClient(transport, tracker, logger);
    const advisor = new RegimeAdvisor(client, config, logger);

    const result = await advisor.assess([snapshot]);
    expect(result).not.toBeNull();
    expect(result!.regime).toBe('weak_trend');
    expect(result!.size_multiplier).toBe(0.6);
  });

  it('SAFETY: clamps multiplier > 1 in advisory response', async () => {
    const logger = makeLogger();
    const config = makeConfig({ regime_advisor_interval_min: 0 });
    const tracker = new CostTracker(null, 190, logger);
    const response = makeResponse(JSON.stringify({
      regime: 'strong_trend',
      confidence: 0.95,
      size_multiplier: 2.0,
      pause_entries: false,
      reasoning: 'Very bullish — double size',
    }));
    const transport = makeMockTransport(response);
    const client = new AnthropicClient(transport, tracker, logger);
    const advisor = new RegimeAdvisor(client, config, logger);

    const result = await advisor.assess([snapshot]);
    expect(result).not.toBeNull();
    expect(result!.size_multiplier).toBe(1.0);
    expect(result!.size_multiplier).toBeLessThanOrEqual(1.0);
  });

  it('SAFETY: applyToSize never increases size', async () => {
    const logger = makeLogger();
    const config = makeConfig({ regime_advisor_interval_min: 0 });
    const tracker = new CostTracker(null, 190, logger);
    const response = makeResponse(JSON.stringify({
      regime: 'weak_trend',
      confidence: 0.8,
      size_multiplier: 0.5,
      pause_entries: false,
      reasoning: 'Reduce',
    }));
    const transport = makeMockTransport(response);
    const client = new AnthropicClient(transport, tracker, logger);
    const advisor = new RegimeAdvisor(client, config, logger);

    await advisor.assess([snapshot]);

    const original = 100;
    const adjusted = advisor.applyToSize(original);
    expect(adjusted).toBeLessThanOrEqual(original);
    expect(adjusted).toBe(50);
  });

  it('SAFETY: applyToSize with multiplier > 1 still caps at input', async () => {
    const logger = makeLogger();
    const config = makeConfig({ regime_advisor_interval_min: 0 });
    const tracker = new CostTracker(null, 190, logger);
    const response = makeResponse(JSON.stringify({
      regime: 'strong_trend',
      confidence: 0.99,
      size_multiplier: 5.0,
      pause_entries: false,
      reasoning: 'Go big',
    }));
    const transport = makeMockTransport(response);
    const client = new AnthropicClient(transport, tracker, logger);
    const advisor = new RegimeAdvisor(client, config, logger);

    await advisor.assess([snapshot]);

    const original = 100;
    const adjusted = advisor.applyToSize(original);
    expect(adjusted).toBeLessThanOrEqual(original);
    expect(adjusted).toBe(100);
  });

  it('SAFETY: returns unchanged size when no advisory', () => {
    const logger = makeLogger();
    const config = makeConfig();
    const tracker = new CostTracker(null, 190, logger);
    const transport = makeMockTransport();
    const client = new AnthropicClient(transport, tracker, logger);
    const advisor = new RegimeAdvisor(client, config, logger);

    expect(advisor.applyToSize(100)).toBe(100);
  });

  it('respects interval — skips if called too soon', async () => {
    const logger = makeLogger();
    const config = makeConfig({ regime_advisor_interval_min: 60 });
    const tracker = new CostTracker(null, 190, logger);
    const response = makeResponse(JSON.stringify({
      regime: 'ranging',
      confidence: 0.6,
      size_multiplier: 0.8,
      pause_entries: false,
      reasoning: 'Sideways',
    }));
    const transport = makeMockTransport(response);
    const client = new AnthropicClient(transport, tracker, logger);
    const advisor = new RegimeAdvisor(client, config, logger);

    const first = await advisor.assess([snapshot]);
    expect(first).not.toBeNull();

    const second = await advisor.assess([snapshot]);
    expect(second).toBe(first);
    expect(transport.createMessage).toHaveBeenCalledTimes(1);
  });
});

// ==========================================================================
// DailyRiskReview
// ==========================================================================
describe('DailyRiskReview', () => {
  const reviewData: DailyReviewData = {
    date: '2026-10-19',
    trades: [{
      symbol: 'BTC-USD',
      side: 'buy',
      entry_price: 60000,
      exit_price: 61000,
      pnl: 50,
      strategy: 'trend_follow',
    }],
    risk_events: [],
    gate_blocks: [],
    equity_start: 10000,
    equity_end: 10050,
    drawdown_pct: 0,
    daily_r: 1.0,
  };

  it('returns null when disabled', async () => {
    const logger = makeLogger();
    const config = makeConfig({ enabled: false });
    const tracker = new CostTracker(null, 190, logger);
    const transport = makeMockTransport();
    const client = new AnthropicClient(transport, tracker, logger);
    const review = new DailyRiskReview(client, tracker, null, config, logger);

    const result = await review.submitReview(reviewData);
    expect(result).toBeNull();
  });

  it('submits a batch request', async () => {
    const logger = makeLogger();
    const config = makeConfig();
    const tracker = new CostTracker(null, 190, logger);
    const transport = makeMockTransport();
    const client = new AnthropicClient(transport, tracker, logger);
    const review = new DailyRiskReview(client, tracker, null, config, logger);

    const batchId = await review.submitReview(reviewData);
    expect(batchId).toBe('batch_test');
    expect(transport.createBatch).toHaveBeenCalledOnce();
  });

  it('collects batch result and generates markdown', async () => {
    const logger = makeLogger();
    const config = makeConfig();
    const tracker = new CostTracker(null, 190, logger);
    const transport = makeMockTransport();
    const client = new AnthropicClient(transport, tracker, logger);
    const review = new DailyRiskReview(client, tracker, null, config, logger);

    const markdown = await review.collectResult('batch_test');
    expect(markdown).toBe('# Daily Review\n\nAll good.');
  });
});

// ==========================================================================
// ResearchAgent
// ==========================================================================
describe('ResearchAgent', () => {
  const results: BacktestResult[] = [
    {
      parameters: { stopAtr: 2.5, takeProfitAtr: 6.0 },
      profit_factor: 1.4,
      total_trades: 50,
      win_rate: 0.45,
      net_pnl: 500,
      max_drawdown: -200,
      sharpe_ratio: 1.2,
      period: '2026-01 to 2026-06',
      is_out_of_sample: false,
    },
    {
      parameters: { stopAtr: 2.5, takeProfitAtr: 6.0 },
      profit_factor: 1.1,
      total_trades: 30,
      win_rate: 0.40,
      net_pnl: 100,
      max_drawdown: -150,
      sharpe_ratio: 0.8,
      period: '2026-07 to 2026-10',
      is_out_of_sample: true,
    },
  ];

  it('returns null when disabled', async () => {
    const logger = makeLogger();
    const config = makeConfig({ enabled: false });
    const tracker = new CostTracker(null, 190, logger);
    const transport = makeMockTransport();
    const client = new AnthropicClient(transport, tracker, logger);
    const agent = new ResearchAgent(client, null, config, logger);

    const result = await agent.analyzeResults('trend_follow', results);
    expect(result).toBeNull();
  });

  it('parses a research card', async () => {
    const logger = makeLogger();
    const config = makeConfig();
    const tracker = new CostTracker(null, 190, logger);
    const response = makeResponse(JSON.stringify({
      strategy: 'trend_follow',
      parameters_tested: [{ stopAtr: 2.5, takeProfitAtr: 6.0 }],
      best_parameters: { stopAtr: 2.5, takeProfitAtr: 6.0 },
      walk_forward_passed: true,
      out_of_sample_passed: true,
      overfit_warning: false,
      summary: 'Parameters hold up well',
      backtest_command: 'pnpm exec tsx src/cli/backtest.ts --start-date 2026-01-01 --end-date 2026-10-01 --products BTC-USD',
    }));
    const transport = makeMockTransport(response);
    const client = new AnthropicClient(transport, tracker, logger);
    const agent = new ResearchAgent(client, null, config, logger);

    const card = await agent.analyzeResults('trend_follow', results);
    expect(card).not.toBeNull();
    expect(card!.walk_forward_passed).toBe(true);
    expect(card!.overfit_warning).toBe(false);
  });
});

// ==========================================================================
// PRReviewer
// ==========================================================================
describe('PRReviewer', () => {
  it('returns null when disabled', async () => {
    const logger = makeLogger();
    const config = makeConfig({ enabled: false });
    const tracker = new CostTracker(null, 190, logger);
    const transport = makeMockTransport();
    const client = new AnthropicClient(transport, tracker, logger);
    const reviewer = new PRReviewer(client, config, logger);

    const result = await reviewer.reviewPR(42);
    expect(result).toBeNull();
  });

  it('formats a report correctly', () => {
    const logger = makeLogger();
    const config = makeConfig();
    const tracker = new CostTracker(null, 190, logger);
    const transport = makeMockTransport();
    const client = new AnthropicClient(transport, tracker, logger);
    const reviewer = new PRReviewer(client, config, logger);

    const report = reviewer.formatReport({
      pr_number: 42,
      summary: 'Looks good overall',
      findings: [
        { severity: 'minor', file: 'src/foo.ts', line: 10, message: 'Consider renaming' },
      ],
      approved: true,
      timestamp: '2026-10-19T00:00:00Z',
    });

    expect(report).toContain('PR #42');
    expect(report).toContain('Looks good overall');
    expect(report).toContain('[MINOR]');
    expect(report).toContain('src/foo.ts:10');
  });
});

// ==========================================================================
// MODEL_PRICING completeness
// ==========================================================================
describe('MODEL_PRICING', () => {
  it('has entries for all configured models', () => {
    const config = makeConfig();
    const models = Object.values(config.models);
    for (const model of models) {
      expect(MODEL_PRICING).toHaveProperty(model);
    }
  });

  it('batch_discount is 0.5 for all models', () => {
    for (const [, pricing] of Object.entries(MODEL_PRICING)) {
      expect(pricing.batch_discount).toBe(0.5);
    }
  });
});

// ==========================================================================
// Config integration — feature flag gating
// ==========================================================================
describe('Feature flag gating', () => {
  it('all components return null when agentic.enabled is false', async () => {
    const logger = makeLogger();
    const config = makeConfig({ enabled: false });
    const tracker = new CostTracker(null, 190, logger);
    const transport = makeMockTransport();
    const client = new AnthropicClient(transport, tracker, logger);

    const newsFilter = new NewsFilter(client, config, logger);
    const regimeAdvisor = new RegimeAdvisor(client, config, logger);
    const dailyReview = new DailyRiskReview(client, tracker, null, config, logger);
    const research = new ResearchAgent(client, null, config, logger);
    const prReviewer = new PRReviewer(client, config, logger);

    expect(await newsFilter.classifyHeadline('test')).toBeNull();
    expect(await regimeAdvisor.assess([])).toBeNull();
    expect(await dailyReview.submitReview({
      date: '2026-10-19', trades: [], risk_events: [], gate_blocks: [],
      equity_start: 10000, equity_end: 10000, drawdown_pct: 0, daily_r: 0,
    })).toBeNull();
    expect(await research.analyzeResults('trend_follow', [])).toBeNull();
    expect(await prReviewer.reviewPR(1)).toBeNull();

    expect(transport.createMessage).not.toHaveBeenCalled();
  });

  it('individual component flags are respected', async () => {
    const logger = makeLogger();
    const config = makeConfig({
      components: {
        news_filter: false,
        regime_advisor: true,
        daily_review: false,
        research: false,
        pr_reviewer: false,
      },
    });
    const tracker = new CostTracker(null, 190, logger);
    const transport = makeMockTransport();
    const client = new AnthropicClient(transport, tracker, logger);

    const newsFilter = new NewsFilter(client, config, logger);
    expect(await newsFilter.classifyHeadline('test')).toBeNull();
    expect(transport.createMessage).not.toHaveBeenCalled();
  });
});

// ==========================================================================
// Safety invariant: size can only decrease — comprehensive proof
// ==========================================================================
describe('SAFETY: size_multiplier can ONLY decrease position size', () => {
  const multipliers = [0.01, 0.1, 0.25, 0.5, 0.75, 0.99, 1.0, 1.01, 1.5, 2.0, 5.0, 100.0];

  for (const m of multipliers) {
    it(`clampMultiplier(${m}) <= 1.0`, () => {
      expect(clampMultiplier(m)).toBeLessThanOrEqual(1.0);
    });
  }

  const baseSizes = [10, 100, 1000, 0.001, 50000];
  for (const baseSize of baseSizes) {
    for (const m of multipliers) {
      it(`applyToSize(${baseSize}) with multiplier=${m} never exceeds ${baseSize}`, async () => {
        const logger = makeLogger();
        const config = makeConfig({ regime_advisor_interval_min: 0 });
        const tracker = new CostTracker(null, 190, logger);
        const response = makeResponse(JSON.stringify({
          regime: 'test',
          confidence: 0.5,
          size_multiplier: m,
          pause_entries: false,
          reasoning: 'test',
        }));
        const transport = makeMockTransport(response);
        const client = new AnthropicClient(transport, tracker, logger);
        const advisor = new RegimeAdvisor(client, config, logger);

        await advisor.assess([{
          symbol: 'BTC-USD',
          recentBars: [],
          atr14: 1500,
          currentPrice: 60000,
          dailyChange: 0,
          volatility30d: 0.3,
        }]);

        const adjusted = advisor.applyToSize(baseSize);
        expect(adjusted).toBeLessThanOrEqual(baseSize);
        expect(adjusted).toBeGreaterThanOrEqual(0);
      });
    }
  }
});
