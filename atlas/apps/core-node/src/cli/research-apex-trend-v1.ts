/**
 * H1 Apex Trend v1 — SHORT DRY-RUN CLI (Creator open). Research only.
 *
 *   NOT research-pass · NOT GO · NOT sealed holdout · NO CONFIRM_LIVE.
 *
 * From `atlas/apps/core-node` (never put `--` after `pnpm research:h1`):
 *
 *   pnpm exec tsx src/cli/research-apex-trend-v1.ts
 *   # = --fixture-dir fixtures/bars/1d/tune-2017-01_2025-03 --products BTC-USD ETH-USD
 *   #   --fee-bps 5 --slippage-bps 2 (placeholder CFM-NANO-H1-v0.1 bracket, UNVERIFIED)
 *
 * Hard locks (exit 2, nothing read):
 *   - only `fixtures/bars/1d/tune-2017-01_2025-03` is readable (TRAIN);
 *   - `fixtures/bars/1d/btc-eth-2017_plus` is BANNED (seal contamination);
 *   - the loose sealed `fixtures/bars/1d/*.json` (HO-H1-DAILY) are refused;
 *   - any bar at/after 2025-03-01 is a seal breach;
 *   - there is no `--allow-synthetic` (yargs strict ⇒ unknown argument).
 *
 * The variant is frozen in `H1_VARIANT` (A1/B1/C3.0/D0.25); no flag changes
 * it — the card is one variant, not a grid. Fee brackets ARE flags because
 * the cited sheet is not on the box; whatever is passed is printed as
 * UNVERIFIED. Nothing here touches guardrails, the strategy registry or any
 * paper/live path.
 */
import path from 'node:path';
import fs from 'node:fs/promises';
import yargs from 'yargs/yargs';
import { hideBin } from 'yargs/helpers';
import {
  H1_BANNER,
  H1_FEE_SHEET,
  H1_VARIANT,
  runApexTrendV1,
  type H1CostModel,
  type H1RunResult,
} from '../research/apex-trend-v1';
import {
  H1_PATH_LOCK,
  H1DataError,
  H1PathLockError,
  assertTrainFixtureDir,
  loadTrainSeries,
} from '../research/apex-trend-v1-data';
import { renderH1Report, type H1LadderRow } from '../research/apex-trend-v1-report';

function parseDay(raw: string | undefined, flag: string): number | undefined {
  if (raw === undefined) return undefined;
  const ms = Date.parse(String(raw));
  if (Number.isNaN(ms)) throw new Error(`${flag}: invalid date "${raw}" (YYYY-MM-DD or ISO, UTC)`);
  return Math.floor(ms / 1000);
}

function ladderRow(result: H1RunResult, cost: H1CostModel): H1LadderRow {
  const m = result.metrics;
  return {
    allInBpsPerSide: cost.feeBpsPerSide + cost.slippageBpsPerSide,
    cost,
    n: m.trades.n,
    sharpe: m.sharpe,
    netReturn: m.netReturn,
    cagr: m.cagr,
    maxDrawdown: m.maxDrawdown,
    profitFactor: m.trades.profitFactor,
    costDragBpsPerYear: m.costDragBpsPerYear,
  };
}

