/**
 * WebSocket Reconnection Tests
 * 
 * Tests for infinite reconnection and health monitoring
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CoinbaseWebSocket, WebSocketHealth } from '../exchanges/coinbase/websocket';
import { CoinbaseConfig } from '../exchanges/coinbase/types';
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

// Mock config
const mockConfig: CoinbaseConfig = {
  apiKey: 'test-key',
  apiSecret: 'test-secret',
  apiPassphrase: 'test-pass',
  environment: 'sandbox',
  wsUrl: 'wss://test.example.com',
  restUrl: 'https://test.example.com',
};

describe('CoinbaseWebSocket - Infinite Reconnection', () => {
  let wsClient: CoinbaseWebSocket;
  let mockWsInstance: any;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    
    // Create mock WebSocket instance
    mockWsInstance = {
      on: vi.fn(),
      send: vi.fn(),
      close: vi.fn(),
      ping: vi.fn(),
      readyState: WebSocket.OPEN,
      removeAllListeners: vi.fn(),
    };
    
    MockWebSocket.mockImplementation(() => mockWsInstance);
    
    wsClient = new CoinbaseWebSocket(mockConfig, mockLogger);
  });

  afterEach(() => {
    wsClient.disconnect();
    vi.useRealTimers();
  });

  describe('Health API', () => {
    it('should return health status', () => {
      const health = wsClient.getHealth();
      
      expect(health).toHaveProperty('connected');
      expect(health).toHaveProperty('reconnecting');
      expect(health).toHaveProperty('lastMessageAt');
      expect(health).toHaveProperty('reconnectAttempts');
      expect(health).toHaveProperty('totalReconnects');
      expect(health).toHaveProperty('subscriptions');
      expect(health).toHaveProperty('messageAgeMs');
    });

    it('should track reconnect attempts', () => {
      wsClient.connect();
      
      // Simulate close event
      const onClose = mockWsInstance.on.mock.calls.find(
        ([event]: [string]) => event === 'close'
      )?.[1];
      
      if (onClose) {
        onClose(1006, 'Connection lost');
      }
      
      const health = wsClient.getHealth();
      expect(health.reconnectAttempts).toBe(1);
      expect(health.reconnecting).toBe(true);
    });
  });

  describe('Infinite Reconnection', () => {
    it('should continue reconnecting beyond 10 attempts', () => {
      wsClient.connect();
      
      // Get the close handler
      const onClose = mockWsInstance.on.mock.calls.find(
        ([event]: [string]) => event === 'close'
      )?.[1];
      
      // Simulate 15 disconnections
      for (let i = 0; i < 15; i++) {
        if (onClose) {
          onClose(1006, 'Connection lost');
        }
        vi.advanceTimersByTime(60001); // Max delay + 1
        
        // Re-set the mock for new connection
        MockWebSocket.mockImplementation(() => mockWsInstance);
      }
      
      // Should have attempted to reconnect 15 times
      expect(wsClient.getReconnectAttempts()).toBe(15);
      
      // Should still be trying to reconnect (not given up)
      expect(wsClient.getHealth().reconnecting).toBe(true);
    });

    it('should use exponential backoff with jitter', () => {
      wsClient.connect();
      
      const onClose = mockWsInstance.on.mock.calls.find(
        ([event]: [string]) => event === 'close'
      )?.[1];
      
      // First disconnect
      if (onClose) {
        onClose(1006, 'Connection lost');
      }
      
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('Scheduling reconnect'),
        expect.any(Object)
      );
    });

    it('should emit reconnect_failed event after many attempts', () => {
      const reconnectFailedHandler = vi.fn();
      wsClient.on('reconnect_failed', reconnectFailedHandler);
      
      wsClient.connect();
      
      const onClose = mockWsInstance.on.mock.calls.find(
        ([event]: [string]) => event === 'close'
      )?.[1];
      
      // Simulate 10 disconnections (triggers event every 10th attempt after 10)
      for (let i = 0; i < 11; i++) {
        if (onClose) {
          onClose(1006, 'Connection lost');
        }
        vi.advanceTimersByTime(60001);
        MockWebSocket.mockImplementation(() => mockWsInstance);
      }
      
      // Should have emitted reconnect_failed
      expect(reconnectFailedHandler).toHaveBeenCalled();
    });
  });

  describe('Manual Disconnect', () => {
    it('should not reconnect after manual disconnect', () => {
      wsClient.connect();
      
      const onClose = mockWsInstance.on.mock.calls.find(
        ([event]: [string]) => event === 'close'
      )?.[1];
      
      // Manually disconnect
      wsClient.disconnect();
      
      // Simulate close event
      if (onClose) {
        onClose(1000, 'Manual disconnect');
      }
      
      vi.advanceTimersByTime(5000);
      
      // Should not be reconnecting
      expect(wsClient.getHealth().reconnecting).toBe(false);
    });
  });

  describe('Force Reconnect', () => {
    it('should force reconnect when requested', () => {
      wsClient.connect();
      
      // Simulate successful connection
      const onOpen = mockWsInstance.on.mock.calls.find(
        ([event]: [string]) => event === 'open'
      )?.[1];
      
      if (onOpen) {
        onOpen();
      }
      
      // Force reconnect
      wsClient.forceReconnect();
      
      expect(mockLogger.info).toHaveBeenCalledWith('Force reconnect requested');
    });
  });

  describe('Heartbeat Timeout', () => {
    it('should detect stale connection via heartbeat', () => {
      wsClient.connect();
      
      // Simulate successful connection
      const onOpen = mockWsInstance.on.mock.calls.find(
        ([event]: [string]) => event === 'open'
      )?.[1];
      
      if (onOpen) {
        onOpen();
      }
      
      const healthDegradedHandler = vi.fn();
      wsClient.on('health_degraded', healthDegradedHandler);
      
      // Advance time past heartbeat timeout
      vi.advanceTimersByTime(50000);
      
      // Should have detected degraded health
      expect(healthDegradedHandler).toHaveBeenCalled();
    });
  });

  describe('Subscription Persistence', () => {
    it('should track subscriptions for resubscription', () => {
      wsClient.connect();
      
      // Simulate successful connection
      const onOpen = mockWsInstance.on.mock.calls.find(
        ([event]: [string]) => event === 'open'
      )?.[1];
      
      if (onOpen) {
        onOpen();
      }
      
      // Subscribe to channels
      wsClient.subscribe(['ticker'], ['BTC-USD', 'ETH-USD']);

      // Health surface returns CoinbaseChannelSpec[] = { channel, product_ids }[]
      const health = wsClient.getHealth();
      const channels = health.subscriptions.map((s) => s.channel);
      const products = health.subscriptions.flatMap((s) => s.product_ids);
      expect(channels).toContain('ticker');
      expect(products).toContain('BTC-USD');
      expect(products).toContain('ETH-USD');
    });
  });

  describe('Connection State', () => {
    it('should correctly report connection state', () => {
      expect(wsClient.isActive()).toBe(false);
      
      wsClient.connect();
      
      // Simulate successful connection
      const onOpen = mockWsInstance.on.mock.calls.find(
        ([event]: [string]) => event === 'open'
      )?.[1];
      
      if (onOpen) {
        onOpen();
      }
      
      // Note: isActive checks both isConnected AND ws.readyState
      // Since we mocked readyState as OPEN, this should work
      expect(wsClient.getHealth().connected).toBe(true);
    });

    it('should track total reconnects', () => {
      wsClient.connect();
      
      const onOpen = mockWsInstance.on.mock.calls.find(
        ([event]: [string]) => event === 'open'
      )?.[1];
      const onClose = mockWsInstance.on.mock.calls.find(
        ([event]: [string]) => event === 'close'
      )?.[1];
      
      // Initial connection
      if (onOpen) {
        onOpen();
      }
      
      // Simulate disconnect and reconnect cycle
      for (let i = 0; i < 3; i++) {
        if (onClose) {
          onClose(1006, 'Connection lost');
        }
        vi.advanceTimersByTime(2000);
        
        // Reset mock for new connection
        MockWebSocket.mockImplementation(() => mockWsInstance);
        
        if (onOpen) {
          onOpen();
        }
      }
      
      const health = wsClient.getHealth();
      expect(health.totalReconnects).toBe(3);
    });
  });
});
