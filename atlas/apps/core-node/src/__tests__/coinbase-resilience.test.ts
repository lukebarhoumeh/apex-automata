/**
 * Coinbase Resilience Tests
 * 
 * Tests for:
 * - REST retry policy
 * - Rate limiter
 * - Circuit breaker
 * - Reconciler idempotency
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { 
  TokenBucketRateLimiter, 
  CoinbaseRateLimiter 
} from '../exchanges/coinbase/http/rate-limiter';
import { 
  CoinbaseApiError, 
  CoinbaseNetworkError,
  isRetryableError,
  isBusinessError,
  isRateLimitError,
} from '../exchanges/coinbase/http/errors';
import { 
  ResilientHttpClient, 
  DEFAULT_COINBASE_HTTP_CONFIG 
} from '../exchanges/coinbase/http/resilient-http';
import { 
  CoinbaseReconciler, 
  DEFAULT_RECONCILER_CONFIG 
} from '../exchanges/coinbase/reconciliation/reconciler';
import { Logger } from '../core/logger';

// Mock logger
const mockLogger: Logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as any;

describe('CoinbaseApiError', () => {
  describe('Error Classification', () => {
    it('should classify 429 as rate_limit and retryable', () => {
      const error = CoinbaseApiError.fromResponse({
        status: 429,
        data: { message: 'Rate limited' },
        headers: { 'retry-after': '60' },
      });

      expect(error.kind).toBe('rate_limit');
      expect(error.retryable).toBe(true);
      expect(error.retryAfterMs).toBe(60000);
    });

    it('should classify 500 as server error and retryable', () => {
      const error = CoinbaseApiError.fromResponse({
        status: 500,
        data: { message: 'Internal server error' },
      });

      expect(error.kind).toBe('server');
      expect(error.retryable).toBe(true);
    });

    it('should classify 401 as auth error and NOT retryable', () => {
      const error = CoinbaseApiError.fromResponse({
        status: 401,
        data: { message: 'Invalid API key' },
      });

      expect(error.kind).toBe('auth');
      expect(error.retryable).toBe(false);
    });

    it('should classify post-only rejection as NOT retryable', () => {
      const error = CoinbaseApiError.fromResponse({
        status: 400,
        data: { message: 'Post-only order would have crossed' },
      });

      expect(error.kind).toBe('post_only');
      expect(error.retryable).toBe(false);
      expect(isBusinessError(error)).toBe(true);
    });

    it('should classify insufficient funds as NOT retryable', () => {
      const error = CoinbaseApiError.fromResponse({
        status: 400,
        data: { message: 'Insufficient funds' },
      });

      expect(error.kind).toBe('insufficient_funds');
      expect(error.retryable).toBe(false);
      expect(isBusinessError(error)).toBe(true);
    });
  });

  describe('Error Helpers', () => {
    it('isRetryableError should return true for network errors', () => {
      const error = new CoinbaseNetworkError({
        kind: 'timeout',
        message: 'Request timeout',
      });

      expect(isRetryableError(error)).toBe(true);
    });

    it('isRateLimitError should identify rate limit errors', () => {
      const rateError = CoinbaseApiError.fromResponse({
        status: 429,
        data: {},
      });

      const serverError = CoinbaseApiError.fromResponse({
        status: 500,
        data: {},
      });

      expect(isRateLimitError(rateError)).toBe(true);
      expect(isRateLimitError(serverError)).toBe(false);
    });
  });
});

describe('TokenBucketRateLimiter', () => {
  let limiter: TokenBucketRateLimiter;

  beforeEach(() => {
    vi.useFakeTimers();
    limiter = new TokenBucketRateLimiter({
      maxTokens: 5,
      refillRate: 1, // 1 token per second
      minInterval: 100,
      name: 'test',
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should allow immediate requests when tokens available', async () => {
    const start = Date.now();
    await limiter.acquire();
    const duration = Date.now() - start;

    expect(duration).toBeLessThan(200); // Should be nearly instant
    expect(limiter.getState().tokens).toBeLessThan(5);
  });

  it('should not exceed configured rate', async () => {
    // Exhaust all tokens
    for (let i = 0; i < 5; i++) {
      await limiter.acquire();
      limiter.release();
    }

    // Next acquire should wait
    const acquirePromise = limiter.acquire();
    
    // Advance time to allow token refill
    vi.advanceTimersByTime(1000);
    
    await acquirePromise;
    expect(limiter.getState().tokens).toBeLessThan(5);
  });

  it('should enforce forced wait on rate limit', async () => {
    limiter.forceWait(5000);
    
    expect(limiter.isLimited()).toBe(true);
    expect(limiter.getState().forcedWaitUntil).not.toBeNull();
  });

  it('should track wait statistics', async () => {
    // Force a wait scenario
    limiter.forceWait(100);
    
    const acquirePromise = limiter.acquire();
    vi.advanceTimersByTime(100);
    await acquirePromise;
    
    const state = limiter.getState();
    expect(state.totalWaits).toBeGreaterThan(0);
  });

  it('should reset properly', () => {
    limiter.forceWait(5000);
    expect(limiter.isLimited()).toBe(true);
    
    limiter.reset();
    
    expect(limiter.isLimited()).toBe(false);
    expect(limiter.getState().tokens).toBe(5);
  });
});

describe('CoinbaseRateLimiter', () => {
  let limiter: CoinbaseRateLimiter;

  beforeEach(() => {
    limiter = new CoinbaseRateLimiter();
  });

  it('should identify public routes correctly', async () => {
    // Public routes should use public limiter
    await limiter.acquire('/products', 1);
    limiter.release('/products');
    
    const state = limiter.getState();
    expect(state.public.tokens).toBeLessThan(10);
  });

  it('should apply stricter limits to order routes', async () => {
    await limiter.acquire('/orders', 1);
    limiter.release('/orders');
    
    const state = limiter.getState();
    // Order routes go through both global and orders limiter
    expect(state.orders.tokens).toBeLessThan(5);
    expect(state.global.tokens).toBeLessThan(15);
  });

  it('should force wait on all limiters when rate limited', () => {
    limiter.forceWait(5000);
    
    expect(limiter.isLimited()).toBe(true);
    
    const state = limiter.getState();
    expect(state.global.forcedWaitUntil).not.toBeNull();
    expect(state.orders.forcedWaitUntil).not.toBeNull();
    expect(state.public.forcedWaitUntil).not.toBeNull();
  });
});

describe('ResilientHttpClient', () => {
  let client: ResilientHttpClient;

  beforeEach(() => {
    vi.useFakeTimers({ advanceTimers: true });
    
    client = new ResilientHttpClient({
      ...DEFAULT_COINBASE_HTTP_CONFIG,
      baseUrl: 'https://api.exchange.coinbase.com',
      logger: mockLogger,
      circuitBreaker: {
        failureThreshold: 3,
        resetTimeoutMs: 5000,
        successThreshold: 2,
      },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('Circuit Breaker', () => {
    it('should start with closed circuit', () => {
      expect(client.isCircuitOpen()).toBe(false);
      expect(client.getCircuitState().state).toBe('closed');
    });

    it('should track consecutive failures', () => {
      // Record failures (simulated)
      for (let i = 0; i < 2; i++) {
        (client as any).recordFailure(new Error('Test failure'));
      }

      const state = client.getCircuitState();
      expect(state.consecutiveFailures).toBe(2);
      expect(state.state).toBe('closed'); // Not yet opened
    });

    it('should open circuit after threshold failures', () => {
      // Record enough failures to trip the circuit
      for (let i = 0; i < 3; i++) {
        (client as any).recordFailure(new Error('Test failure'));
      }

      expect(client.isCircuitOpen()).toBe(true);
      expect(client.getCircuitState().state).toBe('open');
    });

    it('should reset failures on success', () => {
      // Add some failures
      (client as any).recordFailure(new Error('Test failure'));
      (client as any).recordFailure(new Error('Test failure'));
      
      expect(client.getCircuitState().consecutiveFailures).toBe(2);
      
      // Record success
      (client as any).recordSuccess();
      
      expect(client.getCircuitState().consecutiveFailures).toBe(0);
    });

    it('should allow force close', () => {
      // Open circuit
      for (let i = 0; i < 3; i++) {
        (client as any).recordFailure(new Error('Test failure'));
      }
      
      expect(client.isCircuitOpen()).toBe(true);
      
      // Force close
      client.forceCloseCircuit();
      
      expect(client.isCircuitOpen()).toBe(false);
      expect(client.getCircuitState().consecutiveFailures).toBe(0);
    });
  });

  describe('Health API', () => {
    it('should return comprehensive health status', () => {
      const health = client.getHealth();
      
      expect(health).toHaveProperty('circuitState');
      expect(health).toHaveProperty('circuitOpen');
      expect(health).toHaveProperty('rateLimited');
      expect(health).toHaveProperty('consecutiveFailures');
      expect(health).toHaveProperty('lastFailureAt');
    });
  });
});

describe('CoinbaseReconciler', () => {
  let reconciler: CoinbaseReconciler;
  let mockRestClient: any;
  let mockOrderManager: any;

  beforeEach(() => {
    vi.useFakeTimers();
    
    mockRestClient = {
      getOrders: vi.fn().mockResolvedValue([]),
      getOrder: vi.fn().mockResolvedValue({ id: 'order-1', status: 'done' }),
      getFills: vi.fn().mockResolvedValue([]),
    };

    mockOrderManager = {
      getActiveOrders: vi.fn().mockReturnValue([]),
      getOrderByExchangeOrderId: vi.fn().mockReturnValue(undefined),
    };

    reconciler = new CoinbaseReconciler(
      { ...DEFAULT_RECONCILER_CONFIG, autoReconcile: false },
      mockLogger,
      mockRestClient,
      mockOrderManager
    );
  });

  afterEach(() => {
    reconciler.stop();
    vi.useRealTimers();
  });

  describe('Fill Deduplication', () => {
    it('should deduplicate fills by trade_id', async () => {
      const fill = {
        trade_id: 'fill-123',
        order_id: 'order-1',
        product_id: 'BTC-USD',
        side: 'buy',
        size: '0.1',
        price: '50000',
        fee: '0.5',
        created_at: new Date().toISOString(),
      };

      mockRestClient.getFills.mockResolvedValue([fill, fill]); // Same fill twice

      reconciler.start();
      const newFills = await reconciler.reconcileFills();

      // Should only count as 1 new fill
      expect(newFills).toBe(1);
      expect(reconciler.hasFillBeenSeen('fill-123')).toBe(true);
    });

    it('should not reprocess seen fills', async () => {
      const fill = {
        trade_id: 'fill-456',
        order_id: 'order-1',
        product_id: 'BTC-USD',
        side: 'buy',
        size: '0.1',
        price: '50000',
        fee: '0.5',
        created_at: new Date().toISOString(),
      };

      mockRestClient.getFills.mockResolvedValue([fill]);

      reconciler.start();
      
      // First reconciliation
      const first = await reconciler.reconcileFills();
      expect(first).toBe(1);

      // Second reconciliation with same fill
      const second = await reconciler.reconcileFills();
      expect(second).toBe(0);
    });

    it('should emit fill:ingested event with isNew flag', async () => {
      const fill = {
        trade_id: 'fill-789',
        order_id: 'order-1',
        product_id: 'BTC-USD',
        side: 'buy',
        size: '0.1',
        price: '50000',
        fee: '0.5',
        created_at: new Date().toISOString(),
      };

      mockRestClient.getFills.mockResolvedValue([fill]);

      const fillHandler = vi.fn();
      reconciler.on('fill:ingested', fillHandler);
      reconciler.start();

      await reconciler.reconcileFills();

      expect(fillHandler).toHaveBeenCalledWith(fill, true); // isNew = true

      // Second time
      await reconciler.reconcileFills();
      
      // Should be called again but with isNew = false
      expect(fillHandler).toHaveBeenLastCalledWith(fill, false);
    });
  });

  describe('Order Reconciliation', () => {
    it('should detect orders that disappeared from open set', async () => {
      const localOrder = {
        id: 'local-1',
        exchangeOrderId: 'exchange-1',
        status: 'open',
      };

      mockOrderManager.getActiveOrders.mockReturnValue([localOrder]);
      mockRestClient.getOrders.mockResolvedValue([]); // Order no longer open
      mockRestClient.getOrder.mockResolvedValue({ id: 'exchange-1', status: 'done' });

      const stateChangeHandler = vi.fn();
      reconciler.on('order:state_changed', stateChangeHandler);
      reconciler.start();

      await reconciler.reconcileOrders();

      expect(stateChangeHandler).toHaveBeenCalledWith(
        'exchange-1',
        'open',
        'done',
        expect.any(Object)
      );
    });

    it('should handle orders still in open set correctly', async () => {
      const localOrder = {
        id: 'local-1',
        exchangeOrderId: 'exchange-1',
        status: 'open',
      };

      mockOrderManager.getActiveOrders.mockReturnValue([localOrder]);
      mockRestClient.getOrders.mockResolvedValue([{ id: 'exchange-1', status: 'open' }]);

      const stateChangeHandler = vi.fn();
      reconciler.on('order:state_changed', stateChangeHandler);
      reconciler.start();

      const changes = await reconciler.reconcileOrders();

      expect(changes).toBe(0);
      expect(stateChangeHandler).not.toHaveBeenCalled();
    });
  });

  describe('Degraded Mode', () => {
    it('should enter degraded mode after consecutive errors', async () => {
      mockRestClient.getOrders.mockRejectedValue(new Error('API Error'));

      const degradedHandler = vi.fn();
      reconciler.on('degraded', degradedHandler);
      reconciler.start();

      // Trigger multiple failures
      for (let i = 0; i < 3; i++) {
        try {
          await reconciler.reconcileOrders();
        } catch (e) {
          // Expected
        }
      }

      expect(reconciler.isDegraded()).toBe(true);
      expect(degradedHandler).toHaveBeenCalled();
    });

    it('should recover from degraded mode on success', async () => {
      mockRestClient.getOrders.mockRejectedValue(new Error('API Error'));

      reconciler.start();

      // Trigger failures
      for (let i = 0; i < 3; i++) {
        try {
          await reconciler.reconcileOrders();
        } catch (e) {
          // Expected
        }
      }

      expect(reconciler.isDegraded()).toBe(true);

      // Now succeed
      mockRestClient.getOrders.mockResolvedValue([]);
      mockRestClient.getFills.mockResolvedValue([]);

      const recoveredHandler = vi.fn();
      reconciler.on('recovered', recoveredHandler);

      await reconciler.reconcileOrders();

      expect(reconciler.isDegraded()).toBe(false);
      expect(recoveredHandler).toHaveBeenCalled();
    });
  });

  describe('State API', () => {
    it('should return comprehensive state', () => {
      reconciler.start();
      const state = reconciler.getState();

      expect(state).toHaveProperty('running');
      expect(state).toHaveProperty('lastOrderReconcileAt');
      expect(state).toHaveProperty('lastFillReconcileAt');
      expect(state).toHaveProperty('seenFillIds');
      expect(state).toHaveProperty('degraded');
    });
  });
});

describe('Retry Policy', () => {
  it('should calculate exponential backoff correctly', () => {
    const policy = DEFAULT_COINBASE_HTTP_CONFIG.retryPolicy;
    
    // First retry: 1000ms base
    const delay1 = policy.initialDelayMs * Math.pow(policy.backoffMultiplier, 0);
    expect(delay1).toBe(1000);
    
    // Second retry: 2000ms base
    const delay2 = policy.initialDelayMs * Math.pow(policy.backoffMultiplier, 1);
    expect(delay2).toBe(2000);
    
    // Third retry: 4000ms base
    const delay3 = policy.initialDelayMs * Math.pow(policy.backoffMultiplier, 2);
    expect(delay3).toBe(4000);
    
    // Should cap at maxDelayMs
    const delay10 = Math.min(
      policy.initialDelayMs * Math.pow(policy.backoffMultiplier, 9),
      policy.maxDelayMs
    );
    expect(delay10).toBe(policy.maxDelayMs);
  });
});
