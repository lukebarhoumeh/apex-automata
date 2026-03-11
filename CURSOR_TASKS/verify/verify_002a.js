/**
 * Verification script for TASK_002A — Coinbase Perps Adapter
 * Run from project root: node CURSOR_TASKS/verify/verify_002a.js
 */
import fs from 'fs';
import path from 'path';

const BASE = 'atlas/apps/core-node/src/exchanges';
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

// ============ Section 1: Coinbase Types ============
console.log('\n📦 Section 1: Coinbase Perps Types (coinbase/types.ts)');
const cbTypes = readFile(`${BASE}/coinbase/types.ts`);
if (!cbTypes) {
  check('coinbase/types.ts exists', false);
} else {
  check('CoinbasePerpsProduct interface exists', cbTypes.includes('interface CoinbasePerpsProduct'));
  check('CoinbaseIntxPosition interface exists', cbTypes.includes('interface CoinbaseIntxPosition'));
  check('CoinbaseIntxPosition has number_of_contracts', cbTypes.includes('number_of_contracts'));
  check('CoinbaseIntxPortfolio interface exists', cbTypes.includes('interface CoinbaseIntxPortfolio'));
  check('CoinbaseIntxPortfolio has collateral field', /collateral\s*:\s*string/.test(cbTypes));
  check('CoinbaseFundingRate interface exists', cbTypes.includes('interface CoinbaseFundingRate'));
  check('CoinbaseFundingRate has funding_rate field', cbTypes.includes('funding_rate'));
  check('CoinbaseLeverageRequest interface exists', cbTypes.includes('interface CoinbaseLeverageRequest'));
  check("CoinbasePerpsProduct has product_type 'FUTURE'", cbTypes.includes("'FUTURE'"));
  check("CoinbasePerpsProduct has contract_expiry_type 'PERPETUAL'", cbTypes.includes("'PERPETUAL'"));
}

