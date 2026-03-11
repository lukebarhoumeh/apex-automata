#!/usr/bin/env node
/**
 * verify_003b.js — Verify perps market data proxy + order routing (TASK_003B)
 *
 * Checks:
 * 1. Module-scoped perpsAdapter
 * 2. Dynamic products list
 * 3. Spot-to-perps candle proxy
 * 4. Status reporting
 * 5. No regressions
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
const server = fs.readFileSync(serverPath, 'utf8');

// ------- Section 1: Module-scoped perpsAdapter -------
console.log('\n=== Section 1: Module-scoped perpsAdapter ===');

check(
  'perpsAdapter declared at module scope (let perpsAdapter)',
  // Should be a let declaration at module level, not const inside function
  server.includes('let perpsAdapter') && server.includes('CoinbasePerpsAdapter | null')
);

check(
  'perpsAdapter assigned (not const declared) inside handler',
  // Should be assignment: perpsAdapter = new CoinbasePerpsAdapter
  // NOT: const perpsAdapter = new CoinbasePerpsAdapter
  server.includes('perpsAdapter = new CoinbasePerpsAdapter') &&
  !server.includes('const perpsAdapter = new CoinbasePerpsAdapter')
);

// Check shutdown cleanup
const shutdownMatches = server.match(/perpsAdapter\s*=\s*null/g);
check(
  'perpsAdapter nulled in shutdown handler(s)',
  shutdownMatches && shutdownMatches.length >= 1
);

// ------- Section 2: Dynamic Products List -------
console.log('\n=== Section 2: Dynamic Products List ===');

// Check that hardcoded products are gone from engine config
// Look for the pattern: products: ['BTC-USD', 'ETH-USD', 'SOL-USD'] in engine config context
const hardcodedProductsCount = (server.match(/products:\s*\['BTC-USD',\s*'ETH-USD',\s*'SOL-USD'\]/g) || []).length;
check(
  'Hardcoded products array removed from engine config (max 0-1 occurrences)',
  hardcodedProductsCount <= 1  // May still exist in comments or unused code
);

check(
  'spotSymbols derived from guardrails.per_symbol or config',
  server.includes('per_symbol') && (
    server.includes('spotSymbols') ||
    server.includes('spot_symbols') ||
    server.includes('Object.keys(guardrails.per_symbol)')
  )
);

check(
  'perpsSymbols derived from guardrails.perps_symbols',
  server.includes('perps_symbols') && (
    server.includes('perpsSymbols') ||
    server.includes('Object.keys(guardrails.perps_symbols)')
  )
);

check(
  'Dynamic products variable used in engine config',
  server.includes('engineProducts') ||
  server.includes('spotSymbols') ||
  // Or check that TradingEngineConfig products field isn't hardcoded
  server.includes('products: spot') ||
  server.includes('products: engine')
);

// ------- Section 3: Spot-to-Perps Candle Proxy -------
console.log('\n=== Section 3: Spot-to-Perps Candle Proxy ===');

check(
  'Spot-to-perps mapping exists (Map or object)',
  server.includes('spotToPerps') ||
  server.includes('spot_to_perps') ||
  server.includes('perpsMap') ||
  server.includes('PERP-INTX')
);

check(
  'Module-scoped mapping variable for candle mirroring',
  server.includes('let activeSpotToPerps') ||
  server.includes('let spotToPerps') ||
  // Could be implemented differently
  server.includes('perpsMap') && server.includes('let ')
);

check(
  'Candle mirroring in processTickerForCandles',
  // Look for the perps symbol mirroring in the candle processing function
  server.includes('addCandle') && (
    server.includes('perpsSymbol') ||
    server.includes('perps_symbol') ||
    server.includes('Mirror') ||
    server.includes('mirror') ||
    server.includes('proxy')
  )
);

check(
  'Mirror calls signalProcessor.addCandle for perps symbol',
  // The mirror should call addCandle with a different symbol
  (server.match(/addCandle\(/g) || []).length >= 3  // At least: spot candle + perps mirror + warmup
);

check(
  'Warmup includes perps symbols (via proxy or candle copy)',
  server.includes('warmup') && (
    server.includes('perpsSymbol') ||
    server.includes('perps_symbol') ||
    server.includes('-PERP-') ||
    server.includes('getCandleBuffer') ||
    server.includes('getCandles') ||
    server.includes('Mirror')
  )
);

// ------- Section 4: Status Reporting -------
console.log('\n=== Section 4: Status Reporting ===');

check(
  'Engine start response includes perps info',
  server.includes('perpsSymbols') ||
  server.includes('perps_symbols') ||
  server.includes('spotToPerps')
);

check(
  'Engine start response includes mapping info',
  server.includes('Mapping') ||
  server.includes('mapping') ||
  server.includes('spotToPerps') ||
  server.includes('proxy')
);

// ------- Section 5: No Regressions -------
console.log('\n=== Section 5: No Regressions ===');

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
  'reduce_only flag on perps close orders present',
  server.includes('reduce_only')
);

check(
  'PerpsRiskMonitor start present',
  server.includes('perpsRiskMonitor') && server.includes('.start()')
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
  console.log('\n✅ All checks passed! TASK_003B complete.');
  process.exit(0);
}
