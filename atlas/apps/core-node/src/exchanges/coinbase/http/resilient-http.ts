/**
 * Resilient HTTP Layer for Coinbase REST API
 * 
 * Features:
 * - Hard timeouts with AbortController
 * - Automatic retries with exponential backoff + jitter
 * - Rate limit aware throttling
 * - Circuit breaker for graceful degradation
 * - Structured error handling
 */

import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios';
import { EventEmitter } from 'events';
import { Counter, Gauge, Histogram } from 'prom-client';
import { Logger } from '../../../core/logger';
import { 
  CoinbaseApiError, 
  CoinbaseNetworkError, 
  CircuitOpenError,
  isRetryableError,
  isRateLimitError,
} from './errors';
import { CoinbaseRateLimiter, getDefaultRateLimiter } from './rate-limiter';

// Prometheus metrics
const requestsTotal = new Counter({
  name: 'coinbase_rest_requests_total',
  help: 'Total number of Coinbase REST requests',
  labelNames: ['route', 'method', 'status'],
});

const retriesTotal = new Counter({
  name: 'coinbase_rest_retries_total',
  help: 'Total number of Coinbase REST retries',
  labelNames: ['route', 'reason'],
});

const circuitOpenGauge = new Gauge({
  name: 'coinbase_rest_circuit_open',
  help: 'Whether the REST circuit breaker is open (1) or closed (0)',
});

const requestDuration = new Histogram({
  name: 'coinbase_rest_request_duration_seconds',
  help: 'Duration of Coinbase REST requests',
  labelNames: ['route', 'method'],
  buckets: [0.1, 0.25, 0.5, 1, 2.5, 5, 10],
});

/**
 * Retry policy configuration
 */
export interface RetryPolicy {
  /** Maximum number of retries */
  maxRetries: number;
  /** Initial delay before first retry (ms) */
  initialDelayMs: number;
  /** Maximum delay between retries (ms) */
  maxDelayMs: number;
  /** Backoff multiplier */
  backoffMultiplier: number;
  /** Maximum jitter to add (ms) */
  jitterMs: number;
}

/**
 * Circuit breaker configuration
 */
export interface CircuitBreakerConfig {
  /** Number of failures before opening circuit */
  failureThreshold: number;
  /** Time to keep circuit open before half-open probe (ms) */
  resetTimeoutMs: number;
  /** Number of successes in half-open state to close circuit */
  successThreshold: number;
}

/**
 * Resilient HTTP client configuration
 */
export interface ResilientHttpConfig {
  /** Base URL for requests */
  baseUrl: string;
  /** Request timeout (ms) */
  timeoutMs: number;
  /** Retry policy */
  retryPolicy: RetryPolicy;
  /** Circuit breaker config */
  circuitBreaker: CircuitBreakerConfig;
  /** Logger instance */
  logger: Logger;
  /** Rate limiter instance (optional, uses default if not provided) */
  rateLimiter?: CoinbaseRateLimiter;
  /** Allow reconciliation requests when circuit is open */
  allowReconciliationWhenOpen?: boolean;
}

/**
 * Circuit breaker states
 */
type CircuitState = 'closed' | 'open' | 'half-open';

/**
 * Request options
 */
export interface RequestOptions {
  /** Request priority (0 = highest, used for reconciliation) */
  priority?: number;
  /** Skip rate limiter (use with caution) */
  skipRateLimit?: boolean;
  /** Mark as reconciliation request (allowed when circuit half-open) */
  isReconciliation?: boolean;
  /** Custom timeout override */
  timeoutMs?: number;
  /** Request ID for correlation */
  requestId?: string;
}

/**
 * Resilient HTTP client with retry, rate limiting, and circuit breaker
 */
export class ResilientHttpClient extends EventEmitter {
  private config: ResilientHttpConfig;
  private client: AxiosInstance;
  private rateLimiter: CoinbaseRateLimiter;
  private logger: Logger;

