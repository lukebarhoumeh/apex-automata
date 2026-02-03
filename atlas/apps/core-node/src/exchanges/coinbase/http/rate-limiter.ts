/**
 * Coinbase Rate Limiter
 * 
 * Implements token bucket rate limiting to prevent hitting Coinbase's rate limits.
 * Provides coordination across concurrent requests to avoid stampedes.
 * 
 * Coinbase rate limits:
 * - Public endpoints: ~10 requests/second
 * - Private endpoints: ~15 requests/second
 * - Orders endpoint: ~5-10 requests/second (more restrictive)
 */

import { EventEmitter } from 'events';
import { Counter, Gauge } from 'prom-client';

// Prometheus metrics
const rateLimitWaitsTotal = new Counter({
  name: 'coinbase_rate_limit_waits_total',
  help: 'Total number of times requests waited for rate limit',
  labelNames: ['bucket'],
});

const rateLimitEventsTotal = new Counter({
  name: 'coinbase_rest_rate_limit_events_total',
  help: 'Total number of 429 rate limit responses received',
});

const rateLimitTokensGauge = new Gauge({
  name: 'coinbase_rate_limit_tokens',
  help: 'Current number of tokens available in rate limit bucket',
  labelNames: ['bucket'],
});

export interface RateLimiterConfig {
  /** Maximum tokens in the bucket */
  maxTokens: number;
  /** Tokens refilled per second */
  refillRate: number;
  /** Minimum time between requests (ms) */
  minInterval: number;
  /** Name for logging/metrics */
  name: string;
}

export interface RateLimiterState {
  tokens: number;
  lastRefill: number;
  lastRequest: number;
  waiting: number;
  totalWaits: number;
  forcedWaitUntil: number | null;
}

/**
 * Token bucket rate limiter with coordination
 */
export class TokenBucketRateLimiter extends EventEmitter {
  private config: RateLimiterConfig;
  private tokens: number;
  private lastRefill: number;
  private lastRequest: number;
  private waiting: number = 0;
  private totalWaits: number = 0;
  private forcedWaitUntil: number | null = null;
  private waitQueue: Array<{ resolve: () => void; priority: number }> = [];

  constructor(config: RateLimiterConfig) {
    super();
    this.config = config;
    this.tokens = config.maxTokens;
    this.lastRefill = Date.now();
    this.lastRequest = 0;
  }

  /**
   * Acquire a token, waiting if necessary
   * @param priority Lower = higher priority (reconciliation can use 0, normal requests use 1)
   */
  public async acquire(priority: number = 1): Promise<void> {
    // Refill tokens based on time elapsed
    this.refill();

    // Check if we're in a forced wait period (from 429 response)
    if (this.forcedWaitUntil && Date.now() < this.forcedWaitUntil) {
      const waitTime = this.forcedWaitUntil - Date.now();
      this.waiting++;
      this.totalWaits++;
      rateLimitWaitsTotal.inc({ bucket: this.config.name });
      
      await this.sleep(waitTime);
      this.waiting--;
      this.refill();
    }

    // Check minimum interval
    const timeSinceLastRequest = Date.now() - this.lastRequest;
    if (timeSinceLastRequest < this.config.minInterval) {
      const minWait = this.config.minInterval - timeSinceLastRequest;
      await this.sleep(minWait);
    }

    // If tokens available, acquire immediately
    if (this.tokens >= 1) {
      this.tokens -= 1;
      this.lastRequest = Date.now();
      rateLimitTokensGauge.set({ bucket: this.config.name }, this.tokens);
      return;
    }

    // No tokens available, wait in queue
    this.waiting++;
    this.totalWaits++;
    rateLimitWaitsTotal.inc({ bucket: this.config.name });

    await new Promise<void>((resolve) => {
      // Insert into queue sorted by priority
      const entry = { resolve, priority };
      const insertIndex = this.waitQueue.findIndex(e => e.priority > priority);
      if (insertIndex === -1) {
        this.waitQueue.push(entry);
      } else {
        this.waitQueue.splice(insertIndex, 0, entry);
      }
    });

    this.waiting--;
    this.lastRequest = Date.now();
    rateLimitTokensGauge.set({ bucket: this.config.name }, this.tokens);
  }

  /**
   * Release a token (call when request completes)
   * This also triggers processing of the wait queue
   */
  public release(): void {
    this.refill();
    this.processQueue();
  }

  /**
   * Force a wait period (called when 429 is received)
   */
  public forceWait(durationMs: number): void {
    rateLimitEventsTotal.inc();
    this.forcedWaitUntil = Date.now() + durationMs;
    this.emit('rate_limited', { durationMs, until: this.forcedWaitUntil });
  }

  /**
   * Get current state for monitoring
   */
  public getState(): RateLimiterState {
    this.refill();
    return {
      tokens: this.tokens,
      lastRefill: this.lastRefill,
      lastRequest: this.lastRequest,
      waiting: this.waiting,
      totalWaits: this.totalWaits,
      forcedWaitUntil: this.forcedWaitUntil,
    };
  }

