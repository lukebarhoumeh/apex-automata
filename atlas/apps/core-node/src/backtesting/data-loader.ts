/**
 * Historical Data Loader for Backtesting
 *
 * Loads real historical candle data from, in precedence order:
 *   1. Local JSON fixtures (`fixtureDir/<SYMBOL>.json`) when configured —
 *      deterministic, offline, used by the backtest-gate CI workflow.
 *   2. Supabase `bars` table (15m OHLCV, epoch-second `time`).
 *   3. Coinbase Exchange REST API (only when credentials are configured).
 *
 * TASK_017 (B1) — FAIL-CLOSED. When none of the real sources yields data
 * for a (symbol, window) the loader throws {@link DataUnavailableError}
 * (`code = 'DATA_UNAVAILABLE'`). Synthetic random-walk candles are only
 * generated when the caller passes `allowSynthetic: true` explicitly, and
 * every result carries a {@link DataProvenance} record so downstream
 * reports can stamp `DATA: SYNTHETIC` on line 1 and tag the run VOID.
 *
 * Every loaded series is validated (OHLC sanity), sorted by time and
 * de-duplicated on `time` so downstream consumers never see out-of-order
 * or duplicate bars regardless of the source.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { Logger } from '../core/logger';
import { OHLCV } from '../indicators/technical';
import { CoinbaseRestClient } from '../exchanges/coinbase/rest-client';
import type { Granularity } from '../exchanges/coinbase/types';

/**
 * Where a series came from. `in-memory` is used by the engine for series
 * handed in programmatically (tests / embedding callers) — it is real data
 * as far as the loader knows, but carries no external provenance.
 */
export type DataSource = 'supabase' | 'exchange' | 'fixture' | 'synthetic' | 'in-memory';

const EXCHANGE_GRANULARITIES: readonly number[] = [60, 300, 900, 3600, 21600, 86400];

export interface DataLoaderConfig {
  /** Supabase project URL. Optional when `fixtureDir` is set. */
  supabaseUrl?: string;
  /** Supabase service-role key. Optional when `fixtureDir` is set. */
  supabaseKey?: string;
  coinbaseConfig?: {
    apiKey: string;
    apiSecret: string;
    apiPassphrase?: string;
    environment: 'production' | 'sandbox';
  };
  /**
   * Directory containing `<SYMBOL>.json` fixture files (see
   * {@link BarFixtureFile}). When set, fixtures are the ONLY real source —
   * a missing fixture for a requested symbol is DATA_UNAVAILABLE, never a
   * silent fall-through to Supabase or synthetic data.
   */
  fixtureDir?: string;
}

export interface LoadCandlesOptions {
  /**
   * Opt-in synthetic fallback. Default false → DATA_UNAVAILABLE on missing
   * data. When true the loader generates a random walk and stamps
   * `provenance.source = 'synthetic'`; reports must surface this as
   * SMOKE/VOID. Never use synthetic output as evidence of edge.
   */
  allowSynthetic?: boolean;
  /**
   * Minimum acceptable coverage (loaded bars / expected bars for the
   * window at the requested granularity). Below this the loader throws
   * DATA_UNAVAILABLE naming the coverage. Default 0.5. Set 0 to disable.
   */
  minCoverage?: number;
}

/**
 * Provenance for one loaded series. Surfaced verbatim in backtest results
 * and reports so every number in a report can be traced to its data.
 */
export interface DataProvenance {
  symbol: string;
  source: DataSource;
  windowStart: string;
  windowEnd: string;
  granularitySeconds: number;
  candleCount: number;
  /** Bars the window would contain at `granularitySeconds` if fully covered. */
  expectedCount: number;
  /** `candleCount / expectedCount` (may exceed 1 if the store holds finer bars). */
  coverage: number;
  firstBarTime: string | null;
  lastBarTime: string | null;
  /** Median spacing between consecutive bars, in minutes (null if < 2 bars). */
  inferredBarMinutes: number | null;
  fixturePath?: string;
  fixtureSha256?: string;
  loadTimeMs: number;
}

