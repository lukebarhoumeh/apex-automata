/**
 * CoinDeskClient — News + Sentiment data source adapter.
 *
 * Wraps CoinDesk's public Data API (https://developers.coindesk.com/documentation/data-api/news_v1)
 * to surface aggregate per-symbol sentiment for the MetaFilter `coindesk_sentiment` rule.
 *
 * Design:
 *   - Stateless from the engine's POV. The signal pipeline asks for an aggregate
 *     score and the client returns either a fresh number or a cached one.
 *   - In-memory TTL cache (default 60s) keyed by (symbol, lookbackMinutes) so we
 *     don't hammer the API on every signal tick.
 *   - 3-attempt retry with exponential backoff for 429 / 5xx responses.
 *   - 401/403 fail fast (no retry) — operator must rotate the key.
 *   - 5s default per-attempt timeout via AbortController.
 *   - Logger is mandatory; the API key is NEVER logged or surfaced in errors.
 *
 * Auth:
 *   `Authorization: Apikey <COINDESK_API_KEY>` per CoinDesk docs.
 *
 * Sentiment normalization:
 *   CoinDesk tags every article with SENTIMENT ∈ {NEGATIVE, NEUTRAL, POSITIVE}.
 *   We map to {-1, 0, +1}, weight each article by source benchmark score and an
 *   exponential freshness decay (half-life = lookback/2), and average to a
 *   bounded score in [-1, +1].
 *
 * NOTE: CoinDesk's free tier sunsets 2026-05-21. The current Apex key shows free-
 * tier limits (11k req/month). After that date the rule will start returning
 * abstain on auth failures unless the key is upgraded. Failure mode is graceful:
 * the rule abstains and emits a Logger error; no signals are blocked.
 */

import { Logger } from '../core/logger';

export interface ICoinDeskNewsArticle {
  id: number;
  guid: string;
  publishedOnSec: number;
  title: string;
  sentiment: 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL';
  sourceName: string;
  sourceBenchmarkScore: number; // 0..100
  categories: string[]; // upper-cased symbols/tags (e.g. ["BTC", "MARKET", "TRADING"])
  url: string;
  lang: string;
}

export interface ICoinDeskSentimentScore {
  symbol: string;
  /** Decay-weighted, source-benchmark-weighted aggregate sentiment in [-1, +1]. */
  score: number;
  articleCount: number;
  /** Milliseconds since the freshest article was published. */
  freshnessMs: number;
  /** Distribution of article sentiments. */
  positive: number;
  negative: number;
  neutral: number;
  /** Wall-clock of when this aggregate was computed (cache stamp). */
  computedAt: number;
}

export interface ICoinDeskClientConfig {
  apiKey: string;
  baseUrl?: string; // overridable for tests
  cacheTtlMs?: number; // default 60_000
  requestTimeoutMs?: number; // default 5_000
  maxRetries?: number; // default 3
  /** Backoff schedule in ms; index N corresponds to attempt N (0-based). */
  retryBackoffMs?: number[]; // default [250, 1000, 4000]
  userAgent?: string;
}

const DEFAULT_BASE_URL = 'https://data-api.coindesk.com';
const DEFAULT_CACHE_TTL_MS = 60_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BACKOFF_MS = [250, 1_000, 4_000];
const DEFAULT_USER_AGENT = 'apex-automata/1.0 (+coindesk-news-sentiment)';

const SENTIMENT_VAL: Record<ICoinDeskNewsArticle['sentiment'], number> = {
  POSITIVE: 1,
  NEUTRAL: 0,
  NEGATIVE: -1,
};

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

/** Map an Atlas trading symbol (e.g. "ETH-PERP-INTX", "BTC-USD") to the base
 * asset CoinDesk tags articles with (e.g. "ETH", "BTC"). */
export function symbolToBaseAsset(symbol: string): string {
  // Strip common quote/venue suffixes. CoinDesk tags by base asset only.
  const upper = symbol.toUpperCase();
  const stripped = upper.replace(/-(PERP|PERP-INTX|USD|USDC|USDT|EUR|GBP)$/u, '');
  // Handle plain "BTC" / "ETH" already.
  return stripped.split('-')[0];
}

