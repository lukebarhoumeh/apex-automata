import path from 'node:path';
import dotenv from 'dotenv';
// .env lives at the repo root; pnpm sets cwd to atlas/apps/core-node.
dotenv.config({ path: path.resolve(process.cwd(), '../../../.env') });
import yargs from 'yargs/yargs';
import { hideBin } from 'yargs/helpers';
import { createLogger } from '../core/logger';
import {
  BacktestRunner,
  BacktestRunnerConfig,
  FeeTierLabel,
  describeExitReasons,
  describeExitRules,
} from '../backtesting/backtest-runner';
import { BacktestResult, EvGateMode } from '../backtesting/backtest-engine';
import { isDataUnavailableError } from '../backtesting/data-loader';
import { SUPPORTED_BAR_MINUTES, describeBarTimeframe, isBarAggregationError } from '../backtesting/bar-aggregation';
import { buildBacktestConfig, buildFeeModel, resolveFeeTier } from '../backtesting/backtest-cli-config';
import { loadGuardrails } from '../config/loadGuardrails';
import type { MarketVenue } from '../trading/execution/venue-capabilities';

/** Print the CI-parsed summary. Line 1 is always the data stamp. */
function printSummary(result: BacktestResult, feeTier: FeeTierLabel): void {
  const m = result.metrics;
  console.log('');
  console.log(result.dataStamp === 'SYNTHETIC'
    ? 'DATA: SYNTHETIC — SMOKE/VOID (random-walk candles; not evidence)'
    : 'DATA: REAL');
  console.log('Backtest Results:');
  console.log('=================');
  for (const p of Object.values(result.dataProvenance)) {
    const agg = p.aggregation && p.aggregation.subBarsPerBucket > 1
      ? ` aggregated=${p.aggregation.sourceMinutes}m→${p.aggregation.targetMinutes}m(src=${p.aggregation.sourceCandleCount},dropped=${p.aggregation.bucketsDropped})`
      : '';
    console.log(
      `Data source ${p.symbol}: ${p.source} bars=${p.candleCount}/${p.expectedCount} ` +
        `coverage=${(p.coverage * 100).toFixed(1)}% spacing=${p.inferredBarMinutes ?? 'n/a'}m${agg}` +
        (p.source === 'synthetic' ? ' [SYNTHETIC — VOID]' : ''),
    );
  }
  console.log(`Bar timeframe: ${describeBarTimeframe(Object.values(result.dataProvenance))}`);
  console.log(`Venue: ${Object.entries(result.venueBySymbol).map(([s, v]) => `${s}=${v}`).join(', ')}`);
  if (result.fees.routing === 'flat-override') {
    console.log(`Fees: flat ${((result.fees.flatRate ?? 0) * 10_000).toFixed(2)} bps/side (--commission override; fee tier ${feeTier.name} ignored)`);
  } else {
    const per = Object.entries(result.fees.perVenue).map(([v, b]) => `${v} maker=${b.makerBps}/taker=${b.takerBps} bps`).join('; ');
    console.log(`Fees: tier=${feeTier.name} → ${per}`);
  }
  console.log(`Long/Short entries: ${m.longEntries}/${m.shortEntries} (sell-exits=${m.sellSignalExits}, short-blocked=${m.shortBlocked})`);
  console.log(`EV gate: mode=${m.evGate.mode} evaluated=${m.evGate.evaluated} rejected=${m.evGate.rejected} shadow-would-reject=${m.evGate.shadowWouldReject}`);
  console.log(`Regime gate: enabled=${result.regimeGate.enabled} minCompat=${result.regimeGate.minCompatibilityScore} minConf=${result.regimeGate.minRegimeConfidence}`);
  // A6 regime-conditional gates (guardrails.regime_gates) — distinct from the
  // RegimeFilter line above. Ships disabled; `--regime-conditional-gates` flips it for a run.
  const a6 = result.config.regimeConditionalGates;
  console.log(`Regime-conditional gates (A6): enabled=${a6?.enabled ?? false} rules=${a6?.rules.length ?? 0}`);
  console.log(`Exit rules: ${describeExitRules(m.exitRules)}`);
  console.log(`Exits by reason: ${describeExitReasons(m.exitReasons)}`);
  console.log(`Total Return: ${m.returnPercent.toFixed(2)}%`);
  console.log(`Sharpe Ratio: ${m.sharpeRatio.toFixed(2)}`);
  console.log(`Win Rate: ${(m.winRate * 100).toFixed(2)}%`);
  console.log(`Profit Factor: ${m.profitFactor.toFixed(2)}`);
  console.log(`Max Drawdown: ${(m.maxDrawdownPercent * 100).toFixed(2)}%`);
  console.log(`Total Trades: ${m.totalTrades}`);
  console.log(`Total Fees: $${m.totalFees.toFixed(2)}`);
  console.log(`Average Hold Time: ${m.averageHoldTime.toFixed(1)} minutes`);
  console.log(`Final Capital: $${m.finalCapital.toFixed(2)}`);
}