export interface DataLoaderResult {
  candles: OHLCV[];
  source: DataSource;
  loadTime: number;
  provenance: DataProvenance;
}

/**
 * Provenance for a fixture whose bars were derived offline from finer
 * native candles (`pnpm backtest:backfill --rollup-minutes N`). Present only
 * on rolled-up fixtures; native fixtures (e.g. the 15m backtest-gate set)
 * omit it.
 */
export interface BarFixtureRollup {
  /** Aggregation method identifier. */
  method: 'utc-aligned-ohlcv';
  /** Coinbase granularity enum the source candles were fetched at. */
  sourceGranularity: string;
  sourceGranularitySeconds: number;
  /** Width of one output bar; equals the fixture's `granularitySeconds`. */
  bucketSeconds: number;
  /** `bucketSeconds / sourceGranularitySeconds` — bars required per bucket. */
  sourceBarsPerBucket: number;
  /** Validated source candles that entered the rollup. */
  sourceBars: number;
  /** Buckets written to `candles[]` (complete buckets only). */
  bucketsEmitted: number;
  /** Buckets dropped because they had fewer than `sourceBarsPerBucket` source bars. */
  bucketsDroppedIncomplete: number;
  /** Human-readable statement of the aggregation rules. */
  rules: string;
}

/** On-disk fixture format written by `pnpm backtest:backfill --out-dir`. */
export interface BarFixtureFile {
  symbol: string;
  exchange: string;
  granularity: string;
  granularitySeconds: number;
  source: string;
  endpoint?: string;
  fetchedAt: string;
  start: string;
  end: string;
  /** Set when the bars were rolled up offline from finer native candles. */
  rollup?: BarFixtureRollup;
  /** `time` is epoch SECONDS (same convention as the `bars` table). */
  candles: Array<{ time: number; open: number; high: number; low: number; close: number; volume: number }>;
}

/**
 * Thrown when no real data exists for a (symbol, window) and synthetic
 * data was not explicitly allowed. `code` is stable for programmatic
 * matching; the message names the symbol and window for humans.
 */
export class DataUnavailableError extends Error {
  public readonly code = 'DATA_UNAVAILABLE' as const;
  public readonly symbol: string;
  public readonly windowStart: Date;
  public readonly windowEnd: Date;
  public readonly attempted: DataSource[];

  constructor(symbol: string, windowStart: Date, windowEnd: Date, attempted: DataSource[], detail?: string) {
    const tried = attempted.length > 0 ? attempted.join(' → ') : 'none';
    super(
      `DATA_UNAVAILABLE: no real candles for ${symbol} in ` +
        `${windowStart.toISOString()} → ${windowEnd.toISOString()} ` +
        `(sources tried: ${tried})${detail ? `: ${detail}` : ''}. ` +
        'Backfill the window (pnpm backtest:backfill) or pass --allow-synthetic ' +
        'for a SMOKE/VOID run.',
    );
    this.name = 'DataUnavailableError';
    this.symbol = symbol;
    this.windowStart = windowStart;
    this.windowEnd = windowEnd;
    this.attempted = attempted;
  }
}

/**
 * Type guard for {@link DataUnavailableError} that also matches errors
 * re-thrown across module boundaries (checks the stable `code`).
 */
export function isDataUnavailableError(err: unknown): err is DataUnavailableError {
  return Boolean(err) && typeof err === 'object' && (err as { code?: string }).code === 'DATA_UNAVAILABLE';
}

/**
 * Validates a single OHLCV candle for data integrity.
 * Returns true if the candle has valid OHLCV values.
 */
export function validateCandle(candle: OHLCV): boolean {
  if (!Number.isFinite(candle.time) || candle.time <= 0) return false;
  if (!Number.isFinite(candle.open) || !Number.isFinite(candle.high)) return false;
  if (!Number.isFinite(candle.low) || !Number.isFinite(candle.close)) return false;
  if (!Number.isFinite(candle.volume)) return false;
  if (candle.open <= 0 || candle.close <= 0) return false;
  if (candle.high < candle.low) return false;
  if (candle.volume < 0) return false;
  if (candle.high < Math.max(candle.open, candle.close)) return false;
  if (candle.low > Math.min(candle.open, candle.close)) return false;
  return true;
}

