const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
let pass = 0;
let fail = 0;

function exists(rel) { return fs.existsSync(path.join(root, rel)); }
function read(rel) { return fs.readFileSync(path.join(root, rel), 'utf8'); }
function check(label, condition) {
  if (condition) { console.log(`  PASS  ${label}`); pass++; }
  else { console.log(`  FAIL  ${label}`); fail++; }
}

console.log('=== TASK_007 Verification ===\n');

check('1. Hyperliquid adapter directory created',
  exists('atlas/apps/core-node/src/exchanges/hyperliquid'));

check('2. HyperliquidAdapter class exists',
  exists('atlas/apps/core-node/src/exchanges/hyperliquid/index.ts') &&
  read('atlas/apps/core-node/src/exchanges/hyperliquid/index.ts').includes('class HyperliquidAdapter'));

check('3. Implements IExchangeAdapter',
  read('atlas/apps/core-node/src/exchanges/hyperliquid/index.ts').includes('implements IExchangeAdapter'));

check('4. Implements IPerpsAdapter',
  read('atlas/apps/core-node/src/exchanges/hyperliquid/index.ts').includes('IPerpsAdapter'));

check('5. Type mappings file created',
  exists('atlas/apps/core-node/src/exchanges/hyperliquid/types.ts'));

check('6. hyperliquid SDK in dependencies',
  read('atlas/apps/core-node/package.json').includes('"hyperliquid"'));

check('7. Hyperliquid config in guardrails.yaml',
  read('atlas/config/guardrails.yaml').includes('hyperliquid:'));

check('8. Testnet is default (safety)',
  read('atlas/apps/core-node/src/exchanges/hyperliquid/types.ts').includes('testnet: true'));

const adapter = read('atlas/apps/core-node/src/exchanges/hyperliquid/index.ts');
check('9. Uses nomeida/hyperliquid SDK',
  adapter.includes("from 'hyperliquid'"));

check('10. placeOrder implemented (not just placeholder)',
  adapter.includes('placeOrder') && adapter.includes('sdk!.exchange.placeOrder'));

check('11. getCandles implemented',
  adapter.includes('getCandleSnapshot'));

check('12. getBalances uses clearinghouseState',
  adapter.includes('getClearinghouseState'));

check('13. getPositions maps szi to side/size',
  adapter.includes('szi'));

check('14. subscribeOrderBook uses SDK subscriptions',
  adapter.includes('subscribeToL2Book'));

check('15. subscribeUserOrders uses SDK subscriptions',
  adapter.includes('subscribeToOrderUpdates'));

check('16. getFundingRate implemented',
  adapter.includes('getPredictedFundings'));

check('17. setLeverage uses updateLeverage',
  adapter.includes('updateLeverage'));

check('18. Symbol mapping: ETH-USD → ETH-PERP',
  read('atlas/apps/core-node/src/exchanges/hyperliquid/types.ts').includes('PERP'));

const guardrails = read('atlas/config/guardrails.yaml');
check('19. hyperliquid_symbols section exists',
  guardrails.includes('hyperliquid_symbols:'));

check('20. Hyperliquid fee config present',
  guardrails.includes('taker_fee: 0.0005'));

check('21. Adapter test file exists',
  exists('atlas/apps/core-node/src/__tests__/hyperliquid-adapter.test.ts'));

console.log(`\n=== Results: ${pass} PASS / ${fail} FAIL ===`);
process.exit(fail > 0 ? 1 : 0);
