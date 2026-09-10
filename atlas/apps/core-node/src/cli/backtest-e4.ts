/**
 * E4 multi-timeframe FeeModel expectancy harness — CLI.
 *
 * One timeframe per invocation on one per-TF fixture directory. Desk order:
 * 4H → 1D → (1H demoted). From `atlas/apps/core-node`:
 *
 *   pnpm exec tsx src/cli/backtest-e4.ts --tf 4h \
 *     --fixture-dir fixtures/bars/4h/holdout-2025-03_2026-03 \
 *     --products BTC-USD ETH-USD SOL-USD --start-date 2025-03-01 --end-date 2026-03-01 \
 *     --run-card <Algo Alpha run card>          # only after the desk clears the burn
 *   pnpm exec tsx src/cli/backtest-e4.ts --tf 1d --fixture-dir fixtures/bars/1d \
 *     --products BTC-USD ETH-USD SOL-USD --start-date 2024-09-01 --end-date 2026-08-31
 *
 * Never put `--` after `pnpm backtest:e4` (yargs then treats every flag as
 * positional). There is deliberately NO `--allow-synthetic` and NO override
 * for the locked floors. Missing/short data is DATA_UNAVAILABLE (exit 2); a
 * fixture directory whose bar width is not the TF is refused (exit 2). Line 1
 * of stdout is the DERIVED label (SMOKE ONLY / FULL WINDOW … UNGRADED or
 * GRADED / VOID); line 2 is the DATA stamp.
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
import {
  E4_TF_POLICY,
  isE4DataPathError,
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
    .usage('$0 --tf <4h|1d|1h> --fixture-dir <per-TF dir> --start-date YYYY-MM-DD --end-date YYYY-MM-DD [options]')
    .option('tf', {
      type: 'string',
      demandOption: true,
      describe: 'Timeframe for THIS run: 4h (first; zero-fee floor 1.61; month-block MC) | 1d (next; floor 1.44; EXPLORATORY if E[n] < 100) | 1h (demoted; floor 2.25). 15m is refused.',
    })
    .option('fixture-dir', {
      type: 'string',
      demandOption: true,
      describe:
        'Per-TF fixture directory (one timeframe per directory), e.g. fixtures/bars/4h/holdout-2025-03_2026-03 or fixtures/bars/1d. ' +
        'Bar width must equal --tf; the 15m gate fixtures (fixtures/bars/*.json) are refused. Missing data is DATA_UNAVAILABLE — never synthetic.',
    })
    .option('start-date', { type: 'string', demandOption: true, describe: 'Window start (YYYY-MM-DD or ISO, UTC)' })
    .option('end-date', { type: 'string', demandOption: true, describe: 'Window end (YYYY-MM-DD or ISO, UTC)' })
    .option('products', { type: 'array', default: ['BTC-USD', 'ETH-USD', 'SOL-USD'], describe: 'Spot products (space-separated). Perps (XXX-PERP-INTX) are refused.' })
    .option('strategy', {
      type: 'string',
      default: 'trend_follow',
      choices: ['trend_follow', 'momentum', 'all'],
      describe: 'Paper GO set: trend_follow (spot+PERP) | momentum (spot). disabled_strategies in guardrails.yaml still apply to "all".',
    })
    .option('initial-capital', { type: 'number', default: 1000, describe: 'Starting equity (TASK_018 E1 uses $1,000)' })
    .option('fee-tier', {
      type: 'string',
      describe:
        'Fee-pass tier: intro1 (60/120) | t1k (35/75) | t10k (25/40) | custom:<maker>,<taker>. ' +
        'Default: guardrails.yaml spot bucket = FeeModel 40 (25/40 bps) — the first-burn spec. Tier-consistent re-runs are a second step.',
    })
    .option('ev-gate', { type: 'string', choices: ['enforce', 'shadow', 'off'], default: 'enforce', describe: 'EV-gate mode for the FEE pass (zero-fee pass is always off)' })
    .option('regime-gates', { type: 'string', choices: ['on', 'off'], default: 'on' })
    .option('min-coverage', { type: 'number', default: 0.5, describe: 'Fixture coverage floor before DATA_UNAVAILABLE (0 disables)' })
    .option('mc-runs', { type: 'number', default: 2000, describe: 'Monte Carlo replicates' })
    .option('mc-block', { type: 'string', choices: ['month', 'trade', 'none'], describe: 'Bootstrap unit. Default per TF: month for 4h/1h, trade for 1d.' })
    .option('seed', { type: 'number', default: 20260910, describe: 'PRNG seed (deterministic MC)' })
    .option('run-card', {
      type: 'string',
      describe:
        'Algo Alpha run card id. Required for a FULL (≥ 365d) REAL window to be GRADED; without it the run is UNGRADED ' +
        '(desk burn hold 2026-09-10: wait for run card + Beta design clear). Recorded on line 1 and in E4_RESULT.',
    })
    .option('smoke-run-all-stages', { type: 'boolean', default: false, describe: 'SMOKE ONLY windows: keep going past a fail-fast so the fee pass and MC are exercised (pipeline validation; never evidence)' })
    .option('results-path', { type: 'string', default: path.resolve(process.cwd(), '../../var/backtest_results/e4'), describe: 'Where per-pass backtest_*.json/report_*.txt and the e4_*.json/.md live' })
    // Floors and gates are LOCKED: there is no --zero-fee-pf-min / --min-expected-trades /
    // --allow-synthetic. strict() makes any such attempt a hard error instead of a silent no-op.
    .strict()
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

  const fixtureDir = path.resolve(process.cwd(), String(argv.fixtureDir));
  const feeTier = resolveE4FeeTier(argv.feeTier ? String(argv.feeTier) : undefined, guardrails);
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
    fixtureDir,
    minCoverage: Number(argv.minCoverage),
    mc: {
      runs: Number(argv.mcRuns),
      block: (argv.mcBlock ? String(argv.mcBlock) : policy.defaultMcBlock) as McBlockMode,
      seed: Number(argv.seed),
    },
    runCard: argv.runCard ? String(argv.runCard) : undefined,
    smokeRunAllStages: Boolean(argv.smokeRunAllStages),
  };

  logger.info('E4 harness starting', {
    tf, barMinutes: policy.barMinutes, policy: policy.status, startDate, endDate, products: request.products,
    strategy: request.strategy, feeTier, evGateMode: request.evGateMode, mc: request.mc, fixtureDir,
    runCard: request.runCard ?? null, floors: { zeroFeePf: policy.zeroFeePfMin, minExpectedTrades: policy.minExpectedTrades },
  });

  const resultsPath = String(argv.resultsPath);
  const runner = new BacktestRunner({ resultsPath, fixtureDir }, logger);

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
    logger.info('E4 harness complete', { tf, label: report.label, graded: report.graded, verdict: report.verdict, jsonPath, mdPath });
  } catch (error) {
    if (isDataUnavailableError(error)) {
      logger.error('E4 harness aborted: DATA_UNAVAILABLE', { symbol: error.symbol, windowStart: error.windowStart, windowEnd: error.windowEnd });
      console.error(`\n${error.message}`);
      process.exit(2);
    }
    if (isBarAggregationError(error) || isE4DataPathError(error)) {
      logger.error('E4 harness aborted: invalid data path', { message: error.message });
      console.error(`\n${error.message}`);
      process.exit(2);
    }
    logger.error('E4 harness failed', error);
    console.error('E4 harness failed:', error);
    process.exit(1);
  }

  process.exit(0);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
