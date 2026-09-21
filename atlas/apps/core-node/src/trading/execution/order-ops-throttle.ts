/**
 * Order-operation throttle — card SH-QMAKER-CFM-PAPER-v0 blocker 2.
 *
 * The desk's failure mode for a queue-aware maker is the cancel/replace
 * storm: REST 429s (Advanced Trade private rps is not cleanly published —
 * "handle 429, do not copy Exchange 15 rps as gospel") and WS disconnects
 * (~8 msg/s/IP caution). This throttle sits in front of order MUTATIONS
 * (place / edit / cancel) and gives the harness:
 *
 *   1. a token-bucket budget (`maxOpsPerSec`, `burst`) so re-quotes are paced;
 *   2. a 429 cooldown: `observeError()` on a rate-limit error opens a window of
 *      `Retry-After` (when the venue said so) or an exponential backoff with
 *      jitter that doubles on consecutive 429s and resets on the next success;
 *   3. counters for the card metrics (edit count, 429 count, waits).
 *
 * The throttle never drops or reorders operations — `acquire()` resolves once
 * the budget allows — so exits are delayed at worst, never lost. Callers that
 * must not wait (forced flatten) should simply not route through it.
 *
 * Pure timing dependencies (`now`, `sleep`) are injectable for tests.
 */

import { EventEmitter } from 'events';

export type OrderOpKind = 'place' | 'edit' | 'cancel';

export interface OrderOpsThrottleConfig {
  /** Sustained order-mutation budget per second (token refill rate). */
  maxOpsPerSec: number;
  /** Bucket capacity (default: `ceil(maxOpsPerSec)`, i.e. ~1 s of burst). */
  burst?: number;
  /** First 429 backoff when no Retry-After is given (default 1 000 ms). */
  backoffBaseMs?: number;
  /** Ceiling for the exponential backoff (default 30 000 ms). */
  backoffMaxMs?: number;
  /** Jitter as a fraction of the backoff (default 0.2 → ±20 %). */
  jitterRatio?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

export interface OrderOpsThrottleStats {
  places: number;
  edits: number;
  cancels: number;
  /** Rate-limit (429) errors observed. */
  rateLimited429: number;
  /** Acquires that had to wait (budget or cooldown). */
  waits: number;
  /** Consecutive 429s since the last success (drives the backoff exponent). */
  consecutive429: number;
  /** Epoch ms until which order ops are held back, or null. */
  cooldownUntil: number | null;
  /** Tokens currently available. */
  tokens: number;
}

/** Structural view of the errors the Coinbase clients throw on HTTP 429. */
interface RateLimitErrorLike {
  kind?: string;
  httpStatus?: number;
  retryAfterMs?: number;
}

/** True when `error` is a venue rate-limit (HTTP 429) error. */
export function isRateLimitErrorLike(error: unknown): error is RateLimitErrorLike {
  if (!error || typeof error !== 'object') return false;
  const e = error as RateLimitErrorLike;
  return e.kind === 'rate_limit' || e.httpStatus === 429;
}

export class OrderOpsThrottle extends EventEmitter {
  private readonly maxOpsPerSec: number;
  private readonly burst: number;
  private readonly backoffBaseMs: number;
  private readonly backoffMaxMs: number;
  private readonly jitterRatio: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;

  private tokens: number;
  private lastRefill: number;
  private cooldownUntil: number | null = null;
  private consecutive429 = 0;
  private counts = { places: 0, edits: 0, cancels: 0, rateLimited429: 0, waits: 0 };