/**
 * Filters an array of candles, removing invalid entries and logging warnings.
 */
function filterValidCandles(candles: OHLCV[], product: string, logger: Logger): OHLCV[] {
  const valid: OHLCV[] = [];
  let invalidCount = 0;

  for (const candle of candles) {
    if (validateCandle(candle)) {
      valid.push(candle);
    } else {
      invalidCount++;
    }
  }

  if (invalidCount > 0) {
    logger.warn(`Filtered ${invalidCount} invalid candles for ${product}`, {
      totalLoaded: candles.length,
      validCount: valid.length,
    });
  }

  return valid;
}

/** Sort ascending by time and drop duplicate timestamps (last wins). */
export function normalizeCandles(candles: OHLCV[]): OHLCV[] {
  const byTime = new Map<number, OHLCV>();
  for (const c of candles) byTime.set(c.time, c);
  return Array.from(byTime.values()).sort((a, b) => a.time - b.time);
}

/** Median spacing between consecutive bars in minutes; null when < 2 bars. */
export function inferBarMinutes(candles: OHLCV[]): number | null {
  if (candles.length < 2) return null;
  const gaps: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const gap = candles[i].time - candles[i - 1].time;
    if (gap > 0) gaps.push(gap);
  }
  if (gaps.length === 0) return null;
  gaps.sort((a, b) => a - b);
  const mid = Math.floor(gaps.length / 2);
  const medianMs = gaps.length % 2 === 0 ? (gaps[mid - 1] + gaps[mid]) / 2 : gaps[mid];
  return Math.round((medianMs / 60_000) * 1000) / 1000;
}

/**
 * Build the provenance record for a loaded series. Pure — exported so the
 * engine/tests can describe in-memory series the same way.
 */
export function describeSeries(
  symbol: string,
  source: DataSource,
  candles: OHLCV[],
  windowStart: Date,
  windowEnd: Date,
  granularitySeconds: number,
  loadTimeMs: number,
  extra: Partial<Pick<DataProvenance, 'fixturePath' | 'fixtureSha256'>> = {},
): DataProvenance {
  const spanMs = Math.max(0, windowEnd.getTime() - windowStart.getTime());
  const expectedCount = granularitySeconds > 0 ? Math.floor(spanMs / (granularitySeconds * 1000)) + 1 : 0;
  const coverage = expectedCount > 0 ? candles.length / expectedCount : 0;
  return {
    symbol,
    source,
    windowStart: windowStart.toISOString(),
    windowEnd: windowEnd.toISOString(),
    granularitySeconds,
    candleCount: candles.length,
    expectedCount,
    coverage,
    firstBarTime: candles.length > 0 ? new Date(candles[0].time).toISOString() : null,
    lastBarTime: candles.length > 0 ? new Date(candles[candles.length - 1].time).toISOString() : null,
    inferredBarMinutes: inferBarMinutes(candles),
    loadTimeMs,
    ...extra,
  };
}

/** Default granularity: the `bars` table stores 15-minute candles. */
export const DEFAULT_GRANULARITY_SECONDS = 900;
const DEFAULT_MIN_COVERAGE = 0.5;

/**
 * HistoricalDataLoader loads candle data from various sources.
 */
export class HistoricalDataLoader {
  private config: DataLoaderConfig;
  private logger: Logger;
  private supabase: SupabaseClient | null = null;
  private coinbaseClient: CoinbaseRestClient | null = null;