  /**
   * Check if rate limit is currently being enforced
   */
  public isLimited(): boolean {
    return this.forcedWaitUntil !== null && Date.now() < this.forcedWaitUntil;
  }

  /**
   * Reset limiter state (useful for testing or recovery)
   */
  public reset(): void {
    this.tokens = this.config.maxTokens;
    this.lastRefill = Date.now();
    this.forcedWaitUntil = null;
    this.waitQueue.forEach(entry => entry.resolve());
    this.waitQueue = [];
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000; // seconds
    const tokensToAdd = elapsed * this.config.refillRate;
    
    this.tokens = Math.min(this.config.maxTokens, this.tokens + tokensToAdd);
    this.lastRefill = now;
    
    rateLimitTokensGauge.set({ bucket: this.config.name }, this.tokens);
  }

  private processQueue(): void {
    while (this.waitQueue.length > 0 && this.tokens >= 1) {
      const entry = this.waitQueue.shift();
      if (entry) {
        this.tokens -= 1;
        entry.resolve();
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

/**
 * Coinbase-specific rate limiter with multiple buckets
 */
export class CoinbaseRateLimiter {
  private global: TokenBucketRateLimiter;
  private orders: TokenBucketRateLimiter;
  private public_: TokenBucketRateLimiter;

  constructor(config?: {
    globalMaxTokens?: number;
    globalRefillRate?: number;
    ordersMaxTokens?: number;
    ordersRefillRate?: number;
    publicMaxTokens?: number;
    publicRefillRate?: number;
  }) {
    // Global limiter for all authenticated requests
    this.global = new TokenBucketRateLimiter({
      maxTokens: config?.globalMaxTokens ?? 15,
      refillRate: config?.globalRefillRate ?? 10,
      minInterval: 50, // 50ms between requests minimum
      name: 'global',
    });

    // Orders limiter (more restrictive)
    this.orders = new TokenBucketRateLimiter({
      maxTokens: config?.ordersMaxTokens ?? 5,
      refillRate: config?.ordersRefillRate ?? 5,
      minInterval: 100, // 100ms between order requests
      name: 'orders',
    });

    // Public endpoints limiter
    this.public_ = new TokenBucketRateLimiter({
      maxTokens: config?.publicMaxTokens ?? 10,
      refillRate: config?.publicRefillRate ?? 8,
      minInterval: 50,
      name: 'public',
    });
  }

  /**
   * Acquire token for a route
   * @param route The API route (e.g., '/orders', '/accounts')
   * @param priority Lower = higher priority
   */
  public async acquire(route: string, priority: number = 1): Promise<void> {
    const isPublic = this.isPublicRoute(route);
    const isOrderRoute = this.isOrderRoute(route);

    if (isPublic) {
      await this.public_.acquire(priority);
    } else {
      // Authenticated requests go through global limiter
      await this.global.acquire(priority);
      
      // Order routes also go through orders limiter
      if (isOrderRoute) {
        await this.orders.acquire(priority);
      }
    }
  }

  /**
   * Release token for a route
   */
  public release(route: string): void {
    const isPublic = this.isPublicRoute(route);
    const isOrderRoute = this.isOrderRoute(route);

    if (isPublic) {
      this.public_.release();
    } else {
      this.global.release();
      if (isOrderRoute) {
        this.orders.release();
      }
    }
  }

  /**
   * Force wait on all limiters (called on 429)
   */
  public forceWait(durationMs: number): void {
    this.global.forceWait(durationMs);
    this.orders.forceWait(durationMs);
    this.public_.forceWait(durationMs);
  }

  /**
   * Check if any limiter is enforcing a wait
   */
  public isLimited(): boolean {
    return this.global.isLimited() || this.orders.isLimited() || this.public_.isLimited();
  }

  /**
   * Get state of all limiters
   */
  public getState(): {
    global: RateLimiterState;
    orders: RateLimiterState;
    public: RateLimiterState;
    limited: boolean;
  } {
    return {
      global: this.global.getState(),
      orders: this.orders.getState(),
      public: this.public_.getState(),
      limited: this.isLimited(),
    };
  }

  /**
   * Reset all limiters
   */
  public reset(): void {
    this.global.reset();
    this.orders.reset();
    this.public_.reset();
  }

  private isPublicRoute(route: string): boolean {
    // Public routes don't require authentication
    const publicPrefixes = ['/products', '/currencies', '/time'];
    return publicPrefixes.some(prefix => route.startsWith(prefix));
  }

  private isOrderRoute(route: string): boolean {
    return route.startsWith('/orders') || route.includes('/orders/');
  }
}

// Default singleton instance
let defaultLimiter: CoinbaseRateLimiter | null = null;

export function getDefaultRateLimiter(): CoinbaseRateLimiter {
  if (!defaultLimiter) {
    defaultLimiter = new CoinbaseRateLimiter();
  }
  return defaultLimiter;
}

export function resetDefaultRateLimiter(): void {
  defaultLimiter = null;
}
