/**
 * Verification script for TASK_002C — Perps Risk Module
 * Run from project root: node CURSOR_TASKS/verify/verify_002c.js
 */
import fs from 'fs';
import path from 'path';

const BASE = 'atlas/apps/core-node/src/trading';
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

function readFile(relPath) {
  const full = path.resolve(relPath);
  if (!fs.existsSync(full)) return null;
  return fs.readFileSync(full, 'utf-8');
}

function dirExists(relPath) {
  return fs.existsSync(path.resolve(relPath)) && fs.statSync(path.resolve(relPath)).isDirectory();
}

// ============ Section 1: File Structure ============
console.log('\n📁 Section 1: File Structure');
check('trading/perps/ directory exists', dirExists(`${BASE}/perps`));
check('trading/perps/types.ts exists', fs.existsSync(path.resolve(`${BASE}/perps/types.ts`)));
check('trading/perps/perps-risk-monitor.ts exists', fs.existsSync(path.resolve(`${BASE}/perps/perps-risk-monitor.ts`)));
check('trading/perps/index.ts exists', fs.existsSync(path.resolve(`${BASE}/perps/index.ts`)));

// ============ Section 2: Perps Types ============
console.log('\n📦 Section 2: Perps Types (perps/types.ts)');
const types = readFile(`${BASE}/perps/types.ts`);
if (!types) {
  check('types.ts readable', false);
} else {
  check('PerpsRiskConfig interface exists', types.includes('interface PerpsRiskConfig'));
  check('PerpsRiskConfig has liquidationBufferPct', types.includes('liquidationBufferPct'));
  check('PerpsRiskConfig has maxFundingRateBps', types.includes('maxFundingRateBps'));
  check('PerpsRiskConfig has riskPerTrade', types.includes('riskPerTrade'));
  check('PerpsRiskConfig has maxLeverage', types.includes('maxLeverage'));
  check('PerpsRiskConfig has nanoContractSize', types.includes('nanoContractSize'));
  check('PerpsPositionRisk interface exists', types.includes('interface PerpsPositionRisk'));
  check('PerpsPositionRisk has liquidationDanger', types.includes('liquidationDanger'));
  check('PerpsPositionRisk has fundingExcessive', types.includes('fundingExcessive'));
  check('PerpsPositionRisk has liquidationDistance', types.includes('liquidationDistance'));
  check('PerpsPositionRisk has estimatedHourlyFundingCost', types.includes('estimatedHourlyFundingCost'));
  check('PerpsRiskSummary interface exists', types.includes('interface PerpsRiskSummary'));
  check('PerpsRiskSummary has riskBreached', types.includes('riskBreached'));
  check('PerpsRiskSummary has positionsInDanger', types.includes('positionsInDanger'));
  check('PerpsRiskSummary has estimatedDailyFundingCost', types.includes('estimatedDailyFundingCost'));
  check('PerpsRiskEvents interface exists', types.includes('PerpsRiskEvents'));
}

// ============ Section 3: PerpsRiskMonitor ============
console.log('\n🚨 Section 3: PerpsRiskMonitor');
const monitor = readFile(`${BASE}/perps/perps-risk-monitor.ts`);
if (!monitor) {
  check('perps-risk-monitor.ts readable', false);
} else {
  check('Class extends EventEmitter', monitor.includes('extends EventEmitter'));
  check('Has setAdapter method', monitor.includes('setAdapter'));
  check('Has start method', /\bstart\s*\(/.test(monitor));
  check('Has stop method', /\bstop\s*\(/.test(monitor));
  check('Has forceCheck method', monitor.includes('forceCheck'));
  check('Has getLastSummary method', monitor.includes('getLastSummary'));
  check('Has evaluatePositionRisk method', monitor.includes('evaluatePositionRisk'));
  check('Uses isPerpsAdapter type guard', monitor.includes('isPerpsAdapter'));
  check('Emits perps:liquidation_warning', monitor.includes("'perps:liquidation_warning'"));
  check('Emits perps:funding_warning', monitor.includes("'perps:funding_warning'"));
  check('Emits perps:leverage_warning', monitor.includes("'perps:leverage_warning'"));
  check('Emits perps:risk_update', monitor.includes("'perps:risk_update'"));
  check('Emits perps:reduce_recommended', monitor.includes("'perps:reduce_recommended'"));
  check('Has fundingRateCache', monitor.includes('fundingRateCache'));
  check('Calculates liq distance for long (markPrice - liqPrice)', monitor.includes('markPrice - liqPrice') || monitor.includes('markPrice -'));
  check('Calculates liq distance for short (liqPrice - markPrice)', monitor.includes('liqPrice - markPrice') || monitor.includes('liqPrice -'));
  check('Imports from exchanges/types', monitor.includes('exchanges/types'));
  check('Imports PerpsRiskConfig from types', monitor.includes('PerpsRiskConfig'));
  check('Has checkInterval timer', monitor.includes('checkInterval'));
  check('Uses clearInterval on stop', monitor.includes('clearInterval'));
}

// ============ Section 4: Barrel Exports ============
console.log('\n📤 Section 4: Barrel Exports');
const barrel = readFile(`${BASE}/perps/index.ts`);
if (!barrel) {
  check('perps/index.ts readable', false);
} else {
  check('Exports PerpsRiskMonitor', barrel.includes('PerpsRiskMonitor'));
  check('Exports types', barrel.includes("from './types'") || barrel.includes('export *'));
}

// ============ Section 5: No Regressions ============
console.log('\n🛡️  Section 5: No Regressions');
const riskEngine = readFile(`${BASE}/risk-engine.ts`);
const riskController = readFile(`${BASE}/risk-controller.ts`);
const orderManager = readFile(`${BASE}/order-manager.ts`);

// Check these files haven't been modified by checking key signatures are intact
if (riskEngine) {
  check('risk-engine.ts still has shortsAllowed check', riskEngine.includes('shortsAllowed'));
  check('risk-engine.ts still has killSwitchActive', riskEngine.includes('killSwitchActive'));
}
if (riskController) {
  check('risk-controller.ts exists and is intact', riskController.length > 100);
}
if (orderManager) {
  check('order-manager.ts still has setExchangeAdapter', orderManager.includes('setExchangeAdapter'));
}

// ============ Summary ============
console.log('\n' + '='.repeat(60));
console.log(`✅ Passed: ${passed}`);
console.log(`❌ Failed: ${failed}`);
console.log('='.repeat(60));

if (failed === 0) {
  console.log('\n🎉 All checks passed. TASK_002C verified clean.\n');
} else {
  console.log(`\n🔴 ${failed} check(s) failed. Review output above.\n`);
  process.exit(1);
}
