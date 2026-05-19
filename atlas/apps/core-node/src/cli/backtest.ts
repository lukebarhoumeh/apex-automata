import path from 'node:path';
import dotenv from 'dotenv';
// .env lives at the repo root; pnpm sets cwd to atlas/apps/core-node.
dotenv.config({ path: path.resolve(process.cwd(), '../../../.env') });
import yargs from 'yargs/yargs';
import { hideBin } from 'yargs/helpers';
import { createLogger } from '../core/logger';
import { BacktestRunner, BacktestRunnerConfig } from '../backtesting/backtest-runner';
import { BacktestConfig, PerSymbolStrategyOverrides } from '../backtesting/backtest-engine';
import { loadGuardrails } from '../config/loadGuardrails';
import { buildPerSymbolDisabledStrategies } from '../strategies/per-symbol-disable';
import { FeeModel } from '../core/fee-model';

async function main() {
  // Single source of truth for fees — backtest must match paper/live or
  // comparisons are meaningless. Per #11 (2026-05-18), we pass the
  // FeeModel into BacktestConfig so per-fill fees route by symbol
  // (spot vs perps_intx) instead of one flat decimal applied uniformly.
  // CLI `--commission` is kept as an explicit sensitivity-analysis
  // override (e.g. simulate HL 4.5 bps on Coinbase candles).
  const atlasRoot = path.resolve(process.cwd(), '../..');
  const guardrails = loadGuardrails(atlasRoot);
  const feeModel = FeeModel.fromGuardrails(guardrails);

  const argv = await yargs(hideBin(process.argv))
    .scriptName('atlas-backtest')
    .usage('$0 [options]')
    .option('start-date', {
      type: 'string',
      describe: 'Start date (YYYY-MM-DD)',
      demandOption: true,
    })
    .option('end-date', {
      type: 'string',
      describe: 'End date (YYYY-MM-DD)',
      demandOption: true,
    })
    .option('products', {
      type: 'array',
      describe: 'Products to backtest (e.g., BTC-USD ETH-USD)',
      default: ['BTC-USD'],
    })
    .option('initial-capital', {
      type: 'number',
      describe: 'Initial capital',
      default: 10000,
    })
    .option('results-path', {
      type: 'string',
      describe: 'Path to save results',
      default: path.resolve(process.cwd(), '../../var/backtest_results'),
    })
    .option('strategy', {
      type: 'string',
      describe: 'Strategy to test (breakout, vwap, momentum, trend_follow, all). disabled_strategies in guardrails.yaml override this.',
      default: 'all',
    })
    .option('commission', {
      type: 'number',
      describe:
        'OPTIONAL flat commission override (decimal, e.g. 0.00045 = 4.5 bps). ' +
        'When set, every fill is charged this rate regardless of symbol — ' +
        'use this to simulate Hyperliquid fees on Coinbase candles or for ' +
        'sensitivity analysis. When omitted, fees are resolved per-symbol ' +
        'via FeeModel (coinbase.spot.taker_bps for spot, ' +
        'coinbase.perps_intx.taker_bps for *-PERP-INTX).',
    })
    .option('slippage', {
      type: 'number',
      describe: 'Slippage rate (e.g., 0.0005 for 5 bps)',
      default: 0.0005,
    })
    .option('optimize', {
      type: 'boolean',
      describe: 'Run parameter optimization',
      default: false,
    })
    .help()
    .parse();

  const logger = createLogger(path.join(process.cwd(), '../../var/logs/backtest.jsonl'));

  // NOTE: `guardrails` and `feeModel` are loaded at the top of main()
  // and passed into BacktestConfig below. Both backtest-engine
  // (disabled_strategies, per-symbol overrides, account sizing) and
  // the fee resolution path read from the same source of truth so
  // backtest behaviour can't drift from paper/live.

  const SUPABASE_URL = process.env.SUPABASE_URL || '';
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY — backtest reads candles from public.bars');
    process.exit(1);
  }

  logger.info('Starting backtest', {
    startDate: argv.startDate,
    endDate: argv.endDate,
    products: argv.products,
    strategy: argv.strategy,
    feeRouting: argv.commission !== undefined ? 'flat-override' : 'per-symbol-feeModel',
    commissionOverride: argv.commission,
  });

  const runnerConfig: BacktestRunnerConfig = {
    resultsPath: String(argv.resultsPath),
    supabaseUrl: SUPABASE_URL,
    supabaseKey: SUPABASE_SERVICE_KEY,
  };

  const runner = new BacktestRunner(runnerConfig, logger);

  // Build per-symbol overrides snapshot the same way live trading does
  // (signal-processor.loadPerSymbolOverridesFromGuardrails called twice in
  // api/server.ts:1631-1644 — once for per_symbol, once for perps_symbols).
  // Backtest then forwards this verbatim to the strategy registry.
  //
  // F4 follow-up (2026-05-19): same backtest/live drift class as #11 — the
  // CLI previously read only `guardrails.per_symbol` and silently dropped
  // `guardrails.perps_symbols.*.strategy_overrides`, so YAML-side perps
  // momentum/trend_follow tuning was invisible to backtests while live
  // honoured it. Mirror the live dual-call here so the backtest sees the
  // same per-symbol config the engine uses in paper/live. See
  // docs/research/2026-05-19_f4-followup-perps-action.md §3.
  const perSymbolOverrides: PerSymbolStrategyOverrides = {};
  for (const [symbol, cfg] of Object.entries(guardrails.per_symbol ?? {})) {
    if (cfg.strategy_overrides) {
      perSymbolOverrides[symbol] = cfg.strategy_overrides as Record<string, Record<string, unknown>>;
    }
  }
  for (const [symbol, cfg] of Object.entries(guardrails.perps_symbols ?? {})) {
    if (cfg.strategy_overrides) {
      perSymbolOverrides[symbol] = cfg.strategy_overrides as Record<string, Record<string, unknown>>;
    }
  }

  const initialCapital = Number(argv.initialCapital);

  // #11 (2026-05-18): only set `commission` when the user passed
  // `--commission` explicitly. When omitted, the engine routes per-fill
  // via `feeModel.getFeeRate(venue, marketForSymbol(symbol), 'taker')`
  // so mixed --products lists (spot + perps) charge the correct tier
  // per symbol — the bug that 402e757 fixed in the paper path.
  const commissionOverride =
    argv.commission !== undefined ? Number(argv.commission) : undefined;

  // Configure backtest
  const backtestConfig: BacktestConfig = {
    startDate: new Date(String(argv.startDate)),
    endDate: new Date(String(argv.endDate)),
    initialCapital,
    feeModel,
    venue: 'coinbase',
    ...(commissionOverride !== undefined ? { commission: commissionOverride } : {}),
    slippage: Number(argv.slippage),
    products: argv.products as string[],
    // Strategy parameters mirror atlas/config/guardrails.yaml. trend_follow
    // is wired here too — defect #1: prior backtests silently dropped it.
    signals: {
      breakout: {
        enabled: argv.strategy === 'breakout' || argv.strategy === 'all',
        parameters: {
          period: 20,
          atrPeriod: 14,
          atrMultiplier: 2,
          volumeThreshold: 1.5,
        },
      },
      vwapMeanReversion: {
        enabled: argv.strategy === 'vwap' || argv.strategy === 'all',
        parameters: {
          deviationEntry: 2,
          deviationExit: 0.5,
          minVolume: 1000,
        },
      },
      momentum: {
        enabled: argv.strategy === 'momentum' || argv.strategy === 'all',
        parameters: {
          // strategy-tuning: was 55/40 — restored to canonical 70/30 to
          // match the plugin schema and guardrails.yaml.
          rsiPeriod: 10,
          rsiOverbought: 70,
          rsiOversold: 30,
          macdFast: 8,
          macdSlow: 21,
          macdSignal: 5,
        },
      },
      trendFollow: {
        enabled: argv.strategy === 'trend_follow' || argv.strategy === 'all',
        parameters: {},
      },
    },
    risk: {
      // Hard ceiling on per-position notional. Risk-based sizing is now
      // primary; this is a guardrail, not the sizing function (defect #5).
      maxPositionSize: initialCapital * guardrails.risk.max_position_exposure_pct,
      // Total exposure = equity × max_account_leverage (matches live).
      maxTotalExposure: initialCapital * guardrails.account.max_account_leverage,
      stopLossPercent: 0.02, // fallback only; signals carry ATR-based stops
      takeProfitPercent: 0.04, // fallback only; signals carry ATR-based TPs
    },
    account: {
      equityUsd: initialCapital,
      riskPerTrade: guardrails.account.risk_per_trade,
      maxPositionExposurePct: guardrails.risk.max_position_exposure_pct,
      minNotionalBuffer: guardrails.account.min_notional_buffer,
    },
    // Defect #2: honour the same kill list live uses.
    disabledStrategies: guardrails.disabled_strategies,
    // F4 follow-up §8 (2026-05-19): same shape as the live API server reads
    // — flatten per-(symbol, strategy) disable from per_symbol /
    // perps_symbols / hyperliquid_symbols blocks into a single map.
    perSymbolDisabledStrategies: buildPerSymbolDisabledStrategies(guardrails),
    // Defect #1: forward per-symbol parameter overrides so trend_follow on
    // ETH-USD uses emaFast=12 / emaSlow=15, momentum on ETH uses rsi 10/40/55, etc.
    perSymbolOverrides,
    realism: guardrails.backtest
      ? {
          nextBarFill: guardrails.backtest.next_bar_fill,
          entrySlippageBps: guardrails.backtest.entry_slippage_bps,
          stopOvershootBarRangePct: guardrails.backtest.stop_overshoot_bar_range_pct,
          stopOvershootMinBps: guardrails.backtest.stop_overshoot_min_bps,
          sizeDecimals: guardrails.backtest.size_decimals,
        }
      : undefined,
  };

  try {
    if (argv.optimize) {
      // Run optimization
      logger.info('Running parameter optimization');

      const parameterRanges = {
        'signals.breakout.parameters.period': { min: 10, max: 30, step: 5 },
        'signals.breakout.parameters.atrMultiplier': { min: 1, max: 3, step: 0.5 },
        'signals.vwapMeanReversion.parameters.deviationEntry': { min: 1.5, max: 3, step: 0.5 },
        'risk.stopLossPercent': { min: 0.01, max: 0.03, step: 0.005 },
        'risk.takeProfitPercent': { min: 0.02, max: 0.06, step: 0.01 },
      };

      const result = await runner.runOptimization(backtestConfig, parameterRanges, 'sharpeRatio');

      logger.info('Optimization complete', {
        bestParams: result.bestParams,
        bestSharpe: result.bestMetric,
      });

      console.log('\nOptimization Results:');
      console.log('====================');
      console.log(`Best Sharpe Ratio: ${result.bestMetric.toFixed(2)}`);
      console.log('Best Parameters:');
      console.log(JSON.stringify(result.bestParams, null, 2));
    } else {
      // Run single backtest
      const result = await runner.runBacktest(backtestConfig);

      // Print summary
      console.log('\nBacktest Results:');
      console.log('=================');
      console.log(`Total Return: ${result.metrics.returnPercent.toFixed(2)}%`);
      console.log(`Sharpe Ratio: ${result.metrics.sharpeRatio.toFixed(2)}`);
      console.log(`Win Rate: ${(result.metrics.winRate * 100).toFixed(2)}%`);
      console.log(`Profit Factor: ${result.metrics.profitFactor.toFixed(2)}`);
      console.log(`Max Drawdown: ${(result.metrics.maxDrawdownPercent * 100).toFixed(2)}%`);
      console.log(`Total Trades: ${result.metrics.totalTrades}`);
      console.log(`Total Fees: $${result.metrics.totalFees.toFixed(2)}`);
      console.log(`Final Capital: $${result.metrics.finalCapital.toFixed(2)}`);
    }
  } catch (error) {
    logger.error('Backtest failed:', error);
    console.error('Backtest failed:', error);
    process.exit(1);
  }

  // The Supabase client (used by BacktestRunner to read candles from
  // public.bars) keeps the Node event loop alive after main() resolves —
  // its connection pool / realtime subscription holds open handles. Without
  // an explicit exit here, the process hangs indefinitely after results
  // print and the CI step has to wrap us in `timeout`. Exit cleanly now
  // that we have nothing useful left to do.
  logger.info('Backtest CLI exiting cleanly');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
