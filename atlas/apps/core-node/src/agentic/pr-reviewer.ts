/**
 * PR second-reviewer — Opus-based code review of PR diffs.
 *
 * Reads a PR diff via `gh pr diff`, sends it to Claude, and outputs
 * structured findings. NEVER auto-merges or approves — human-only.
 */

import type { Logger } from '../core/logger';
import type { AnthropicClient } from './anthropic-client';
import type { AgenticConfig } from '../config/loadGuardrails';
import type { PRReviewFinding, PRReviewResult } from './types';
import { execSync } from 'node:child_process';

const SYSTEM_PROMPT = `You are a senior code reviewer for an algorithmic crypto trading system (AtlasBot v2).

Review the PR diff and output structured findings as valid JSON:
{
  "summary": "Brief overall assessment",
  "findings": [
    {
      "severity": "critical|major|minor|suggestion",
      "file": "path/to/file.ts",
      "line": 42,
      "message": "What's wrong and how to fix it"
    }
  ],
  "approved": false
}

Focus on:
- Safety: anything that could affect live trading, risk limits, or order execution
- Financial correctness: floating-point money, rounding, fee calculations
- Desk pins / config drift: guardrails changes without matching config-drift.ts updates
- Error handling: swallowed errors, missing retries, unhandled promise rejections
- Type safety: any casts, type assertions, unchecked null access
- Test coverage: untested critical paths

DO NOT auto-approve. Set approved=true ONLY if there are zero critical/major findings.
Output valid JSON only, no markdown.`;

export class PRReviewer {
  constructor(
    private readonly client: AnthropicClient,
    private readonly config: AgenticConfig,
    private readonly logger: Logger,
  ) {}

  /**
   * Review a PR by number. Uses `gh pr diff` to fetch the diff.
   * Returns structured findings — never auto-merges.
   */
  async reviewPR(prNumber: number): Promise<PRReviewResult | null> {
    if (!this.config.enabled || !this.config.components.pr_reviewer) {
      return null;
    }

    const diff = this.fetchDiff(prNumber);
    if (!diff) {
      this.logger.warn('PRReviewer: failed to fetch diff', { prNumber });
      return null;
    }

    const truncatedDiff = diff.length > 100_000 ? diff.slice(0, 100_000) + '\n... (truncated)' : diff;

    const model = this.config.models.pr_reviewer;
    const response = await this.client.callModel('pr_reviewer', {
      model,
      max_tokens: 8192,
      system: SYSTEM_PROMPT,
      messages: [{
        role: 'user',
        content: `Review this PR diff (#${prNumber}):\n\n\`\`\`diff\n${truncatedDiff}\n\`\`\``,
      }],
      temperature: 0,
    });

    if (!response) return null;

    const text = response.content[0]?.text ?? '';
    try {
      const parsed = JSON.parse(text) as {
        summary: string;
        findings: PRReviewFinding[];
        approved: boolean;
      };

      const result: PRReviewResult = {
        pr_number: prNumber,
        summary: parsed.summary ?? '',
        findings: (parsed.findings ?? []).map((f) => ({
          severity: f.severity,
          file: f.file ?? '',
          line: f.line,
          message: f.message ?? '',
        })),
        approved: parsed.approved === true && (parsed.findings ?? []).every(
          (f) => f.severity !== 'critical' && f.severity !== 'major',
        ),
        timestamp: new Date().toISOString(),
      };

      this.logger.info('PRReviewer: review complete', {
        prNumber,
        findings: result.findings.length,
        approved: result.approved,
      });

      return result;
    } catch (err) {
      this.logger.warn('PRReviewer: failed to parse response', { error: (err as Error).message });
      return null;
    }
  }

  private fetchDiff(prNumber: number): string | null {
    try {
      return execSync(`gh pr diff ${prNumber}`, {
        encoding: 'utf-8',
        timeout: 30_000,
        maxBuffer: 10 * 1024 * 1024,
      });
    } catch (err) {
      this.logger.warn('PRReviewer: gh pr diff failed', { error: (err as Error).message, prNumber });
      return null;
    }
  }

  formatReport(result: PRReviewResult): string {
    const lines = [
      `# PR #${result.pr_number} — Claude Review`,
      `_Generated ${result.timestamp}_`,
      '',
      '## Summary',
      result.summary,
      '',
      `**Verdict**: ${result.approved ? 'No critical issues found' : 'Issues found — human review required'}`,
      '',
    ];

    if (result.findings.length > 0) {
      lines.push('## Findings', '');
      for (const f of result.findings) {
        const loc = f.line ? `${f.file}:${f.line}` : f.file;
        lines.push(`### [${f.severity.toUpperCase()}] ${loc}`);
        lines.push(f.message, '');
      }
    } else {
      lines.push('## Findings', '_No issues found._', '');
    }

    return lines.join('\n');
  }
}