async function main() {
  // Single source of truth for fees — backtest must match paper/live or
  // comparisons are meaningless. Per #11 (2026-05-18), we pass the
  // FeeModel into BacktestConfig so per-fill fees route by symbol
  // (spot vs perps_intx) instead of one flat decimal applied uniformly.
  // CLI `--commission` is kept as an explicit sensitivity-analysis
  // override (e.g. simulate HL 4.5 bps on Coinbase candles).
  const atlasRoot = path.resolve(process.cwd(), '../..');
  const guardrails = loadGuardrails(atlasRoot);

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
      describe:
        'Entry/exit slippage as a decimal rate (0.0005 = 5 bps). Maps onto ' +
        'realism.entrySlippageBps; when omitted guardrails.yaml backtest.entry_slippage_bps applies.',
    })
    .option('allow-synthetic', {
      type: 'boolean',
      describe:
        'SMOKE ONLY. Permit random-walk synthetic candles when no real data exists. ' +
        'Default false → exit 1 with DATA_UNAVAILABLE. Any synthetic run is stamped ' +
        '"DATA: SYNTHETIC" and is VOID as evidence.',
      default: false,
    })
    .option('fixture-dir', {
      type: 'string',
      describe:
        'Load candles from <dir>/<SYMBOL>.json fixtures instead of Supabase (offline/CI). ' +
        'Fixtures are the only source when set — a missing fixture is DATA_UNAVAILABLE.',
    })
    .option('min-coverage', {
      type: 'number',
      describe: 'Minimum bars-loaded / bars-expected ratio per symbol before DATA_UNAVAILABLE (0 disables).',
      default: 0.5,
    })
    .option('bar-minutes', {
      type: 'number',
      choices: [...SUPPORTED_BAR_MINUTES],
      default: 15,
      describe:
        'Bar size the engine runs on (TASK_017 step 5 / E4 frequency lever). 15 = native stored bars. ' +
        '60|240|1440 roll the stored 15m bars up UTC-aligned (OHLCV: first open, max high, min low, last close, summed volume). ' +
        'Indicator periods stay in BARS of the chosen size (EMA(15) on 240m = 15 × 4H bars). ' +
        'Partial buckets below --min-bucket-fill are dropped and counted in the report.',
    })
    .option('min-bucket-fill', {
      type: 'number',
      default: 0.5,
      describe: 'With --bar-minutes > 15: min fraction of expected sub-bars a rolled-up bar must contain to be kept (1 = complete buckets only).',
    })
    .option('venue', {
      type: 'string',
      choices: ['spot', 'perps'],
      describe:
        'Force every product onto one venue class (fee bucket + shorting capability). ' +
        'Default: inferred per symbol (XXX-PERP-INTX → perps, else spot). Spot is long-only.',
    })
    .option('fee-tier', {
      type: 'string',
      describe:
        'Coinbase spot fee tier: intro1 (60/120 bps) | t1k (35/75) | t10k (25/40) | custom:<maker>,<taker>. ' +
        'Default: guardrails.yaml fees (t10k today). Ignored when --commission is set.',
    })
    .option('ev-gate', {
      type: 'string',
      choices: ['enforce', 'shadow', 'off'],
      default: 'enforce',
      describe:
        'Fee-adjusted EV gate: enforce (reject negative-EV entries, live parity) | ' +
        'shadow (allow but count would-be rejects) | off.',
    })
    .option('regime-gates', {
      type: 'string',
      choices: ['on', 'off'],
      default: 'on',
      describe:
        'Regime/strategy compatibility filter (RegimeFilter). Default on. ' +
        'NOT the A6 guardrails.regime_gates policy — see --regime-conditional-gates.',
    })
    .option('regime-conditional-gates', {
      type: 'boolean',
      describe:
        'A6: enable regime-conditional gates for THIS run (overrides ' +
        'guardrails.regime_gates.enabled=false). The rules themselves come ' +
        'from guardrails.yaml regime_gates.rules. Use to measure projected ' +
        'impact without changing live/paper config.',
      default: false,
    })
    .option('exit-parity', {
      type: 'string',
      choices: ['on', 'off'],
      default: 'off',
      describe:
        'Live PositionMonitor exit rules from guardrails.yaml: ATR trailing stop ' +
        '(strategy.stop_trail_atr × entry ATR, label trailing_stop) + time stop ' +
        '(strategy.time_stop_bars completed bars, label time_stop). Default off so E1/E2 ' +
        'cards are unchanged; G1/G3/G5 infra only — flipping the default is an E5 decision.',
    })
    .option('optimize', {
      type: 'boolean',
      describe: 'Run parameter optimization',
      default: false,
    })
    .help()
    .parse();

  const logger = createLogger(path.join(process.cwd(), '../../var/logs/backtest.jsonl'));

  // NOTE: `guardrails` is loaded at the top of main() and passed into
  // BacktestConfig below. Both backtest-engine (disabled_strategies,
  // per-symbol overrides, account sizing) and the fee resolution path
  // read from the same source of truth so backtest behaviour can't
  // drift from paper/live.

  const fixtureDir = argv.fixtureDir ? path.resolve(process.cwd(), String(argv.fixtureDir)) : undefined;
  const SUPABASE_URL = process.env.SUPABASE_URL || '';
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';
  if (!fixtureDir && (!SUPABASE_URL || !SUPABASE_SERVICE_KEY)) {
    console.error(
      'Missing SUPABASE_URL or SUPABASE_SERVICE_KEY — backtest reads candles from public.bars. ' +
        'Pass --fixture-dir <dir> to run offline on committed fixtures.',
    );
    process.exit(1);
  }

  // Fee tier → FeeModel. The tier only rewrites the coinbase.spot bucket;
  // perps buckets stay as configured in guardrails.yaml.
  const feeTier = resolveFeeTier(argv.feeTier ? String(argv.feeTier) : undefined, guardrails.fees.coinbase.spot);
  const feeModel = buildFeeModel(guardrails, feeTier);

  const evGateMode = String(argv.evGate) as EvGateMode;
  const venueOverride = argv.venue ? (String(argv.venue) as MarketVenue) : undefined;
  const allowSynthetic = Boolean(argv.allowSynthetic);
  const barMinutes = Number(argv.barMinutes);
  // A6 (2026-05-29): regime-conditional gates default to guardrails.regime_gates
  // (disabled unless the YAML flips `enabled: true`). The flag force-enables
  // for this run only so projected impact can be measured without touching
  // live/paper config. Wired through buildBacktestConfig() (below).
  const forceRegimeConditionalGates = Boolean(argv.regimeConditionalGates);
  const exitParity = String(argv.exitParity) === 'on';

  logger.info('Starting backtest', {
    startDate: argv.startDate,
    endDate: argv.endDate,
    products: argv.products,
    strategy: argv.strategy,
    feeRouting: argv.commission !== undefined ? 'flat-override' : 'per-symbol-feeModel',
    commissionOverride: argv.commission,
    feeTier,
    venueOverride: venueOverride ?? 'per-symbol',
    evGateMode,
    regimeGates: argv.regimeGates,
    regimeConditionalGates: forceRegimeConditionalGates ? 'forced-on' : 'guardrails',
    exitParity,
    barMinutes,
    allowSynthetic,
    fixtureDir,
    dataSource: fixtureDir ? 'fixture' : 'supabase',
  });
  if (allowSynthetic) {
    console.warn('WARNING: --allow-synthetic set. If real data is missing, output is SMOKE/VOID and stamped DATA: SYNTHETIC.');
  }

  const runnerConfig: BacktestRunnerConfig = {
    resultsPath: String(argv.resultsPath),
    supabaseUrl: SUPABASE_URL || undefined,
    supabaseKey: SUPABASE_SERVICE_KEY || undefined,
    fixtureDir,
  };

  const runner = new BacktestRunner(runnerConfig, logger);

  // Engine config is assembled by the shared builder
  // (backtesting/backtest-cli-config.ts) so `pnpm backtest` and the E4
  // harness cannot drift: strategy toggles, guardrails kill lists,
  // per-symbol overrides (per_symbol + perps_symbols, F4 follow-up §3/§8),
  // equity-based sizing and the realism block all come from one place.
  //
  // #11 (2026-05-18): `commission` is only set when the user passed
  // `--commission` explicitly. When omitted, the engine routes per-fill
  // via `feeModel.getFeeRate(venue, marketForSymbol(symbol), 'taker')`
  // so mixed --products lists (spot + perps) charge the correct tier
  // per symbol — the bug that 402e757 fixed in the paper path.
  const backtestConfig = buildBacktestConfig(
    {
      startDate: new Date(String(argv.startDate)),
      endDate: new Date(String(argv.endDate)),
      initialCapital: Number(argv.initialCapital),
      products: argv.products as string[],
      strategy: String(argv.strategy),
      feeModel,
      commissionOverride: argv.commission !== undefined ? Number(argv.commission) : undefined,
      venueOverride,
      evGateMode,
      regimeGates: String(argv.regimeGates) !== 'off',
      forceRegimeConditionalGates,
      slippageRate: argv.slippage !== undefined ? Number(argv.slippage) : undefined,
      applyExitParity: exitParity,
    },
    guardrails,
  );

  const dataOptions = {
    allowSynthetic,
    minCoverage: Number(argv.minCoverage),
    barMinutes,
    minBucketFill: Number(argv.minBucketFill),
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

      const result = await runner.runOptimization(backtestConfig, parameterRanges, 'sharpeRatio', dataOptions);

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
      const result = await runner.runBacktest(backtestConfig, dataOptions, { feeTier });
      printSummary(result, feeTier);
    }
  } catch (error) {
    if (isDataUnavailableError(error)) {
      logger.error('Backtest aborted: DATA_UNAVAILABLE', {
        symbol: error.symbol,
        windowStart: error.windowStart.toISOString(),
        windowEnd: error.windowEnd.toISOString(),
        attempted: error.attempted,
      });
      console.error(`\n${error.message}`);
      process.exit(2);
    }
    if (isBarAggregationError(error)) {
      logger.error('Backtest aborted: BAR_AGGREGATION_INVALID', { message: error.message, barMinutes });
      console.error(`\n${error.message}`);
      process.exit(2);
    }
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
