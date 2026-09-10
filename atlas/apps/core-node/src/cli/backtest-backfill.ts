/**
 * Backfill real OHLCV candles from the Coinbase Advanced Trade PUBLIC
 * market-data endpoint (no API key required) into either:
 *
 *   --out-dir <dir>   JSON fixtures `<dir>/<SYMBOL>.json` (BarFixtureFile),
 *                     consumed by `pnpm backtest --fixture-dir <dir>` and the
 *                     backtest-gate CI workflow.
 *   --upsert          the Supabase `bars` table (idempotent upsert on the
 *                     unique key (symbol, time, exchange)). Requires
 *                     SUPABASE_URL + SUPABASE_SERVICE_KEY.
 *
 * Usage (from atlas/apps/core-node — never put `--` after `pnpm`):
 *   pnpm backtest:backfill --products BTC-USD,ETH-USD --since 2026-09-03 \
 *     --until 2026-09-10 --granularity FIFTEEN_MINUTE --out-dir fixtures/bars
 *
 * Endpoint: GET /api/v3/brokerage/market/products/{id}/candles
 *   query: start, end (unix seconds), granularity (enum); ≤ 350 candles per
 *   call, so the window is paged in 300-bar chunks with a small delay.
 *
 * Offline rollup (`--rollup-minutes N`, fixtures only): the endpoint has no
 * FOUR_HOUR enum, so true 4h bars are produced by fetching ONE_HOUR (or
 * FIFTEEN_MINUTE) and aggregating into UTC-aligned buckets — see
 * {@link rollupCandles}. The fixture records the derivation in `rollup`.
 *
 * TASK_017 step 8. No new dependencies (global fetch, Node ≥ 20).
 */
import path from 'node:path';
import fs from 'node:fs/promises';
import dotenv from 'dotenv';
dotenv.config({ path: path.resolve(process.cwd(), '../../../.env') });
import yargs from 'yargs/yargs';
import { hideBin } from 'yargs/helpers';
import { createLogger } from '../core/logger';
import { decimalAdd, decimalToNumber } from '../core/decimal';
import type { OHLCV } from '../indicators/technical';
import {
  HistoricalDataLoader,
  normalizeCandles,
  validateCandle,
  type BarFixtureFile,
  type BarFixtureRollup,
} from '../backtesting/data-loader';

const PUBLIC_BASE = 'https://api.coinbase.com/api/v3/brokerage/market/products';

const GRANULARITY_SECONDS: Record<string, number> = {
  ONE_MINUTE: 60,
  FIVE_MINUTE: 300,
  FIFTEEN_MINUTE: 900,
  THIRTY_MINUTE: 1800,
  ONE_HOUR: 3600,
  TWO_HOUR: 7200,
  SIX_HOUR: 21600,
  ONE_DAY: 86400,
};

/**
 * Labels for rolled-up bar widths. FOUR_HOUR etc. are NOT Coinbase enums —
 * they only ever appear on fixtures carrying a `rollup` provenance block.
 */
const ROLLUP_LABELS: Record<number, string> = {
  3600: 'ONE_HOUR',
  7200: 'TWO_HOUR',
  10800: 'THREE_HOUR',
  14400: 'FOUR_HOUR',
  21600: 'SIX_HOUR',
  28800: 'EIGHT_HOUR',
  43200: 'TWELVE_HOUR',
  86400: 'ONE_DAY',
};

/** Fixture `granularity` label for a bar width in seconds. */
export function granularityLabelForSeconds(seconds: number): string {
  return ROLLUP_LABELS[seconds] ?? `ROLLUP_${Math.round(seconds / 60)}M`;
}

export interface RollupResult {
  candles: OHLCV[];
  sourceBars: number;
  bucketsEmitted: number;
  bucketsDroppedIncomplete: number;
}

