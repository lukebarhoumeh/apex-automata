/**
 * News filter — Haiku-based crypto headline classifier.
 *
 * Classifies headlines for BTC/ETH relevance and severity. Uses the cheapest
 * model (claude-haiku-5-5) for high-volume, low-latency classification.
 * Output is purely informational (logged + persisted) and does NOT enter
 * the order path.
 */

import type { Logger } from '../core/logger';
import type { AnthropicClient } from './anthropic-client';
import type { AgenticConfig } from '../config/loadGuardrails';
import type { NewsClassification } from './types';

const SYSTEM_PROMPT = `You are a crypto news classifier for an algorithmic trading system.
Classify each headline for:
1. relevance: high | medium | low | none — how relevant is this to BTC or ETH price action?
2. severity: critical | major | minor | neutral | positive — impact on price?
3. assets: which crypto assets are affected (e.g. ["BTC", "ETH"])
4. summary: one-sentence summary of why this matters (or "Not relevant")

Respond with valid JSON only. No markdown, no explanation.
Example: {"relevance":"high","severity":"critical","assets":["BTC"],"summary":"Major exchange hack affecting BTC liquidity"}`;

export class NewsFilter {
  constructor(
    private readonly client: AnthropicClient,
    private readonly config: AgenticConfig,
    private readonly logger: Logger,
  ) {}

  async classifyHeadline(headline: string): Promise<NewsClassification | null> {
    if (!this.config.enabled || !this.config.components.news_filter) {
      return null;
    }

    const model = this.config.models.news_filter;
    const response = await this.client.callModel('news_filter', {
      model,
      max_tokens: 256,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: `Classify this headline:\n\n"${headline}"` }],
      temperature: 0,
    });

    if (!response) return null;

    try {
      const text = response.content[0]?.text ?? '';
      const parsed = JSON.parse(text) as {
        relevance: string;
        severity: string;
        assets: string[];
        summary: string;
      };

      const classification: NewsClassification = {
        headline,
        relevance: parsed.relevance as NewsClassification['relevance'],
        severity: parsed.severity as NewsClassification['severity'],
        assets: parsed.assets ?? [],
        summary: parsed.summary ?? '',
        timestamp: new Date().toISOString(),
      };

      this.logger.info('NewsFilter: classified headline', {
        headline: headline.slice(0, 80),
        relevance: classification.relevance,
        severity: classification.severity,
      });

      return classification;
    } catch (err) {
      this.logger.warn('NewsFilter: failed to parse response', { error: (err as Error).message });
      return null;
    }
  }

  async classifyBatch(headlines: string[]): Promise<NewsClassification[]> {
    const results: NewsClassification[] = [];
    for (const headline of headlines) {
      const result = await this.classifyHeadline(headline);
      if (result) results.push(result);
    }
    return results;
  }
}
