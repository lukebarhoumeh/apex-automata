/**
 * H1 Apex Trend v1 — TRAIN-only data path with hard locks.
 *
 * The only directory this loader will ever open is
 * `fixtures/bars/1d/tune-2017-01_2025-03` (BTC + ETH, native daily, ends
 * 2025-02-28). Anything else — the sealed loose `fixtures/bars/1d/*.json`
 * (HO-H1-DAILY), the banned `fixtures/bars/1d/btc-eth-2017_plus`, any other
 * directory — is refused before a single byte is read (`H1PathLockError`).
 * Any bar at or after the seal boundary (2025-03-01) is a hard failure too.
 * There is no synthetic path and no override.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { DailyBar, H1Series } from './apex-trend-v1';

/** Frozen path policy for the H1 dry-run. */
export const H1_PATH_LOCK = Object.freeze({
  /** The one and only readable directory (relative to `atlas/apps/core-node`). */
  trainDir: 'fixtures/bars/1d/tune-2017-01_2025-03',
  /** Seal-contaminated directory: never read, never listed, never used. */
  bannedDirs: Object.freeze(['fixtures/bars/1d/btc-eth-2017_plus']) as readonly string[],
  /** Loose sealed HO-H1-DAILY files live here; refused as a `--fixture-dir`. */
  sealedLooseDir: 'fixtures/bars/1d',
  /** First bar of the sealed holdout; no bar with time ≥ this may be read. */
  sealBoundaryUtc: '2025-03-01T00:00:00.000Z',
  /** Universe for this card. */
  symbols: Object.freeze(['BTC-USD', 'ETH-USD']) as readonly string[],
  /** Committed sha256s (fixtures/bars/MULTI_TF.md) — printed, and mismatch is a WARN, not silent. */
  committedSha256: Object.freeze({
    'BTC-USD': '0308ba0d72da994db3cc50215268f40d9fc76fc58446cbc96885093498c4a039',
    'ETH-USD': 'eaa217768fc4f7387850ffacaacb805ca8753631a202a1e16fde3ec15326d9e3',
  }) as Readonly<Record<string, string>>,
});

export class H1PathLockError extends Error {
  public readonly code = 'H1_PATH_LOCK';
  constructor(message: string) {
    super(message);
    this.name = 'H1PathLockError';
  }
}

export class H1DataError extends Error {
  public readonly code = 'H1_DATA_UNAVAILABLE';
  constructor(message: string) {
    super(message);
    this.name = 'H1DataError';
  }
}

/** Mirror of `BarFixtureFile` (data-loader.ts) — kept local so the harness has no engine imports. */
export interface H1FixtureFile {
  symbol: string;
  exchange: string;
  granularity: string;
  granularitySeconds: number;
  source: string;
  endpoint?: string;
  fetchedAt: string;
  start: string;
  end: string;
  rollup?: unknown;
  candles: DailyBar[];
}

export interface H1LoadedSeries extends H1Series {
  filePath: string;
  sha256: string;
  sha256MatchesCommitted: boolean | null;
  granularity: string;
  granularitySeconds: number;
  source: string;
  fetchedAt: string;
  totalBarsInFile: number;
}

export interface H1LoadResult {
  fixtureDir: string;
  series: H1LoadedSeries[];
  openedFiles: string[];
  /** REAL only — this loader has no synthetic branch. */
  dataStamp: 'REAL';
  bannedDirsPresentOnDisk: Record<string, boolean>;
  sealBoundaryEpochSeconds: number;
}

function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

