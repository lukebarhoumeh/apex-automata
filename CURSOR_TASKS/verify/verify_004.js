#!/usr/bin/env node
/**
 * verify_004.js — Verify startup resilience fixes (TASK_004)
 *
 * Checks:
 * 1. Non-fatal perps initialization
 * 2. Engine state cleanup on startup failure
 * 3. REST client hardening
 * 4. No regressions
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
const perpsAdapterPath = path.join(ROOT, 'exchanges/coinbase-perps-adapter.ts');
const restClientPath = path.join(ROOT, 'exchanges/coinbase/rest-client.ts');

const server = fs.readFileSync(serverPath, 'utf8');
const perpsAdapter = fs.readFileSync(perpsAdapterPath, 'utf8');
const restClient = fs.readFileSync(restClientPath, 'utf8');

// ------- Section 1: Non-Fatal Perps Init -------
console.log('\n=== Section 1: Non-Fatal Perps Init ===');

check(
  'initialize() wraps refreshPerpsProducts in try-catch',
  // The initialize method should have a try block around refreshPerpsProducts
  perpsAdapter.includes('try') &&
  perpsAdapter.includes('refreshPerpsProducts') &&
  perpsAdapter.includes('catch') &&
  // Make sure the catch is within initialize context (near the refreshPerpsProducts call)
  (() => {
    const initBlock = perpsAdapter.slice(
      perpsAdapter.indexOf('override async initialize'),
      perpsAdapter.indexOf('override async initialize') + 800
    );
    return initBlock.includes('try') && initBlock.includes('catch') && initBlock.includes('refreshPerpsProducts');
  })()
);

check(
  'refreshPerpsProducts has internal try-catch for product fetch',
  (() => {
    const methodStart = perpsAdapter.indexOf('async refreshPerpsProducts');
    if (methodStart === -1) return false;
    const methodBlock = perpsAdapter.slice(methodStart, methodStart + 800);
    // Should have try-catch around the actual API call
    return methodBlock.includes('try') && methodBlock.includes('catch');
  })()
);

check(
  'initialize() always completes (no uncaught throw from refreshPerpsProducts)',
  (() => {
    const initStart = perpsAdapter.indexOf('override async initialize');
    if (initStart === -1) return false;
    const initBlock = perpsAdapter.slice(initStart, initStart + 600);
    // Should have try-catch and the log AFTER the try-catch (meaning it continues)
    return initBlock.includes('try') &&
           initBlock.includes('catch') &&
           initBlock.includes('initialized with') &&
           initBlock.indexOf('initialized with') > initBlock.indexOf('catch');
  })()
);

check(
  'Warning log mentions perps/INTX on failure',
  (() => {
    const initStart = perpsAdapter.indexOf('override async initialize');
    if (initStart === -1) return false;
    const initBlock = perpsAdapter.slice(initStart, initStart + 800);
    return (initBlock.includes('INTX') || initBlock.includes('perps product')) &&
           initBlock.includes('warn');
  })()
);

// ------- Section 2: Engine State Cleanup -------
console.log('\n=== Section 2: Engine State Cleanup ===');

// Find the catch block in engine start handler
const engineStartCatch = (() => {
  // Find 'Failed to start trading engine' in a catch context
  const idx = server.indexOf("'Failed to start trading engine'");
  if (idx === -1) return '';
  // Get surrounding context (the catch block)
  return server.slice(Math.max(0, idx - 1000), idx + 500);
})();

check(
  'Catch block nulls tradingEngine on failure',
  engineStartCatch.includes('tradingEngine') &&
  (engineStartCatch.includes('tradingEngine = null') || engineStartCatch.includes('tradingEngine=null'))
);

check(
  'Catch block nulls perpsAdapter on failure',
  engineStartCatch.includes('perpsAdapter = null') || engineStartCatch.includes('perpsAdapter=null')
);

check(
  'Catch block stops/nulls perpsRiskMonitor on failure',
  engineStartCatch.includes('perpsRiskMonitor') &&
  (engineStartCatch.includes('.stop()') || engineStartCatch.includes('perpsRiskMonitor = null'))
);

check(
  'Catch block resets activeSpotToPerpsMap',
  engineStartCatch.includes('activeSpotToPerpsMap') &&
  (engineStartCatch.includes('new Map') || engineStartCatch.includes('clear'))
);

check(
  'Catch block resets engine gauge to 0',
  engineStartCatch.includes('engineRunningGauge') && engineStartCatch.includes('0')
);

// ------- Section 3: REST Client Hardening -------
console.log('\n=== Section 3: REST Client Hardening ===');

check(
  'getPerpsProducts fallback wrapped in try-catch',
  (() => {
    const methodStart = restClient.indexOf('async getPerpsProducts');
    if (methodStart === -1) return false;
    const methodBlock = restClient.slice(methodStart, methodStart + 2000);
    // Should have at least TWO try blocks (primary + fallback)
    const tryCount = (methodBlock.match(/\btry\b/g) || []).length;
    return tryCount >= 2;
  })()
);

check(
  'Returns empty array if both primary and fallback fail',
  (() => {
    const methodStart = restClient.indexOf('async getPerpsProducts');
    if (methodStart === -1) return false;
    const methodBlock = restClient.slice(methodStart, methodStart + 2000);
    return methodBlock.includes('return []') || methodBlock.includes('return[]');
  })()
);

check(
  'Warning log includes both error details',
  (() => {
    const methodStart = restClient.indexOf('async getPerpsProducts');
    if (methodStart === -1) return false;
    const methodBlock = restClient.slice(methodStart, methodStart + 2000);
    return (methodBlock.includes('primaryError') || methodBlock.includes('primary')) &&
           (methodBlock.includes('fallbackError') || methodBlock.includes('fallback'));
  })()
);

// ------- Section 4: No Regressions -------
console.log('\n=== Section 4: No Regressions ===');

check(
  'perpsAdapter.initialize() still called in startup flow',
  server.includes('perpsAdapter.initialize') || server.includes('perpsAdapter!.initialize')
);

check(
  'Spot candle flow still calls signalProcessor.addCandle(symbol, candle)',
  server.includes('signalProcessor.addCandle(symbol, candle)') ||
  server.includes('signalProcessor!.addCandle(symbol, candle)')
);

check(
  'effectiveRiskPerTrade logic present',
  server.includes('effectiveRiskPerTrade')
);

check(
  'Shutdown handlers clean up resources',
  server.includes('perpsRiskMonitor') &&
  server.includes('.stop()') &&
  server.includes('.removeAllListeners()')
);

// ------- Summary -------
console.log(`\n========================================`);
console.log(`  PASSED: ${passed}  |  FAILED: ${failed}  |  TOTAL: ${passed + failed}`);
console.log(`========================================`);

if (failed > 0) {
  console.log('\n⚠️  Some checks failed. Review the task spec and try again.');
  process.exit(1);
} else {
  console.log('\n✅ All checks passed! TASK_004 complete.');
  process.exit(0);
}
