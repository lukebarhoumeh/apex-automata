/**
 * Bar aggregation — roll stored 15m candles up to 60m / 240m / 1440m bars
 * for the frequency-lever experiments (TASK_017 step 5, TASK_018 E4).
 *
 * Rules:
 *   - Buckets are UTC-aligned: `bucketStart = floor(time / period) * period`
 *     on epoch-ms, so a 1440m bar always opens at 00:00 UTC and a 240m bar
 *     at 00/04/08/12/16/20 UTC. This matches SignalProcessor's own MTF
 *     rollup (`aggregateToTimeframe`) so the two can never disagree.
 *   - OHLCV rollup: open = first sub-bar open, high = max, low = min,
 *     close = last sub-bar close, volume = sum. `time` = bucket start.
 *   - FAIL-CLOSED on geometry: the target must be an integer multiple of the
 *     source spacing and coarser than it. Anything else throws
 *     {@link BarAggregationError} — never a silent resample.
 *   - Partial buckets (window edges, data gaps) are dropped unless they hold
 *     at least `minBucketFill` of the expected sub-bars. Both the dropped and
 *     the kept-partial counts are recorded in provenance so a report can
 *     never hide a thin bar.
 *
 * Indicator periods are NOT rescaled: an EMA(15) on 240m bars is 15 × 4H
 * bars. That is the intended semantics of the frequency lever (the strategy
 * sees the same bar-count geometry at a slower clock).
 */

import type { OHLCV } from '../indicators/technical';
import type { Logger } from '../core/logger';
import {
  describeSeries,
  normalizeCandles,
  type DataProvenance,
  type DataProviderOutputLike,
} from './data-loader';

/** Bar sizes the CLI accepts. 15 = native stored bars (no aggregation). */
export const SUPPORTED_BAR_MINUTES = [15, 60, 240, 1440] as const;
export type SupportedBarMinutes = (typeof SUPPORTED_BAR_MINUTES)[number];

/** Default fraction of expected sub-bars a bucket must contain to be kept. */
export const DEFAULT_MIN_BUCKET_FILL = 0.5;

export interface AggregationOptions {
  /**
   * Minimum `subBarsPresent / subBarsPerBucket` for a bucket to be emitted.
   * Default {@link DEFAULT_MIN_BUCKET_FILL}. `1` keeps only complete buckets.
   */
  minBucketFill?: number;
}

/** What happened during one rollup — surfaced verbatim in provenance. */
export interface AggregationSummary {
  targetMinutes: number;
  sourceMinutes: number;
  sourceCandleCount: number;
  outputCandleCount: number;
  subBarsPerBucket: number;
  /** Buckets discarded for holding fewer than `minBucketFill` of their sub-bars. */
  bucketsDropped: number;
  /** Buckets emitted with fewer than `subBarsPerBucket` sub-bars (≥ minBucketFill). */
  partialBucketsKept: number;
  minBucketFill: number;
}

/**
 * Thrown when a rollup is geometrically impossible (target not a multiple of
 * the source spacing, target finer than source, unknown spacing). `code` is
 * stable for programmatic matching.
 */
export class BarAggregationError extends Error {
  public readonly code = 'BAR_AGGREGATION_INVALID' as const;
  constructor(message: string) {
    super(`BAR_AGGREGATION_INVALID: ${message}`);
    this.name = 'BarAggregationError';
  }
}

/** Type guard for {@link BarAggregationError} across module boundaries. */
export function isBarAggregationError(err: unknown): err is BarAggregationError {
  return Boolean(err) && typeof err === 'object' && (err as { code?: string }).code === 'BAR_AGGREGATION_INVALID';
}

/**
 * Validate `(sourceMinutes → targetMinutes)` and return the sub-bars per
 * bucket. Throws {@link BarAggregationError} on any impossible geometry.
 */