async function main(): Promise<void> {
  const coreNodeRoot = process.cwd();

  const argv = await yargs(hideBin(process.argv))
    .scriptName('atlas-research-h1')
    .usage('$0 [--fixture-dir fixtures/bars/1d/tune-2017-01_2025-03] [--fee-bps N --slippage-bps N] [options]')
    .option('fixture-dir', {
      type: 'string',
      default: H1_PATH_LOCK.trainDir,
      describe: `TRAIN directory. Locked to ${H1_PATH_LOCK.trainDir}; the sealed ${H1_PATH_LOCK.sealedLooseDir}/*.json and the banned ${H1_PATH_LOCK.bannedDirs.join(', ')} are refused (exit 2).`,
    })
    .option('products', {
      type: 'array',
      default: [...H1_PATH_LOCK.symbols],
      describe: 'Universe subset (space-separated). Only BTC-USD ETH-USD exist in TRAIN; anything else is DATA_UNAVAILABLE.',
    })
    .option('start-date', { type: 'string', describe: 'Optional sub-window start (YYYY-MM-DD, UTC) — still inside TRAIN; warm-up is taken inside the window.' })
    .option('end-date', { type: 'string', describe: 'Optional sub-window end (YYYY-MM-DD, UTC, inclusive) — cannot exceed the TRAIN file (2025-02-28).' })
    .option('fee-bps', {
      type: 'number',
      default: H1_FEE_SHEET.placeholderFeeBpsPerSide,
      describe: `Commission incl. exchange/NFA, bps per side. Default = ${H1_FEE_SHEET.id} PLACEHOLDER (sheet not on box) — printed as UNVERIFIED whatever you pass. Never Intro-1.`,
    })
    .option('slippage-bps', {
      type: 'number',
      default: H1_FEE_SHEET.placeholderSlippageBpsPerSide,
      describe: 'Adverse fill allowance folded into the next-bar-close fill, bps per side (UNVERIFIED placeholder).',
    })
    .option('fee-ladder', {
      type: 'boolean',
      default: true,
      describe: `Also print the same variant at all-in ${H1_FEE_SHEET.ladderAllInBpsPerSide.join('/')} bps per side (informational sensitivity; never graded). --no-fee-ladder to skip.`,
    })
    .option('initial-capital', { type: 'number', default: 10_000, describe: 'Starting equity (research units).' })
    .option('results-path', {
      type: 'string',
      default: path.resolve(coreNodeRoot, '../../var/backtest_results/h1'),
      describe: 'Where h1_apex-trend-v1_<ts>.{json,txt} are written (gitignored).',
    })
    // No --allow-synthetic, no variant knobs: strict() makes any attempt a hard error.
    .strict()
    .help()
    .parse();

  const requestedFixtureDir = String(argv.fixtureDir);
  const trainDirAbs = assertTrainFixtureDir(requestedFixtureDir, coreNodeRoot);
  const startTime = parseDay(argv.startDate as string | undefined, '--start-date');
  const endTime = parseDay(argv.endDate as string | undefined, '--end-date');
  if (startTime !== undefined && endTime !== undefined && endTime <= startTime) {
    throw new Error('--end-date must be after --start-date');
  }
  const products = (argv.products as unknown[]).map(String);
  const data = loadTrainSeries(trainDirAbs, products, { startTime, endTime });

  const feeBps = Number(argv.feeBps);
  const slipBps = Number(argv.slippageBps);
  if (!Number.isFinite(feeBps) || feeBps < 0 || !Number.isFinite(slipBps) || slipBps < 0) {
    throw new Error('--fee-bps and --slippage-bps must be finite and ≥ 0');
  }
  const cost: H1CostModel = { feeBpsPerSide: feeBps, slippageBpsPerSide: slipBps };
  const initialCapital = Number(argv.initialCapital);
  if (!(initialCapital > 0)) throw new Error('--initial-capital must be > 0');

  const result = runApexTrendV1(data.series, { initialCapital, cost });
  const zeroCost = runApexTrendV1(data.series, { initialCapital, cost: { feeBpsPerSide: 0, slippageBpsPerSide: 0 } });

  const ladder: H1LadderRow[] = [];
  if (argv.feeLadder) {
    for (const allIn of H1_FEE_SHEET.ladderAllInBpsPerSide) {
      // Split each all-in bracket as fee + the same slippage allowance as the primary run (or all fee when smaller).
      const slippage = Math.min(slipBps, allIn);
      const c: H1CostModel = { feeBpsPerSide: allIn - slippage, slippageBpsPerSide: slippage };
      ladder.push(ladderRow(runApexTrendV1(data.series, { initialCapital, cost: c }), c));
    }
  }

  const generatedAt = new Date().toISOString();
  const text = renderH1Report({ data, requestedFixtureDir, coreNodeRoot, result, ladder, zeroCost, generatedAt });
  console.log(text);

  const resultsPath = String(argv.resultsPath);
  await fs.mkdir(resultsPath, { recursive: true });
  const stamp = generatedAt.replace(/[:.]/g, '-');
  const jsonPath = path.join(resultsPath, `h1_apex-trend-v1_${stamp}.json`);
  const txtPath = path.join(resultsPath, `h1_apex-trend-v1_${stamp}.txt`);
  const payload = {
    banner: H1_BANNER,
    dataStamp: data.dataStamp,
    generatedAt,
    variant: H1_VARIANT,
    feeSheet: { ...H1_FEE_SHEET, applied: cost, allInBpsPerSide: feeBps + slipBps, label: 'UNVERIFIED' },
    pathLock: {
      ...H1_PATH_LOCK,
      requestedFixtureDir,
      resolvedFixtureDir: data.fixtureDir,
      openedFiles: data.openedFiles.map((f) => path.relative(coreNodeRoot, f)),
      bannedDirsPresentOnDisk: data.bannedDirsPresentOnDisk,
    },
    provenance: data.series.map((s) => ({
      symbol: s.symbol,
      file: path.relative(coreNodeRoot, s.filePath),
      sha256: s.sha256,
      sha256MatchesCommitted: s.sha256MatchesCommitted,
      bars: s.bars.length,
      totalBarsInFile: s.totalBarsInFile,
      first: new Date(s.bars[0].time * 1000).toISOString(),
      last: new Date(s.bars[s.bars.length - 1].time * 1000).toISOString(),
      granularity: s.granularity,
      granularitySeconds: s.granularitySeconds,
      source: s.source,
      fetchedAt: s.fetchedAt,
    })),
    window: result.window,
    warmupBars: result.warmupBars,
    metrics: result.metrics,
    zeroCostMetrics: zeroCost.metrics,
    ladder,
    trades: result.trades,
    equityCurve: result.equityCurve,
  };
  await fs.writeFile(jsonPath, JSON.stringify(payload, null, 2), 'utf8');
  await fs.writeFile(txtPath, `${text}\n`, 'utf8');
  console.log('');
  console.log(`artefacts: ${jsonPath} · ${txtPath}`);
}

main().catch((err: unknown) => {
  if (err instanceof H1PathLockError || err instanceof H1DataError) {
    console.error(`${H1_BANNER}\n${err.code}: ${err.message}`);
    process.exit(2);
  }
  console.error(`${H1_BANNER}\nERROR: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
