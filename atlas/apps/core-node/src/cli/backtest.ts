import path from 'node:path';
import dotenv from 'dotenv';
// .env lives at the repo root; pnpm sets cwd to atlas/apps/core-node.
dotenv.config({ path: path.resolve(process.cwd(), '../../../.env') });
import yargs from 'yargs/yargs';
import { hideBin } from 'yargs/helpers';
import { createLogger } from '../core/logger';
import { BacktestRunner, BacktestRunnerConfig } from '../backtesting/backtest-runner';
import { BacktestConfig } from '../backtesting/backtest-engine';

async function main() {
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
      describe: 'Strategy to test (breakout, vwap, momentum, all)',
      default: 'all',
    })
    .option('commission', {
      type: 'number',
      describe: 'Commission rate (e.g., 0.006 for 0.60% Coinbase Advanced Trade taker, 0.0005 for Hyperliquid)',
      default: 0.006,
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
  });

  const runnerConfig: BacktestRunnerConfig = {
    resultsPath: String(argv.resultsPath),
    supabaseUrl: SUPABASE_URL,
    supabaseKey: SUPABASE_SERVICE_KEY,
  };

  const runner = new BacktestRunner(runnerConfig, logger);

  // Configure backtest
  const backtestConfig: BacktestConfig = {
    startDate: new Date(String(argv.startDate)),
    endDate: new Date(String(argv.endDate)),
    initialCapital: Number(argv.initialCapital),
    commission: Number(argv.commission),
    slippage: Number(argv.slippage),
    products: argv.products as string[],
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
          rsiPeriod: 14,
          rsiOverbought: 70,
          rsiOversold: 30,
          macdFast: 12,
          macdSlow: 26,
          macdSignal: 9,
        },
      },
    },
    risk: {
      maxPositionSize: 5000, // $5k per position
      maxTotalExposure: 8000, // $8k total (80% of capital)
      stopLossPercent: 0.02, // 2%
      takeProfitPercent: 0.04, // 4%
    },
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
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
