/**
 * Agentic layer — shared types.
 *
 * Claude is NEVER in the order path. Advisory signals may only REDUCE
 * position size or PAUSE new entries (size_multiplier ∈ (0, 1]).
 */

/** Component identifiers matching guardrails `agentic.components` keys. */
export type AgenticComponent =
  | 'news_filter'
  | 'regime_advisor'
  | 'daily_review'
  | 'research'
  | 'pr_reviewer';

/** Per-call token usage returned by the Anthropic API. */
export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

/** Row shape for the `agentic_calls` table. */
export interface AgenticCallRow {
  component: AgenticComponent;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_usd: number;
  duration_ms: number | null;
  batch_id: string | null;
  metadata: Record<string, unknown> | null;
  error: string | null;
}

/** Row shape for the `agentic_reports` table. */
export interface AgenticReportRow {
  report_type: 'daily_risk_review' | 'research_card';
  title: string | null;
  markdown: string;
  metadata: Record<string, unknown> | null;
  call_id: number | null;
}

/**
 * Model pricing per million tokens (USD).
 * Used by CostTracker to compute per-call cost from token counts.
 * Source: https://platform.claude.com/docs/en/about-claude/pricing (2026-10-19)
 */
export interface ModelPricing {
  input_per_mtok: number;
  output_per_mtok: number;
  cache_read_per_mtok: number;
  cache_write_per_mtok: number;
  batch_discount: number;
}

export const MODEL_PRICING: Record<string, ModelPricing> = {
  'claude-haiku-5-5': {
    input_per_mtok: 0.10,
    output_per_mtok: 0.50,
    cache_read_per_mtok: 0.01,
    cache_write_per_mtok: 0.125,
    batch_discount: 0.5,
  },
  'claude-sonnet-5-5': {
    input_per_mtok: 2.0,
    output_per_mtok: 10.0,
    cache_read_per_mtok: 0.10,
    cache_write_per_mtok: 2.50,
    batch_discount: 0.5,
  },
  'claude-opus-5-5': {
    input_per_mtok: 4.0,
    output_per_mtok: 20.0,
    cache_read_per_mtok: 0.20,
    cache_write_per_mtok: 5.0,
    batch_discount: 0.5,
  },
  'claude-fable-5-1': {
    input_per_mtok: 10.0,
    output_per_mtok: 50.0,
    cache_read_per_mtok: 0.25,
    cache_write_per_mtok: 12.50,
    batch_discount: 0.5,
  },
};

/**
 * Regime advisor output — the ONLY structured advisory that can influence
 * the risk engine. `size_multiplier` is clamped to (0, 1] at every layer:
 * the advisor itself, the parser, and the risk engine consumer.
 */
export interface RegimeAdvisory {
  regime: string;
  confidence: number;
  size_multiplier: number;
  pause_entries: boolean;
  reasoning: string;
  timestamp: string;
}

/** Parsed news classification from the Haiku news filter. */
export interface NewsClassification {
  headline: string;
  relevance: 'high' | 'medium' | 'low' | 'none';
  severity: 'critical' | 'major' | 'minor' | 'neutral' | 'positive';
  assets: string[];
  summary: string;
  timestamp: string;
}

/** PR review finding. */
export interface PRReviewFinding {
  severity: 'critical' | 'major' | 'minor' | 'suggestion';
  file: string;
  line?: number;
  message: string;
}

export interface PRReviewResult {
  pr_number: number;
  summary: string;
  findings: PRReviewFinding[];
  approved: boolean;
  timestamp: string;
}

/** Nightly research card output. */
export interface ResearchCard {
  strategy: string;
  parameters_tested: Record<string, unknown>[];
  best_parameters: Record<string, unknown> | null;
  walk_forward_passed: boolean;
  out_of_sample_passed: boolean;
  overfit_warning: boolean;
  summary: string;
  backtest_command: string;
  timestamp: string;
}