/**
 * Validate a (source, bucket) pair for {@link rollupCandles}. Buckets must be
 * a whole multiple of the source width and must divide the UTC day so every
 * bucket starts on a UTC day boundary offset (00:00, 04:00, … for 4h).
 */
export function assertRollupWidths(sourceSeconds: number, bucketSeconds: number): void {
  if (!Number.isInteger(sourceSeconds) || sourceSeconds <= 0) {
    throw new Error(`rollup: source width must be a positive integer number of seconds, got ${sourceSeconds}`);
  }
  if (!Number.isInteger(bucketSeconds) || bucketSeconds <= sourceSeconds) {
    throw new Error(`rollup: bucket width (${bucketSeconds}s) must be an integer larger than the source width (${sourceSeconds}s)`);
  }
  if (bucketSeconds % sourceSeconds !== 0) {
    throw new Error(`rollup: bucket width ${bucketSeconds}s is not a whole multiple of source width ${sourceSeconds}s`);
  }
  if (86400 % bucketSeconds !== 0) {
    throw new Error(`rollup: bucket width ${bucketSeconds}s must divide 86400 so buckets align to UTC midnight`);
  }
}

/**
 * Roll finer candles up into UTC-aligned buckets of `bucketSeconds`.
 *
 *   bucket start = floor(time / bucketSeconds) * bucketSeconds   (epoch is UTC)
 *   open   = open of the first source bar in the bucket
 *   high   = max(high), low = min(low)
 *   close  = close of the last source bar in the bucket
 *   volume = exact decimal sum of source volumes (no float accumulation)
 *
 * Only COMPLETE buckets — exactly `bucketSeconds / sourceSeconds` distinct
 * source bars — are emitted. Partial buckets (window edges, exchange gaps)
 * are dropped and counted in `bucketsDroppedIncomplete` so a fixture never
 * contains a bar that pretends to cover time it has no data for.
 * Source candles are normalised (sorted, de-duplicated on time) first.
 */
export function rollupCandles(source: OHLCV[], sourceSeconds: number, bucketSeconds: number): RollupResult {
  assertRollupWidths(sourceSeconds, bucketSeconds);
  const perBucket = bucketSeconds / sourceSeconds;
  const bucketMs = bucketSeconds * 1000;
  const normalized = normalizeCandles(source);

  const buckets = new Map<number, OHLCV[]>();
  for (const c of normalized) {
    const start = Math.floor(c.time / bucketMs) * bucketMs;
    const group = buckets.get(start);
    if (group) group.push(c);
    else buckets.set(start, [c]);
  }

  const out: OHLCV[] = [];
  let dropped = 0;
  for (const start of Array.from(buckets.keys()).sort((a, b) => a - b)) {
    const group = buckets.get(start)!; // already time-sorted (normalized input)
    if (group.length !== perBucket) {
      dropped++;
      continue;
    }
    let high = group[0].high;
    let low = group[0].low;
    let volume = '0';
    for (const c of group) {
      if (c.high > high) high = c.high;
      if (c.low < low) low = c.low;
      volume = decimalAdd(volume, c.volume);
    }
    out.push({
      time: start,
      open: group[0].open,
      high,
      low,
      close: group[group.length - 1].close,
      volume: decimalToNumber(volume),
    });
  }

  return { candles: out, sourceBars: normalized.length, bucketsEmitted: out.length, bucketsDroppedIncomplete: dropped };
}

/** Provenance block for a rolled-up fixture (see {@link BarFixtureRollup}). */
export function describeRollup(sourceGranularity: string, bucketSeconds: number, result: RollupResult): BarFixtureRollup {
  const sourceSeconds = GRANULARITY_SECONDS[sourceGranularity];
  return {
    method: 'utc-aligned-ohlcv',
    sourceGranularity,
    sourceGranularitySeconds: sourceSeconds,
    bucketSeconds,
    sourceBarsPerBucket: bucketSeconds / sourceSeconds,
    sourceBars: result.sourceBars,
    bucketsEmitted: result.bucketsEmitted,
    bucketsDroppedIncomplete: result.bucketsDroppedIncomplete,
    rules:
      `bucket=floor(time/${bucketSeconds})*${bucketSeconds} (UTC); open=first, high=max, low=min, close=last, ` +
      'volume=exact decimal sum; complete buckets only',
  };
}