  // Circuit breaker state
  private circuitState: CircuitState = 'closed';
  private consecutiveFailures = 0;
  private consecutiveSuccesses = 0;
  private circuitOpenedAt: number | null = null;
  private lastFailure: { error: any; timestamp: number } | null = null;

  constructor(config: ResilientHttpConfig) {
    super();
    this.config = config;
    this.logger = config.logger;
    this.rateLimiter = config.rateLimiter ?? getDefaultRateLimiter();

    this.client = axios.create({
      baseURL: config.baseUrl,
      timeout: config.timeoutMs,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'AtlasBot/1.0',
      },
    });
  }

  /**
   * Make a GET request with resilience
   */
  public async get<T = any>(
    route: string,
    config?: AxiosRequestConfig,
    options?: RequestOptions
  ): Promise<T> {
    return this.request<T>('GET', route, config, options);
  }

  /**
   * Make a POST request with resilience
   */
  public async post<T = any>(
    route: string,
    data?: any,
    config?: AxiosRequestConfig,
    options?: RequestOptions
  ): Promise<T> {
    return this.request<T>('POST', route, { ...config, data }, options);
  }

  /**
   * Make a DELETE request with resilience
   */
  public async delete<T = any>(
    route: string,
    config?: AxiosRequestConfig,
    options?: RequestOptions
  ): Promise<T> {
    return this.request<T>('DELETE', route, config, options);
  }

  /**
   * Make a PUT request with resilience
   */
  public async put<T = any>(
    route: string,
    data?: any,
    config?: AxiosRequestConfig,
    options?: RequestOptions
  ): Promise<T> {
    return this.request<T>('PUT', route, { ...config, data }, options);
  }

  /**
   * Core request method with all resilience features
   */
  private async request<T>(
    method: string,
    route: string,
    config?: AxiosRequestConfig,
    options: RequestOptions = {}
  ): Promise<T> {
    const {
      priority = 1,
      skipRateLimit = false,
      isReconciliation = false,
      timeoutMs = this.config.timeoutMs,
      requestId = this.generateRequestId(),
    } = options;

    // Check circuit breaker
    this.checkCircuit(route, isReconciliation);

    let lastError: any = null;
    let attempt = 0;

    while (attempt <= this.config.retryPolicy.maxRetries) {
      try {
        // Acquire rate limit token
        if (!skipRateLimit) {
          await this.rateLimiter.acquire(route, priority);
        }

        // Make request with abort controller for timeout
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

        const startTime = Date.now();

        try {
          const response = await this.client.request<T>({
            method,
            url: route,
            ...config,
            signal: controller.signal,
            headers: {
              ...config?.headers,
              'X-Request-ID': requestId,
            },
          });

          // Record metrics
          const duration = (Date.now() - startTime) / 1000;
          requestDuration.observe({ route: this.normalizeRoute(route), method }, duration);
          requestsTotal.inc({ route: this.normalizeRoute(route), method, status: String(response.status) });

          // Release rate limit token
          if (!skipRateLimit) {
            this.rateLimiter.release(route);
          }

          // Success - reset circuit breaker
          this.recordSuccess();

          return response.data;
        } finally {
          clearTimeout(timeoutId);
        }
      } catch (error: any) {
        attempt++;
        lastError = this.transformError(error, route, method, requestId);

        // Release rate limit token on error
        if (!skipRateLimit) {
          this.rateLimiter.release(route);
        }

        // Record failure metrics
        requestsTotal.inc({
          route: this.normalizeRoute(route),
          method,
          status: lastError.httpStatus || 'network_error',
        });

        // Handle rate limit
        if (isRateLimitError(lastError)) {
          const waitMs = lastError.retryAfterMs || 60000;
          this.rateLimiter.forceWait(waitMs);
          
          this.logger.warn('rate_limited_waiting', {
            route,
            method,
            waitMs,
            requestId,
          });

          // Wait and retry
          await this.sleep(waitMs);
          continue;
        }

        // Record circuit breaker failure
        this.recordFailure(lastError);

        // Check if retryable
        if (!isRetryableError(lastError)) {
          this.logger.error('rest_call_failed', {
            route,
            method,
            requestId,
            error: lastError.toJSON?.() ?? String(lastError),
            retryable: false,
          });
          throw lastError;
        }

        // Check if max retries reached
        if (attempt > this.config.retryPolicy.maxRetries) {
          this.logger.error('rest_call_failed', {
            route,
            method,
            requestId,
            error: lastError.toJSON?.() ?? String(lastError),
            attempts: attempt,
          });
          throw lastError;
        }

        // Calculate retry delay
        const delay = this.calculateRetryDelay(attempt);
        
        retriesTotal.inc({
          route: this.normalizeRoute(route),
          reason: lastError.kind || 'unknown',
        });

        this.logger.warn('rest_retry_scheduled', {
          route,
          method,
          requestId,
          attempt,
          delayMs: delay,
          reason: lastError.kind || 'unknown',
        });

        await this.sleep(delay);
      }
    }

    throw lastError;
  }

  /**
   * Check circuit breaker state
   */
  private checkCircuit(route: string, isReconciliation: boolean): void {
    if (this.circuitState === 'closed') {
      return;
    }

    if (this.circuitState === 'open') {
      const elapsed = Date.now() - (this.circuitOpenedAt || 0);
      
      // Check if we should transition to half-open
      if (elapsed >= this.config.circuitBreaker.resetTimeoutMs) {
        this.circuitState = 'half-open';
        this.logger.info('Circuit breaker transitioning to half-open', { route });
        circuitOpenGauge.set(0.5);
        return;
      }

      // Allow reconciliation requests at reduced priority when circuit is open
      if (isReconciliation && this.config.allowReconciliationWhenOpen) {
        return;
      }

      const remainingMs = this.config.circuitBreaker.resetTimeoutMs - elapsed;
      throw new CircuitOpenError({
        message: 'Circuit breaker is open - request blocked',
        route,
        cooldownRemainingMs: remainingMs,
      });
    }

    // Half-open state allows requests through for probing
  }

  /**
   * Record a successful request
   */
  private recordSuccess(): void {
    this.consecutiveFailures = 0;

    if (this.circuitState === 'half-open') {
      this.consecutiveSuccesses++;
      
      if (this.consecutiveSuccesses >= this.config.circuitBreaker.successThreshold) {
        this.circuitState = 'closed';
        this.consecutiveSuccesses = 0;
        this.circuitOpenedAt = null;
        this.lastFailure = null;
        circuitOpenGauge.set(0);
        
        this.logger.info('Circuit breaker closed after successful probes');
        this.emit('circuit:closed');
      }
    }
  }

  /**
   * Record a failed request
   */
  private recordFailure(error: any): void {
    this.consecutiveFailures++;
    this.consecutiveSuccesses = 0;
    this.lastFailure = { error, timestamp: Date.now() };

    if (this.circuitState === 'closed') {
      if (this.consecutiveFailures >= this.config.circuitBreaker.failureThreshold) {
        this.circuitState = 'open';
        this.circuitOpenedAt = Date.now();
        circuitOpenGauge.set(1);
        
        this.logger.error('Circuit breaker opened due to consecutive failures', {
          failures: this.consecutiveFailures,
          lastError: error.toJSON?.() ?? String(error),
        });
        
        this.emit('circuit:opened', { failures: this.consecutiveFailures, error });
      }
    } else if (this.circuitState === 'half-open') {
      // Failed probe - go back to open
      this.circuitState = 'open';
      this.circuitOpenedAt = Date.now();
      circuitOpenGauge.set(1);
      
      this.logger.warn('Circuit breaker re-opened after failed probe');
      this.emit('circuit:opened', { reason: 'failed_probe', error });
    }
  }

  /**
   * Calculate retry delay with exponential backoff and jitter
   */
  private calculateRetryDelay(attempt: number): number {
    const { initialDelayMs, maxDelayMs, backoffMultiplier, jitterMs } = this.config.retryPolicy;
    
    const baseDelay = initialDelayMs * Math.pow(backoffMultiplier, attempt - 1);
    const cappedDelay = Math.min(baseDelay, maxDelayMs);
    const jitter = Math.random() * jitterMs;
    
    return cappedDelay + jitter;
  }

  /**
   * Transform axios error into our error types
   */
  private transformError(
    error: any,
    route: string,
    method: string,
    requestId: string
  ): CoinbaseApiError | CoinbaseNetworkError {
    // Aborted request (timeout)
    if (error.name === 'AbortError' || error.code === 'ECONNABORTED') {
      return new CoinbaseNetworkError({
        kind: 'timeout',
        message: `Request timed out after ${this.config.timeoutMs}ms`,
        originalError: error,
        code: error.code,
        route,
        method,
      });
    }

    // Response error (4xx, 5xx)
    if (error.response) {
      return CoinbaseApiError.fromResponse(
        {
          status: error.response.status,
          data: error.response.data,
          headers: error.response.headers,
        },
        route,
        method
      );
    }

    // Network error (no response)
    return CoinbaseNetworkError.fromAxiosError(error, route, method);
  }

  /**
   * Normalize route for metrics (remove dynamic parts)
   */
  private normalizeRoute(route: string): string {
    // Replace UUIDs and order IDs with placeholder
    return route
      .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '/:id')
      .replace(/\/orders\/[^/]+/, '/orders/:id')
      .replace(/\/accounts\/[^/]+/, '/accounts/:id')
      .replace(/\/products\/[^/]+/, '/products/:id');
  }

  /**
   * Generate a request ID for correlation
   */
  private generateRequestId(): string {
    return `atlas-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // ============ Health & State APIs ============

  /**
   * Get circuit breaker state
   */
  public getCircuitState(): {
    state: CircuitState;
    consecutiveFailures: number;
    consecutiveSuccesses: number;
    openedAt: number | null;
    lastFailure: { error: any; timestamp: number } | null;
  } {
    return {
      state: this.circuitState,
      consecutiveFailures: this.consecutiveFailures,
      consecutiveSuccesses: this.consecutiveSuccesses,
      openedAt: this.circuitOpenedAt,
      lastFailure: this.lastFailure,
    };
  }

  /**
   * Check if circuit is open
   */
  public isCircuitOpen(): boolean {
    return this.circuitState === 'open';
  }

  /**
   * Get rate limiter state
   */
  public getRateLimiterState() {
    return this.rateLimiter.getState();
  }

  /**
   * Check if rate limited
   */
  public isRateLimited(): boolean {
    return this.rateLimiter.isLimited();
  }

  /**
   * Manually close circuit (for recovery)
   */
  public forceCloseCircuit(): void {
    this.circuitState = 'closed';
    this.consecutiveFailures = 0;
    this.consecutiveSuccesses = 0;
    this.circuitOpenedAt = null;
    circuitOpenGauge.set(0);
    this.logger.info('Circuit breaker force closed');
    this.emit('circuit:closed');
  }

  /**
   * Get comprehensive health status
   */
  public getHealth(): {
    circuitState: CircuitState;
    circuitOpen: boolean;
    rateLimited: boolean;
    consecutiveFailures: number;
    lastFailureAt: number | null;
  } {
    return {
      circuitState: this.circuitState,
      circuitOpen: this.circuitState === 'open',
      rateLimited: this.rateLimiter.isLimited(),
      consecutiveFailures: this.consecutiveFailures,
      lastFailureAt: this.lastFailure?.timestamp ?? null,
    };
  }
}

/**
 * Default configuration for Coinbase
 */
export const DEFAULT_COINBASE_HTTP_CONFIG: Omit<ResilientHttpConfig, 'baseUrl' | 'logger'> = {
  timeoutMs: 10000, // 10 second timeout
  retryPolicy: {
    maxRetries: 3,
    initialDelayMs: 1000,
    maxDelayMs: 30000,
    backoffMultiplier: 2,
    jitterMs: 500,
  },
  circuitBreaker: {
    failureThreshold: 5,
    resetTimeoutMs: 30000, // 30 seconds
    successThreshold: 2,
  },
  allowReconciliationWhenOpen: true,
};
