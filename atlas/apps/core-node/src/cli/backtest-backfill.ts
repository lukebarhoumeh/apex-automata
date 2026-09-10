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
 * TASK_017 step 8. No new dependencies (global fetch, Node ≥ 20).
 */
import path from 'node:path';
import fs from 'node:fs/promises';
import dotenv from 'dotenv';
dotenv.config({ path: path.resolve(process.cwd(), '../../../.env') });
import yargs from 'yargs/yargs';
import { hideBin } from 'yargs/helpers';
import { createLogger } from '../core/logger';
import type { OHLCV } from '../indicators/technical';
import {
  HistoricalDataLoader,
  normalizeCandles,
  validateCandle,
  type BarFixtureFile,
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

/** Build the on-disk fixture document for a fetched series. */
export function buildFixture(
  product: string,
  granularity: string,
  start: Date,
  end: Date,
  candles: OHLCV[],
  fetchedAt: Date = new Date(),
): BarFixtureFile {
  return {
    symbol: product,
    exchange: 'coinbase',
    granularity,
    granularitySeconds: GRANULARITY_SECONDS[granularity],
    source: 'coinbase-advanced-trade-public',
    endpoint: `${PUBLIC_BASE}/${product}/candles`,
    fetchedAt: fetchedAt.toISOString(),
    start: start.toISOString(),
    end: end.toISOString(),
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
    .usage('$0 --products BTC-USD,ETH-USD --since YYYY-MM-DD [--until YYYY-MM-DD] --granularity FIFTEEN_MINUTE (--out-dir <dir> | --upsert)')
    .option('products', { type: 'array', demandOption: true, describe: 'Comma- or space-separated product ids' })
    .option('since', { type: 'string', demandOption: true, describe: 'Window start (UTC, inclusive) YYYY-MM-DD or ISO' })
    .option('until', { type: 'string', describe: 'Window end (UTC, inclusive). Default: now floored to granularity' })
    .option('granularity', { type: 'string', default: 'FIFTEEN_MINUTE', choices: Object.keys(GRANULARITY_SECONDS) })
    .option('out-dir', { type: 'string', describe: 'Write <SYMBOL>.json fixtures here' })
    .option('upsert', { type: 'boolean', default: false, describe: 'Upsert into Supabase bars (symbol,time,exchange)' })
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
  const startSec = Math.floor(start.getTime() / 1000 / step) * step;
  const endSec = Math.floor(endRaw.getTime() / 1000 / step) * step;
  if (endSec < startSec) throw new Error('--until must be after --since');

  const outDir = argv.outDir ? path.resolve(process.cwd(), String(argv.outDir)) : undefined;
  const upsert = Boolean(argv.upsert);
  if (!outDir && !upsert) {
    throw new Error('Nothing to do: pass --out-dir <dir> and/or --upsert');
  }

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
      const fixture = buildFixture(product, granularity, windowStart, windowEnd, candles);
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