const MAX_CANDLES_PER_REQUEST = 300;
const REQUEST_DELAY_MS = 150;

interface PublicCandle {
  start: string;
  low: string;
  high: string;
  open: string;
  close: string;
  volume: string;
}

/**
 * Fetch every candle in [startSec, endSec] for a product at the given
 * granularity, paging through the 350-candle response cap. Returns
 * validated, time-sorted, de-duplicated OHLCV (millisecond `time`).
 */
export async function fetchPublicCandles(
  product: string,
  startSec: number,
  endSec: number,
  granularity: string,
  fetchImpl: typeof fetch = fetch,
  onPage?: (info: { from: number; to: number; count: number }) => void,
): Promise<OHLCV[]> {
  const step = GRANULARITY_SECONDS[granularity];
  if (!step) {
    throw new Error(`Unsupported granularity "${granularity}". Use one of ${Object.keys(GRANULARITY_SECONDS).join('|')}`);
  }
  const out: OHLCV[] = [];
  let cursor = startSec;
  while (cursor <= endSec) {
    const chunkEnd = Math.min(cursor + (MAX_CANDLES_PER_REQUEST - 1) * step, endSec);
    const url = `${PUBLIC_BASE}/${encodeURIComponent(product)}/candles?start=${cursor}&end=${chunkEnd}&granularity=${granularity}`;
    const res = await fetchImpl(url, { headers: { accept: 'application/json' } });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Coinbase candles ${product} ${cursor}-${chunkEnd} → HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    const json = (await res.json()) as { candles?: PublicCandle[] };
    const page = json.candles ?? [];
    for (const c of page) {
      const candle: OHLCV = {
        time: Number(c.start) * 1000,
        open: Number(c.open),
        high: Number(c.high),
        low: Number(c.low),
        close: Number(c.close),
        volume: Number(c.volume),
      };
      if (validateCandle(candle)) out.push(candle);
    }
    onPage?.({ from: cursor, to: chunkEnd, count: page.length });
    cursor = chunkEnd + step;
    if (cursor <= endSec) {
      await new Promise((r) => setTimeout(r, REQUEST_DELAY_MS));
    }
  }
  return normalizeCandles(out);
}

/**
 * Build the on-disk fixture document for a fetched series. When `rollup` is
 * given, `granularity` is the SOURCE enum the candles were fetched at and the
 * fixture is labelled with the rolled-up width instead (e.g. FOUR_HOUR/14400).
 */
export function buildFixture(
  product: string,
  granularity: string,
  start: Date,
  end: Date,
  candles: OHLCV[],
  fetchedAt: Date = new Date(),
  rollup?: BarFixtureRollup,
): BarFixtureFile {
  return {
    symbol: product,
    exchange: 'coinbase',
    granularity: rollup ? granularityLabelForSeconds(rollup.bucketSeconds) : granularity,
    granularitySeconds: rollup ? rollup.bucketSeconds : GRANULARITY_SECONDS[granularity],
    source: 'coinbase-advanced-trade-public',
    endpoint: `${PUBLIC_BASE}/${product}/candles`,
    fetchedAt: fetchedAt.toISOString(),
    start: start.toISOString(),
    end: end.toISOString(),
    ...(rollup ? { rollup } : {}),
    candles: candles.map((c) => ({
      time: Math.floor(c.time / 1000),
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume,
    })),
  };
}

function parseProducts(raw: unknown): string[] {
  const items = Array.isArray(raw) ? raw : [raw];
  return items
    .flatMap((v) => String(v).split(','))
    .map((s) => s.trim())
    .filter(Boolean);
}

