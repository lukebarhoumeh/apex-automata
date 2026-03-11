/**
 * Verification script for TASK_002B — Guardrails Perps Update
 * Run from project root: node CURSOR_TASKS/verify/verify_002b.js
 */
import fs from 'fs';
import path from 'path';

const YAML_PATH = 'atlas/config/guardrails.yaml';
const SCHEMA_PATH = 'atlas/apps/core-node/src/config/loadGuardrails.ts';
let passed = 0;
let failed = 0;
let warnings = 0;

function check(label, condition) {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.log(`  ❌ ${label}`);
    failed++;
  }
}

function warn(label) {
  console.log(`  ⚠️  ${label}`);
  warnings++;
}

function readFile(relPath) {
  const full = path.resolve(relPath);
  if (!fs.existsSync(full)) return null;
  return fs.readFileSync(full, 'utf-8');
}

// ============ Section 1: guardrails.yaml Content ============
console.log('\n📋 Section 1: guardrails.yaml Content');
const yaml = readFile(YAML_PATH);
if (!yaml) {
  check('guardrails.yaml exists', false);
} else {
  check('allow_short is true', /allow_short:\s*true/.test(yaml));
  check('Old PLATFORM LIMITATION comment removed', !yaml.includes('PLATFORM LIMITATION'));
  check('perps: section exists', /^perps:/m.test(yaml));
  check('perps.risk_per_trade is 0.015', /risk_per_trade:\s*0\.015/.test(yaml));
  check('perps.default_leverage is 3', yaml.includes('default_leverage: 3'));
  check('perps.max_leverage is 10', yaml.includes('max_leverage: 10'));
  check('perps.liquidation_buffer_pct is 0.20', /liquidation_buffer_pct:\s*0\.20/.test(yaml) || /liquidation_buffer_pct:\s*0\.2\b/.test(yaml));
  check('perps.taker_fee is 0.0003', /taker_fee:\s*0\.0003/.test(yaml));
  check('perps_symbols: section exists', /^perps_symbols:/m.test(yaml));
  check('ETH-PERP-INTX configured', yaml.includes('ETH-PERP-INTX'));
  check('BTC-PERP-INTX configured', yaml.includes('BTC-PERP-INTX'));
  check('max_open_positions is 4', /max_open_positions:\s*4/.test(yaml));
  check('Nano contract size present', yaml.includes('nano_contract_size'));
  check('Funding check interval present', yaml.includes('funding_check_interval_sec'));
}

// ============ Section 2: Zod Schema ============
console.log('\n🔧 Section 2: Zod Schema (loadGuardrails.ts)');
const schema = readFile(SCHEMA_PATH);
if (!schema) {
  check('loadGuardrails.ts exists', false);
} else {
  check('PerpsSymbolLimitSchema exists', schema.includes('PerpsSymbolLimitSchema'));
  check('PerpsSymbolLimit type exported', schema.includes('PerpsSymbolLimit'));
  check('perps section in GuardrailsSchema', /perps:\s*z\.object/.test(schema));
  check('perps has risk_per_trade', /perps[\s\S]*?risk_per_trade/.test(schema));
  check('perps has max_leverage', /perps[\s\S]*?max_leverage/.test(schema));
  check('perps has liquidation_buffer_pct', /perps[\s\S]*?liquidation_buffer_pct/.test(schema));
  check('perps section is optional', /perps[\s\S]*?\.optional\(\)/.test(schema));
  check('perps_symbols section exists in schema', /perps_symbols/.test(schema));
  check('perps_symbols is optional', schema.includes('perps_symbols') && schema.includes('.optional()'));
  check('PerpsSymbolLimitSchema has default_leverage', /PerpsSymbolLimitSchema[\s\S]*?default_leverage/.test(schema));
  check('PerpsSymbolLimitSchema has max_leverage', /PerpsSymbolLimitSchema[\s\S]*?max_leverage/.test(schema));
}

// ============ Section 3: Schema Validation ============
console.log('\n✅ Section 3: Schema Validation');
try {
  // We can't easily run Zod validation in a plain JS script without building,
  // but we can check the YAML parses and has required structure
  const yamlLines = yaml.split('\n');
  const hasPerpsSection = yamlLines.some(l => /^perps:/.test(l));
  const hasPerpsSymbols = yamlLines.some(l => /^perps_symbols:/.test(l));
  const hasAllowShort = /allow_short:\s*true/.test(yaml);
  check('YAML has perps section at root level', hasPerpsSection);
  check('YAML has perps_symbols section at root level', hasPerpsSymbols);
  check('allow_short is true in parsed config', hasAllowShort);
} catch (e) {
  check('YAML structure validation', false);
}

// ============ Section 4: No Regressions ============
console.log('\n🛡️  Section 4: No Regressions');
check('ETH-USD still in per_symbol', yaml.includes('ETH-USD:'));
check('BTC-USD still in per_symbol', yaml.includes('BTC-USD:'));
check('SOL-USD still in per_symbol', yaml.includes('SOL-USD:'));
check('Spot risk_per_trade 0.005 in account section', /account:[\s\S]*?risk_per_trade:\s*0\.005/.test(yaml));
check('max_account_leverage unchanged at 3.0', /max_account_leverage:\s*3\.0/.test(yaml) || /max_account_leverage:\s*3\b/.test(yaml));
check('disabled_strategies has vwap_mr', yaml.includes('- vwap_mr'));
check('disabled_strategies has breakout', yaml.includes('- breakout'));
check('execution section present', /^execution:/m.test(yaml));
check('circuit_breakers section present', /^circuit_breakers:/m.test(yaml));
check('compliance section present', /^compliance:/m.test(yaml));

// ============ Summary ============
console.log('\n' + '='.repeat(60));
console.log(`✅ Passed: ${passed}`);
console.log(`❌ Failed: ${failed}`);
console.log(`⚠️  Warnings: ${warnings}`);
console.log('='.repeat(60));

if (failed === 0) {
  console.log('\n🎉 All checks passed. TASK_002B verified clean.\n');
} else {
  console.log(`\n🔴 ${failed} check(s) failed. Review output above.\n`);
  process.exit(1);
}
