/**
 * E4 multi-timeframe FeeModel expectancy harness — CLI.
 *
 * One timeframe per invocation. Desk order: 4H → 1D → (1H demoted).
 *
 *   cd atlas/apps/core-node
 *   pnpm exec tsx src/cli/backtest-e4.ts --tf 4h --fixture-dir fixtures/bars/4h \
 *     --products BTC-USD ETH-USD SOL-USD --start-date 2026-08-01 --end-date 2026-09-01
 *   pnpm exec tsx src/cli/backtest-e4.ts --tf 1d --fixture-dir fixtures/bars/1d \
 *     --products BTC-USD ETH-USD SOL-USD --start-date 2024-09-01 --end-date 2026-08-31
 *
 * Never put `--` after `pnpm backtest:e4` (yargs then treats every flag as
 * positional). There is deliberately NO `--allow-synthetic`: missing data is
 * DATA_UNAVAILABLE (exit 2). Line 1 of stdout is the DERIVED label
 * (SMOKE ONLY / FULL WINDOW / VOID); line 2 is the DATA stamp.
 */
import path from 'node:path';
import fs from 'node:fs/promises';
import dotenv from 'dotenv';
dotenv.config({ path: path.resolve(process.cwd(), '../../../.env') });
import yargs from 'yargs/yargs';
import { hideBin } from 'yargs/helpers';
import { createLogger } from '../core/logger';
import { BacktestRunner } from '../backtesting/backtest-runner';
import { isDataUnavailableError } from '../backtesting/data-loader';
import { isBarAggregationError } from '../backtesting/bar-aggregation';
import { loadGuardrails } from '../config/loadGuardrails';
import type { EvGateMode } from '../backtesting/backtest-engine';
import type { MarketVenue } from '../trading/execution/venue-capabilities';
import {
  E4_TF_POLICY,
  parseTimeframe,
  resolveE4FeeTier,
  renderE4Report,
  runE4,
  type E4Request,
  type McBlockMode,
} from '../backtesting/e4-harness';

