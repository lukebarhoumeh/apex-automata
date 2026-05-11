/**
 * Backtest realism demo. Runs a single deterministic backtest on synthetic
 * data and prints the report. Used in the fix/backtest-engine-realism
 * deliverable to capture before/after summary stats without requiring
 * Supabase candles.
 */
import { Logger } from '../core/logger';
import { BacktestEngine, BacktestConfig } from '../backtesting/backtest-engine';
import { OHLCV } from '../indicators/technical';

// Quiet logger — debug suppressed, only warn/error to stderr. The default
// createLogger flushes every debug line to console, which is too slow for a
// 1500-bar backtest.
const logger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: (msg: string, extra?: unknown) => console.warn('WARN', msg, extra ?? ''),
  error: (msg: string, extra?: unknown) => console.error('ERROR', msg, extra ?? ''),
};

function buildDeterministicCandles(count: number, seed: number): OHLCV[] {
  let state = seed >>> 0;
  const rand = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return (state >>> 8) / 0x01000000;
  };

  const candles: OHLCV[] = [];
  let price = 30_000;
  for (let i = 0; i < count; i++) {
    // Add a slow uptrend so trend_follow can fire
    const trend = i * 1.5;
    const noise = (rand() - 0.5) * 200;
    const open = price;
    const close = price + noise + trend * 0.05;
    const high = Math.max(open, close) + rand() * 80;
    const low = Math.min(open, close) - rand() * 80;
    candles.push({
      time: 1_700_000_000_000 + i * 60_000,
      open,
      high,
      low,
      close,
      volume: 100 + rand() * 50,
    });
    price = close;
  }
  return candles;
}

async function main() {
  const candles = buildDeterministicCandles(1500, 42);
  console.log(`[demo] generated ${candles.length} synthetic 1m candles, deterministic seed=42`);

  const baseConfig: BacktestConfig = {
    startDate: new Date(candles[0].time),
    endDate: new Date(candles[candles.length - 1].time),
    initialCapital: 10_000,
    commission: 0.0005, // 5 bps Hyperliquid taker
    slippage: 0.0005,
    products: ['BTC-USD'],
    signals: {
      breakout: { enabled: true, parameters: {} },
      vwapMeanReversion: { enabled: true, parameters: {} },
      momentum: { enabled: true, parameters: {} },
      trendFollow: { enabled: true, parameters: {} },
    },
    risk: {
      maxPositionSize: 3_000,
      maxTotalExposure: 30_000,
      stopLossPercent: 0.02,
      takeProfitPercent: 0.04,
    },
    account: {
      equityUsd: 10_000,
      riskPerTrade: 0.005,
      maxPositionExposurePct: 0.30,
      minNotionalBuffer: 1.1,
    },
    disabledStrategies: ['vwap_mr', 'breakout'],
  };

  // SCENARIO A — pre-fix simulation: same-bar fill, no overshoot, no trend_follow.
  const before: BacktestConfig = {
    ...baseConfig,
    signals: {
      ...baseConfig.signals,
      trendFollow: { enabled: false, parameters: {} },
    },
    disabledStrategies: [], // pre-fix didn't honour the kill list
    realism: {
      nextBarFill: false, // look-ahead bug
      entrySlippageBps: 5,
      stopOvershootBarRangePct: 0, // no overshoot
      stopOvershootMinBps: 0,
      sizeDecimals: 6,
    },
    // Force the legacy fixed sizing by pinning equity high so risk-based
    // would naturally exceed the legacy $5k cap (which we put back in
    // maxPositionSize here to mimic prior behaviour).
    risk: {
      maxPositionSize: 5_000,
      maxTotalExposure: 8_000,
      stopLossPercent: 0.02,
      takeProfitPercent: 0.04,
    },
  };

  // SCENARIO B — post-fix: realism on, trend_follow wired, disabled honoured.
  const after: BacktestConfig = baseConfig;

  const beforeEngine = new BacktestEngine(before, logger);
  await beforeEngine.loadHistoricalData(async () => candles);
  const beforeResult = await beforeEngine.run();

  const afterEngine = new BacktestEngine(after, logger);
  await afterEngine.loadHistoricalData(async () => candles);
  const afterResult = await afterEngine.run();

  const fmt = (n: number, d = 2) => n.toFixed(d);
  const pad = (s: string, n = 24) => s.padEnd(n);

  const printReport = (label: string, result: typeof beforeResult) => {
    const m = result.metrics;
    console.log(`\n=== ${label} ===`);
    console.log(`${pad('active_strategies')}${(m.activeStrategies || []).join(', ') || '(none)'}`);
    console.log(`${pad('disabled_strategies')}${(result.config.disabledStrategies || []).join(', ') || '(none)'}`);
    console.log(`${pad('total_trades')}${m.totalTrades}`);
    console.log(`${pad('win_rate_%')}${fmt(m.winRate * 100)}`);
    console.log(`${pad('return_%')}${fmt(m.returnPercent)}`);
    console.log(`${pad('net_profit_$')}${fmt(m.netProfit)}`);
    console.log(`${pad('max_drawdown_%')}${fmt(m.maxDrawdownPercent * 100)}`);
    console.log(`${pad('profit_factor')}${fmt(m.profitFactor)}`);
    console.log(`${pad('sharpe')}${fmt(m.sharpeRatio)}`);
    console.log(`${pad('total_fees_$')}${fmt(m.totalFees)}`);
    console.log(`${pad('final_capital_$')}${fmt(m.finalCapital)}`);
    console.log(`${pad('by_strategy')}`);
    for (const [id, b] of Object.entries(m.byStrategy || {})) {
      console.log(`  ${id.padEnd(14)} trades=${String(b.trades).padStart(3)} winRate=${fmt(b.winRate * 100, 1)}% netPnL=$${fmt(b.netProfit)} avgR=${fmt(b.averageRMultiple, 2)}`);
    }
  };

  printReport('BEFORE (pre-fix simulation: same-bar fills, no overshoot, no trend_follow, no disabled list)', beforeResult);
  printReport('AFTER  (post-fix: next-bar fills, 20%-bar-range stop overshoot, trend_follow on, disabled honoured)', afterResult);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
