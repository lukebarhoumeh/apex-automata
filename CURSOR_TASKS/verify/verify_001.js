#!/usr/bin/env node
/**
 * Verify Task 001 — Phase 4A Exchange Abstraction Layer
 * Run: node CURSOR_TASKS/verify/verify_001.js
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const BASE = path.join(__dirname, '../../atlas/apps/core-node/src');

let passed = 0;
let failed = 0;
let warnings = 0;

function check(name, condition) {
  if (condition) {
    console.log(`  ✅ ${name}`);
    passed++;
  } else {
    console.log(`  ❌ ${name}`);
    failed++;
  }
}

function warn(name) {
  console.log(`  ⚠️  ${name}`);
  warnings++;
}

function fileExists(relPath) {
  return fs.existsSync(path.join(BASE, relPath));
}

function readFile(relPath) {
  return fs.readFileSync(path.join(BASE, relPath), 'utf-8');
}

console.log('\n🔍 Verifying Task 001 — Phase 4A Exchange Abstraction Layer\n');

// ============ SECTION 1: File Existence ============
console.log('📁 File Existence:');

check('exchanges/types.ts exists', fileExists('exchanges/types.ts'));
check('exchanges/exchange-registry.ts exists', fileExists('exchanges/exchange-registry.ts'));
check('exchanges/coinbase-adapter.ts exists', fileExists('exchanges/coinbase-adapter.ts'));
check('exchanges/index.ts exists (barrel)', fileExists('exchanges/index.ts'));
check('coinbase/index.ts still exists (not overwritten)', fileExists('exchanges/coinbase/index.ts'));

// ============ SECTION 2: IExchangeAdapter Interface ============
console.log('\n🔌 IExchangeAdapter Interface (exchanges/types.ts):');

if (fileExists('exchanges/types.ts')) {
  const types = readFile('exchanges/types.ts');

  check('Exports IExchangeAdapter interface', types.includes('export interface IExchangeAdapter'));
  check('IExchangeAdapter extends EventEmitter', types.includes('IExchangeAdapter') && types.includes('EventEmitter'));
  check('Has readonly id: string', types.includes('readonly id: string'));
  check('Has readonly exchangeType', types.includes('readonly exchangeType'));
  check('Has initialize() method', types.includes('initialize('));
  check('Has shutdown() method', types.includes('shutdown()'));
  check('Has placeOrder() method', types.includes('placeOrder('));
  check('Has cancelOrder() method', types.includes('cancelOrder('));
  check('Has getBalances() method', types.includes('getBalances()'));
  check('Has getPositions() method', types.includes('getPositions()'));
  check('Has subscribeOrderBook() method', types.includes('subscribeOrderBook('));
  check('Has subscribeTicker() method', types.includes('subscribeTicker('));
  check('Has getCandles() method', types.includes('getCandles('));
  check('Has getMarkets() method', types.includes('getMarkets()'));

  // Check adapter types exist
  check('AdapterOrderRequest type exported', types.includes('AdapterOrderRequest') || types.includes('OrderRequest'));
  check('AdapterOrderResult type exported', types.includes('AdapterOrderResult') || types.includes('OrderResult'));
  check('AdapterBalance type exported', types.includes('AdapterBalance') || types.includes('BalanceInfo'));
  check('ExchangeType defined (spot | perpetual)', types.includes('spot') && types.includes('perpetual'));
  check('OrderSide defined (buy | sell)', types.includes("'buy'") && types.includes("'sell'"));

  // Perps support in types
  check('reduceOnly field for perpetuals', types.includes('reduceOnly'));
  check('leverage field for perpetuals', types.includes('leverage'));
  check('liquidationPrice field', types.includes('liquidationPrice'));
} else {
  console.log('  ❌ SKIPPED — file not found');
  failed += 15;
}

// ============ SECTION 3: ExchangeRegistry ============
console.log('\n📋 ExchangeRegistry (exchanges/exchange-registry.ts):');

if (fileExists('exchanges/exchange-registry.ts')) {
  const registry = readFile('exchanges/exchange-registry.ts');

  check('Exports ExchangeRegistry class', registry.includes('export class ExchangeRegistry'));
  check('Extends EventEmitter', registry.includes('extends EventEmitter'));
  check('Has register() method', registry.includes('register('));
  check('Has get() method', registry.includes('get('));
  check('Has getDefault() method', registry.includes('getDefault()'));
  check('Has setDefault() method', registry.includes('setDefault('));
  check('Has shutdown() method', registry.includes('shutdown()'));
  check('Has has() method', registry.includes('has('));
  check('Has remove() method', registry.includes('remove('));
  check('Uses Map<string, IExchangeAdapter>', registry.includes('Map<'));
  check('Throws on duplicate registration', registry.includes('already registered'));
  check('Throws on missing adapter', registry.includes('not found'));
  check('Uses Logger', registry.includes('Logger'));
} else {
  console.log('  ❌ SKIPPED — file not found');
  failed += 13;
}

// ============ SECTION 4: CoinbaseAdapter ============
console.log('\n🏦 CoinbaseAdapter (exchanges/coinbase-adapter.ts):');

if (fileExists('exchanges/coinbase-adapter.ts')) {
  const adapter = readFile('exchanges/coinbase-adapter.ts');

  check('Exports CoinbaseAdapter class', adapter.includes('export class CoinbaseAdapter'));
  check('Implements IExchangeAdapter', adapter.includes('implements IExchangeAdapter'));
  check('id = \'coinbase\'', adapter.includes("'coinbase'"));
  check('exchangeType = \'spot\'', adapter.includes("'spot'"));
  check('Imports CoinbaseExchange', adapter.includes('CoinbaseExchange'));
  check('Has initialize() method', adapter.includes('initialize('));
  check('Has shutdown() method', adapter.includes('shutdown()'));
  check('Has placeOrder() method', adapter.includes('placeOrder('));
  check('Has getPositions() returning []', adapter.includes('getPositions') && adapter.includes('[]'));
  check('Has getBalances() method', adapter.includes('getBalances()'));
  check('Bridges events (ticker:update)', adapter.includes('ticker:update'));
  check('Bridges events (order:update)', adapter.includes('order:update'));
  check('Maps CoinbaseOrder to AdapterOrderResult', adapter.includes('mapOrderToResult') || adapter.includes('OrderResult'));
  check('Does NOT import rest-client directly', !adapter.includes('from \'./coinbase/rest-client\''));
  check('Does NOT import websocket directly', !adapter.includes('from \'./coinbase/websocket\''));

  // Check for getUnderlyingExchange (backward compat escape hatch)
  if (adapter.includes('getUnderlyingExchange') || adapter.includes('getExchange')) {
    check('Has backward-compat escape hatch to underlying exchange', true);
  } else {
    warn('No getUnderlyingExchange() method — may need for reconciler/health access');
  }
} else {
  console.log('  ❌ SKIPPED — file not found');
  failed += 15;
}

// ============ SECTION 5: Barrel Export ============
console.log('\n📦 Barrel Export (exchanges/index.ts):');

if (fileExists('exchanges/index.ts')) {
  const barrel = readFile('exchanges/index.ts');

  check('Exports from types', barrel.includes('./types'));
  check('Exports ExchangeRegistry', barrel.includes('ExchangeRegistry'));
  check('Exports CoinbaseAdapter', barrel.includes('CoinbaseAdapter'));
  check('Re-exports CoinbaseExchange for backward compat', barrel.includes('CoinbaseExchange'));
} else {
  console.log('  ❌ SKIPPED — file not found');
  failed += 4;
}

// ============ SECTION 6: OrderManager Update ============
console.log('\n⚙️  OrderManager Update (trading/order-manager.ts):');

if (fileExists('trading/order-manager.ts')) {
  const om = readFile('trading/order-manager.ts');

  check('Imports IExchangeAdapter', om.includes('IExchangeAdapter'));
  check('Has exchangeAdapter property', om.includes('exchangeAdapter'));
  check('Has setExchangeAdapter() method', om.includes('setExchangeAdapter'));
  check('Still imports CoinbaseExchange (backward compat)', om.includes('CoinbaseExchange'));
  check('Constructor signature unchanged (still takes CoinbaseExchange)', om.includes('exchange: CoinbaseExchange'));
  check('Existing createOrder still references this.exchange', om.includes('this.exchange.createOrder') || om.includes('this.exchange'));
} else {
  console.log('  ❌ SKIPPED — file not found');
  failed += 6;
}

// ============ SECTION 7: No Coinbase Internals Modified ============
console.log('\n🛡️  Coinbase Internals Unchanged:');

if (fileExists('exchanges/coinbase/types.ts')) {
  const cbTypes = readFile('exchanges/coinbase/types.ts');
  check('coinbase/types.ts still starts with CoinbaseConfig', cbTypes.includes('export interface CoinbaseConfig'));
  check('coinbase/types.ts does NOT import from ../types', !cbTypes.includes('from \'../types\''));
}

if (fileExists('exchanges/coinbase/index.ts')) {
  const cbIndex = readFile('exchanges/coinbase/index.ts');
  check('coinbase/index.ts still exports CoinbaseExchange', cbIndex.includes('CoinbaseExchange'));
}

// ============ SUMMARY ============
console.log(`\n${'═'.repeat(60)}`);
console.log(`  Passed:   ${passed}`);
console.log(`  Failed:   ${failed}`);
console.log(`  Warnings: ${warnings}`);
console.log(`${'═'.repeat(60)}`);

if (failed === 0) {
  console.log(`\n✅ ALL ${passed} CHECKS PASSED — Phase 4A verified!`);
  if (warnings > 0) {
    console.log(`   (${warnings} non-blocking warning(s) — review recommended)\n`);
  } else {
    console.log('');
  }
  process.exit(0);
} else {
  console.log(`\n❌ ${failed} CHECK(S) FAILED — come back to Cowork Claude for diagnosis\n`);
  process.exit(1);
}