function realpathOrSelf(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * Resolve and enforce the TRAIN-only path lock.
 *
 * @param requestedDir `--fixture-dir` as given (relative to `coreNodeRoot` or absolute)
 * @param coreNodeRoot absolute path of `atlas/apps/core-node`
 * @returns the absolute TRAIN directory
 * @throws H1PathLockError for any banned, sealed or otherwise non-TRAIN path
 */
export function assertTrainFixtureDir(requestedDir: string, coreNodeRoot: string): string {
  const requestedAbs = path.resolve(coreNodeRoot, requestedDir);
  const requestedPosix = toPosix(requestedAbs);
  for (const banned of H1_PATH_LOCK.bannedDirs) {
    if (requestedPosix.includes(banned) || toPosix(requestedDir).includes(banned)) {
      throw new H1PathLockError(`BANNED fixture path (seal contamination): ${banned} — refused, nothing read`);
    }
  }
  const trainAbs = path.resolve(coreNodeRoot, H1_PATH_LOCK.trainDir);
  if (realpathOrSelf(requestedAbs) !== realpathOrSelf(trainAbs)) {
    const sealedAbs = path.resolve(coreNodeRoot, H1_PATH_LOCK.sealedLooseDir);
    const isSealed = realpathOrSelf(requestedAbs) === realpathOrSelf(sealedAbs);
    throw new H1PathLockError(
      `H1 path lock: only ${H1_PATH_LOCK.trainDir} is readable (got ${requestedDir}${isSealed ? ' = SEALED HO-H1-DAILY source' : ''}) — refused, nothing read`,
    );
  }
  return trainAbs;
}

function sha256File(filePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

/**
 * Load BTC/ETH daily series from the TRAIN directory with fail-closed checks:
 * native `ONE_DAY` (86400 s), no rollup block, non-synthetic source, strictly
 * contiguous daily spacing, every bar strictly before the seal boundary.
 *
 * @param trainDirAbs value returned by `assertTrainFixtureDir`
 * @param symbols subset of the card universe (default: both)
 * @param window optional inclusive epoch-second filter (still inside TRAIN)
 */
export function loadTrainSeries(
  trainDirAbs: string,
  symbols: readonly string[] = H1_PATH_LOCK.symbols,
  window?: { startTime?: number; endTime?: number },
): H1LoadResult {
  const coreNodeRoot = path.resolve(trainDirAbs, '../../../..');
  const sealBoundary = Math.floor(Date.parse(H1_PATH_LOCK.sealBoundaryUtc) / 1000);
  const openedFiles: string[] = [];
  const series: H1LoadedSeries[] = [];

  for (const symbol of symbols) {
    if (!H1_PATH_LOCK.symbols.includes(symbol)) {
      throw new H1DataError(`DATA_UNAVAILABLE: ${symbol} is not in the H1 universe (${H1_PATH_LOCK.symbols.join(', ')})`);
    }
    const filePath = path.join(trainDirAbs, `${symbol}.json`);
    if (!fs.existsSync(filePath)) {
      throw new H1DataError(`DATA_UNAVAILABLE: ${filePath} missing`);
    }
    openedFiles.push(filePath);
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as H1FixtureFile;
    if (raw.symbol !== symbol) throw new H1DataError(`${filePath}: symbol ${raw.symbol} ≠ ${symbol}`);
    if (raw.granularity !== 'ONE_DAY' || raw.granularitySeconds !== 86_400) {
      throw new H1DataError(`${filePath}: expected native ONE_DAY/86400, got ${raw.granularity}/${raw.granularitySeconds}`);
    }
    if (raw.rollup !== undefined) throw new H1DataError(`${filePath}: rollup block present — daily must be native`);
    if (/synthetic/i.test(raw.source ?? '')) throw new H1DataError(`${filePath}: synthetic source refused`);
    if (!Array.isArray(raw.candles) || raw.candles.length === 0) throw new H1DataError(`${filePath}: no candles`);

    for (let i = 0; i < raw.candles.length; i++) {
      const c = raw.candles[i];
      if (c.time >= sealBoundary) {
        throw new H1PathLockError(
          `SEAL BREACH: ${symbol} bar ${new Date(c.time * 1000).toISOString()} is at/after ${H1_PATH_LOCK.sealBoundaryUtc} — refused`,
        );
      }
      if (i > 0 && c.time - raw.candles[i - 1].time !== 86_400) {
        throw new H1DataError(`${filePath}: non-daily spacing at index ${i} (${c.time - raw.candles[i - 1].time}s)`);
      }
      if (!(c.high >= c.low) || !(c.high >= c.close) || !(c.low <= c.close) || !(c.close > 0)) {
        throw new H1DataError(`${filePath}: OHLC violation at index ${i}`);
      }
    }

    const bars = raw.candles.filter(
      (c) => (window?.startTime === undefined || c.time >= window.startTime) && (window?.endTime === undefined || c.time <= window.endTime),
    );
    if (bars.length === 0) throw new H1DataError(`DATA_UNAVAILABLE: ${symbol} has no bars in the requested window`);

    const sha256 = sha256File(filePath);
    const committed = H1_PATH_LOCK.committedSha256[symbol];
    series.push({
      symbol,
      bars,
      filePath,
      sha256,
      sha256MatchesCommitted: committed ? sha256 === committed : null,
      granularity: raw.granularity,
      granularitySeconds: raw.granularitySeconds,
      source: raw.source,
      fetchedAt: raw.fetchedAt,
      totalBarsInFile: raw.candles.length,
    });
  }

  const bannedDirsPresentOnDisk: Record<string, boolean> = {};
  for (const banned of H1_PATH_LOCK.bannedDirs) {
    bannedDirsPresentOnDisk[banned] = fs.existsSync(path.resolve(coreNodeRoot, banned));
  }

  return {
    fixtureDir: trainDirAbs,
    series,
    openedFiles,
    dataStamp: 'REAL',
    bannedDirsPresentOnDisk,
    sealBoundaryEpochSeconds: sealBoundary,
  };
}
