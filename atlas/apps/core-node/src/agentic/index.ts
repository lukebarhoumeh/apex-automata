/**
 * Agentic layer — module entry point.
 *
 * Wires up all components with the shared AnthropicClient and CostTracker.
 * Feature-flagged OFF by default. Claude is NEVER in the order path.
 */

export { AnthropicClient, createHttpTransport } from './anthropic-client';
export type { AnthropicTransport, AnthropicRequest, AnthropicResponse, AnthropicBatchRequest, AnthropicBatchResponse, AnthropicMessage } from './anthropic-client';
export { CostTracker } from './cost-tracker';
export { NewsFilter } from './news-filter';
export { RegimeAdvisor, clampMultiplier, parseRegimeAdvisory } from './regime-advisor';
export type { MarketSnapshot } from './regime-advisor';
export { DailyRiskReview } from './daily-risk-review';
export type { DailyReviewData } from './daily-risk-review';
export { ResearchAgent } from './research-agent';
export type { BacktestResult } from './research-agent';
export { PRReviewer } from './pr-reviewer';
export * from './types';
