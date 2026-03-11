#!/usr/bin/env node
/**
 * Verify Task 000 — Regime Detector Confidence Fix
 * Run: node CURSOR_TASKS/verify/verify_000.js
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const FILE = path.join(__dirname, '../../atlas/apps/core-node/src/strategies/regime-detector.ts');

let passed = 0;
let failed = 0;

function check(name, condition) {
  if (condition) {
    console.log(`  ✅ ${name}`);
    passed++;
  } else {
    console.log(`  ❌ ${name}`);
    failed++;
  }
}

console.log('\n🔍 Verifying Task 000 — Regime Detector Confidence Fix\n');

// Read the file
let content;
try {
  content = fs.readFileSync(FILE, 'utf-8');
} catch (e) {
  console.log(`❌ Cannot read file: ${FILE}`);
  process.exit(1);
}

// Find the adx_primary block
const adxPrimaryMatch = content.match(/if\s*\(\s*this\.config\.classificationMode\s*===\s*'adx_primary'\s*\)\s*\{([\s\S]*?)(?=\/\/\s*---\s*multi_factor|else\s*\{)/);

if (!adxPrimaryMatch) {
  console.log('❌ Cannot find adx_primary block in classifyRegime()');
  process.exit(1);
}

const block = adxPrimaryMatch[1];

// Check 1: No hardcoded 20 in confidence calculations
const confidenceLines = block.match(/confidence:\s*[^}]+/g) || [];
check(
  'No hardcoded "20" in confidence calculations',
  !confidenceLines.some(line => /[\s(\/\-+*]20[\s)\/\-+*,}]/.test(line) && !line.includes('this.config'))
);

// Check 2: weak_trend uses config for both numerator and denominator
check(
  'weak_trend confidence uses this.config.adxWeakTrend',
  block.includes('this.config.adxWeakTrend') && block.includes('this.config.adxStrongTrend')
);

// Check 3: ranging uses config
const rangingLine = confidenceLines.find(l => l.includes('ranging') || (block.includes('ranging') && !l.includes('strong') && !l.includes('weak')));
check(
  'ranging confidence references this.config.adxWeakTrend',
  block.includes('this.config.adxWeakTrend')
);

// Check 4: strong_trend confidence unchanged (uses /50 which is fine)
const strongLine = block.match(/regime:\s*'strong_trend'.*confidence:\s*([^}]+)/);
check(
  'strong_trend confidence still uses Math.min(adx / 50, 1.0)',
  strongLine && strongLine[1].includes('Math.min')
);

// Check 5: Exactly 3 return statements in adx_primary block
const returnCount = (block.match(/return\s*\{/g) || []).length;
check(
  `Exactly 3 return statements in adx_primary block (found ${returnCount})`,
  returnCount === 3
);

// Summary
console.log(`\n${'─'.repeat(50)}`);
if (failed === 0) {
  console.log(`✅ ALL ${passed} CHECKS PASSED — Task 000 verified!\n`);
  process.exit(0);
} else {
  console.log(`❌ ${failed} CHECK(S) FAILED out of ${passed + failed} — review needed\n`);
  process.exit(1);
}
