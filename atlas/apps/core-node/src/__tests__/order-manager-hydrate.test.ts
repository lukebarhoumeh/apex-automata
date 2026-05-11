/**
 * Unit tests for OrderManager.hydrateOpenOrders.
 *
 * Guards the startup-rehydration path added in the platform-integrity PR.
 * Before this work, OrderManager held every in-flight order in-memory only,
 * so a PM2 / start.cjs restart silently lost the ability to cancel or
 * track them.
 */
import { describe, test, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import { OrderManager, OrderManagerConfig } from '../trading/order-manager';

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

let nextQueryResult: { data: any[] | null; error: { message: string } | null } = { data: [], error: null };

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          in: () => Promise.resolve(nextQueryResult),
        }),
      }),
    }),
  }),
}));

class MockExchange extends EventEmitter {}

const baseConfig: OrderManagerConfig = {
  supabaseUrl: 'http://localhost:54321',
  supabaseKey: 'test-key',
  defaultTimeInForce: 'GTC',
  maxOrderRetries: 3,
  postOnlyRetries: 5,
  twapConfig: {
    minSliceSize: 0.001,
    maxSliceSize: 0.1,
    sliceDuration: 60000,
    randomizeSize: true,
    randomizeTime: true,
  },
};

const creds = { supabaseUrl: 'http://localhost:54321', supabaseKey: 'test-key' };

describe('OrderManager.hydrateOpenOrders', () => {
  let exchange: MockExchange;
  let manager: OrderManager;

  beforeEach(() => {
    vi.clearAllMocks();
    nextQueryResult = { data: [], error: null };
    exchange = new MockExchange();
    manager = new OrderManager(baseConfig, mockLogger as any, exchange as any);
  });

  test('returns 0 with empty userId', async () => {
    const n = await manager.hydrateOpenOrders('', creds);
    expect(n).toBe(0);
  });

  test('returns 0 with missing creds', async () => {
    const n = await manager.hydrateOpenOrders('user-x', { supabaseUrl: '', supabaseKey: '' } as any);
    expect(n).toBe(0);
  });

  test('hydrates working/new/partially_filled orders and skips terminal ones', async () => {
    nextQueryResult = {
      data: [
        {
          id: 'order-1',
          external_order_id: 'exch-1',
          symbol: 'BTC-USD',
          side: 'buy',
          type: 'limit',
          status: 'working',
          price: 50_000,
          quantity: 0.1,
          strategy: 'momentum',
          created_at: '2026-05-10T12:00:00.000Z',
          updated_at: '2026-05-10T12:00:00.000Z',
          meta_prob: null,
        },
        {
          id: 'order-2',
          external_order_id: null,
          symbol: 'ETH-USD',
          side: 'sell',
          type: 'limit',
          status: 'new',
          price: 3000,
          quantity: 0.5,
          strategy: 'trend_follow',
          created_at: '2026-05-10T12:01:00.000Z',
          updated_at: '2026-05-10T12:01:00.000Z',
          meta_prob: 0.65,
        },
      ],
      error: null,
    };

    const n = await manager.hydrateOpenOrders('user-x', creds);
    expect(n).toBe(2);

    const active = manager.getActiveOrders();
    expect(active).toHaveLength(2);

    const byExch = manager.getOrderByExchangeOrderId('exch-1');
    expect(byExch).toBeDefined();
    expect(byExch!.symbol ?? byExch!.product).toBe('BTC-USD');

    const second = manager.getOrder('order-2');
    expect(second).toBeDefined();
    expect(second!.status).toBe('pending');
    expect(second!.metadata?.metaProb).toBe(0.65);
  });

  test('idempotent — second call replaces in-memory orders with current DB snapshot', async () => {
    nextQueryResult = {
      data: [
        { id: 'o1', external_order_id: 'e1', symbol: 'BTC-USD', side: 'buy', type: 'limit', status: 'working', price: 1, quantity: 1, created_at: '2026-05-10T00:00:00Z', updated_at: '2026-05-10T00:00:00Z' },
      ],
      error: null,
    };
    await manager.hydrateOpenOrders('user-x', creds);
    expect(manager.getActiveOrders()).toHaveLength(1);

    nextQueryResult = { data: [], error: null };
    const n = await manager.hydrateOpenOrders('user-x', creds);
    expect(n).toBe(0);
    expect(manager.getActiveOrders()).toHaveLength(0);
  });

  test('throws when supabase errors so engine can branch on failure', async () => {
    nextQueryResult = { data: null, error: { message: 'fetch failed' } };
    await expect(manager.hydrateOpenOrders('user-x', creds)).rejects.toThrow(/orders hydrate query failed/);
  });
});