export function subBarsPerBucket(sourceMinutes: number, targetMinutes: number): number {
  if (!Number.isFinite(sourceMinutes) || sourceMinutes <= 0) {
    throw new BarAggregationError(`source bar spacing must be a positive number of minutes, got ${sourceMinutes}`);
  }
  if (!Number.isInteger(targetMinutes) || targetMinutes <= 0) {
    throw new BarAggregationError(`target bar size must be a positive integer number of minutes, got ${targetMinutes}`);
  }
  if (targetMinutes < sourceMinutes) {
    throw new BarAggregationError(
      `cannot build ${targetMinutes}m bars from ${sourceMinutes}m bars (target is finer than source; disaggregation is not possible)`,
    );
  }
  const ratio = targetMinutes / sourceMinutes;
  if (!Number.isInteger(ratio)) {
    throw new BarAggregationError(
      `cannot build ${targetMinutes}m bars from ${sourceMinutes}m bars (${targetMinutes} is not an integer multiple of ${sourceMinutes})`,
    );
  }
  return ratio;
}

/**
 * Roll `candles` (any order, duplicates tolerated) up to `targetMinutes`
 * bars. Pure and deterministic. Returns the aggregated series plus a summary
 * for provenance. When `targetMinutes === sourceMinutes` the input is
 * returned normalized with `subBarsPerBucket = 1` and nothing dropped.
 */
export function aggregateCandles(
  candles: OHLCV[],
  targetMinutes: number,
  sourceMinutes: number,
  options: AggregationOptions = {},
): { candles: OHLCV[]; summary: AggregationSummary } {
  const perBucket = subBarsPerBucket(sourceMinutes, targetMinutes);
  const minBucketFill = clampFill(options.minBucketFill ?? DEFAULT_MIN_BUCKET_FILL);
  const normalized = normalizeCandles(candles);

  if (perBucket === 1) {
    return {
      candles: normalized,
      summary: {
        targetMinutes,
        sourceMinutes,
        sourceCandleCount: normalized.length,
        outputCandleCount: normalized.length,
        subBarsPerBucket: 1,
        bucketsDropped: 0,
        partialBucketsKept: 0,
        minBucketFill,
      },
    };
  }

  const periodMs = targetMinutes * 60_000;
  const buckets = new Map<number, OHLCV[]>();
  for (const candle of normalized) {
    const bucketStart = Math.floor(candle.time / periodMs) * periodMs;
    const group = buckets.get(bucketStart);
    if (group) group.push(candle);
    else buckets.set(bucketStart, [candle]);
  }

  const out: OHLCV[] = [];
  let bucketsDropped = 0;
  let partialBucketsKept = 0;
  const minSubBars = Math.max(1, Math.ceil(minBucketFill * perBucket));

  for (const bucketStart of Array.from(buckets.keys()).sort((a, b) => a - b)) {
    const group = buckets.get(bucketStart)!;
    if (group.length < minSubBars) {
      bucketsDropped += 1;
      continue;
    }
    if (group.length < perBucket) partialBucketsKept += 1;
    let high = -Infinity;
    let low = Infinity;
    let volume = 0;
    for (const c of group) {
      if (c.high > high) high = c.high;
      if (c.low < low) low = c.low;
      volume += c.volume;
    }
    out.push({
      time: bucketStart,
      open: group[0].open,
      high,
      low,
      close: group[group.length - 1].close,
      volume,
    });
  }

  return {
    candles: out,
    summary: {
      targetMinutes,
      sourceMinutes,
      sourceCandleCount: normalized.length,
      outputCandleCount: out.length,
      subBarsPerBucket: perBucket,
      bucketsDropped,
      partialBucketsKept,
      minBucketFill,
    },
  };
}

function clampFill(v: number): number {
  if (!Number.isFinite(v)) return DEFAULT_MIN_BUCKET_FILL;
  return Math.min(1, Math.max(0, v));
}

/** Provider signature shared with `BacktestEngine.loadHistoricalData`. */
export type SeriesProvider = (product: string, start: Date, end: Date) => Promise<DataProviderOutputLike>;