  constructor(config: DataLoaderConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;

    if (config.supabaseUrl && config.supabaseKey) {
      this.supabase = createClient(config.supabaseUrl, config.supabaseKey);
    }

    // Initialize Coinbase client if config provided
    if (config.coinbaseConfig) {
      this.coinbaseClient = new CoinbaseRestClient({
        apiKey: config.coinbaseConfig.apiKey,
        apiSecret: config.coinbaseConfig.apiSecret,
        apiPassphrase: config.coinbaseConfig.apiPassphrase,
        environment: config.coinbaseConfig.environment,
        wsUrl: '',
        restUrl: config.coinbaseConfig.environment === 'production'
          ? 'https://api.exchange.coinbase.com'
          : 'https://api-public.sandbox.exchange.coinbase.com',
      }, logger);
    }
  }

  /**
   * Load historical candles for a product within a date range.
   *
   * Precedence: fixture (if `fixtureDir` configured) → Supabase → exchange.
   * Throws {@link DataUnavailableError} when no real source has data unless
   * `options.allowSynthetic` is true, in which case a synthetic random walk
   * is returned with `source: 'synthetic'` (SMOKE/VOID — never evidence).
   */
  async loadCandles(
    product: string,
    startDate: Date,
    endDate: Date,
    granularitySeconds: number = DEFAULT_GRANULARITY_SECONDS,
    options: LoadCandlesOptions = {},
  ): Promise<DataLoaderResult> {
    const startTime = Date.now();
    const attempted: DataSource[] = [];
    const minCoverage = options.minCoverage ?? DEFAULT_MIN_COVERAGE;

    const finish = (
      source: DataSource,
      candles: OHLCV[],
      extra: Partial<Pick<DataProvenance, 'fixturePath' | 'fixtureSha256'>> = {},
      barSeconds: number = granularitySeconds,
    ): DataLoaderResult => {
      const normalized = normalizeCandles(candles);
      const loadTime = Date.now() - startTime;
      const provenance = describeSeries(
        product, source, normalized, startDate, endDate, barSeconds, loadTime, extra,
      );
      if (source !== 'synthetic' && minCoverage > 0 && provenance.coverage < minCoverage) {
        throw new DataUnavailableError(
          product, startDate, endDate, attempted,
          `coverage ${(provenance.coverage * 100).toFixed(1)}% (${provenance.candleCount}/${provenance.expectedCount} bars) ` +
            `below minimum ${(minCoverage * 100).toFixed(0)}%`,
        );
      }
      this.logger.info(`Loaded ${normalized.length} candles for ${product} from ${source}`, {
        coverage: `${(provenance.coverage * 100).toFixed(1)}%`,
        expected: provenance.expectedCount,
        inferredBarMinutes: provenance.inferredBarMinutes,
        firstBarTime: provenance.firstBarTime,
        lastBarTime: provenance.lastBarTime,
      });
      return { candles: normalized, source, loadTime, provenance };
    };

    if (this.config.fixtureDir) {
      attempted.push('fixture');
      const fixture = this.loadFromFixture(product, startDate, endDate);
      if (fixture.candles.length > 0) {
        // A fixture declares its own bar width (15m gate set, 4h/1d multi-TF
        // sets). Coverage must be judged against THAT width, not the 15m
        // `bars`-table default the caller assumes — otherwise a complete 4h
        // fixture reads as ~6% covered and trips the DATA_UNAVAILABLE floor.
        const barSeconds = fixture.granularitySeconds ?? granularitySeconds;
        if (barSeconds !== granularitySeconds) {
          this.logger.info(`Fixture for ${product} declares ${barSeconds}s bars; using that for coverage/provenance`, {
            requestedGranularitySeconds: granularitySeconds,
            fixtureGranularitySeconds: barSeconds,
          });
        }
        return finish(
          'fixture', fixture.candles, { fixturePath: fixture.path, fixtureSha256: fixture.sha256 }, barSeconds,
        );
      }
      // Fixtures are an explicit, closed source: never fall through.
      if (options.allowSynthetic) {
        return finish('synthetic', this.generateSyntheticData(product, startDate, endDate, granularitySeconds));
      }
      throw new DataUnavailableError(
        product, startDate, endDate, attempted,
        fixture.path ? `fixture ${fixture.path} has no bars in window` : `no fixture file in ${this.config.fixtureDir}`,
      );
    }

    if (this.supabase) {
      attempted.push('supabase');
      const supabaseData = await this.loadFromSupabase(product, startDate, endDate);
      if (supabaseData.length > 0) {
        return finish('supabase', supabaseData);
      }
    }

    if (this.coinbaseClient) {
      attempted.push('exchange');
      const exchangeData = await this.loadFromExchange(product, startDate, endDate, granularitySeconds);
      if (exchangeData.length > 0) {
        return finish('exchange', exchangeData);
      }
    }

    if (options.allowSynthetic) {
      this.logger.warn(
        `SMOKE/VOID: no real data for ${product} — generating SYNTHETIC candles because --allow-synthetic was passed. ` +
          'Results are not evidence of anything.',
        { symbol: product, start: startDate.toISOString(), end: endDate.toISOString(), attempted },
      );
      return finish('synthetic', this.generateSyntheticData(product, startDate, endDate, granularitySeconds));
    }

    throw new DataUnavailableError(product, startDate, endDate, attempted);
  }

