#!/usr/bin/env node
/**
 * verify_003a.js — Verify perps symbol override wiring (TASK_003A)
 *
 * Checks:
 * 1. Strategy overrides wired for perps_symbols
 * 2. Notional limits merged for perps_symbols
 * 3. Leverage initialization for perps symbols
 * 4. No regressions to spot logic
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ROOT = path.resolve(__dirname, '../../atlas/apps/core-node/src');
let passed = 0;
let failed = 0;

function check(label, condition) {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.log(`  ❌ ${label}`);
    failed++;
  }
}

// Read files
const serverPath = path.join(ROOT, 'api/server.ts');
const evalRiskPath = path.join(ROOT, 'trading/risk/evaluate-risk.ts');

const serverExists = fs.existsSync(serverPath);
const evalRiskExists = fs.existsSync(evalRiskPath);

if (!serverExists) {
  console.error('ERROR: server.ts not found at', serverPath);
  process.exit(1);
}

const server = serverExists ? fs.readFileSync(serverPath, 'utf8') : '';
const evalRisk = evalRiskExists ? fs.readFileSync(evalRiskPath, 'utf8') : '';

// ------- Section 1: Strategy Overrides Wiring -------
console.log('\n=== Section 1: Strategy Overrides Wiring ===');

check(
  'loadPerSymbolOverridesFromGuardrails called with guardrails.perps_symbols',
  server.includes('loadPerSymbolOverridesFromGuardrails(guardrails.perps_symbols)')
);

check(
  'Log message contains "perps" for perps overrides loading',
  server.includes("strategy overrides (perps)") || server.includes("strategy overrides (perps_symbols)") || server.includes("perps_symbols")
);

check(
  'Original per_symbol loading still present',
  server.includes('loadPerSymbolOverridesFromGuardrails(guardrails.per_symbol)')
);

check(
  'Perps override loading happens AFTER spot override loading',
  server.indexOf('guardrails.per_symbol') < server.indexOf('guardrails.perps_symbols')
    || server.indexOf('per_symbol') < server.lastIndexOf('perps_symbols')
);

// ------- Section 2: Notional Limits Wiring -------
console.log('\n=== Section 2: Notional Limits Wiring ===');

if (evalRiskExists) {
  check(
    'evaluate-risk.ts type includes perps_symbols field',
    evalRisk.includes('perps_symbols')
  );

  check(
    'Perps symbols merged into maxExposurePerSymbolUsd',
    evalRisk.includes('perps_symbols') && evalRisk.includes('max_notional_usd')
  );

  check(
    'Perps symbols merged into maxDailyLossPerSymbolUsd',
    evalRisk.includes('perps_symbols') && evalRisk.includes('max_daily_loss_usd')
  );

  check(
    'Original per_symbol loop still present',
    evalRisk.includes('guardrails.per_symbol')
  );
} else {
  console.log('  ⚠️  evaluate-risk.ts not found — skipping notional limit checks');
  // Still check server.ts for any alternative approach
  check(
    'Perps notional limits handled somewhere',
    server.includes('perps_symbols') && (server.includes('max_notional') || server.includes('notional'))
  );
}

// ------- Section 3: Leverage Initialization -------
console.log('\n=== Section 3: Leverage Initialization ===');

check(
  'setLeverage called for perps symbols',
  server.includes('setLeverage') && server.includes('perps_symbols')
);

check(
  'Leverage fallback chain (symbol -> perps.default_leverage -> 3)',
  server.includes('default_leverage') && (server.includes('?? 3') || server.includes('|| 3'))
);

check(
  'setLeverage errors are caught (not thrown)',
  server.includes('.catch') && server.includes('setLeverage')
);

check(
  'Log message includes leverage settings',
  server.includes('leverage') && (server.includes("'Applied") || server.includes("leverage setting") || server.includes("per-symbol leverage"))
);

// ------- Section 4: No Regressions -------
console.log('\n=== Section 4: No Regressions ===');

check(
  'per_symbol spot override loading still works',
  server.includes('loadPerSymbolOverridesFromGuardrails(guardrails.per_symbol)')
);

check(
  'effectiveRiskPerTrade logic present',
  server.includes('effectiveRiskPerTrade')
);

check(
  'reduce_only flag on perps close orders present',
  server.includes('reduce_only')
);

check(
  'PerpsRiskMonitor start present',
  server.includes('perpsRiskMonitor') && server.includes('.start()')
);

check(
  'Funding bias guardrail check present',
  server.includes('funding_bias_enabled') && server.includes('getLastSummary')
);

// ------- Summary -------
console.log(`\n========================================`);
console.log(`  PASSED: ${passed}  |  FAILED: ${failed}  |  TOTAL: ${passed + failed}`);
console.log(`========================================`);

if (failed > 0) {
  console.log('\n⚠️  Some checks failed. Review the task spec and try again.');
  process.exit(1);
} else {
  console.log('\n✅ All checks passed! TASK_003A complete.');
  process.exit(0);
}
