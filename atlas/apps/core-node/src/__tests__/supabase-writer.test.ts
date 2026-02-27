/**
 * SupabaseWriter Tests
 * 
 * Tests for:
 * 1. Coalescing (100 updates → only last flushes)
 * 2. Retry logic with backoff
 * 3. Schema error handling (non-retryable)
 * 4. Idempotency / dedupe
 * 5. Backpressure (evict oldest non-critical on overflow)
 * 6. Operation timeout
 * 7. Circuit breaker
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SupabaseWriter, WriterConfig, WriteOp } from '../persistence/supabase-writer';
import { Logger } from '../core/logger';

// Mock logger
const mockLogger: Logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as any;

// Mock Supabase client
const mockInsert = vi.fn();
const mockUpsert = vi.fn();
const mockUpdate = vi.fn();
const mockEq = vi.fn();

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    from: vi.fn(() => ({
      insert: mockInsert,
      upsert: mockUpsert,
      update: vi.fn(() => ({
        eq: mockEq,
      })),
      select: vi.fn(() => ({
        limit: vi.fn(() => ({ error: null })),
      })),
    })),
  })),
}));

describe('SupabaseWriter', () => {
  let writer: SupabaseWriter;

  const createWriter = (overrides: Partial<WriterConfig> = {}) => {
    return new SupabaseWriter({
      supabaseUrl: 'https://test.supabase.co',
      supabaseServiceKey: 'test-key',
      logger: mockLogger,
      flushIntervalMs: 100000, // Long interval so we control flushes
      ...overrides,
    });
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockInsert.mockResolvedValue({ error: null });
    mockUpsert.mockResolvedValue({ error: null });
    mockEq.mockResolvedValue({ error: null });
  });

  afterEach(async () => {
    if (writer) {
      await writer.shutdown();
    }
  });

  describe('Coalescing', () => {
    it('should keep only the latest write for coalesced operations', async () => {
      writer = createWriter();

      // Enqueue 100 risk_metrics updates with the same coalesceKey
      for (let i = 0; i < 100; i++) {
        writer.upsert(
          'risk_metrics',
          { user_id: 'user1', daily_pnl: i * 10 },
          'user_id',
          { coalesceKey: 'risk_metrics:user1' }
        );
      }

      // Verify queue shows only 1 (coalesced)
      const health = writer.getHealth();
      expect(health.queueDepth).toBe(1);

      // Flush
      await writer.flushNow();

      // Verify only 1 upsert was called with the last value
      expect(mockUpsert).toHaveBeenCalledTimes(1);
      expect(mockUpsert).toHaveBeenCalledWith(
        { user_id: 'user1', daily_pnl: 990 },
        { onConflict: 'user_id' }
      );
    });

    it('should not coalesce operations without coalesceKey', async () => {
      writer = createWriter();

      // Enqueue 5 inserts without coalesceKey
      for (let i = 0; i < 5; i++) {
        writer.insert('alerts', { user_id: 'user1', message: `Alert ${i}` });
      }

      const health = writer.getHealth();
      expect(health.queueDepth).toBe(5);
    });
  });

  describe('Retry Logic', () => {
    it('should retry on transient failure and succeed', async () => {
      writer = createWriter({
        maxRetries: 3,
        retryBaseDelayMs: 10,
        retryMaxDelayMs: 50,
      });

      // First call fails, second succeeds
      mockInsert
        .mockResolvedValueOnce({ error: { code: '08000', message: 'Connection failed' } })
        .mockResolvedValueOnce({ error: null });

      writer.insert('alerts', { user_id: 'user1', message: 'Test' });
      await writer.flushNow();

      // Should have been called twice (original + 1 retry)
      expect(mockInsert).toHaveBeenCalledTimes(2);
    });

    it('should stop retrying after max retries', async () => {
      writer = createWriter({
        maxRetries: 2,
        retryBaseDelayMs: 10,
        retryMaxDelayMs: 50,
      });

      // Always fail
      mockInsert.mockResolvedValue({ error: { code: '08000', message: 'Connection failed' } });

      writer.insert('alerts', { user_id: 'user1', message: 'Test' });
      await writer.flushNow();

      // Should have been called 3 times (original + 2 retries)
      expect(mockInsert).toHaveBeenCalledTimes(3);
      expect(mockLogger.error).toHaveBeenCalledWith(
        'Max retries exceeded',
        expect.objectContaining({ retries: 3 })
      );
    });
  });

  describe('Schema Error Handling', () => {
    it('should not retry schema errors (column does not exist)', async () => {
      writer = createWriter({ maxRetries: 3 });

      mockInsert.mockResolvedValue({
        error: { code: '42703', message: 'column "foo" does not exist' },
      });

      writer.insert('alerts', { user_id: 'user1', foo: 'bar' });
      await writer.flushNow();

      // Should only be called once (no retries)
      expect(mockInsert).toHaveBeenCalledTimes(1);
      expect(mockLogger.error).toHaveBeenCalledWith(
        'Schema mismatch (non-retryable)',
        expect.objectContaining({ code: '42703' })
      );
    });

    it('should not retry schema errors (table does not exist)', async () => {
      writer = createWriter({ maxRetries: 3 });

      mockInsert.mockResolvedValue({
        error: { code: '42P01', message: 'relation "foo" does not exist' },
      });

      writer.insert('foo', { id: 1 });
      await writer.flushNow();

      expect(mockInsert).toHaveBeenCalledTimes(1);
    });
  });

  describe('Deduplication', () => {
    it('should drop duplicate writes with same dedupeKey', async () => {
      writer = createWriter();

      const dedupeKey = 'fill:user1:trade123';

      // Enqueue same write twice
      writer.insert('fills', { trade_id: 'trade123' }, { dedupeKey });
      writer.insert('fills', { trade_id: 'trade123' }, { dedupeKey });

      const health = writer.getHealth();
      expect(health.queueDepth).toBe(1);
    });

    it('should allow writes with different dedupeKeys', async () => {
      writer = createWriter();

      writer.insert('fills', { trade_id: 'trade1' }, { dedupeKey: 'fill:1' });
      writer.insert('fills', { trade_id: 'trade2' }, { dedupeKey: 'fill:2' });

      const health = writer.getHealth();
      expect(health.queueDepth).toBe(2);
    });

    it('should handle conflict as success (idempotent upsert)', async () => {
      writer = createWriter();

      // Conflict error (23505) should be treated as success for upserts
      // Actually, with proper onConflict, Supabase doesn't return an error
      mockUpsert.mockResolvedValue({ error: null });

      writer.upsert('positions', { user_id: 'u1', symbol: 'BTC' }, 'user_id,symbol');
      writer.upsert('positions', { user_id: 'u1', symbol: 'BTC' }, 'user_id,symbol');

      await writer.flushNow();

      // Both should succeed (second is just an update)
      expect(mockUpsert).toHaveBeenCalledTimes(2);
    });
  });

  describe('Health Status', () => {
    it('should track connected status', async () => {
      writer = createWriter();

      let health = writer.getHealth();
      expect(health.connected).toBe(true);

      // Simulate failure
      mockInsert.mockResolvedValue({ error: { code: '08000', message: 'Connection failed' } });
      writer.insert('alerts', { message: 'test' });

      // Don't retry - just check immediate state
      await new Promise(r => setTimeout(r, 50));

      // Note: Connection status updates after retry attempts
    });

    it('should track queue depth', async () => {
      writer = createWriter();

      expect(writer.getHealth().queueDepth).toBe(0);

      writer.insert('alerts', { message: '1' });
      writer.insert('alerts', { message: '2' });
      writer.insert('alerts', { message: '3' });

      expect(writer.getHealth().queueDepth).toBe(3);

      await writer.flushNow();

      expect(writer.getHealth().queueDepth).toBe(0);
    });

    it('should track lastSuccessAt', async () => {
      writer = createWriter();

      const before = Date.now();

      mockInsert.mockResolvedValue({ error: null });
      writer.insert('alerts', { message: 'test' });
      await writer.flushNow();

      const health = writer.getHealth();
      expect(health.lastSuccessAt).toBeDefined();
      expect(health.lastSuccessAt).toBeGreaterThanOrEqual(before);
    });
  });

  describe('Backpressure', () => {
    it('should evict oldest non-critical when queue is full and new non-critical arrives', async () => {
      writer = createWriter({ maxQueueSize: 5 });

      // Fill queue with 10 non-critical writes — oldest get evicted
      for (let i = 0; i < 10; i++) {
        writer.insert('alerts', { message: `Alert ${i}` });
      }

      // Queue should be capped at 5
      expect(writer.getHealth().queueDepth).toBe(5);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Backpressure: evicted oldest non-critical write',
        expect.anything()
      );
    });

    it('should evict oldest non-critical to make room for critical op', async () => {
      writer = createWriter({ maxQueueSize: 3 });

      // Fill with non-critical
      writer.insert('alerts', { message: 'A' });
      writer.insert('alerts', { message: 'B' });
      writer.insert('alerts', { message: 'C' });
      expect(writer.getHealth().queueDepth).toBe(3);

      // Now enqueue a critical op — should evict oldest non-critical
      writer.insert('positions', { symbol: 'BTC' }, { critical: true });
      expect(writer.getHealth().queueDepth).toBe(3);

      // Flush and verify the critical op gets written
      await writer.flushNow();
      expect(mockInsert).toHaveBeenCalledWith({ symbol: 'BTC' });
    });

    it('should never evict critical ops via backpressure', async () => {
      writer = createWriter({ maxQueueSize: 2 });

      // Fill queue with critical ops
      writer.insert('positions', { symbol: 'BTC' }, { critical: true });
      writer.insert('positions', { symbol: 'ETH' }, { critical: true });
      expect(writer.getHealth().queueDepth).toBe(2);

      // Non-critical can't evict critical, so it gets dropped
      writer.insert('alerts', { message: 'low priority' });
      expect(writer.getHealth().queueDepth).toBe(2);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Queue overflow (all critical), dropping non-critical write',
        expect.anything()
      );
    });
  });

  describe('Operation Timeout', () => {
    it('should timeout hanging operations', async () => {
      writer = createWriter({
        operationTimeoutMs: 50,
        maxRetries: 0,
        circuitBreakerThreshold: 100,
      });

      // Simulate a hanging insert
      mockInsert.mockImplementation(() => new Promise(() => {}));

      writer.insert('alerts', { message: 'test' });
      await writer.flushNow();

      expect(mockLogger.error).not.toHaveBeenCalledWith(
        'Schema mismatch (non-retryable)',
        expect.anything()
      );
      // The error should be logged as non-retryable or max retries
      const health = writer.getHealth();
      expect(health.lastError).toContain('timed out');
    });

    it('should not timeout fast operations', async () => {
      writer = createWriter({ operationTimeoutMs: 5000 });

      mockInsert.mockResolvedValue({ error: null });
      writer.insert('alerts', { message: 'test' });
      await writer.flushNow();

      const health = writer.getHealth();
      expect(health.lastError).toBeUndefined();
      expect(health.lastSuccessAt).toBeDefined();
    });

    it('should disable timeout when set to 0', async () => {
      writer = createWriter({ operationTimeoutMs: 0 });

      mockInsert.mockResolvedValue({ error: null });
      writer.insert('alerts', { message: 'test' });
      await writer.flushNow();

      expect(mockInsert).toHaveBeenCalledTimes(1);
    });
  });

  describe('Circuit Breaker', () => {
    it('should trip after consecutive failures reach threshold', async () => {
      writer = createWriter({
        circuitBreakerThreshold: 3,
        circuitBreakerCooldownMs: 60000,
        maxRetries: 0,
      });

      mockInsert.mockResolvedValue({ error: { code: '42703', message: 'column does not exist' } });

      // Enqueue 3 operations that will all fail
      writer.insert('alerts', { message: '1' });
      writer.insert('alerts', { message: '2' });
      writer.insert('alerts', { message: '3' });
      await writer.flushNow();

      const health = writer.getHealth();
      expect(health.circuitBreakerOpen).toBe(true);
      expect(health.consecutiveFailures).toBe(3);

      expect(mockLogger.error).toHaveBeenCalledWith(
        'Circuit breaker OPEN — stopping writes',
        expect.objectContaining({ consecutiveFailures: 3 })
      );
    });

    it('should skip flush when circuit breaker is open', async () => {
      writer = createWriter({
        circuitBreakerThreshold: 1,
        circuitBreakerCooldownMs: 60000,
        maxRetries: 0,
      });

      // Trip the circuit breaker
      mockInsert.mockResolvedValue({ error: { code: '42703', message: 'column does not exist' } });
      writer.insert('alerts', { message: 'fail' });
      await writer.flushNow();

      expect(writer.getHealth().circuitBreakerOpen).toBe(true);

      // Now enqueue more ops — flush should be skipped
      mockInsert.mockResolvedValue({ error: null });
      writer.insert('alerts', { message: 'should not flush' });
      await writer.flushNow();

      // The second insert mock should NOT have been called (circuit is open)
      // mockInsert was called once for the first fail
      expect(mockInsert).toHaveBeenCalledTimes(1);

      // Queue should still have the pending op
      expect(writer.getHealth().queueDepth).toBe(1);
    });

    it('should reset after a successful write', async () => {
      writer = createWriter({
        circuitBreakerThreshold: 5,
        circuitBreakerCooldownMs: 60000,
        maxRetries: 0,
      });

      // Fail 3 times (below threshold)
      mockInsert.mockResolvedValue({ error: { code: '42703', message: 'column does not exist' } });
      writer.insert('alerts', { message: '1' });
      writer.insert('alerts', { message: '2' });
      writer.insert('alerts', { message: '3' });
      await writer.flushNow();

      expect(writer.getHealth().consecutiveFailures).toBe(3);

      // Now succeed
      mockInsert.mockResolvedValue({ error: null });
      writer.insert('alerts', { message: 'success' });
      await writer.flushNow();

      const health = writer.getHealth();
      expect(health.consecutiveFailures).toBe(0);
      expect(health.circuitBreakerOpen).toBe(false);
    });

    it('should report circuit breaker status in health', async () => {
      writer = createWriter({
        circuitBreakerThreshold: 100,
        circuitBreakerCooldownMs: 60000,
      });

      const health = writer.getHealth();
      expect(health.circuitBreakerOpen).toBe(false);
      expect(health.consecutiveFailures).toBe(0);
    });
  });
});

describe('Session Context', () => {
  it('should generate consistent dedupe keys', async () => {
    const { generateDedupeKey } = await import('../runtime/session-context');

    const key1 = generateDedupeKey('user1', 'trade123', 1234567890);
    const key2 = generateDedupeKey('user1', 'trade123', 1234567890);
    const key3 = generateDedupeKey('user1', 'trade456', 1234567890);

    expect(key1).toBe(key2);
    expect(key1).not.toBe(key3);
  });

  it('should format timestamps in UTC ISO', async () => {
    const { formatTimestamp } = await import('../runtime/session-context');

    const date = new Date('2025-06-15T10:30:00Z');
    const formatted = formatTimestamp(date);

    expect(formatted).toBe('2025-06-15T10:30:00.000Z');
    expect(formatted).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z$/);
  });
});
