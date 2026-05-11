/**
 * One-shot helper to compute the locked-in snapshot values used by
 * `__tests__/indicator-snapshot.test.ts`. Run once after any deliberate
 * indicator-formula change, copy the printed numbers into the test, commit.
 */

import { ValidatedIndicators } from '../src/indicators/validated-indicators';
import type { OHLCV } from '../src/indicators/technical';

function makeFixture(): OHLCV[] {
  const candles: OHLCV[] = [];
  let seed = 1337;
  let price = 50000;
  for (let i = 0; i < 50; i++) {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    const change = ((seed / 2147483648) - 0.5) * 0.02;
    const close = price * (1 + change);
    const high = Math.max(price, close) * (1 + Math.abs(change) * 0.4);
    const low = Math.min(price, close) * (1 - Math.abs(change) * 0.4);
    candles.push({
      time: 1700000000000 + i * 60000,
      open: price,
      high,
      low,
      close,
      volume: 100 + (seed % 200),
    });
    price = close;
  }
  return candles;
}

const candles = makeFixture();
const closes = candles.map((c) => c.close);

const ema12 = ValidatedIndicators.EMA(closes, 12);
const rsi14 = ValidatedIndicators.RSI(closes, 14);
const atr14 = ValidatedIndicators.ATR(candles, 14);
const adx14 = ValidatedIndicators.ADX(candles, 14);
const macd = ValidatedIndicators.MACD(closes, 12, 26, 9);

console.log('SNAPSHOT_LAST_CLOSE =', closes[closes.length - 1].toFixed(8));
console.log('SNAPSHOT_EMA12_LAST =', ema12[ema12.length - 1].toFixed(8));
console.log('SNAPSHOT_RSI14_LAST =', rsi14[rsi14.length - 1].toFixed(8));
console.log('SNAPSHOT_ATR14_LAST =', atr14[atr14.length - 1].toFixed(8));
console.log('SNAPSHOT_ADX14_LAST =', adx14.adx[adx14.adx.length - 1].toFixed(8));
console.log('SNAPSHOT_MACD_LAST  =', macd.macd[macd.macd.length - 1].toFixed(8));
console.log('SNAPSHOT_MSIG_LAST  =', macd.signal[macd.signal.length - 1].toFixed(8));
console.log('SNAPSHOT_MHIST_LAST =', macd.histogram[macd.histogram.length - 1].toFixed(8));
