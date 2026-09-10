/**
 * CLI: `pnpm check:config` (from atlas/apps/core-node) or
 * `pnpm exec tsx src/cli/check-config-drift.ts`.
 *
 * Runs `checkConfigDrift()` against the repo root (resolved from this
 * file's location, so it works from any cwd) and exits non-zero on any
 * violation. Wired into `.github/workflows/config-drift.yml`.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkConfigDrift, formatViolations } from '../config/config-drift';

const here = path.dirname(fileURLToPath(import.meta.url));
// src/cli -> src -> core-node -> apps -> atlas -> repo root
const repoRoot = path.resolve(here, '..', '..', '..', '..', '..');

const { violations, checked } = checkConfigDrift(repoRoot);

// eslint-disable-next-line no-console
console.log(`config-drift: inspected ${checked.length} file(s) under ${repoRoot}`);
for (const file of checked) {
  // eslint-disable-next-line no-console
  console.log(`  - ${file}`);
}

if (violations.length > 0) {
  // eslint-disable-next-line no-console
  console.error(`\nconfig-drift: ${violations.length} violation(s)\n${formatViolations(violations)}`);
  process.exit(1);
}

// eslint-disable-next-line no-console
console.log('config-drift: OK — single-source guardrails and desk pins intact');
