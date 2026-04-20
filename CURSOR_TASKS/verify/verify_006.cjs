const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
let pass = 0;
let fail = 0;

function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

function exists(rel) {
  return fs.existsSync(path.join(root, rel));
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

console.log('=== TASK_006 Verification ===\n');

check('1. streaming-indicators.ts created',
  exists('atlas/apps/core-node/src/indicators/streaming-indicators.ts'));

check('2. validated-indicators.ts created',
  exists('atlas/apps/core-node/src/indicators/validated-indicators.ts'));

check('3. indicator-parity.test.ts created',
  exists('atlas/apps/core-node/src/__tests__/indicator-parity.test.ts'));

const streamingInd = exists('atlas/apps/core-node/src/indicators/streaming-indicators.ts')
  ? read('atlas/apps/core-node/src/indicators/streaming-indicators.ts') : '';
const validatedInd = exists('atlas/apps/core-node/src/indicators/validated-indicators.ts')
  ? read('atlas/apps/core-node/src/indicators/validated-indicators.ts') : '';

check('4. trading-signals imported in streaming-indicators.ts',
  streamingInd.includes("from 'trading-signals'"));

check('5. trading-signals imported in validated-indicators.ts',
  validatedInd.includes("from 'trading-signals'"));

check('6. ValidatedIndicators exports SMA, EMA, RSI, MACD, BB, ATR, ADX',
  validatedInd.includes('static SMA') &&
  validatedInd.includes('static EMA') &&
  validatedInd.includes('static RSI') &&
  validatedInd.includes('static MACD') &&
  validatedInd.includes('static BollingerBands') &&
  validatedInd.includes('static ATR') &&
  validatedInd.includes('static ADX'));

const signalProcessor = read('atlas/apps/core-node/src/strategies/signal-processor.ts');
check('7. ValidatedIndicators imported in signal-processor.ts',
  signalProcessor.includes("from '../indicators/validated-indicators'"));

check('8. signal-processor uses ValidatedIndicators.SMA',
  signalProcessor.includes('ValidatedIndicators.SMA'));

check('9. signal-processor uses ValidatedIndicators.EMA',
  signalProcessor.includes('ValidatedIndicators.EMA'));

check('10. signal-processor uses ValidatedIndicators.RSI',
  signalProcessor.includes('ValidatedIndicators.RSI'));

check('11. signal-processor uses ValidatedIndicators.MACD',
  signalProcessor.includes('ValidatedIndicators.MACD'));

check('12. signal-processor uses ValidatedIndicators.BollingerBands',
  signalProcessor.includes('ValidatedIndicators.BollingerBands'));

check('13. signal-processor uses ValidatedIndicators.ATR',
  signalProcessor.includes('ValidatedIndicators.ATR'));

check('14. technical.ts preserved as fallback',
  exists('atlas/apps/core-node/src/indicators/technical.ts'));

check('15. VWAP still uses TechnicalIndicators (not in trading-signals)',
  signalProcessor.includes('TechnicalIndicators.VWAP'));

check('16. DonchianChannels still uses TechnicalIndicators (not in trading-signals)',
  signalProcessor.includes('TechnicalIndicators.DonchianChannels'));

check('17. v7 API: no .toNumber() calls in code (native numbers in v7)',
  !validatedInd.includes('.getResult().toNumber()'));

check('18. v7 API: MACD uses EMA instances, not config object',
  validatedInd.includes('new MACD(') && validatedInd.includes('new EMA('));

console.log(`\n=== Results: ${pass} PASS / ${fail} FAIL ===`);
process.exit(fail > 0 ? 1 : 0);
