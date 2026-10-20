/**
 * Daily risk review — Opus via Message Batches API (50% cost).
 *
 * Summarizes the day's trades, drawdown, gate blocks, and risk events.
 * Writes a report row to `agentic_reports` + a markdown summary.
 * Submitted as a batch request — latency does not matter.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Logger } from '../core/logger';
import type { AnthropicClient, AnthropicBatchRequest } from './anthropic-client';
import type { AgenticConfig } from '../config/loadGuardrails';
import type { CostTracker } from './cost-tracker';

const SYSTEM_PROMPT = `You are a risk review analyst for a crypto algorithmic trading system.
Produce a daily risk review report in markdown format with the following sections:

## Daily Risk Review — {date}

### Summary
Brief overview of the trading day.

### Trade Activity
- Total trades, win/loss breakdown
- P&L summary (realized, unrealized)
- Best/worst trades

### Risk Events
- Kill ladder activations (L1-L6)
- Gate blocks (regime, EV, cooldown)
- Circuit breaker events

### Drawdown Analysis
- Current drawdown from HWM
- Daily R
- Weekly loss position

### Recommendations
- Advisory observations (not orders — purely informational)
- Areas of concern

Use concrete numbers from the provided data. Be concise.`;

export interface DailyReviewData {
  date: string;
  trades: Array<{
    symbol: string;
    side: string;
    entry_price: number;
    exit_price: number | null;
    pnl: number;
    strategy: string;
  }>;
  risk_events: Array<{
    type: string;
    reason: string;
    timestamp: string;
  }>;
  gate_blocks: Array<{
    stage: string;
    reason: string;
    count: number;
  }>;
  equity_start: number;
  equity_end: number;
  drawdown_pct: number;
  daily_r: number;
}

export class DailyRiskReview {
  constructor(
    private readonly client: AnthropicClient,
    private readonly costTracker: CostTracker,
    private readonly supabase: SupabaseClient | null,
    private readonly config: AgenticConfig,
    private readonly logger: Logger,
  ) {}

  /**
   * Submit the daily review as a batch request. Returns the batch ID
   * for later result retrieval.
   */
  async submitReview(data: DailyReviewData): Promise<string | null> {
    if (!this.config.enabled || !this.config.components.daily_review) {
      return null;
    }

    const model = this.config.models.daily_review;
    const batchRequest: AnthropicBatchRequest = {
      custom_id: `daily-review-${data.date}`,
      params: {
        model,
        max_tokens: 4096,
        system: SYSTEM_PROMPT,
        messages: [{
          role: 'user',
          content: `Generate the daily risk review for ${data.date}.\n\nTrading data:\n${JSON.stringify(data, null, 2)}`,
        }],
        temperature: 0,
      },
    };

    const batch = await this.client.submitBatch('daily_review', [batchRequest]);
    if (!batch) return null;

    this.logger.info('DailyRiskReview: batch submitted', { batchId: batch.id, date: data.date });
    return batch.id;
  }

  /**
   * Poll for batch completion and persist the report when ready.
   * Returns the markdown report, or null if not yet complete.
   */
  async collectResult(batchId: string): Promise<string | null> {
    const status = await this.client.getBatchStatus(batchId);

    if (status.processing_status !== 'ended') {
      this.logger.info('DailyRiskReview: batch still processing', {
        batchId,
        status: status.processing_status,
        counts: status.request_counts,
      });
      return null;
    }

    if (!status.results_url) {
      this.logger.warn('DailyRiskReview: batch ended with no results URL', { batchId });
      return null;
    }

    const results = await this.client.getBatchResults(status.results_url);
    const result = results[0];

    if (!result || result.result.type !== 'succeeded' || !result.result.message) {
      this.logger.warn('DailyRiskReview: batch result failed', {
        batchId,
        type: result?.result.type,
        error: result?.result.error?.message,
      });
      return null;
    }

    const message = result.result.message;
    const markdown = message.content[0]?.text ?? '';

    await this.costTracker.recordCall({
      component: 'daily_review',
      model: message.model,
      usage: {
        input_tokens: message.usage.input_tokens,
        output_tokens: message.usage.output_tokens,
        cache_read_input_tokens: message.usage.cache_read_input_tokens ?? 0,
        cache_creation_input_tokens: message.usage.cache_creation_input_tokens ?? 0,
      },
      durationMs: 0,
      isBatch: true,
      batchId,
    });

    if (this.supabase) {
      try {
        await this.supabase.from('agentic_reports').insert({
          report_type: 'daily_risk_review',
          title: `Daily Risk Review — ${result.custom_id.replace('daily-review-', '')}`,
          markdown,
          metadata: { batchId, requestCounts: status.request_counts },
        });
      } catch (err) {
        this.logger.warn('DailyRiskReview: failed to persist report', { error: (err as Error).message });
      }
    }

    this.logger.info('DailyRiskReview: report generated', {
      batchId,
      markdownLength: markdown.length,
    });

    return markdown;
  }
}