  /**
   * Load candles from a local fixture file `<fixtureDir>/<SYMBOL>.json`.
   * Returns an empty candle list when the file is missing (caller decides
   * how to fail); throws on a malformed file since that is a repo bug.
   */
  private loadFromFixture(
    product: string,
    startDate: Date,
    endDate: Date,
  ): { candles: OHLCV[]; path?: string; sha256?: string; granularitySeconds?: number } {
    const dir = this.config.fixtureDir as string;
    const filePath = path.resolve(dir, `${product}.json`);
    if (!fs.existsSync(filePath)) {
      this.logger.warn(`No fixture file for ${product}`, { expected: filePath });
      return { candles: [] };
    }

    const raw = fs.readFileSync(filePath);
    const sha256 = createHash('sha256').update(raw).digest('hex');
    const parsed = JSON.parse(raw.toString('utf8')) as Partial<BarFixtureFile>;
    if (!parsed || !Array.isArray(parsed.candles)) {
      throw new Error(`Malformed bar fixture ${filePath}: missing candles[]`);
    }
    if (parsed.symbol && parsed.symbol !== product) {
      throw new Error(`Bar fixture ${filePath} is for ${parsed.symbol}, not ${product}`);
    }
    const declaredSeconds = Number(parsed.granularitySeconds);
    const granularitySeconds =
      Number.isFinite(declaredSeconds) && declaredSeconds > 0 ? declaredSeconds : undefined;

    const startSec = Math.floor(startDate.getTime() / 1000);
    const endSec = Math.floor(endDate.getTime() / 1000);
    const candles: OHLCV[] = [];
    for (const c of parsed.candles) {
      const t = Number(c.time);
      if (t < startSec || t > endSec) continue;
      candles.push({
        time: t * 1000,
        open: Number(c.open),
        high: Number(c.high),
        low: Number(c.low),
        close: Number(c.close),
        volume: Number(c.volume),
      });
    }

    this.logger.info(`Loading ${product} data from fixture`, {
      path: filePath,
      sha256,
      fixtureSource: parsed.source,
      fetchedAt: parsed.fetchedAt,
      granularity: parsed.granularity,
      granularitySeconds,
      rollup: parsed.rollup ? `${parsed.rollup.sourceGranularity} → ${parsed.rollup.bucketSeconds}s` : undefined,
      inWindow: candles.length,
      inFile: parsed.candles.length,
    });
    return { candles: filterValidCandles(candles, product, this.logger), path: filePath, sha256, granularitySeconds };
  }