/**
 * Wrap a loader-backed provider so every series it yields is rolled up to
 * `targetMinutes` before the engine sees it. The native load (and therefore
 * the fail-closed coverage floor and DATA_UNAVAILABLE semantics) is
 * untouched; aggregation is a pure post-step whose summary is attached to
 * the provenance record (`provenance.aggregation`).
 *
 * The source spacing is taken from the loaded series itself
 * (`provenance.inferredBarMinutes`), not from what the caller *asked* the
 * loader for — a fixture or `bars` window that is not actually 15m must
 * not be silently treated as 15m. A mismatch with the declared granularity
 * is logged; an impossible geometry throws {@link BarAggregationError}.
 */
export function withBarAggregation(
  provider: SeriesProvider,
  targetMinutes: number,
  options: AggregationOptions = {},
  logger?: Logger,
): SeriesProvider {
  return async (product, start, end) => {
    const t0 = Date.now();
    const output = await provider(product, start, end);
    const provenance = output.provenance;
    const declaredMinutes = provenance.granularitySeconds / 60;
    const sourceMinutes = provenance.inferredBarMinutes ?? declaredMinutes;
    if (!provenance.inferredBarMinutes) {
      throw new BarAggregationError(
        `${product}: cannot infer source bar spacing from ${output.candles.length} candle(s); need ≥ 2 bars to aggregate to ${targetMinutes}m`,
      );
    }
    if (Math.abs(sourceMinutes - declaredMinutes) > 1e-6) {
      logger?.warn('Bar aggregation: stored spacing differs from declared granularity — using stored spacing', {
        product,
        declaredMinutes,
        inferredMinutes: sourceMinutes,
      });
    }
    if (sourceMinutes === targetMinutes) {
      return output;
    }

    const { candles, summary } = aggregateCandles(output.candles, targetMinutes, sourceMinutes, options);
    const aggregated: DataProvenance = {
      ...describeSeries(
        product,
        provenance.source,
        candles,
        new Date(provenance.windowStart),
        new Date(provenance.windowEnd),
        targetMinutes * 60,
        provenance.loadTimeMs + (Date.now() - t0),
        { fixturePath: provenance.fixturePath, fixtureSha256: provenance.fixtureSha256 },
      ),
      aggregation: summary,
    };
    logger?.info(`Aggregated ${product} ${sourceMinutes}m → ${targetMinutes}m`, {
      sourceBars: summary.sourceCandleCount,
      outputBars: summary.outputCandleCount,
      bucketsDropped: summary.bucketsDropped,
      partialBucketsKept: summary.partialBucketsKept,
      minBucketFill: summary.minBucketFill,
    });
    return { candles, provenance: aggregated };
  };
}

/** Human-readable timeframe line for reports/CLI. */
export function describeBarTimeframe(provenance: Iterable<DataProvenance>): string {
  const records = Array.from(provenance);
  if (records.length === 0) return 'n/a';
  const aggregated = records.filter((p) => p.aggregation && p.aggregation.subBarsPerBucket > 1);
  if (aggregated.length === 0) {
    const spacing = Array.from(new Set(records.map((p) => p.inferredBarMinutes ?? 'n/a'))).join(', ');
    return `${spacing} min (native stored bars; no aggregation)`;
  }
  const targets = Array.from(new Set(aggregated.map((p) => p.aggregation!.targetMinutes))).join(', ');
  const sources = Array.from(new Set(aggregated.map((p) => p.aggregation!.sourceMinutes))).join(', ');
  const dropped = aggregated.reduce((n, p) => n + p.aggregation!.bucketsDropped, 0);
  const partial = aggregated.reduce((n, p) => n + p.aggregation!.partialBucketsKept, 0);
  return (
    `${targets} min (aggregated from ${sources}m stored bars, UTC-aligned buckets; ` +
    `${dropped} partial bucket(s) dropped, ${partial} partial bucket(s) kept)`
  );
}
