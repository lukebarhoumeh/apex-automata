/**
 * E4 multi-timeframe FeeModel expectancy harness — CLI (Algo Creator Beta card).
 *
 * One timeframe per invocation on one per-TF fixture directory. Desk order:
 * 4H (this card) → 1D → (1H demoted; 15m out). From `atlas/apps/core-node`:
 *
 *   # 4H eval window (GO bars here only; run ONCE). Defaults ARE the card:
 *   # BTC/ETH/SOL spot long-only, trend_follow A1 2.5/6.0 (asserted), true 4H,
 *   # cooldown 1 bar, atr_volatility_min 0.005 (asserted), EV gate enforce,
 *   # GO fee book 40 bps/side, stress 25/75/120 separate, month-block MC.
 *   pnpm exec tsx src/cli/backtest-e4.ts --tf 4h --window eval --run-card <card id>
 *
 *   # 4H tune window (diagnostics only; never GO bars)
 *   pnpm exec tsx src/cli/backtest-e4.ts --tf 4h --window tune --run-card <card id>
 *
 *   # 1D eval window (EXPLORATORY unless counted E[n] ≥ 100)
 *   pnpm exec tsx src/cli/backtest-e4.ts --tf 1d --window eval --run-card <card id>
 *
 * `--window` presets --fixture-dir / --start-date / --end-date; explicit flags
 * override them (a window that is not the locked eval/tune pair is `custom`
 * and can never reach BETA BARS PASS). Never put `--` after `pnpm backtest:e4`.
 * There is NO --allow-synthetic and NO override for floors or bars (yargs
 * strict ⇒ "Unknown arguments"). Line 1 of stdout is the DERIVED label; the
 * counted-E[n] preflight block prints first.
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
  E4_CARD,
  E4_DEFAULT_FIXTURE_DIR,
  E4_TF_POLICY,
  E4_WALK_FORWARD,
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
    .usage('$0 --tf <4h|1d|1h> (--window eval|tune | --fixture-dir <dir> --start-date YYYY-MM-DD --end-date YYYY-MM-DD) [--run-card <id>] [options]')
    .option('tf', {
      type: 'string',
      demandOption: true,
      describe: 'Timeframe for THIS run: 4h (first; floor 1.61; month-block MC) | 1d (floor 1.44; EXPLORATORY if E[n] < 100) | 1h (demoted; floor 2.25). 15m is out.',
    })
    .option('window', {
      type: 'string',
      choices: ['eval', 'tune'],
      describe: `Locked walk-forward window preset. eval = ${E4_WALK_FORWARD.eval.start.slice(0, 10)} → ${E4_WALK_FORWARD.eval.end.slice(0, 10)} (run ONCE; GO bars here only) | tune = ${E4_WALK_FORWARD.tune.start.slice(0, 10)} → ${E4_WALK_FORWARD.tune.end.slice(0, 10)} (diagnostics only). Presets --fixture-dir and dates; explicit flags override.`,
    })
    .option('fixture-dir', {
      type: 'string',
      describe: 'Per-TF fixture directory (one timeframe per directory). Defaults from --window (4h: fixtures/bars/4h/holdout-… | tune-…; 1d: fixtures/bars/1d). Bar width must equal --tf; 15m gate fixtures are refused; missing data is DATA_UNAVAILABLE — never synthetic.',
    })
    .option('start-date', { type: 'string', describe: 'Window start (YYYY-MM-DD or ISO, UTC). Default from --window.' })
    .option('end-date', { type: 'string', describe: 'Window end (YYYY-MM-DD or ISO, UTC). Default from --window.' })
    .option('products', { type: 'array', default: [...E4_CARD.products], describe: 'Spot products (space-separated). Perps (XXX-PERP-INTX) are refused.' })
    .option('strategy', {
      type: 'string',
      default: E4_CARD.strategy,
      choices: ['trend_follow', 'momentum', 'all'],
      describe: 'Card: trend_follow (A1 2.5/6.0 per-symbol pins asserted). momentum | all are off-card sensitivity runs.',
    })
    .option('initial-capital', { type: 'number', default: 1000, describe: 'Starting equity (TASK_018 E1 uses $1,000)' })
    .option('fee-tier', {
      type: 'string',
      describe: 'Fee-book pass tier. Default = guardrails spot bucket = GO fee book (40 bps/side, 80 RT). intro1 | t1k | t10k | custom:<maker>,<taker> make it a sensitivity run (never GO). Stress 25/75/120 runs separately via --fee-stress.',
    })
    .option('ev-gate', { type: 'string', choices: ['enforce', 'shadow', 'off'], default: 'enforce', describe: 'EV-gate mode for the fee-book pass (card: enforce; zero-fee pass is always off)' })
    .option('regime-gates', { type: 'string', choices: ['on', 'off'], default: 'on' })
    .option('cooldown-bars', { type: 'number', default: E4_CARD.cooldownBars, describe: 'Min hold in BARS before an opposite-signal exit (card: 1 × 4H bar; live trade_cooldown_min analog on the bar clock). Must be ≥ 1.' })
    .option('min-coverage', { type: 'number', default: 0.5, describe: 'Fixture coverage floor before DATA_UNAVAILABLE (0 disables)' })
    .option('mc-runs', { type: 'number', default: 2000, describe: 'Monte Carlo replicates' })
    .option('mc-block', { type: 'string', choices: ['month', 'trade', 'none'], describe: 'Bootstrap unit. Default per TF: month for 4h/1h, trade for 1d.' })
    .option('seed', { type: 'number', default: 20260910, describe: 'PRNG seed (deterministic MC)' })
    .option('fee-stress', { type: 'boolean', default: true, describe: `Run separate ${E4_CARD.stressBpsPerSide.join('/')} bps-per-side stress passes after the fee book (informational; never cherry-picked). --no-fee-stress to skip.` })
    .option('run-card', {
      type: 'string',
      describe: 'Run card id (Algo Creator Beta CLEAR / Algo Alpha card). Required for a FULL (≥ 365d) REAL window to be graded; without it the run is UNGRADED. Recorded on line 1, in E4_RESULT and in the eval ledger.',
    })
    .option('smoke-run-all-stages', { type: 'boolean', default: false, describe: 'SMOKE ONLY windows: keep going past a STOP so MC/stress are exercised (pipeline validation; never evidence)' })
    .option('results-path', { type: 'string', default: path.resolve(process.cwd(), '../../var/backtest_results/e4'), describe: 'Where per-pass backtest_*.json/report_*.txt, e4_*.json/.md and E4_EVAL_LEDGER.jsonl live' })
    // Floors, bars and the card are LOCKED: no --zero-fee-pf-min / --min-expected-trades /
    // --allow-synthetic. strict() makes any such attempt a hard error instead of a silent no-op.
    .strict()
    .help()
    .parse();

  const logger = createLogger(path.join(process.cwd(), '../../var/logs/backtest-e4.jsonl'));

  const tf = parseTimeframe(String(argv.tf));
  const policy = E4_TF_POLICY[tf];
  const preset = argv.window ? E4_WALK_FORWARD[String(argv.window) as 'eval' | 'tune'] : undefined;
  const startRaw = argv.startDate ? String(argv.startDate) : preset?.start;
  const endRaw = argv.endDate ? String(argv.endDate) : preset?.end;
  if (!startRaw || !endRaw) {
    throw new Error('Pass --window eval|tune or both --start-date and --end-date.');
  }
  const startDate = new Date(startRaw);
  const endDate = new Date(endRaw);
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime()) || endDate <= startDate) {
    throw new Error('Invalid --start-date/--end-date (end must be after start)');
  }
  const fixtureRel = argv.fixtureDir
    ? String(argv.fixtureDir)
    : preset
      ? E4_DEFAULT_FIXTURE_DIR[tf][preset.role]
      : undefined;
  if (!fixtureRel) {
    throw new Error(`Pass --fixture-dir <per-TF dir> (no default for --tf ${tf}${preset ? ` --window ${preset.role}` : ''}); see ${policy.fixtureHint}.`);
  }
  const fixtureDir = path.resolve(process.cwd(), fixtureRel);

  const feeTier = resolveE4FeeTier(argv.feeTier ? String(argv.feeTier) : undefined, guardrails);
  const resultsPath = String(argv.resultsPath);
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
    cooldownBars: Number(argv.cooldownBars),
    mc: {
      runs: Number(argv.mcRuns),
      block: (argv.mcBlock ? String(argv.mcBlock) : policy.defaultMcBlock) as McBlockMode,
      seed: Number(argv.seed),
    },
    feeStress: Boolean(argv.feeStress),
    runCard: argv.runCard ? String(argv.runCard) : undefined,
    evalLedgerPath: path.join(resultsPath, 'E4_EVAL_LEDGER.jsonl'),
    smokeRunAllStages: Boolean(argv.smokeRunAllStages),
  };

  logger.info('E4 harness starting', {
    tf, barMinutes: policy.barMinutes, policy: policy.status, window: preset?.role ?? 'custom', startDate, endDate, products: request.products,
    strategy: request.strategy, feeTier, evGateMode: request.evGateMode, cooldownBars: request.cooldownBars, mc: request.mc, feeStress: request.feeStress,
    fixtureDir, runCard: request.runCard ?? null, floors: { zeroFeePf: policy.zeroFeePfMin, minExpectedTrades: policy.minExpectedTrades },
  });

  const runner = new BacktestRunner({ resultsPath, fixtureDir }, logger);

  try {
    const report = await runE4(request, runner, guardrails, logger);
    const text = renderE4Report(report);

    await fs.mkdir(resultsPath, { recursive: true });
    const stamp = new Date().toISOString().replace(/:/g, '-').split('.')[0];
    const jsonPath = path.join(resultsPath, `e4_${tf}_${report.window.role}_${stamp}.json`);
    const mdPath = path.join(resultsPath, `e4_${tf}_${report.window.role}_${stamp}.md`);
    await fs.writeFile(jsonPath, JSON.stringify(report, null, 2));
    await fs.writeFile(mdPath, `${text}\n`);

    console.log('');
    console.log(text);
    console.log(`E4 artefacts: ${jsonPath}`);
    console.log(`              ${mdPath}`);
    logger.info('E4 harness complete', { tf, window: report.window.role, label: report.label, graded: report.graded, verdict: report.verdict, preflight: report.preflight, jsonPath, mdPath });
  } catch (error) {
    if (isDataUnavailableError(error)) {
      logger.error('E4 harness aborted: DATA_UNAVAILABLE', { symbol: error.symbol, windowStart: error.windowStart, windowEnd: error.windowEnd });
      console.error(`\n${error.message}`);
      process.exit(2);
    }
    if (isBarAggregationError(error) || isE4DataPathError(error)) {
      logger.error('E4 harness aborted: not the card experiment', { message: error.message });
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