  /**
   * Load candles from Supabase bars table.
   *
   * The bars.time column is BIGINT epoch-seconds (per migration
   * 20260305015154_create_bars_table.sql). Filters and the returned
   * OHLCV.time field need to convert between seconds (DB) and millis (engine).
   */
  private async loadFromSupabase(
    product: string,
    startDate: Date,
    endDate: Date
  ): Promise<OHLCV[]> {
    if (!this.supabase) return [];
    try {
      this.logger.info(`Loading ${product} data from Supabase`, {
        start: startDate.toISOString(),
        end: endDate.toISOString(),
      });

      const startEpochSec = Math.floor(startDate.getTime() / 1000);
      const endEpochSec = Math.floor(endDate.getTime() / 1000);

      // Supabase JS client defaults to 1000 rows per response. Page via .range
      // so longer windows (90d × 15m bars × multiple symbols) load fully.
      const PAGE_SIZE = 1000;
      const allRows: Array<Record<string, unknown>> = [];
      let offset = 0;
      while (true) {
        const { data, error } = await this.supabase
          .from('bars')
          .select('time, open, high, low, close, volume')
          .eq('symbol', product)
          .gte('time', startEpochSec)
          .lte('time', endEpochSec)
          .order('time', { ascending: true })
          .range(offset, offset + PAGE_SIZE - 1);

        if (error) {
          if (error.code === '42P01') {
            this.logger.debug('bars table does not exist');
            return [];
          }
          throw error;
        }

        if (!data || data.length === 0) break;
        allRows.push(...(data as Array<Record<string, unknown>>));
        if (data.length < PAGE_SIZE) break;
        offset += PAGE_SIZE;
      }

      if (allRows.length === 0) {
        this.logger.info(`No data found in Supabase for ${product}`);
        return [];
      }

      const candles = allRows.map((row) => ({
        time: Number(row.time) * 1000,
        open: parseFloat(String(row.open)),
        high: parseFloat(String(row.high)),
        low: parseFloat(String(row.low)),
        close: parseFloat(String(row.close)),
        volume: parseFloat(String(row.volume)),
      }));
      return filterValidCandles(candles, product, this.logger);
    } catch (error) {
      this.logger.warn(`Failed to load from Supabase:`, error);
      return [];
    }
  }

  /**
   * Load candles from Coinbase exchange API.
   * Note: Exchange limits data to ~300 candles per request.
   */
  private async loadFromExchange(
    product: string,
    startDate: Date,
    endDate: Date,
    granularitySeconds: number
  ): Promise<OHLCV[]> {
    if (!this.coinbaseClient) {
      return [];
    }
    if (!EXCHANGE_GRANULARITIES.includes(granularitySeconds)) {
      this.logger.warn(`Exchange API does not support granularity ${granularitySeconds}s — skipping exchange source`, {
        product,
        supported: EXCHANGE_GRANULARITIES,
      });
      return [];
    }

    try {
      this.logger.info(`Loading ${product} data from exchange`, {
        start: startDate.toISOString(),
        end: endDate.toISOString(),
      });

      const allCandles: OHLCV[] = [];
      let currentStart = new Date(startDate);
      const maxCandlesPerRequest = 300;
      const intervalMs = granularitySeconds * 1000;

      while (currentStart < endDate) {
        const batchEnd = new Date(
          Math.min(
            currentStart.getTime() + maxCandlesPerRequest * intervalMs,
            endDate.getTime()
          )
        );

        try {
          const candles = await this.coinbaseClient.getProductCandles(product, {
            start: currentStart.toISOString(),
            end: batchEnd.toISOString(),
            granularity: granularitySeconds as Granularity,
          });

          allCandles.push(...candles.map(c => ({
            time: c.time * 1000, // Convert to milliseconds
            open: c.open,
            high: c.high,
            low: c.low,
            close: c.close,
            volume: c.volume,
          })));

          // Rate limiting
          await new Promise(r => setTimeout(r, 100));
        } catch (error) {
          this.logger.warn(`Failed to fetch batch from exchange:`, error);
        }

        currentStart = new Date(batchEnd.getTime() + intervalMs);
      }

      allCandles.sort((a, b) => a.time - b.time);

      const validated = filterValidCandles(allCandles, product, this.logger);
      this.logger.info(`Loaded ${validated.length} candles from exchange for ${product}`);
      return validated;
    } catch (error) {
      this.logger.warn(`Failed to load from exchange:`, error);
      return [];
    }
  }

