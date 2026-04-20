const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
let pass = 0;
let fail = 0;

function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

function check(label, condition) {
  if (condition) {
    console.log(`  PASS  ${label}`);
    pass++;
  } else {
    console.log(`  FAIL  ${label}`);
    fail++;
  }
}

console.log('=== TASK_005 Verification ===\n');

const restClient = read('atlas/apps/core-node/src/exchanges/coinbase/rest-client.ts');
check('Bug A: REST client uses v3 orders endpoint',
  restClient.includes('api/v3/brokerage/orders/historical'));

check('Bug A: getOrder uses v3 endpoint',
  restClient.includes('api/v3/brokerage/orders/historical/'));

check('Bug A: getOrders has 404/401 graceful fallback',
  restClient.includes('error?.response?.status === 404'));

const trendFollow = read('atlas/apps/core-node/src/strategies/plugins/builtin/trend-follow-strategy.ts');
check('Bug B: No hardcoded "length < 25" threshold',
  !trendFollow.includes('length < 25'));

check('Bug B: Uses dynamic minFastData threshold',
  trendFollow.includes('minFastData') || trendFollow.includes('emaFast + 5'));

check('Bug B: Fallback indicator key resolution (ema_)',
  trendFollow.includes("ema_${emaFast}") || trendFollow.includes('ema_'));

const guardrails = read('atlas/apps/core-node/src/config/loadGuardrails.ts');
check('Bug C: disabled_strategies in Zod schema',
  guardrails.includes('disabled_strategies'));

const server = read('atlas/apps/core-node/src/api/server.ts');
check('Bug C: server.ts creates disabledStrategies from guardrails',
  server.includes('guardrails.disabled_strategies'));

check('Bug C: breakout enabled gated by disabledStrategies',
  server.includes("disabledStrategies.includes('breakout')"));

check('Bug C: vwap_mr enabled gated by disabledStrategies',
  server.includes("disabledStrategies.includes('vwap_mr')"));

check('Bug C: momentum enabled gated by disabledStrategies',
  server.includes("disabledStrategies.includes('momentum')"));

check('Bug C: disabledStrategies passed to SignalProcessor config',
  server.includes('disabledStrategies,'));

const paperSim = read('atlas/apps/core-node/src/trading/paper-trading-simulator.ts');
check('Bug D: PaperSimulator has short sell collateral logic',
  paperSim.includes('collateral for short'));

check('Bug D: Checks quote currency for short margin',
  paperSim.includes('quoteAvailable') || paperSim.includes('quoteCurrency'));

const websocket = read('atlas/apps/core-node/src/exchanges/coinbase/websocket.ts');
const noMsgBlock = websocket.substring(
  websocket.indexOf('no_recent_messages') !== -1
    ? websocket.indexOf('no_recent_messages')
    : websocket.indexOf('coinbase_ws_no_recent_messages'),
  websocket.indexOf('no_recent_messages') !== -1
    ? websocket.indexOf('no_recent_messages') + 300
    : websocket.indexOf('coinbase_ws_no_recent_messages') + 300
);
check('Bug E: Message-age stall does NOT call forceReconnect',
  !noMsgBlock.includes('forceReconnect'));

check('Bug E: Threshold raised to heartbeatTimeoutMs * 4',
  websocket.includes('heartbeatTimeoutMs * 4'));

check('Bug F: PerpsRiskMonitor gated on live mode',
  server.includes("mode === 'live'") && server.includes('perpsRiskMonitor.start()'));

check('Bug F: Paper mode logs skip message',
  server.includes('paper mode') && server.includes('NOT polling'));

console.log(`\n=== Results: ${pass} PASS / ${fail} FAIL ===`);
process.exit(fail > 0 ? 1 : 0);
