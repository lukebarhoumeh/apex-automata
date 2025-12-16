import { describe, test, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import { OrderManager, OrderManagerConfig } from '../trading/order-manager';
import type { CoinbaseOrder, Fill, OrderRequest } from '../exchanges/coinbase/types';

// Mock logger
const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

class MockExchange extends EventEmitter {
  public async createOrder(request: OrderRequest): Promise<CoinbaseOrder> {
    const now = new Date().toISOString();
    const exchangeOrder: any = {
      id: 'exch-1',
      product_id: request.product_id,
      side: request.side,
      type: request.type,
      created_at: now,
      fill_fees: '0',
      filled_size: '0',
      executed_value: '0',
      status: 'open',
      settled: false,
      size: request.size,
      price: request.price,
      // Critical for mapping: echo client oid on the order payload
      client_oid: request.client_oid,
    };
    
    // Simulate CoinbaseExchange behavior: emit order event before returning
    this.emit('order', exchangeOrder);
    return exchangeOrder as CoinbaseOrder;
  }
  
  public async cancelOrder(_orderId: string): Promise<boolean> {
    return true;
  }
}

describe('OrderManager', () => {
  let exchange: MockExchange;
  let orderManager: OrderManager;
  
  const config: OrderManagerConfig = {
    supabaseUrl: 'http://localhost:54321',
    supabaseKey: 'test-key',
    defaultTimeInForce: 'GTC',
    maxOrderRetries: 1,
    postOnlyRetries: 1,
    twapConfig: {
      minSliceSize: 0.001,
      maxSliceSize: 0.01,
      sliceDuration: 1000,
      randomizeSize: false,
      randomizeTime: false,
    },
  };
  
  beforeEach(() => {
    exchange = new MockExchange();
    orderManager = new OrderManager(config, mockLogger as any, exchange as any);
  });
  
  test('reconciles fills using exchange order id mapping', async () => {
    const managed = await orderManager.createOrder({
      product_id: 'BTC-USD',
      side: 'buy',
      type: 'limit',
      size: '0.1',
      price: '50000',
    });
    
    expect(managed.exchangeOrderId).toBe('exch-1');
    expect(orderManager.getOrderByExchangeOrderId('exch-1')?.id).toBe(managed.id);
    
    const fill: Fill = {
      trade_id: 123,
      product_id: 'BTC-USD',
      order_id: 'exch-1',
      user_id: 'u',
      profile_id: 'p',
      liquidity: 'T',
      price: '50000',
      size: '0.1',
      fee: '0',
      created_at: new Date().toISOString(),
      side: 'buy',
      settled: true,
      usd_volume: '5000',
    };
    
    exchange.emit('fill', fill);
    
    // Allow async handler to run
    await new Promise(r => setTimeout(r, 10));
    
    const updated = orderManager.getOrder(managed.id)!;
    expect(updated.status).toBe('filled');
    expect(updated.filledSize).toBeCloseTo(0.1, 8);
  });
});

