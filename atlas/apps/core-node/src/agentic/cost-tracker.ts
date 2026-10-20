/**
 * Cost tracker — per-call token accounting with monthly cap enforcement.
 *
 * Records every Anthropic API call to the `agentic_calls` Supabase table
 * and maintains a running monthly total. When the cumulative spend reaches
 * `monthly_cost_cap_usd`, all agentic components auto-disable for the rest
 * of the calendar month.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { Logger } from '../core/logger';
import type { AgenticCallRow, AgenticComponent, ModelPricing, TokenUsage } from './types';
import { MODEL_PRICING } from './types';

export interface RecordCallInput {
  component: AgenticComponent;
  model: string;
  usage: TokenUsage;
  durationMs: number;
  isBatch: boolean;
  batchId?: string;
  metadata?: Record<string, unknown>;
  error?: string;
}

export class CostTracker {
  private monthlySpendUsd = 0;
  private monthKey = ''; // 'YYYY-MM'
  private initialized = false;

  constructor(
    private readonly supabase: SupabaseClient | null,
    private readonly monthlyCostCapUsd: number,
    private readonly logger: Logger,
  ) {}

  /**
   * Load the current month's spend from Supabase. Call once at startup.
   * Safe to call without Supabase (spend starts at 0, cap still enforced
   * against in-memory accumulation).
   */
  async initialize(): Promise<void> {
    this.monthKey = currentMonthKey();
    if (!this.supabase) {
      this.logger.warn('CostTracker: no Supabase client; spend tracking is in-memory only');
      this.initialized = true;
      return;
    }

    try {
      const startOfMonth = `${this.monthKey}-01T00:00:00Z`;
      const { data, error } = await this.supabase
        .from('agentic_calls')
        .select('cost_usd')
        .gte('created_at', startOfMonth)
        .is('error', null);

      if (error) {
        this.logger.warn('CostTracker: failed to load monthly spend', { error: error.message });
      } else if (data) {
        this.monthlySpendUsd = data.reduce((sum, row) => sum + Number(row.cost_usd), 0);
        this.logger.info('CostTracker: loaded monthly spend', {
          month: this.monthKey,
          spend: this.monthlySpendUsd.toFixed(4),
          cap: this.monthlyCostCapUsd,
        });
      }
    } catch (err) {
      this.logger.warn('CostTracker: error loading monthly spend', { error: (err as Error).message });
    }
    this.initialized = true;
  }

  /** Whether the monthly cost cap has been reached. */
  isCapReached(): boolean {
    this.rollMonthIfNeeded();
    return this.monthlySpendUsd >= this.monthlyCostCapUsd;
  }

  /** Current month spend in USD. */
  getMonthlySpend(): number {
    this.rollMonthIfNeeded();
    return this.monthlySpendUsd;
  }

  /** Compute cost for a single call. */
  computeCost(model: string, usage: TokenUsage, isBatch: boolean): number {
    const pricing = this.getPricing(model);
    const inputCost = (usage.input_tokens / 1_000_000) * pricing.input_per_mtok;
    const outputCost = (usage.output_tokens / 1_000_000) * pricing.output_per_mtok;
    const cacheReadCost = (usage.cache_read_input_tokens / 1_000_000) * pricing.cache_read_per_mtok;
    const cacheWriteCost = (usage.cache_creation_input_tokens / 1_000_000) * pricing.cache_write_per_mtok;
    const total = inputCost + outputCost + cacheReadCost + cacheWriteCost;
    return isBatch ? total * pricing.batch_discount : total;
  }

  /**
   * Record a call's token usage and cost. Persists to Supabase when available,
   * always updates the in-memory running total.
   */
  async recordCall(input: RecordCallInput): Promise<void> {
    this.rollMonthIfNeeded();

    const cost = input.error ? 0 : this.computeCost(input.model, input.usage, input.isBatch);
    this.monthlySpendUsd += cost;

    const row: AgenticCallRow = {
      component: input.component,
      model: input.model,
      input_tokens: input.usage.input_tokens,
      output_tokens: input.usage.output_tokens,
      cache_read_tokens: input.usage.cache_read_input_tokens,
      cache_write_tokens: input.usage.cache_creation_input_tokens,
      cost_usd: cost,
      duration_ms: input.durationMs,
      batch_id: input.batchId ?? null,
      metadata: input.metadata ?? null,
      error: input.error ?? null,
    };

    if (this.supabase) {
      try {
        const { error } = await this.supabase.from('agentic_calls').insert(row);
        if (error) {
          this.logger.warn('CostTracker: failed to persist call', { error: error.message, component: input.component });
        }
      } catch (err) {
        this.logger.warn('CostTracker: error persisting call', { error: (err as Error).message });
      }
    }

    if (this.monthlySpendUsd >= this.monthlyCostCapUsd) {
      this.logger.warn('Agentic monthly cost cap reached', {
        spend: this.monthlySpendUsd.toFixed(4),
        cap: this.monthlyCostCapUsd,
      });
    }
  }

  private getPricing(model: string): ModelPricing {
    const pricing = MODEL_PRICING[model];
    if (pricing) return pricing;
    this.logger.warn(`CostTracker: unknown model pricing for "${model}", using opus-5-5 rates`);
    return MODEL_PRICING['claude-opus-5-5']!;
  }

  private rollMonthIfNeeded(): void {
    const now = currentMonthKey();
    if (now !== this.monthKey) {
      this.logger.info('CostTracker: new month, resetting spend', {
        previous: this.monthKey,
        previousSpend: this.monthlySpendUsd.toFixed(4),
        current: now,
      });
      this.monthKey = now;
      this.monthlySpendUsd = 0;
    }
  }
}

function currentMonthKey(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
