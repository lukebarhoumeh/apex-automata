/**
 * Regime advisor — Opus-based hourly market regime assessment.
 *
 * Reads recent bars, volatility data, and outputs structured JSON:
 *   { regime, confidence, size_multiplier, pause_entries, reasoning }
 *
 * SAFETY INVARIANT: size_multiplier is ALWAYS clamped to (0, 1] at EVERY
 * layer — the prompt, the parser, and the consumer. Claude can only REDUCE
 * position size, never increase it. This is enforced by `clampMultiplier()`
 * which is exported for testing.
 */

import type { Logger } from '../core/logger';
import type { AnthropicClient } from './anthropic-client';
import type { AgenticConfig } from '../config/loadGuardrails';
import type { RegimeAdvisory } from './types';

const SYSTEM_PROMPT = `You are a market regime advisor for a crypto algorithmic trading system.
Analyze the provided market data and output a regime assessment as valid JSON.

HARD RULES:
- size_multiplier MUST be between 0.01 and 1.0 (inclusive). You may NEVER output a value > 1.0.
  This multiplier can only REDUCE position sizes, never increase them.
- pause_entries: true means the system should temporarily stop opening new positions.
- regime must be one of: strong_trend | weak_trend | ranging | choppy | crisis
- confidence must be between 0 and 1.

Output ONLY valid JSON, no markdown:
{
  "regime": "weak_trend",
  "confidence": 0.75,
  "size_multiplier": 0.8,
  "pause_entries": false,
  "reasoning": "Brief explanation of assessment"
}`;

/**
 * Clamp size_multiplier to (0, 1]. Exported for direct testing of the
 * safety invariant.
 */
export function clampMultiplier(raw: number): number {
  if (!Number.isFinite(raw) || raw <= 0) {
    return raw === Infinity ? 1.0 : 0.01;
  }
  return Math.min(raw, 1.0);
}

/** Parse and validate the regime advisor JSON response. */
export function parseRegimeAdvisory(text: string): RegimeAdvisory | null {
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;

    const regime = String(parsed.regime ?? 'unknown');
    const confidence = Number(parsed.confidence ?? 0);
    const rawMultiplier = Number(parsed.size_multiplier ?? 1);
    const pauseEntries = Boolean(parsed.pause_entries ?? false);
    const reasoning = String(parsed.reasoning ?? '');

    return {
      regime,
      confidence: Math.max(0, Math.min(1, confidence)),
      size_multiplier: clampMultiplier(rawMultiplier),
      pause_entries: pauseEntries,
      reasoning,
      timestamp: new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

export interface MarketSnapshot {
  symbol: string;
  recentBars: Array<{ open: number; high: number; low: number; close: number; volume: number; timestamp: string }>;
  atr14: number;
  currentPrice: number;
  dailyChange: number;
  volatility30d: number;
}

export class RegimeAdvisor {
  private lastAdvisory: RegimeAdvisory | null = null;
  private lastRunAt = 0;

  constructor(
    private readonly client: AnthropicClient,
    private readonly config: AgenticConfig,
    private readonly logger: Logger,
  ) {}

  getLastAdvisory(): RegimeAdvisory | null {
    return this.lastAdvisory;
  }

  /**
   * Run the regime assessment if enough time has elapsed since the last run.
   * Returns the advisory, or null if skipped/disabled/cap-reached.
   */
  async assess(snapshots: MarketSnapshot[]): Promise<RegimeAdvisory | null> {
    if (!this.config.enabled || !this.config.components.regime_advisor) {
      return null;
    }

    const intervalMs = this.config.regime_advisor_interval_min * 60 * 1000;
    if (Date.now() - this.lastRunAt < intervalMs) {
      return this.lastAdvisory;
    }

    const model = this.config.models.regime_advisor;
    const marketData = snapshots.map((s) => ({
      symbol: s.symbol,
      price: s.currentPrice,
      daily_change_pct: (s.dailyChange * 100).toFixed(2) + '%',
      atr14: s.atr14.toFixed(2),
      volatility_30d: (s.volatility30d * 100).toFixed(2) + '%',
      last_10_bars: s.recentBars.slice(-10).map((b) => ({
        o: b.open, h: b.high, l: b.low, c: b.close, v: b.volume,
      })),
    }));

    const response = await this.client.callModel('regime_advisor', {
      model,
      max_tokens: 512,
      system: SYSTEM_PROMPT,
      messages: [{
        role: 'user',
        content: `Current market data:\n${JSON.stringify(marketData, null, 2)}\n\nProvide your regime assessment.`,
      }],
      temperature: 0,
    });

    if (!response) return null;

    const text = response.content[0]?.text ?? '';
    const advisory = parseRegimeAdvisory(text);

    if (!advisory) {
      this.logger.warn('RegimeAdvisor: failed to parse response', { text: text.slice(0, 200) });
      return null;
    }

    this.lastAdvisory = advisory;
    this.lastRunAt = Date.now();

    this.logger.info('RegimeAdvisor: assessment complete', {
      regime: advisory.regime,
      confidence: advisory.confidence,
      size_multiplier: advisory.size_multiplier,
      pause_entries: advisory.pause_entries,
    });

    return advisory;
  }

  /**
   * Apply the advisory to a proposed position size.
   * SAFETY: always returns a size <= the input size.
   */
  applyToSize(proposedSize: number): number {
    if (!this.lastAdvisory) return proposedSize;
    const multiplier = clampMultiplier(this.lastAdvisory.size_multiplier);
    return proposedSize * multiplier;
  }

  /**
   * Whether the advisor recommends pausing new entries.
   */
  shouldPauseEntries(): boolean {
    return this.lastAdvisory?.pause_entries === true;
  }
}
