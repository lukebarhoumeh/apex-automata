#!/usr/bin/env tsx
/**
 * CLI: PR second-reviewer — Claude Opus reviews a PR diff.
 *
 * Usage:
 *   pnpm exec tsx src/cli/pr-review.ts --pr 42
 *   pnpm exec tsx src/cli/pr-review.ts --pr 42 --json
 *
 * Requires:
 *   - ANTHROPIC_API_KEY in environment
 *   - gh CLI authenticated
 *   - agentic.enabled + agentic.components.pr_reviewer in guardrails
 *
 * NEVER auto-merges. Human review only.
 */

import { createLogger } from '../core/logger';
import { loadGuardrails, resolveAgenticConfig } from '../config/loadGuardrails';
import { AnthropicClient, createHttpTransport } from '../agentic/anthropic-client';
import { CostTracker } from '../agentic/cost-tracker';
import { PRReviewer } from '../agentic/pr-reviewer';

const args = process.argv.slice(2);
const prIdx = args.indexOf('--pr');
const jsonFlag = args.includes('--json');

if (prIdx === -1 || !args[prIdx + 1]) {
  console.error('Usage: pnpm exec tsx src/cli/pr-review.ts --pr <number> [--json]');
  process.exit(1);
}

const prNumber = parseInt(args[prIdx + 1]!, 10);
if (!Number.isFinite(prNumber) || prNumber <= 0) {
  console.error(`Invalid PR number: ${args[prIdx + 1]}`);
  process.exit(1);
}

const logger = createLogger();
const guardrails = loadGuardrails();
const config = resolveAgenticConfig(guardrails);

if (!config.enabled) {
  console.error('Agentic layer is disabled (agentic.enabled: false in guardrails)');
  process.exit(1);
}

if (!config.components.pr_reviewer) {
  console.error('PR reviewer component is disabled (agentic.components.pr_reviewer: false)');
  process.exit(1);
}

const transport = createHttpTransport();
const costTracker = new CostTracker(null, config.monthly_cost_cap_usd, logger);
const client = new AnthropicClient(transport, costTracker, logger);
const reviewer = new PRReviewer(client, config, logger);

async function main() {
  const result = await reviewer.reviewPR(prNumber);
  if (!result) {
    console.error('Review failed — check logs.');
    process.exit(1);
  }

  if (jsonFlag) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(reviewer.formatReport(result));
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