  constructor(config: OrderOpsThrottleConfig) {
    super();
    if (!Number.isFinite(config.maxOpsPerSec) || config.maxOpsPerSec <= 0) {
      throw new Error(`OrderOpsThrottle: maxOpsPerSec must be > 0, got ${config.maxOpsPerSec}`);
    }
    this.maxOpsPerSec = config.maxOpsPerSec;
    this.burst = Math.max(1, config.burst ?? Math.ceil(config.maxOpsPerSec));
    this.backoffBaseMs = config.backoffBaseMs ?? 1_000;
    this.backoffMaxMs = config.backoffMaxMs ?? 30_000;
    this.jitterRatio = config.jitterRatio ?? 0.2;
    this.now = config.now ?? (() => Date.now());
    this.sleep = config.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.random = config.random ?? Math.random;
    this.tokens = this.burst;
    this.lastRefill = this.now();
  }

  /**
   * Wait until one order mutation of `kind` may be sent, then consume a token.
   * Waits first for any 429 cooldown, then for the token bucket.
   */
  public async acquire(kind: OrderOpKind): Promise<void> {
    let waited = false;
    for (;;) {
      const now = this.now();
      if (this.cooldownUntil !== null && now < this.cooldownUntil) {
        waited = true;
        await this.sleep(this.cooldownUntil - now);
        continue;
      }
      this.refill(now);
      if (this.tokens >= 1) {
        this.tokens -= 1;
        break;
      }
      waited = true;
      const deficitMs = Math.ceil(((1 - this.tokens) / this.maxOpsPerSec) * 1000);
      await this.sleep(Math.max(1, deficitMs));
    }
    if (waited) this.counts.waits += 1;
    if (kind === 'place') this.counts.places += 1;
    else if (kind === 'edit') this.counts.edits += 1;
    else this.counts.cancels += 1;
  }

  /**
   * Record the outcome of an order mutation. A rate-limit error opens (or
   * extends) the cooldown; any other outcome resets the consecutive-429 streak.
   *
   * @returns True when the error was a 429 and a cooldown was applied.
   */
  public observeError(error: unknown): boolean {
    if (!isRateLimitErrorLike(error)) {
      return false;
    }
    this.onRateLimited(error.retryAfterMs);
    return true;
  }

  /** Record a successful order mutation (resets the 429 backoff streak). */
  public observeSuccess(): void {
    this.consecutive429 = 0;
  }

  /**
   * Open a cooldown after a venue 429. `retryAfterMs` (from `Retry-After`)
   * wins when present; otherwise exponential backoff with jitter, doubling per
   * consecutive 429 and capped at `backoffMaxMs`.
   */
  public onRateLimited(retryAfterMs?: number): void {
    this.counts.rateLimited429 += 1;
    this.consecutive429 += 1;
    const exponent = Math.min(this.consecutive429 - 1, 16);
    const backoff = Math.min(this.backoffBaseMs * 2 ** exponent, this.backoffMaxMs);
    const jitter = backoff * this.jitterRatio * (this.random() * 2 - 1);
    const waitMs = Math.max(
      0,
      retryAfterMs !== undefined && Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? retryAfterMs : Math.round(backoff + jitter),
    );
    const until = this.now() + waitMs;
    this.cooldownUntil = this.cooldownUntil === null ? until : Math.max(this.cooldownUntil, until);
    this.emit('rate_limited', { waitMs, until: this.cooldownUntil, consecutive429: this.consecutive429 });
  }

  /** True while a 429 cooldown is holding order ops back. */
  public isCoolingDown(): boolean {
    return this.cooldownUntil !== null && this.now() < this.cooldownUntil;
  }

  /** Counters + current state for status / metrics. */
  public getStats(): OrderOpsThrottleStats {
    this.refill(this.now());
    return {
      ...this.counts,
      consecutive429: this.consecutive429,
      cooldownUntil: this.isCoolingDown() ? this.cooldownUntil : null,
      tokens: this.tokens,
    };
  }

  private refill(now: number): void {
    const elapsedSec = Math.max(0, now - this.lastRefill) / 1000;
    this.tokens = Math.min(this.burst, this.tokens + elapsedSec * this.maxOpsPerSec);
    this.lastRefill = now;
  }
}
