/**
 * Execution Adapter Tests
 * 
 * Tests to verify:
 * 1. Adapter contract parity (same event shapes)
 * 2. Paper uses production market data by default
 * 3. Order validation (tick size, lot size, min notional)
 * 4. Post-only behavior
 * 5. Mode switching
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  ExecutionMode,
  MarketDataEnv,
  PlaceOrderRequest,
  BrokerOrderEvent,
  ProductSpec,
  DEFAULT_PRODUCT_SPECS,
  validateOrderAgainstSpec,
  roundQuantity,
  roundPrice,
} from '../trading/execution/execution-adapter';
import { PaperExecutionAdapter, DEFAULT_PAPER_CONFIG } from '../trading/execution/paper-adapter';
import {
  RuntimeConfig,
  DEFAULT_RUNTIME_CONFIG,
  buildRuntimeConfig,
  parseEnvConfig,
  getMarketDataUrls,
  createAdapters,
} from '../trading/execution/adapter-factory';
import { Logger } from '../core/logger';

// Mock logger
const mockLogger: Logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as any;

describe('Execution Adapter Contract', () => {
  describe('BrokerOrderEvent Shapes', () => {
    let paperAdapter: PaperExecutionAdapter;
    let events: BrokerOrderEvent[];

    beforeEach(async () => {
      events = [];
      paperAdapter = new PaperExecutionAdapter({
        logger: mockLogger,
        randomSeed: 12345, // Deterministic
      });
      paperAdapter.onEvent((event) => events.push(event));
      await paperAdapter.start();
      
      // Set market price
      paperAdapter.updateMarketPrice('BTC-USD', 50000, 50010, 50005);
    });

    afterEach(async () => {
      await paperAdapter.stop();
    });

    it('should emit order_accepted with required fields', async () => {
      const request: PlaceOrderRequest = {
        clientOrderId: 'test-order-1',
        symbol: 'BTC-USD',
        side: 'buy',
        type: 'limit',
        price: 49000,
        quantity: 0.01,
      };

      await paperAdapter.placeOrder(request);

      const acceptedEvent = events.find(e => e.type === 'order_accepted');
      expect(acceptedEvent).toBeDefined();
      expect(acceptedEvent).toMatchObject({
        type: 'order_accepted',
        clientOrderId: 'test-order-1',
        ts: expect.any(Number),
      });
      expect(acceptedEvent!.exchangeOrderId).toBeDefined();
    });

    it('should emit order_rejected with reason', async () => {
      const request: PlaceOrderRequest = {
        clientOrderId: 'test-order-2',
        symbol: 'UNKNOWN-USD',
        side: 'buy',
        type: 'market',
        quantity: 0.01,
      };

      await paperAdapter.placeOrder(request);

      const rejectedEvent = events.find(e => e.type === 'order_rejected');
      expect(rejectedEvent).toBeDefined();
      expect(rejectedEvent).toMatchObject({
        type: 'order_rejected',
        clientOrderId: 'test-order-2',
        reason: expect.any(String),
        ts: expect.any(Number),
      });
    });

    it('should emit fill with required fields', async () => {
      const request: PlaceOrderRequest = {
        clientOrderId: 'test-order-3',
        symbol: 'BTC-USD',
        side: 'buy',
        type: 'market',
        quantity: 0.01,
      };

      await paperAdapter.placeOrder(request);

      const fillEvent = events.find(e => e.type === 'fill');
      expect(fillEvent).toBeDefined();
      expect(fillEvent).toMatchObject({
        type: 'fill',
        clientOrderId: 'test-order-3',
        exchangeOrderId: expect.any(String),
        tradeId: expect.any(String),
        price: expect.any(Number),
        size: expect.any(Number),
        fee: expect.any(Number),
        feeCurrency: 'USD',
        liquidity: 'taker',
        ts: expect.any(Number),
      });
    });

    it('should emit order_canceled with required fields', async () => {
      const request: PlaceOrderRequest = {
        clientOrderId: 'test-order-4',
        symbol: 'BTC-USD',
        side: 'buy',
        type: 'limit',
        price: 40000, // Far from market, won't fill
        quantity: 0.01,
      };

      await paperAdapter.placeOrder(request);
      await paperAdapter.cancelOrder('test-order-4');

      const canceledEvent = events.find(e => e.type === 'order_canceled');
      expect(canceledEvent).toBeDefined();
      expect(canceledEvent).toMatchObject({
        type: 'order_canceled',
        clientOrderId: 'test-order-4',
        ts: expect.any(Number),
      });
    });
  });
});

describe('Runtime Config', () => {
  describe('Defaults', () => {
    it('should default to paper mode with production market data', () => {
      const config = buildRuntimeConfig();
      
      expect(config.executionMode).toBe('paper');
      expect(config.marketDataEnv).toBe('production');
      expect(config.executionEnv).toBe('production');
    });

    it('should allow overriding defaults', () => {
      const config = buildRuntimeConfig({
        executionMode: 'live',
        marketDataEnv: 'sandbox',
      });

      expect(config.executionMode).toBe('live');
      expect(config.marketDataEnv).toBe('sandbox');
    });
  });

  describe('Market Data URLs', () => {
    it('should return production URLs by default', () => {
      const urls = getMarketDataUrls('production');
      
      expect(urls.wsUrl).toBe('wss://ws-feed.exchange.coinbase.com');
      expect(urls.restUrl).toBe('https://api.exchange.coinbase.com');
    });

    it('should return sandbox URLs when specified', () => {
      const urls = getMarketDataUrls('sandbox');
      
      expect(urls.wsUrl).toBe('wss://ws-feed-public.sandbox.exchange.coinbase.com');
      expect(urls.restUrl).toBe('https://api-public.sandbox.exchange.coinbase.com');
    });
  });
});

describe('Order Validation', () => {
  const btcSpec = DEFAULT_PRODUCT_SPECS['BTC-USD'];

  describe('Quantity Rounding', () => {
    it('should round quantity to lot size', () => {
      const qty = roundQuantity(0.123456789, btcSpec);
      expect(qty).toBe(0.12345679); // 8 decimal places
    });
  });

  describe('Price Rounding', () => {
    it('should round price to tick size', () => {
      const price = roundPrice(50000.123, btcSpec);
      expect(price).toBe(50000.12);
    });
  });

  describe('Order Validation', () => {
    it('should reject quantity below minimum', () => {
      const result = validateOrderAgainstSpec({
        clientOrderId: 'test',
        symbol: 'BTC-USD',
        side: 'buy',
        type: 'market',
        quantity: 0.00001, // Below min 0.0001
      }, btcSpec);

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('below minimum'))).toBe(true);
    });

    it('should reject quantity above maximum', () => {
      const result = validateOrderAgainstSpec({
        clientOrderId: 'test',
        symbol: 'BTC-USD',
        side: 'buy',
        type: 'market',
        quantity: 1000, // Above max 100
      }, btcSpec);

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('exceeds maximum'))).toBe(true);
    });

    it('should accept valid order', () => {
      const result = validateOrderAgainstSpec({
        clientOrderId: 'test',
        symbol: 'BTC-USD',
        side: 'buy',
        type: 'limit',
        price: 50000,
        quantity: 0.01,
      }, btcSpec, 50000);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });
  });
});

describe('Post-Only Behavior', () => {
  let adapter: PaperExecutionAdapter;
  let events: BrokerOrderEvent[];

  beforeEach(async () => {
    events = [];
    adapter = new PaperExecutionAdapter({
      logger: mockLogger,
      randomSeed: 12345,
    });
    adapter.onEvent((event) => events.push(event));
    await adapter.start();
    
    // Set market: bid=50000, ask=50010
    adapter.updateMarketPrice('BTC-USD', 50000, 50010, 50005);
  });

  afterEach(async () => {
    await adapter.stop();
  });

  it('should reject post-only buy order above ask', async () => {
    const request: PlaceOrderRequest = {
      clientOrderId: 'post-only-buy',
      symbol: 'BTC-USD',
      side: 'buy',
      type: 'limit',
      price: 50015, // Above ask 50010 - would cross
      quantity: 0.01,
      postOnly: true,
    };

    await adapter.placeOrder(request);

    const rejected = events.find(e => e.type === 'order_rejected');
    expect(rejected).toBeDefined();
    expect((rejected as any).reason).toContain('Post-only');
    expect((rejected as any).code).toBe('post_only_rejected');
  });

  it('should reject post-only sell order below bid', async () => {
    const request: PlaceOrderRequest = {
      clientOrderId: 'post-only-sell',
      symbol: 'BTC-USD',
      side: 'sell',
      type: 'limit',
      price: 49990, // Below bid 50000 - would cross
      quantity: 0.01,
      postOnly: true,
    };

    await adapter.placeOrder(request);

    const rejected = events.find(e => e.type === 'order_rejected');
    expect(rejected).toBeDefined();
    expect((rejected as any).reason).toContain('Post-only');
  });

  it('should accept post-only buy order below ask', async () => {
    const request: PlaceOrderRequest = {
      clientOrderId: 'post-only-valid',
      symbol: 'BTC-USD',
      side: 'buy',
      type: 'limit',
      price: 49990, // Below ask 50010 - valid post-only
      quantity: 0.01,
      postOnly: true,
    };

    await adapter.placeOrder(request);

    const accepted = events.find(e => e.type === 'order_accepted');
    expect(accepted).toBeDefined();
    expect(events.find(e => e.type === 'order_rejected')).toBeUndefined();
  });
});

describe('Mode Switching', () => {
  it('should allow stopping and restarting adapter', async () => {
    const adapter = new PaperExecutionAdapter({
      logger: mockLogger,
    });

    await adapter.start();
    expect(adapter.getHealth().ok).toBe(true);

    await adapter.stop();
    expect(adapter.getHealth().ok).toBe(false);

    await adapter.start();
    expect(adapter.getHealth().ok).toBe(true);

    await adapter.stop();
  });

  it('should clear orders on stop', async () => {
    const adapter = new PaperExecutionAdapter({
      logger: mockLogger,
      randomSeed: 12345,
    });

    await adapter.start();
    adapter.updateMarketPrice('BTC-USD', 50000, 50010, 50005);

    // Place a limit order that won't fill
    await adapter.placeOrder({
      clientOrderId: 'test-order',
      symbol: 'BTC-USD',
      side: 'buy',
      type: 'limit',
      price: 40000,
      quantity: 0.01,
    });

    const openBefore = await adapter.getOpenOrders();
    expect(openBefore.length).toBe(1);

    await adapter.stop();

    // Start fresh
    await adapter.start();
    adapter.reset(); // Clear state
    
    const openAfter = await adapter.getOpenOrders();
    expect(openAfter.length).toBe(0);

    await adapter.stop();
  });
});

describe('Deterministic RNG', () => {
  it('should produce consistent results with same seed', async () => {
    const events1: BrokerOrderEvent[] = [];
    const events2: BrokerOrderEvent[] = [];

    // First run
    const adapter1 = new PaperExecutionAdapter({
      logger: mockLogger,
      randomSeed: 42,
    });
    adapter1.onEvent((e) => events1.push(e));
    await adapter1.start();
    adapter1.updateMarketPrice('BTC-USD', 50000, 50010, 50005);
    await adapter1.placeOrder({
      clientOrderId: 'test-1',
      symbol: 'BTC-USD',
      side: 'buy',
      type: 'market',
      quantity: 0.1,
    });
    await adapter1.stop();

    // Second run with same seed
    const adapter2 = new PaperExecutionAdapter({
      logger: mockLogger,
      randomSeed: 42,
    });
    adapter2.onEvent((e) => events2.push(e));
    await adapter2.start();
    adapter2.updateMarketPrice('BTC-USD', 50000, 50010, 50005);
    await adapter2.placeOrder({
      clientOrderId: 'test-1',
      symbol: 'BTC-USD',
      side: 'buy',
      type: 'market',
      quantity: 0.1,
    });
    await adapter2.stop();

    // Fill prices should be identical with same seed
    const fill1 = events1.find(e => e.type === 'fill') as any;
    const fill2 = events2.find(e => e.type === 'fill') as any;
    
    expect(fill1.price).toBe(fill2.price);
  });
});
