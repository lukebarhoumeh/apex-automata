/**
 * Unit tests for CoinDeskClient (data-sources/coindesk-client.ts).
 *
 * All HTTP is mocked via vi.spyOn(global, 'fetch'). Live API is never hit.
 * We deliberately use payloads that mirror the real CoinDesk article shape
 * captured during Phase 1 verification (SENTIMENT, PUBLISHED_ON, SOURCE_DATA,
 * CATEGORY_DATA[].CATEGORY).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CoinDeskClient, symbolToBaseAsset } from '../data-sources/coindesk-client';
import { Logger } from '../core/logger';

const mockLogger: Logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

const TEST_KEY = 'test-key-0123456789abcdef';

function makeArticle(opts: {
  id: number;
  sentiment: 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL';
  publishedOnSec: number;
  categories?: string[];
  benchmark?: number;
  sourceName?: string;
}) {
  return {
    ID: opts.id,
    GUID: `https://example.com/article/${opts.id}`,
    PUBLISHED_ON: opts.publishedOnSec,
    PUBLISHED_ON_NS: opts.publishedOnSec * 1_000_000_000,
    TITLE: `Test article ${opts.id}`,
    SENTIMENT: opts.sentiment,
    SOURCE_DATA: {
      NAME: opts.sourceName ?? 'Test Source',
      BENCHMARK_SCORE: opts.benchmark ?? 50,
    },
    CATEGORY_DATA: (opts.categories ?? ['BTC']).map((c) => ({
      ID: 1,
      NAME: c,
      CATEGORY: c,
      TYPE: '122',
    })),
    URL: `https://example.com/article/${opts.id}`,
    LANG: 'EN',
    SCORE: 0,
    UPVOTES: 0,
    DOWNVOTES: 0,
  };
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function buildClient(overrides: Partial<ConstructorParameters<typeof CoinDeskClient>[0]> = {}): CoinDeskClient {
  return new CoinDeskClient(
    {
      apiKey: TEST_KEY,
      cacheTtlMs: 60_000,
      requestTimeoutMs: 1_000,
      maxRetries: 3,
      retryBackoffMs: [1, 1, 1], // tiny so retries don't slow tests
      ...overrides,
    },
    mockLogger
  );
}

describe('symbolToBaseAsset', () => {
  it('strips standard quote/venue suffixes', () => {
    expect(symbolToBaseAsset('BTC-USD')).toBe('BTC');
    expect(symbolToBaseAsset('eth-usd')).toBe('ETH');
    expect(symbolToBaseAsset('SOL-USDC')).toBe('SOL');
    expect(symbolToBaseAsset('ETH-PERP-INTX')).toBe('ETH');
    expect(symbolToBaseAsset('BTC')).toBe('BTC');
  });
});

describe('CoinDeskClient.constructor', () => {
  it('throws on missing/short key', () => {
    expect(() => new CoinDeskClient({ apiKey: '' }, mockLogger)).toThrow();
    expect(() => new CoinDeskClient({ apiKey: 'short' }, mockLogger)).toThrow();
  });
});

describe('CoinDeskClient.getAggregateSentiment — happy paths', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    vi.clearAllMocks();
  });

  it('returns a positive score for predominantly POSITIVE recent BTC news', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        Data: [
          makeArticle({ id: 1, sentiment: 'POSITIVE', publishedOnSec: nowSec - 60, benchmark: 80 }),
          makeArticle({ id: 2, sentiment: 'POSITIVE', publishedOnSec: nowSec - 120, benchmark: 60 }),
          makeArticle({ id: 3, sentiment: 'NEUTRAL', publishedOnSec: nowSec - 300, benchmark: 50 }),
        ],
        Err: null,
      })
    );

    const client = buildClient();
    const result = await client.getAggregateSentiment('BTC-USD', 60);
    expect(result.symbol).toBe('BTC');
    expect(result.articleCount).toBe(3);
    expect(result.score).toBeGreaterThan(0.3);
    expect(result.score).toBeLessThanOrEqual(1);
    expect(result.positive).toBe(2);
    expect(result.neutral).toBe(1);
    expect(result.negative).toBe(0);
    expect(result.freshnessMs).toBeLessThan(120_000);
  });

  it('returns a negative score for predominantly NEGATIVE recent news', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        Data: [
          makeArticle({ id: 10, sentiment: 'NEGATIVE', publishedOnSec: nowSec - 60, benchmark: 80 }),
          makeArticle({ id: 11, sentiment: 'NEGATIVE', publishedOnSec: nowSec - 120, benchmark: 70 }),
          makeArticle({ id: 12, sentiment: 'POSITIVE', publishedOnSec: nowSec - 300, benchmark: 30 }),
        ],
        Err: null,
      })
    );

    const client = buildClient();
    const result = await client.getAggregateSentiment('BTC-USD', 60);
    expect(result.score).toBeLessThan(-0.2);
    expect(result.negative).toBe(2);
    expect(result.positive).toBe(1);
  });

  it('abstains (articleCount=0) when API returns no articles', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({ Data: [], Err: null }));

    const client = buildClient();
    const result = await client.getAggregateSentiment('SOL-USD', 60);
    expect(result.articleCount).toBe(0);
    expect(result.score).toBe(0);
    expect(result.freshnessMs).toBe(Number.POSITIVE_INFINITY);
  });

  it('abstains when no articles in lookback window match the base asset', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    // BTC articles only — querying SOL → matched=0.
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        Data: [
          makeArticle({ id: 20, sentiment: 'POSITIVE', publishedOnSec: nowSec - 60, categories: ['BTC'] }),
        ],
        Err: null,
      })
    );

    const client = buildClient();
    const result = await client.getAggregateSentiment('SOL-USD', 60);
    expect(result.articleCount).toBe(0);
    expect(result.score).toBe(0);
  });

  it('respects sinceMs filter — drops articles older than the lookback window', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    // The client itself filters via opts.sinceMs in fetchRecentNews. We call
    // it directly to assert that contract.
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        Data: [
          makeArticle({ id: 30, sentiment: 'POSITIVE', publishedOnSec: nowSec - 60 }),
          makeArticle({ id: 31, sentiment: 'POSITIVE', publishedOnSec: nowSec - 7200 }), // 2h old
        ],
        Err: null,
      })
    );

    const client = buildClient();
    const articles = await client.fetchRecentNews(['BTC'], { sinceMs: Date.now() - 30 * 60 * 1000 });
    expect(articles.map((a) => a.id)).toEqual([30]);
  });
});

describe('CoinDeskClient.getAggregateSentiment — caching & coalescing', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    vi.clearAllMocks();
  });

  it('serves the second call from cache within TTL — no second fetch', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        Data: [makeArticle({ id: 40, sentiment: 'POSITIVE', publishedOnSec: nowSec - 60 })],
        Err: null,
      })
    );

    const client = buildClient({ cacheTtlMs: 60_000 });
    const r1 = await client.getAggregateSentiment('BTC-USD', 60);
    const r2 = await client.getAggregateSentiment('BTC-USD', 60);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(r1).toEqual(r2);
  });

  it('coalesces concurrent requests for the same key into one fetch', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    let resolveFetch: (v: Response) => void = () => undefined;
    const fetchPromise = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    fetchSpy.mockReturnValueOnce(fetchPromise);

    const client = buildClient();
    const p1 = client.getAggregateSentiment('BTC-USD', 60);
    const p2 = client.getAggregateSentiment('BTC-PERP-INTX', 60); // same base asset → same cache key
    resolveFetch(
      jsonResponse({
        Data: [makeArticle({ id: 50, sentiment: 'POSITIVE', publishedOnSec: nowSec - 60 })],
        Err: null,
      })
    );

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(r1.symbol).toBe('BTC');
    expect(r2.symbol).toBe('BTC');
  });
});

describe('CoinDeskClient — error handling & retries', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    vi.clearAllMocks();
  });

  it('retries on 429 then succeeds on 2nd attempt', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    fetchSpy.mockResolvedValueOnce(jsonResponse({ Err: 'rate limited' }, 429));
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        Data: [makeArticle({ id: 60, sentiment: 'POSITIVE', publishedOnSec: nowSec - 60 })],
        Err: null,
      })
    );

    const client = buildClient();
    const result = await client.getAggregateSentiment('BTC-USD', 60);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(result.articleCount).toBe(1);
  });

  it('retries on 503 then succeeds on 3rd attempt', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    fetchSpy.mockResolvedValueOnce(jsonResponse({ Err: 'down' }, 503));
    fetchSpy.mockResolvedValueOnce(jsonResponse({ Err: 'down' }, 503));
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        Data: [makeArticle({ id: 70, sentiment: 'NEUTRAL', publishedOnSec: nowSec - 60 })],
        Err: null,
      })
    );

    const client = buildClient();
    const result = await client.getAggregateSentiment('BTC-USD', 60);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(result.articleCount).toBe(1);
  });

  it('does NOT retry on 401 — fails fast', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({ Err: 'unauthorized' }, 401));

    const client = buildClient();
    await expect(client.getAggregateSentiment('BTC-USD', 60)).rejects.toThrow();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry on 403 — fails fast', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({ Err: 'forbidden' }, 403));

    const client = buildClient();
    await expect(client.getAggregateSentiment('BTC-USD', 60)).rejects.toThrow();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('exhausts retries on persistent 500 then throws', async () => {
    fetchSpy.mockResolvedValue(jsonResponse({ Err: 'broken' }, 500));

    const client = buildClient({ maxRetries: 2, retryBackoffMs: [1, 1] });
    await expect(client.getAggregateSentiment('BTC-USD', 60)).rejects.toThrow(/HTTP 500/);
    expect(fetchSpy).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it('translates AbortError into a timeout error', async () => {
    fetchSpy.mockImplementationOnce((_url: unknown, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        // Mimic AbortController behavior — when signal aborts, reject with
        // a DOMException-like AbortError.
        const signal = init?.signal as AbortSignal | undefined;
        signal?.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    });

    const client = buildClient({ requestTimeoutMs: 5, maxRetries: 0 });
    await expect(client.getAggregateSentiment('BTC-USD', 60)).rejects.toThrow(/timeout/i);
  });

  it('never logs the API key on error paths', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({ Err: 'unauthorized' }, 401));
    const client = buildClient();
    await expect(client.getAggregateSentiment('BTC-USD', 60)).rejects.toThrow();

    const errCalls = (mockLogger.error as ReturnType<typeof vi.fn>).mock.calls;
    const warnCalls = (mockLogger.warn as ReturnType<typeof vi.fn>).mock.calls;
    const allArgs = JSON.stringify([...errCalls, ...warnCalls]);
    expect(allArgs).not.toContain(TEST_KEY);
  });
});