async function main(): Promise<void> {
  const atlasRoot = path.resolve(process.cwd(), '../..');
  const guardrails = loadGuardrails(atlasRoot);

  const argv = await yargs(hideBin(process.argv))
    .scriptName('atlas-backtest-e4')
    .usage('$0 --tf <4h|1d|1h> --start-date YYYY-MM-DD --end-date YYYY-MM-DD [options]')
    .option('tf', {
      type: 'string',
      demandOption: true,
      describe: 'Timeframe for THIS run: 4h (first, month-block MC) | 1d (next; EXPLORATORY if E[n] < 100) | 1h (demoted). 15m is refused.',
    })
    .option('start-date', { type: 'string', demandOption: true, describe: 'Window start (YYYY-MM-DD or ISO, UTC)' })
    .option('end-date', { type: 'string', demandOption: true, describe: 'Window end (YYYY-MM-DD or ISO, UTC)' })
    .option('products', { type: 'array', default: ['BTC-USD', 'ETH-USD', 'SOL-USD'], describe: 'Spot products (space-separated)' })
    .option('strategy', {
      type: 'string',
      default: 'trend_follow',
      choices: ['trend_follow', 'momentum', 'all'],
      describe: 'Paper GO set: trend_follow (spot+PERP) | momentum (spot). disabled_strategies in guardrails.yaml still apply to "all".',
    })
    .option('initial-capital', { type: 'number', default: 1000, describe: 'Starting equity (TASK_018 E1 uses $1,000)' })
    .option('fee-tier', {
      type: 'string',
      describe: 'Fee pass tier: intro1 (60/120) | t1k (35/75) | t10k (25/40) | custom:<maker>,<taker>. Default per TF: intro1 for 4h/1d, t1k for 1h (the tier a $1K account sits in at that frequency).',
    })
    .option('ev-gate', { type: 'string', choices: ['enforce', 'shadow', 'off'], default: 'enforce', describe: 'EV-gate mode for the FEE pass (zero-fee pass is always off)' })
    .option('regime-gates', { type: 'string', choices: ['on', 'off'], default: 'on' })
    .option('venue', { type: 'string', choices: ['spot', 'perps'], describe: 'Force venue class. Default: inferred per symbol (spot for XXX-USD; long-only).' })
    .option('fixture-dir', { type: 'string', describe: 'Load <dir>/<SYMBOL>.json fixtures (one timeframe per directory). Omit to read Supabase public.bars (15m, rolled up to the TF).' })
    .option('min-coverage', { type: 'number', default: 0.5, describe: 'Native-load coverage floor before DATA_UNAVAILABLE (0 disables)' })
    .option('min-bucket-fill', { type: 'number', default: 0.5, describe: 'Rollup: min fraction of sub-bars a bucket needs to be kept (only when stored bars are finer than the TF)' })
    .option('mc-runs', { type: 'number', default: 2000, describe: 'Monte Carlo replicates' })
    .option('mc-block', { type: 'string', choices: ['month', 'trade', 'none'], describe: 'Bootstrap unit. Default per TF: month for 4h/1h, trade for 1d.' })
    .option('seed', { type: 'number', default: 20260910, describe: 'PRNG seed (deterministic MC)' })
    .option('zero-fee-pf-min', { type: 'number', describe: 'Override the zero-fee PF fail-fast threshold (defaults: 4h 1.61 · 1d 1.44 · 1h 2.25)' })
    .option('min-zero-fee-trades', { type: 'number', default: 10, describe: 'Below this zero-fee trade count the run is INCONCLUSIVE and stops' })
    .option('min-expected-trades', { type: 'number', describe: 'Override the E[n] gate (defaults: 4h 60 · 1d 100 · 1h 60)' })
    .option('min-full-window-days', { type: 'number', default: 365, describe: 'Windows shorter than this are SMOKE ONLY (no grade issued)' })
    .option('smoke-run-all-stages', { type: 'boolean', default: false, describe: 'SMOKE ONLY runs: keep going past a fail-fast so the fee pass and MC are exercised (pipeline validation)' })
    .option('results-path', { type: 'string', default: path.resolve(process.cwd(), '../../var/backtest_results/e4'), describe: 'Where per-pass backtest_*.json/report_*.txt and the e4_*.json/.md live' })
    .help()
    .parse();

  const logger = createLogger(path.join(process.cwd(), '../../var/logs/backtest-e4.jsonl'));

  const tf = parseTimeframe(String(argv.tf));
  const policy = E4_TF_POLICY[tf];
  const startDate = new Date(String(argv.startDate));
  const endDate = new Date(String(argv.endDate));
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime()) || endDate <= startDate) {
    throw new Error('Invalid --start-date/--end-date (end must be after start)');
  }

  const fixtureDir = argv.fixtureDir ? path.resolve(process.cwd(), String(argv.fixtureDir)) : undefined;
  const SUPABASE_URL = process.env.SUPABASE_URL || '';
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';
  if (!fixtureDir && (!SUPABASE_URL || !SUPABASE_SERVICE_KEY)) {
    console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY — pass --fixture-dir <dir> to run offline on committed fixtures.');
    process.exit(1);
  }

  const feeTier = resolveE4FeeTier(tf, argv.feeTier ? String(argv.feeTier) : undefined, guardrails);
  const request: E4Request = {
    tf,
    startDate,
    endDate,
    products: (argv.products as unknown[]).map(String),
    strategy: String(argv.strategy),
    initialCapital: Number(argv.initialCapital),
    feeTier,
    evGateMode: String(argv.evGate) as EvGateMode,
    regimeGates: String(argv.regimeGates) !== 'off',
    venueOverride: argv.venue ? (String(argv.venue) as MarketVenue) : undefined,
    data: { minCoverage: Number(argv.minCoverage), minBucketFill: Number(argv.minBucketFill) },
    mc: {
      runs: Number(argv.mcRuns),
      block: (argv.mcBlock ? String(argv.mcBlock) : policy.defaultMcBlock) as McBlockMode,
      seed: Number(argv.seed),
    },
    zeroFeePfMin: argv.zeroFeePfMin !== undefined ? Number(argv.zeroFeePfMin) : undefined,
    minZeroFeeTrades: Number(argv.minZeroFeeTrades),
    minExpectedTrades: argv.minExpectedTrades !== undefined ? Number(argv.minExpectedTrades) : undefined,
    minFullWindowDays: Number(argv.minFullWindowDays),
    smokeRunAllStages: Boolean(argv.smokeRunAllStages),
  };

  logger.info('E4 harness starting', {
    tf, barMinutes: policy.barMinutes, policy: policy.status, startDate, endDate, products: request.products,
    strategy: request.strategy, feeTier, evGateMode: request.evGateMode, mc: request.mc, fixtureDir,
    dataSource: fixtureDir ? 'fixture' : 'supabase',
  });

  const resultsPath = String(argv.resultsPath);
  const runner = new BacktestRunner(
    { resultsPath, supabaseUrl: SUPABASE_URL || undefined, supabaseKey: SUPABASE_SERVICE_KEY || undefined, fixtureDir },
    logger,
  );

  try {
    const report = await runE4(request, runner, guardrails, logger);
    const text = renderE4Report(report);

    await fs.mkdir(resultsPath, { recursive: true });
    const stamp = new Date().toISOString().replace(/:/g, '-').split('.')[0];
    const jsonPath = path.join(resultsPath, `e4_${tf}_${stamp}.json`);
    const mdPath = path.join(resultsPath, `e4_${tf}_${stamp}.md`);
    await fs.writeFile(jsonPath, JSON.stringify(report, null, 2));
    await fs.writeFile(mdPath, `${text}\n`);

    console.log('');
    console.log(text);
    console.log(`E4 artefacts: ${jsonPath}`);
    console.log(`              ${mdPath}`);
    logger.info('E4 harness complete', { tf, label: report.label, verdict: report.verdict, jsonPath, mdPath });
  } catch (error) {
    if (isDataUnavailableError(error)) {
      logger.error('E4 harness aborted: DATA_UNAVAILABLE', { symbol: error.symbol, windowStart: error.windowStart, windowEnd: error.windowEnd });
      console.error(`\n${error.message}`);
      process.exit(2);
    }
    if (isBarAggregationError(error)) {
      logger.error('E4 harness aborted: BAR_AGGREGATION_INVALID', { message: error.message });
      console.error(`\n${error.message}`);
      process.exit(2);
    }
    logger.error('E4 harness failed', error);
    console.error('E4 harness failed:', error);
    process.exit(1);
  }

  // Supabase client keeps handles open (see cli/backtest.ts) — exit explicitly.
  process.exit(0);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