  /**
   * Generate synthetic candlestick data for SMOKE runs only.
   * Uses a random walk with loosely realistic properties. Output is tagged
   * `source: 'synthetic'` by the caller and must never be used as evidence.
   */
  private generateSyntheticData(
    product: string,
    startDate: Date,
    endDate: Date,
    granularitySeconds: number
  ): OHLCV[] {
    const candles: OHLCV[] = [];
    const intervalMs = granularitySeconds * 1000;

    // Starting price based on product
    let price = product.startsWith('BTC') ? 50000 : product.startsWith('ETH') ? 3000 : 100;
    const volatility = 0.001; // 0.1% per candle
    const drift = 0.00001; // Slight upward drift

    let currentTime = startDate.getTime();

    while (currentTime <= endDate.getTime()) {
      const change = (Math.random() - 0.5) * 2 * volatility + drift;
      const open = price;

      const intraVolatility = volatility * 2;
      const high = open * (1 + Math.random() * intraVolatility);
      const low = open * (1 - Math.random() * intraVolatility);
      const close = open * (1 + change);

      const actualHigh = Math.max(open, close, high);
      const actualLow = Math.min(open, close, low);

      const baseVolume = product.startsWith('BTC') ? 100 : product.startsWith('ETH') ? 500 : 10000;
      const volume = baseVolume * (0.5 + Math.random() * 1.5);

      candles.push({
        time: currentTime,
        open,
        high: actualHigh,
        low: actualLow,
        close,
        volume,
      });

      price = close;
      currentTime += intervalMs;
    }

    const validated = filterValidCandles(candles, product, this.logger);
    this.logger.warn(`Generated ${validated.length} SYNTHETIC candles for ${product} (SMOKE/VOID)`);
    return validated;
  }

  /**
   * Create a data provider function for the backtest engine. The provider
   * returns candles AND provenance so the engine can stamp reports.
   * Propagates {@link DataUnavailableError} — the engine must not start on
   * missing data.
   */
  createDataProvider(
    options: LoadCandlesOptions & { granularitySeconds?: number } = {},
  ): (product: string, start: Date, end: Date) => Promise<DataLoaderResult> {
    const { granularitySeconds = DEFAULT_GRANULARITY_SECONDS, ...loadOptions } = options;
    return async (product: string, start: Date, end: Date): Promise<DataLoaderResult> => {
      const result = await this.loadCandles(product, start, end, granularitySeconds, loadOptions);
      this.logger.info(`Data provider loaded ${result.candles.length} candles from ${result.source}`, {
        product,
        loadTime: result.loadTime,
        coverage: result.provenance.coverage,
      });
      return result;
    };
  }

  /**
   * Save candles to Supabase `bars` for future use. Idempotent upsert on
   * the table's unique key `(symbol, time, exchange)`.
   */
  async saveToSupabase(product: string, candles: OHLCV[], exchange: string = 'coinbase'): Promise<void> {
    if (candles.length === 0) {
      return;
    }
    if (!this.supabase) {
      throw new Error('saveToSupabase: Supabase client not configured (SUPABASE_URL / SUPABASE_SERVICE_KEY)');
    }

    // bars.time is BIGINT epoch-seconds; OHLCV.time is millis.
    const rows = candles.map(c => ({
      symbol: product,
      exchange,
      time: Math.floor(c.time / 1000),
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume,
    }));

    const chunkSize = 1000;
    for (let i = 0; i < rows.length; i += chunkSize) {
      const chunk = rows.slice(i, i + chunkSize);
      const { error } = await this.supabase.from('bars').upsert(chunk, {
        onConflict: 'symbol,time,exchange',
      });

      if (error) {
        this.logger.error(`Failed to save candles batch for ${product}`, error);
        throw new Error(`bars upsert failed for ${product}: ${error.message}`);
      }
    }

    this.logger.info(`Saved ${candles.length} candles to Supabase for ${product}`);
  }
}
