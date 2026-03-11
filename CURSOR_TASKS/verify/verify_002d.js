/**
 * Verification script for TASK_002D — Strategy Layer Perps Wiring
 * Run from project root: node CURSOR_TASKS/verify/verify_002d.js
 */
import fs from 'fs';
import path from 'path';

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

const SERVER = 'atlas/apps/core-node/src/api/server.ts';
const ENGINE = 'atlas/apps/core-node/src/trading/trading-engine.ts';
const CURSORRULES = '.cursorrules';

// ============ Section 1: Server.ts Integration ============
console.log('\n🔌 Section 1: Server.ts Integration');
const server = readFile(SERVER);
if (!server) {
  check('server.ts exists', false);
} else {
  check('CoinbasePerpsAdapter imported', server.includes('CoinbasePerpsAdapter'));
  check('PerpsRiskMonitor imported', server.includes('PerpsRiskMonitor'));
  check('Perps adapter instantiated', server.includes('new CoinbasePerpsAdapter') || server.includes('CoinbasePerpsAdapter('));
  check('PerpsRiskMonitor instantiated', server.includes('new PerpsRiskMonitor'));
  check('PerpsRiskMonitor.start() called', /perpsRiskMonitor.*\.start\(\)/.test(server) || server.includes('.start()'));
  check('PerpsRiskMonitor.stop() called in shutdown', /perpsRiskMonitor.*\.stop\(\)/.test(server));
  check('Funding bias stub replaced (no more "spot mode stub")', !server.includes('spot mode stub'));
  check('Real funding check in place', server.includes('positionsWithHighFunding') || server.includes('getLastSummary'));
  check('isPerpsSymbol or -PERP- check for risk_per_trade', server.includes('-PERP-') && server.includes('risk_per_trade'));
  check('reduce_only for perps exits', server.includes('reduce_only'));
  check('effectiveRiskPerTrade variable', server.includes('effectiveRiskPerTrade'));
  check('perpsRiskMonitor on liquidation_warning', server.includes('liquidation_warning') || server.includes('LIQUIDATION WARNING'));
}

// ============ Section 2: Position Sizing ============
console.log('\n📐 Section 2: Position Sizing (trading-engine.ts)');
const engine = readFile(ENGINE);
if (!engine) {
  check('trading-engine.ts exists', false);
} else {
  check('computeOrderSize exists', engine.includes('computeOrderSize'));
  check('computeOrderSize has optional riskPerTrade override',
    engine.includes('riskPerTradeOverride') || engine.includes('riskOverride') || engine.includes('riskPerTrade?'));
  // Check it uses the override when provided
  check('Uses override parameter in sizing logic',
    engine.includes('riskPerTradeOverride') || engine.includes('riskOverride ??') || engine.includes('|| this.guardrails'));
}

// ============ Section 3: .cursorrules Updated ============
console.log('\n📝 Section 3: .cursorrules Updated');
const rules = readFile(CURSORRULES);
if (!rules) {
  check('.cursorrules exists', false);
} else {
  check('Mentions CoinbasePerpsAdapter', rules.includes('CoinbasePerpsAdapter') || rules.includes('coinbase-perps'));
  check('Mentions PerpsRiskMonitor', rules.includes('PerpsRiskMonitor') || rules.includes('perps risk'));
  check('Mentions allow_short: true', rules.includes('allow_short') || rules.includes('shorting'));
  check('Mentions PERP-INTX format', rules.includes('PERP-INTX') || rules.includes('-PERP-'));
}

// ============ Section 4: No Regressions ============
console.log('\n🛡️  Section 4: No Regressions');
if (server) {
  check('shortAllowed variable still exists', server.includes('shortAllowed'));
  check('Kill switch logic intact', server.includes('killSwitch'));
  check('Daily stop logic intact', server.includes('dailyStopHit') || server.includes('dailyStop'));
  check('Time filter logic intact', server.includes('time_filter_enabled'));
  check('ATR filter logic intact', server.includes('atr_volatility_min'));
  check('Risk engine check still present', server.includes('riskCheck') || server.includes('risk:check'));
  check('isExitSignal logic preserved', server.includes('isExitSignal'));
}

// ============ Summary ============
console.log('\n' + '='.repeat(60));
console.log(`✅ Passed: ${passed}`);
console.log(`❌ Failed: ${failed}`);
console.log('='.repeat(60));

if (failed === 0) {
  console.log('\n🎉 All checks passed. TASK_002D verified clean.\n');
} else {
  console.log(`\n🔴 ${failed} check(s) failed. Review output above.\n`);
  process.exit(1);
}
