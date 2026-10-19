/**
 * Nightly research / backtest agent — parameter sweeps on the existing
 * backtester for trend_follow / donchian, with overfitting detection
 * (walk-forward, out-of-sample split).
 *
 * Uses Claude to:
 * 1. Propose parameter variations based on recent backtest results
 * 2. Analyze sweep results for overfitting signals
 * 3. Write a research card summarising findings
 *
 * The agent NEVER modifies strategy parameters or guardrails — it only
 * writes research cards to `agentic_reports` for human review.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Logger } from '../core/logger';
import type { AnthropicClient } from './anthropic-client';
import type { AgenticConfig } from '../config/loadGuardrails';
import type { ResearchCard } from './types';

const SYSTEM_PROMPT = `You are a quantitative research analyst for a crypto algorithmic trading system.

Your job is to:
1. Analyze backtest results and propose parameter variations to test
2. Evaluate results for overfitting (walk-forward validation, out-of-sample performance)
3. Flag suspicious patterns (curve-fitting, data-snooping, regime-specific edge)

HARD RULES:
- NEVER recommend deploying parameters without walk-forward validation
- Flag as OVERFIT if: out-of-sample PF < 0.8 * in-sample PF, or if edge
  only appears in one regime, or if sample size < 30 trades
- Every recommendation must include the exact backtest command to reproduce
- Output valid JSON only

Output format:
{
  "strategy": "trend_follow",
  "parameters_tested": [{"stopAtr": 2.5, "takeProfitAtr": 6.0}, ...],
  "best_parameters": {"stopAtr": 2.5, "takeProfitAtr": 6.0} | null,
  "walk_forward_passed": true,
  "out_of_sample_passed": true,
  "overfit_warning": false,
  "summary": "Brief findings",
  "backtest_command": "pnpm exec tsx src/cli/backtest.ts --start-date ... --end-date ... --products BTC-USD"
}`;

export interface BacktestResult {
  parameters: Record<string, unknown>;
  profit_factor: number;
  total_trades: number;
  win_rate: number;
  net_pnl: number;
  max_drawdown: number;
  sharpe_ratio: number;
  period: string;
  is_out_of_sample: boolean;
}

export class ResearchAgent {
  constructor(
    private readonly client: AnthropicClient,
    private readonly supabase: SupabaseClient | null,
    private readonly config: AgenticConfig,
    private readonly logger: Logger,
  ) {}

  /**
   * Analyze a set of backtest results and produce a research card.
   * The agent proposes parameter variations, evaluates overfitting,
   * and writes findings — it never modifies anything.
   */
  async analyzeResults(
    strategy: string,
    results: BacktestResult[],
  ): Promise<ResearchCard | null> {
    if (!this.config.enabled || !this.config.components.research) {
      return null;
    }

    const model = this.config.models.research;
    const response = await this.client.callModel('research', {
      model,
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      messages: [{
        role: 'user',
        content: `Analyze these backtest results for strategy "${strategy}":\n\n${JSON.stringify(results, null, 2)}\n\nProvide your research card with overfitting analysis.`,
      }],
      temperature: 0,
    });

    if (!response) return null;

    const text = response.content[0]?.text ?? '';
    try {
      const parsed = JSON.parse(text) as ResearchCard;
      const card: ResearchCard = {
        strategy: parsed.strategy ?? strategy,
        parameters_tested: parsed.parameters_tested ?? [],
        best_parameters: parsed.best_parameters ?? null,
        walk_forward_passed: Boolean(parsed.walk_forward_passed),
        out_of_sample_passed: Boolean(parsed.out_of_sample_passed),
        overfit_warning: Boolean(parsed.overfit_warning),
        summary: parsed.summary ?? '',
        backtest_command: parsed.backtest_command ?? '',
        timestamp: new Date().toISOString(),
      };

      if (this.supabase) {
        try {
          const markdown = this.formatResearchCard(card);
          await this.supabase.from('agentic_reports').insert({
            report_type: 'research_card',
            title: `Research: ${strategy} parameter sweep — ${card.timestamp.slice(0, 10)}`,
            markdown,
            metadata: { card },
          });
        } catch (err) {
          this.logger.warn('ResearchAgent: failed to persist card', { error: (err as Error).message });
        }
      }

      this.logger.info('ResearchAgent: research card generated', {
        strategy: card.strategy,
        overfit_warning: card.overfit_warning,
        walk_forward_passed: card.walk_forward_passed,
      });

      return card;
    } catch (err) {
      this.logger.warn('ResearchAgent: failed to parse response', { error: (err as Error).message });
      return null;
    }
  }

  private formatResearchCard(card: ResearchCard): string {
    const lines = [
      `# Research Card: ${card.strategy}`,
      `_Generated ${card.timestamp}_`,
      '',
      '## Summary',
      card.summary,
      '',
      '## Parameters Tested',
      '```json',
      JSON.stringify(card.parameters_tested, null, 2),
      '```',
      '',
      card.best_parameters
        ? `## Best Parameters\n\`\`\`json\n${JSON.stringify(card.best_parameters, null, 2)}\n\`\`\``
        : '## Best Parameters\n_No improvement found._',
      '',
      '## Validation',
      `- Walk-forward: ${card.walk_forward_passed ? 'PASSED' : 'FAILED'}`,
      `- Out-of-sample: ${card.out_of_sample_passed ? 'PASSED' : 'FAILED'}`,
      `- Overfit warning: ${card.overfit_warning ? 'YES' : 'No'}`,
      '',
      '## Reproduction',
      '```bash',
      card.backtest_command,
      '```',
    ];
    return lines.join('\n');
  }
}