// ============ Section 2: REST Client Endpoints ============
console.log('\n🌐 Section 2: REST Client Perps Endpoints (coinbase/rest-client.ts)');
const restClient = readFile(`${BASE}/coinbase/rest-client.ts`);
if (!restClient) {
  check('rest-client.ts exists', false);
} else {
  check('getPerpsProducts method exists', restClient.includes('getPerpsProducts'));
  check('getIntxPositions method exists', restClient.includes('getIntxPositions'));
  check('getIntxPosition method exists', /getIntxPosition\s*\(/.test(restClient));
  check('getIntxPortfolio method exists', restClient.includes('getIntxPortfolio'));
  check('getFundingRate method exists', restClient.includes('getFundingRate'));
  check('setLeverage method exists', restClient.includes('setLeverage'));
  check('Imports CoinbasePerpsProduct', restClient.includes('CoinbasePerpsProduct'));
  check('Imports CoinbaseIntxPosition', restClient.includes('CoinbaseIntxPosition'));
  check('Uses /api/v3/brokerage endpoint path', restClient.includes('/api/v3/brokerage'));
  check('Uses intx/positions endpoint', restClient.includes('intx/positions'));
}

// ============ Section 3: Adapter Types ============
console.log('\n🔌 Section 3: Adapter Types (exchanges/types.ts)');
const adapterTypes = readFile(`${BASE}/types.ts`);
if (!adapterTypes) {
  check('exchanges/types.ts exists', false);
} else {
  check('AdapterFundingRate interface exists', adapterTypes.includes('interface AdapterFundingRate'));
  check('AdapterPortfolioSummary interface exists', adapterTypes.includes('interface AdapterPortfolioSummary'));
  check('IPerpsAdapter interface exists', adapterTypes.includes('interface IPerpsAdapter'));
  check('isPerpsAdapter function exists', adapterTypes.includes('function isPerpsAdapter'));
  check('IPerpsAdapter has getFundingRate', /IPerpsAdapter[\s\S]*?getFundingRate/.test(adapterTypes));
  check('IPerpsAdapter has setLeverage', /IPerpsAdapter[\s\S]*?setLeverage/.test(adapterTypes));
  check('IPerpsAdapter has getLeverage', /IPerpsAdapter[\s\S]*?getLeverage/.test(adapterTypes));
  check('IPerpsAdapter has getPerpsSymbols', /IPerpsAdapter[\s\S]*?getPerpsSymbols/.test(adapterTypes));
  check('IPerpsAdapter has getPortfolioSummary', /IPerpsAdapter[\s\S]*?getPortfolioSummary/.test(adapterTypes));
  check('IPerpsAdapter has isPerpsSymbol', /IPerpsAdapter[\s\S]*?isPerpsSymbol/.test(adapterTypes));
  // Verify IExchangeAdapter is unchanged
  check('IExchangeAdapter still extends EventEmitter', adapterTypes.includes('IExchangeAdapter extends EventEmitter'));
  check('IExchangeAdapter still has placeOrder', /IExchangeAdapter[\s\S]*?placeOrder/.test(adapterTypes));
  check('ExchangeType still includes perpetual', adapterTypes.includes("'perpetual'"));
}

// ============ Section 4: CoinbasePerpsAdapter ============
console.log('\n🚀 Section 4: CoinbasePerpsAdapter (coinbase-perps-adapter.ts)');
const perpsAdapter = readFile(`${BASE}/coinbase-perps-adapter.ts`);
if (!perpsAdapter) {
  check('coinbase-perps-adapter.ts exists', false);
} else {
  check('File exists', true);
  check('Extends CoinbaseAdapter', perpsAdapter.includes('extends CoinbaseAdapter'));
  check('Implements IPerpsAdapter', perpsAdapter.includes('implements IPerpsAdapter'));
  check("id is 'coinbase-perps'", perpsAdapter.includes("'coinbase-perps'"));
  check("name includes 'Perpetual'", perpsAdapter.includes('Perpetual'));
  check("exchangeType is 'perpetual'", /exchangeType.*=.*'perpetual'/.test(perpsAdapter));
  check('Has getPositions override', /override\s+async\s+getPositions/.test(perpsAdapter) || (perpsAdapter.includes('getPositions') && !perpsAdapter.includes('return []')));
  check('getPositions does NOT return empty array unconditionally', !(/async getPositions.*\{[\s\n]*return \[\]/.test(perpsAdapter)));
  check('Has getFundingRate method', perpsAdapter.includes('getFundingRate'));
  check('Has setLeverage with validation', perpsAdapter.includes('setLeverage') && (perpsAdapter.includes('leverage < 1') || perpsAdapter.includes('leverage > 10') || perpsAdapter.includes('1-10')));
  check('Has getLeverage method', /getLeverage\s*\(/.test(perpsAdapter));
  check('Has getPortfolioSummary method', perpsAdapter.includes('getPortfolioSummary'));
  check('Has getPerpsSymbols method', perpsAdapter.includes('getPerpsSymbols'));
  check('Has isPerpsSymbol method', perpsAdapter.includes('isPerpsSymbol'));
  check('Has refreshPerpsProducts method', perpsAdapter.includes('refreshPerpsProducts'));
  check('Has getMarketInfo override', perpsAdapter.includes('getMarketInfo'));
  check('Perps maker fee is 0.0000', perpsAdapter.includes('0.0000'));
  check('Perps taker fee is 0.0003', perpsAdapter.includes('0.0003'));
  check('Imports from coinbase-adapter', perpsAdapter.includes('./coinbase-adapter'));
  check('Imports from ./types', perpsAdapter.includes("from './types'") || perpsAdapter.includes("from \"./types\""));
  check('Imports from ./coinbase', perpsAdapter.includes('./coinbase'));
  check('Has perpsProductCache', perpsAdapter.includes('perpsProductCache'));
  check('Has leverageCache', perpsAdapter.includes('leverageCache'));
}

// ============ Section 5: Barrel Exports ============
console.log('\n📤 Section 5: Barrel Exports (exchanges/index.ts)');
const barrelExports = readFile(`${BASE}/index.ts`);
if (!barrelExports) {
  check('exchanges/index.ts exists', false);
} else {
  check('Exports CoinbasePerpsAdapter', barrelExports.includes('CoinbasePerpsAdapter'));
  check('Still exports CoinbaseAdapter', barrelExports.includes('CoinbaseAdapter'));
  check('Still exports ExchangeRegistry', barrelExports.includes('ExchangeRegistry'));
  check("Still exports types via export * from './types'", barrelExports.includes("export * from './types'") || barrelExports.includes('export * from "./types"'));
  check('Still exports CoinbaseExchange', barrelExports.includes('CoinbaseExchange'));
}

// ============ Section 6: No Regressions ============
console.log('\n🛡️  Section 6: No Regressions');
const spotAdapter = readFile(`${BASE}/coinbase-adapter.ts`);
if (!spotAdapter) {
  check('coinbase-adapter.ts still exists', false);
} else {
  check("CoinbaseAdapter still has id = 'coinbase'", /id\s*=\s*'coinbase'/.test(spotAdapter) && !spotAdapter.includes("'coinbase-perps'"));
  check("CoinbaseAdapter still has exchangeType = 'spot'", /exchangeType.*=.*'spot'/.test(spotAdapter));
  check('CoinbaseAdapter.getPositions still returns []', /getPositions[\s\S]*?return\s*\[\]/.test(spotAdapter));
  check('CoinbaseAdapter still has getUnderlyingExchange', spotAdapter.includes('getUnderlyingExchange'));
}

const registry = readFile(`${BASE}/exchange-registry.ts`);
if (!registry) {
  check('exchange-registry.ts still exists', false);
} else {
  check('ExchangeRegistry is unchanged (still has register/get/getDefault)',
    registry.includes('register(') && registry.includes('getDefault(') && registry.includes('get('));
}

// ============ Summary ============
console.log('\n' + '='.repeat(60));
console.log(`✅ Passed: ${passed}`);
console.log(`❌ Failed: ${failed}`);
console.log(`⚠️  Warnings: ${warnings}`);
console.log('='.repeat(60));

if (failed === 0) {
  console.log('\n🎉 All checks passed. TASK_002A verified clean.\n');
} else {
  console.log(`\n🔴 ${failed} check(s) failed. Review output above.\n`);
  process.exit(1);
}
