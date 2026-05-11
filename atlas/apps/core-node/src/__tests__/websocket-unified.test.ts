/**
 * Unified WebSocket Tests
 * 
 * Tests to ensure:
 * 1. Single WebSocket instance in runtime
 * 2. Idempotent subscriptions
 * 3. Reconnect resubscription
 * 4. No duplicate event emissions
 * 5. Stall detection
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SubscriptionManager, CoinbaseChannelSpec } from '../exchanges/coinbase/ws/coinbase-ws.interface';
import { CoinbaseWebSocket } from '../exchanges/coinbase/websocket';
import { CoinbaseExchange } from '../exchanges/coinbase';
import { Logger } from '../core/logger';
import WebSocket from 'ws';

// Mock ws module
vi.mock('ws');
const MockWebSocket = WebSocket as any;

// Mock logger
const mockLogger: Logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as any;

describe('SubscriptionManager', () => {
  let manager: SubscriptionManager;

  beforeEach(() => {
    manager = new SubscriptionManager();
  });

  describe('Idempotent Subscriptions', () => {
    it('should add new subscription and return true', () => {
      const isNew = manager.add('ticker', 'BTC-USD');
      expect(isNew).toBe(true);
      expect(manager.has('ticker', 'BTC-USD')).toBe(true);
    });

    it('should return false when adding duplicate subscription', () => {
      manager.add('ticker', 'BTC-USD');
      const isNew = manager.add('ticker', 'BTC-USD');
      expect(isNew).toBe(false);
    });

    it('should handle addMany and return only new subscriptions', () => {
      // First add
      const first = manager.addMany(['ticker'], ['BTC-USD', 'ETH-USD']);
      expect(first).toHaveLength(1);
      expect(first[0].channel).toBe('ticker');
      expect(first[0].productIds).toEqual(['BTC-USD', 'ETH-USD']);

      // Second add with overlap
      const second = manager.addMany(['ticker'], ['BTC-USD', 'SOL-USD']);
      expect(second).toHaveLength(1);
      expect(second[0].productIds).toEqual(['SOL-USD']); // Only SOL-USD is new

      // Third add with all duplicates
      const third = manager.addMany(['ticker'], ['BTC-USD', 'ETH-USD']);
      expect(third).toHaveLength(0); // Nothing new
    });

    it('should track count correctly', () => {
      expect(manager.count()).toBe(0);
      
      manager.add('ticker', 'BTC-USD');
      expect(manager.count()).toBe(1);
      
      manager.add('ticker', 'ETH-USD');
      expect(manager.count()).toBe(2);
      
      manager.add('level2', 'BTC-USD');
      expect(manager.count()).toBe(3);
      
      // Duplicate should not increase count
      manager.add('ticker', 'BTC-USD');
      expect(manager.count()).toBe(3);
    });
  });

  describe('Unsubscribe', () => {
    it('should remove subscription and return true', () => {
      manager.add('ticker', 'BTC-USD');
      const removed = manager.remove('ticker', 'BTC-USD');
      expect(removed).toBe(true);
      expect(manager.has('ticker', 'BTC-USD')).toBe(false);
    });

    it('should return false when removing non-existent subscription', () => {
      const removed = manager.remove('ticker', 'BTC-USD');
      expect(removed).toBe(false);
    });

    it('should handle removeMany correctly', () => {
      manager.addMany(['ticker', 'level2'], ['BTC-USD', 'ETH-USD']);
      
      const removed = manager.removeMany(['ticker'], ['BTC-USD', 'ETH-USD']);
      expect(removed).toHaveLength(1);
      expect(removed[0].productIds).toEqual(['BTC-USD', 'ETH-USD']);
      
      // level2 should still be subscribed
      expect(manager.has('level2', 'BTC-USD')).toBe(true);
    });
  });

  describe('getDesired', () => {
    it('should return all subscriptions as channel specs', () => {
      manager.addMany(['ticker', 'level2'], ['BTC-USD', 'ETH-USD']);
      
      const desired = manager.getDesired();
      expect(desired).toHaveLength(2);
      
      const tickerSpec = desired.find(d => d.channel === 'ticker');
      expect(tickerSpec?.product_ids).toContain('BTC-USD');
      expect(tickerSpec?.product_ids).toContain('ETH-USD');
    });

    it('should return empty array when no subscriptions', () => {
      expect(manager.getDesired()).toEqual([]);
    });
  });

  describe('Clear', () => {
    it('should clear all subscriptions', () => {
      manager.addMany(['ticker', 'level2'], ['BTC-USD', 'ETH-USD']);
      expect(manager.count()).toBe(4);
      
      manager.clear();
      expect(manager.count()).toBe(0);
      expect(manager.getDesired()).toEqual([]);
    });
  });
});

describe('CoinbaseWebSocket - Unified Implementation', () => {
  let wsClient: CoinbaseWebSocket;
  let mockWsInstance: any;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    
    mockWsInstance = {
      on: vi.fn(),
      send: vi.fn(),
      close: vi.fn(),
      ping: vi.fn(),
      readyState: WebSocket.OPEN,
      removeAllListeners: vi.fn(),
    };
    
    MockWebSocket.mockImplementation(() => mockWsInstance);
    
    wsClient = new CoinbaseWebSocket({
      apiKey: 'test',
      apiSecret: 'test',
      environment: 'sandbox',
      wsUrl: 'wss://test.example.com',
      restUrl: 'https://test.example.com',
    }, mockLogger);
  });

  afterEach(() => {
    wsClient.disconnect();
    vi.useRealTimers();
  });

  describe('Idempotent Subscribe', () => {
    it('should only send one subscribe message for duplicate subscriptions', () => {
      wsClient.connect();
      
      // Simulate successful connection
      const onOpen = mockWsInstance.on.mock.calls.find(
        ([event]: [string]) => event === 'open'
      )?.[1];
      if (onOpen) onOpen();
      
      // First subscribe
      wsClient.subscribe(['ticker'], ['BTC-USD']);
      expect(mockWsInstance.send).toHaveBeenCalledTimes(1);
      
      // Reset mock
      mockWsInstance.send.mockClear();
      
      // Second subscribe to same channel/product - should NOT send
      wsClient.subscribe(['ticker'], ['BTC-USD']);
      expect(mockWsInstance.send).not.toHaveBeenCalled();
    });

    it('should send subscribe for new products only', () => {
      wsClient.connect();
      
      const onOpen = mockWsInstance.on.mock.calls.find(
        ([event]: [string]) => event === 'open'
      )?.[1];
      if (onOpen) onOpen();
      
      // First subscribe
      wsClient.subscribe(['ticker'], ['BTC-USD', 'ETH-USD']);
      expect(mockWsInstance.send).toHaveBeenCalledTimes(1);
      
      // Reset mock
      mockWsInstance.send.mockClear();
      
      // Subscribe with overlap - should only send for new product
      wsClient.subscribe(['ticker'], ['BTC-USD', 'SOL-USD']);
      expect(mockWsInstance.send).toHaveBeenCalledTimes(1);
      
      const sentMessage = JSON.parse(mockWsInstance.send.mock.calls[0][0]);
      expect(sentMessage.product_ids).toEqual(['SOL-USD']);
    });
  });

  describe('Reconnect Resubscribe', () => {
    it('should resubscribe to all channels on reconnect', () => {
      wsClient.connect();
      
      const onOpen = mockWsInstance.on.mock.calls.find(
        ([event]: [string]) => event === 'open'
      )?.[1];
      const onClose = mockWsInstance.on.mock.calls.find(
        ([event]: [string]) => event === 'close'
      )?.[1];
      
      if (onOpen) onOpen();
      
      // Subscribe to multiple channels
      wsClient.subscribe(['ticker'], ['BTC-USD', 'ETH-USD']);
      wsClient.subscribe(['level2'], ['BTC-USD']);
      
      // Reset mock
      mockWsInstance.send.mockClear();
      
      // Simulate disconnect
      if (onClose) onClose(1006, 'Connection lost');
      
      // Advance timer for reconnect
      vi.advanceTimersByTime(2000);
      
      // Reconnect
      MockWebSocket.mockImplementation(() => mockWsInstance);
      if (onOpen) onOpen();
      
      // Should have resubscribed to both channels
      expect(mockWsInstance.send).toHaveBeenCalledTimes(2);
      
      const sentMessages = mockWsInstance.send.mock.calls.map((call: any) => 
        JSON.parse(call[0])
      );
      
      const tickerSub = sentMessages.find((m: any) => m.channels.includes('ticker'));
      const level2Sub = sentMessages.find((m: any) => m.channels.includes('level2'));
      
      expect(tickerSub?.product_ids).toContain('BTC-USD');
      expect(tickerSub?.product_ids).toContain('ETH-USD');
      expect(level2Sub?.product_ids).toContain('BTC-USD');
    });
  });

  describe('Health API', () => {
    it('should return correct health status', () => {
      const health = wsClient.getHealth();
      
      expect(health).toHaveProperty('connected');
      expect(health).toHaveProperty('reconnecting');
      expect(health).toHaveProperty('reconnectAttempts');
      expect(health).toHaveProperty('totalReconnects');
      expect(health).toHaveProperty('lastMessageAt');
      expect(health).toHaveProperty('lastHeartbeatAt');
      expect(health).toHaveProperty('messageAgeMs');
      expect(health).toHaveProperty('isStalled');
      expect(health).toHaveProperty('subscriptions');
      expect(health).toHaveProperty('socketUrl');
    });

    it('should include subscriptions in health', () => {
      wsClient.connect();
      
      const onOpen = mockWsInstance.on.mock.calls.find(
        ([event]: [string]) => event === 'open'
      )?.[1];
      if (onOpen) onOpen();
      
      wsClient.subscribe(['ticker'], ['BTC-USD']);
      
      const health = wsClient.getHealth();
      expect(health.subscriptions).toHaveLength(1);
      expect(health.subscriptions[0].channel).toBe('ticker');
      expect(health.subscriptions[0].product_ids).toContain('BTC-USD');
    });

    it('should detect stalled connection', () => {
      wsClient.connect();
      
      const onOpen = mockWsInstance.on.mock.calls.find(
        ([event]: [string]) => event === 'open'
      )?.[1];
      if (onOpen) onOpen();
      
      // Initially not stalled
      let health = wsClient.getHealth();
      expect(health.isStalled).toBe(false);

      // Advance just past the 45s stall threshold but before the next 5s
      // heartbeat-timeout tick at 50s — that tick would call forceReconnect
      // (cleanupConnection sets isConnected=false, masking isStalled).
      vi.advanceTimersByTime(46000);

      health = wsClient.getHealth();
      expect(health.isStalled).toBe(true);
    });
  });

  describe('Event Emissions', () => {
    it('should emit ws:connected on open', () => {
      const connectedHandler = vi.fn();
      wsClient.on('ws:connected', connectedHandler);
      
      wsClient.connect();
      
      const onOpen = mockWsInstance.on.mock.calls.find(
        ([event]: [string]) => event === 'open'
      )?.[1];
      if (onOpen) onOpen();
      
      expect(connectedHandler).toHaveBeenCalled();
    });

    it('should emit ws:subscribed after subscribe', () => {
      const subscribedHandler = vi.fn();
      wsClient.on('ws:subscribed', subscribedHandler);
      
      wsClient.connect();
      
      const onOpen = mockWsInstance.on.mock.calls.find(
        ([event]: [string]) => event === 'open'
      )?.[1];
      if (onOpen) onOpen();
      
      wsClient.subscribe(['ticker'], ['BTC-USD']);
      
      expect(subscribedHandler).toHaveBeenCalled();
    });

    it('should emit ws:resubscribed after reconnect', () => {
      const resubscribedHandler = vi.fn();
      wsClient.on('ws:resubscribed', resubscribedHandler);
      
      wsClient.connect();
      
      const onOpen = mockWsInstance.on.mock.calls.find(
        ([event]: [string]) => event === 'open'
      )?.[1];
      const onClose = mockWsInstance.on.mock.calls.find(
        ([event]: [string]) => event === 'close'
      )?.[1];
      
      if (onOpen) onOpen();
      wsClient.subscribe(['ticker'], ['BTC-USD']);
      
      // Simulate disconnect and reconnect
      if (onClose) onClose(1006, 'Connection lost');
      vi.advanceTimersByTime(2000);
      
      MockWebSocket.mockImplementation(() => mockWsInstance);
      if (onOpen) onOpen();
      
      expect(resubscribedHandler).toHaveBeenCalled();
    });
  });
});

describe('CoinbaseExchange - Single Instance', () => {
  it('should expose single WS health surface', () => {
    const exchange = new CoinbaseExchange({
      apiKey: 'test',
      apiSecret: 'test',
      environment: 'sandbox',
      wsUrl: 'wss://test.example.com',
      restUrl: 'https://test.example.com',
    }, mockLogger);

    // Should have getWsHealth method
    expect(typeof exchange.getWsHealth).toBe('function');
    
    // Should return health object
    const health = exchange.getWsHealth();
    expect(health).toHaveProperty('connected');
    expect(health).toHaveProperty('subscriptions');
  });

  it('should expose forceWsReconnect method', () => {
    const exchange = new CoinbaseExchange({
      apiKey: 'test',
      apiSecret: 'test',
      environment: 'sandbox',
      wsUrl: 'wss://test.example.com',
      restUrl: 'https://test.example.com',
    }, mockLogger);

    expect(typeof exchange.forceWsReconnect).toBe('function');
  });
});