async function main(): Promise<void> {
  const argv = await yargs(hideBin(process.argv))
    .scriptName('atlas-backtest-backfill')
    .usage(
      '$0 --products BTC-USD,ETH-USD --since YYYY-MM-DD [--until YYYY-MM-DD] --granularity FIFTEEN_MINUTE ' +
        '(--out-dir <dir> [--rollup-minutes N] | --upsert)',
    )
    .option('products', { type: 'array', demandOption: true, describe: 'Comma- or space-separated product ids' })
    .option('since', { type: 'string', demandOption: true, describe: 'Window start (UTC, inclusive) YYYY-MM-DD or ISO' })
    .option('until', { type: 'string', describe: 'Window end (UTC, inclusive). Default: now floored to granularity' })
    .option('granularity', { type: 'string', default: 'FIFTEEN_MINUTE', choices: Object.keys(GRANULARITY_SECONDS) })
    .option('out-dir', { type: 'string', describe: 'Write <SYMBOL>.json fixtures here' })
    .option('upsert', { type: 'boolean', default: false, describe: 'Upsert into Supabase bars (symbol,time,exchange)' })
    .option('rollup-minutes', {
      type: 'number',
      describe:
        'Fixtures only: aggregate the fetched candles into UTC-aligned N-minute bars before writing ' +
        '(e.g. --granularity ONE_HOUR --rollup-minutes 240 → true 4h bars). Complete buckets only. ' +
        'Not allowed with --upsert (public.bars holds native candles).',
    })
    .help()
    .parse();

  const logger = createLogger(path.join(process.cwd(), '../../var/logs/backtest-backfill.jsonl'));
  const products = parseProducts(argv.products);
  const granularity = String(argv.granularity);
  const step = GRANULARITY_SECONDS[granularity];
  const start = new Date(String(argv.since));
  const endRaw = argv.until ? new Date(String(argv.until)) : new Date();
  if (Number.isNaN(start.getTime()) || Number.isNaN(endRaw.getTime())) {
    throw new Error('Invalid --since/--until date');
  }

  const outDir = argv.outDir ? path.resolve(process.cwd(), String(argv.outDir)) : undefined;
  const upsert = Boolean(argv.upsert);
  if (!outDir && !upsert) {
    throw new Error('Nothing to do: pass --out-dir <dir> and/or --upsert');
  }

  const rollupSeconds = argv.rollupMinutes !== undefined ? Number(argv.rollupMinutes) * 60 : undefined;
  if (rollupSeconds !== undefined) {
    if (upsert) {
      throw new Error('--rollup-minutes cannot be combined with --upsert: public.bars holds native candles only');
    }
    assertRollupWidths(step, rollupSeconds);
  }

  // Source window floored to the source granularity; in rollup mode the start
  // is additionally floored to the bucket so the first bucket can be complete.
  const alignSec = rollupSeconds ?? step;
  const startSec = Math.floor(start.getTime() / 1000 / alignSec) * alignSec;
  const endSec = Math.floor(endRaw.getTime() / 1000 / step) * step;
  if (endSec < startSec) throw new Error('--until must be after --since');

  let loader: HistoricalDataLoader | null = null;
  if (upsert) {
    const supabaseUrl = process.env.SUPABASE_URL || '';
    const supabaseKey = process.env.SUPABASE_SERVICE_KEY || '';
    if (!supabaseUrl || !supabaseKey) {
      throw new Error('--upsert requires SUPABASE_URL and SUPABASE_SERVICE_KEY');
    }
    loader = new HistoricalDataLoader({ supabaseUrl, supabaseKey }, logger);
  }
  if (outDir) {
    await fs.mkdir(outDir, { recursive: true });
  }

  const windowStart = new Date(startSec * 1000);
  const windowEnd = new Date(endSec * 1000);
  const expected = Math.floor((endSec - startSec) / step) + 1;
  console.log(`Backfill ${products.join(', ')} ${windowStart.toISOString()} → ${windowEnd.toISOString()} @ ${granularity} (expect ${expected} bars/product)`);

  // Rollup output window: buckets that lie entirely inside [startSec, endSec].
  let rollupLabel = '';
  let rollupEnd = windowEnd;
  let expectedBuckets = 0;
  if (rollupSeconds !== undefined) {
    rollupLabel = granularityLabelForSeconds(rollupSeconds);
    const lastFullBucketStart = Math.floor((endSec + step) / rollupSeconds) * rollupSeconds - rollupSeconds;
    if (lastFullBucketStart < startSec) {
      throw new Error(`--rollup-minutes ${rollupSeconds / 60}: window holds no complete bucket`);
    }
    rollupEnd = new Date(lastFullBucketStart * 1000);
    expectedBuckets = Math.floor((lastFullBucketStart - startSec) / rollupSeconds) + 1;
    console.log(
      `Rollup ${granularity} → ${rollupLabel} (${rollupSeconds / step} bars/bucket, UTC-aligned): ` +
        `${windowStart.toISOString()} → ${rollupEnd.toISOString()} (expect ${expectedBuckets} buckets/product)`,
    );
  }

  for (const product of products) {
    const t0 = Date.now();
    const candles = await fetchPublicCandles(product, startSec, endSec, granularity, fetch, (info) => {
      logger.debug('fetched candle page', { product, ...info });
    });
    const coverage = expected > 0 ? candles.length / expected : 0;
    console.log(
      `${product}: ${candles.length}/${expected} bars (${(coverage * 100).toFixed(1)}% coverage) in ${Date.now() - t0}ms` +
        (candles.length > 0
          ? ` first=${new Date(candles[0].time).toISOString()} last=${new Date(candles[candles.length - 1].time).toISOString()}`
          : ''),
    );
    if (candles.length === 0) {
      throw new Error(`No candles returned for ${product} — refusing to write an empty fixture`);
    }

    if (outDir) {
      let fixture: BarFixtureFile;
      if (rollupSeconds !== undefined) {
        const rolled = rollupCandles(candles, step, rollupSeconds);
        if (rolled.candles.length === 0) {
          throw new Error(`Rollup produced no complete ${rollupLabel} buckets for ${product} — refusing to write an empty fixture`);
        }
        const bucketCoverage = expectedBuckets > 0 ? rolled.bucketsEmitted / expectedBuckets : 0;
        console.log(
          `  rollup: ${rolled.sourceBars} × ${granularity} → ${rolled.bucketsEmitted}/${expectedBuckets} × ${rollupLabel} ` +
            `(${(bucketCoverage * 100).toFixed(1)}% coverage, ${rolled.bucketsDroppedIncomplete} incomplete bucket(s) dropped)`,
        );
        fixture = buildFixture(
          product, granularity, windowStart, rollupEnd, rolled.candles, new Date(),
          describeRollup(granularity, rollupSeconds, rolled),
        );
      } else {
        fixture = buildFixture(product, granularity, windowStart, windowEnd, candles);
      }
      const file = path.join(outDir, `${product}.json`);
      await fs.writeFile(file, JSON.stringify(fixture, null, 1) + '\n');
      console.log(`  wrote ${file}`);
    }
    if (loader) {
      await loader.saveToSupabase(product, candles, 'coinbase');
      console.log(`  upserted ${candles.length} bars into public.bars (symbol,time,exchange)`);
    }
  }

  console.log('Backfill complete.');
  process.exit(0);
}

const isDirectRun = process.argv[1] && /backtest-backfill\.(ts|js|cjs|mjs)$/.test(process.argv[1]);
if (isDirectRun) {
  main().catch((err) => {
    console.error('Backfill failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