export class CoinDeskClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly cacheTtlMs: number;
  private readonly requestTimeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryBackoffMs: number[];
  private readonly userAgent: string;
  private readonly logger: Logger;

  private readonly aggregateCache = new Map<string, CacheEntry<ICoinDeskSentimentScore>>();
  private readonly inflight = new Map<string, Promise<ICoinDeskSentimentScore>>();

  constructor(config: ICoinDeskClientConfig, logger: Logger) {
    if (!config.apiKey || typeof config.apiKey !== 'string' || config.apiKey.length < 16) {
      // Defensive — caller is expected to gate construction on the feature flag.
      throw new Error('CoinDeskClient: COINDESK_API_KEY is missing or malformed');
    }
    this.apiKey = config.apiKey;
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/u, '');
    this.cacheTtlMs = config.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.requestTimeoutMs = config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.retryBackoffMs = config.retryBackoffMs ?? DEFAULT_BACKOFF_MS;
    this.userAgent = config.userAgent ?? DEFAULT_USER_AGENT;
    this.logger = logger;
  }

  /**
   * Fetch the most recent N articles tagged with the given symbols.
   * Returns parsed, normalized records; payload-shape errors abstain (return []).
   */
  public async fetchRecentNews(
    symbols: string[],
    opts: { limit?: number; sinceMs?: number } = {}
  ): Promise<ICoinDeskNewsArticle[]> {
    const limit = clamp(opts.limit ?? 50, 1, 100);
    const params = new URLSearchParams({ lang: 'EN', limit: String(limit) });
    if (symbols.length > 0) {
      params.set('categories', symbols.map((s) => s.toUpperCase()).join(','));
    }

    const url = `${this.baseUrl}/news/v1/article/list?${params.toString()}`;
    const raw = await this.requestWithRetry(url);

    const data = (raw && typeof raw === 'object' && 'Data' in raw ? (raw as { Data?: unknown }).Data : null);
    if (!Array.isArray(data)) {
      this.logger.warn('CoinDesk fetchRecentNews: unexpected payload shape', {
        hasData: Boolean(data),
        keys: raw && typeof raw === 'object' ? Object.keys(raw as object).slice(0, 8) : null,
      });
      return [];
    }

    const cutoffSec = opts.sinceMs ? Math.floor(opts.sinceMs / 1000) : 0;
    const out: ICoinDeskNewsArticle[] = [];
    for (const a of data as Record<string, unknown>[]) {
      const normalized = this.normalizeArticle(a);
      if (!normalized) continue;
      if (cutoffSec && normalized.publishedOnSec < cutoffSec) continue;
      out.push(normalized);
    }
    return out;
  }

  /**
   * Aggregate sentiment for `symbol` over the past `lookbackMinutes`.
   * Result is cached for `cacheTtlMs` keyed by (baseAsset, lookbackMinutes).
   * On API failure, throws — the rule layer is responsible for treating
   * thrown errors as abstain.
   */
  public async getAggregateSentiment(
    symbol: string,
    lookbackMinutes: number
  ): Promise<ICoinDeskSentimentScore> {
    const baseAsset = symbolToBaseAsset(symbol);
    const cacheKey = `${baseAsset}|${lookbackMinutes}`;
    const cached = this.aggregateCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }

    // Coalesce concurrent fetches for the same key — common when many symbols
    // share a base asset (e.g. BTC-USD and BTC-PERP-INTX both → BTC).
    const inflight = this.inflight.get(cacheKey);
    if (inflight) return inflight;

    const promise = this.computeAggregate(baseAsset, lookbackMinutes)
      .then((value) => {
        this.aggregateCache.set(cacheKey, {
          value,
          expiresAt: Date.now() + this.cacheTtlMs,
        });
        return value;
      })
      .finally(() => {
        this.inflight.delete(cacheKey);
      });
    this.inflight.set(cacheKey, promise);
    return promise;
  }

  /** Test-only — clears the in-memory cache. */
  public clearCache(): void {
    this.aggregateCache.clear();
    this.inflight.clear();
  }

  // ============ internals ============

  private async computeAggregate(
    baseAsset: string,
    lookbackMinutes: number
  ): Promise<ICoinDeskSentimentScore> {
    const sinceMs = Date.now() - lookbackMinutes * 60 * 1_000;
    // Pull a wider window than the lookback so we can post-filter and have
    // enough samples even when some articles are older than the window.
    const articles = await this.fetchRecentNews([baseAsset], { limit: 100, sinceMs });

    const matched = articles.filter((a) => a.categories.includes(baseAsset));
    const articleCount = matched.length;

    if (articleCount === 0) {
      return {
        symbol: baseAsset,
        score: 0,
        articleCount: 0,
        freshnessMs: Number.POSITIVE_INFINITY,
        positive: 0,
        negative: 0,
        neutral: 0,
        computedAt: Date.now(),
      };
    }

    const nowSec = Math.floor(Date.now() / 1_000);
    const halfLifeSec = Math.max(60, lookbackMinutes * 30); // half-life = lookback/2
    let weightedSum = 0;
    let totalWeight = 0;
    let positive = 0;
    let negative = 0;
    let neutral = 0;
    let freshestSec = 0;

    for (const a of matched) {
      const ageSec = Math.max(0, nowSec - a.publishedOnSec);
      const freshness = Math.exp(-Math.LN2 * (ageSec / halfLifeSec));
      const sourceTrust = Math.max(0, Math.min(1, a.sourceBenchmarkScore / 100));
      // Source-trust gets a floor so unrated sources still vote (just lightly).
      const weight = freshness * (0.25 + 0.75 * sourceTrust);
      const val = SENTIMENT_VAL[a.sentiment];
      weightedSum += val * weight;
      totalWeight += weight;
      if (val > 0) positive += 1;
      else if (val < 0) negative += 1;
      else neutral += 1;
      if (a.publishedOnSec > freshestSec) freshestSec = a.publishedOnSec;
    }

    const score = totalWeight > 0 ? clamp(weightedSum / totalWeight, -1, 1) : 0;
    const freshnessMs = freshestSec ? Math.max(0, Date.now() - freshestSec * 1_000) : Number.POSITIVE_INFINITY;

    return {
      symbol: baseAsset,
      score,
      articleCount,
      freshnessMs,
      positive,
      negative,
      neutral,
      computedAt: Date.now(),
    };
  }

  private async requestWithRetry(url: string): Promise<unknown> {
    let lastErr: unknown = null;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        return await this.requestOnce(url);
      } catch (err) {
        const status = (err as { status?: number }).status;
        // Auth / client errors should not be retried.
        if (status === 401 || status === 403) {
          this.logger.error('CoinDesk auth failed (no retry)', {
            status,
            url: this.redactUrl(url),
          });
          throw err;
        }
        // Non-retryable 4xx other than 429.
        if (typeof status === 'number' && status >= 400 && status < 500 && status !== 429) {
          this.logger.error('CoinDesk client error (no retry)', {
            status,
            url: this.redactUrl(url),
          });
          throw err;
        }
        lastErr = err;
        if (attempt >= this.maxRetries) break;
        const delay = this.retryBackoffMs[Math.min(attempt, this.retryBackoffMs.length - 1)] ?? 1_000;
        this.logger.warn('CoinDesk request failed, retrying', {
          attempt: attempt + 1,
          maxAttempts: this.maxRetries + 1,
          delayMs: delay,
          status: status ?? null,
          err: (err as Error)?.message,
        });
        await sleep(delay);
      }
    }
    this.logger.error('CoinDesk request exhausted retries', {
      url: this.redactUrl(url),
      err: (lastErr as Error)?.message,
    });
    throw lastErr instanceof Error ? lastErr : new Error('CoinDesk request failed');
  }

  private async requestOnce(url: string): Promise<unknown> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.requestTimeoutMs);
    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: {
          accept: 'application/json',
          authorization: `Apikey ${this.apiKey}`,
          'user-agent': this.userAgent,
        },
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const err = new Error(`CoinDesk HTTP ${res.status} ${res.statusText}`) as Error & {
          status: number;
        };
        err.status = res.status;
        throw err;
      }
      return await res.json();
    } catch (err) {
      // Translate AbortError into a typed timeout while never echoing the key.
      if ((err as { name?: string }).name === 'AbortError') {
        const wrapped = new Error(`CoinDesk request timeout after ${this.requestTimeoutMs}ms`) as Error & {
          status?: number;
        };
        throw wrapped;
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  private normalizeArticle(raw: Record<string, unknown>): ICoinDeskNewsArticle | null {
    const sentiment = String(raw.SENTIMENT ?? '').toUpperCase() as ICoinDeskNewsArticle['sentiment'];
    if (sentiment !== 'POSITIVE' && sentiment !== 'NEGATIVE' && sentiment !== 'NEUTRAL') return null;
    const id = Number(raw.ID);
    const publishedOnSec = Number(raw.PUBLISHED_ON);
    if (!Number.isFinite(id) || !Number.isFinite(publishedOnSec)) return null;

    const sourceData = (raw.SOURCE_DATA as Record<string, unknown>) ?? {};
    const benchmark = Number(sourceData.BENCHMARK_SCORE);
    const sourceBenchmarkScore = Number.isFinite(benchmark) ? benchmark : 0;

    const categories: string[] = [];
    const catData = raw.CATEGORY_DATA;
    if (Array.isArray(catData)) {
      for (const c of catData) {
        if (typeof c === 'string') {
          categories.push(c.toUpperCase());
        } else if (c && typeof c === 'object') {
          const cat = (c as Record<string, unknown>).CATEGORY ?? (c as Record<string, unknown>).NAME;
          if (typeof cat === 'string') categories.push(cat.toUpperCase());
        }
      }
    }

    return {
      id,
      guid: String(raw.GUID ?? ''),
      publishedOnSec,
      title: String(raw.TITLE ?? ''),
      sentiment,
      sourceName: String((sourceData as { NAME?: unknown }).NAME ?? ''),
      sourceBenchmarkScore,
      categories,
      url: String(raw.URL ?? ''),
      lang: String(raw.LANG ?? 'EN'),
    };
  }

  /** Returns a logging-safe rendering of the URL — strips query string entirely
   * (it never contains the key, but it's defensive against future changes that
   * might pass auth via query). */
  private redactUrl(url: string): string {
    try {
      const u = new URL(url);
      return `${u.origin}${u.pathname}`;
    } catch {
      return '<malformed-url>';
    }
  }
}

function clamp(n: number, lo: number, hi: number): number {
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
