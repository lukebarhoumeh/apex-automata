import WebSocket from 'ws';
import { EventEmitter } from 'events';
import { Counter, Gauge } from 'prom-client';
import { Logger } from '../../core/logger';
import { 
  CoinbaseConfig, 
  WebSocketMessage, 
  WebSocketChannelMessage,
  Ticker,
  OrderBook
} from './types';
import { 
  ICoinbaseWsClient, 
  CoinbaseWsHealth, 
  CoinbaseChannelSpec,
  SubscriptionManager 
} from './ws/coinbase-ws.interface';

// Prometheus metrics for WebSocket
const wsReconnectCounter = new Counter({
  name: 'atlas_ws_reconnect_count',
  help: 'Total number of WebSocket reconnection attempts',
});

const wsReconnectSuccessCounter = new Counter({
  name: 'atlas_ws_reconnect_success_count',
  help: 'Total number of successful WebSocket reconnections',
});

const wsConnectedGauge = new Gauge({
  name: 'atlas_ws_connected',
  help: '1 if WebSocket is connected, 0 otherwise',
});

const wsReconnectingGauge = new Gauge({
  name: 'atlas_ws_reconnecting',
  help: '1 if WebSocket is attempting to reconnect, 0 otherwise',
});

const wsLastMessageAgeGauge = new Gauge({
  name: 'atlas_ws_last_message_age_seconds',
  help: 'Seconds since last WebSocket message received',
});

/**
 * WebSocket events (legacy interface for backwards compatibility)
 */
export interface WebSocketEvents {
  ticker: (ticker: Ticker) => void;
  orderbook: (orderbook: OrderBook) => void;
  error: (error: Error) => void;
  open: () => void;
  close: (code: number, reason: string) => void;
  message: (data: WebSocketMessage) => void;
  reconnected: () => void;
  reconnect_failed: (attempts: number) => void;
  health_degraded: (reason: string) => void;
  // New unified events from interface
  'ws:connected': () => void;
  'ws:disconnected': (code: number, reason: string) => void;
  'ws:reconnecting': (attempt: number, delayMs: number) => void;
  'ws:reconnected': () => void;
  'ws:stalled': (messageAgeMs: number) => void;
  'ws:subscribed': (channels: CoinbaseChannelSpec[]) => void;
  'ws:unsubscribed': (channels: any[]) => void;
  'ws:resubscribed': (channels: CoinbaseChannelSpec[]) => void;
}

// Re-export health type from interface for backwards compatibility
export type { CoinbaseWsHealth } from './ws/coinbase-ws.interface';

/**
 * @deprecated Use CoinbaseWsHealth instead
 */
export type WebSocketHealth = CoinbaseWsHealth;

// Configuration for reconnection behavior - INFINITE reconnection for 24/7 operation
const RECONNECT_CONFIG = {
  // NO MAX ATTEMPTS - we reconnect forever
  initialDelayMs: 1000,      // Start with 1 second
  maxDelayMs: 60000,         // Cap at 60 seconds
  backoffMultiplier: 2,      // Double delay each attempt
  jitterMs: 500,             // Add random jitter to prevent thundering herd
  heartbeatIntervalMs: 30000, // Ping every 30 seconds
  heartbeatTimeoutMs: 45000, // If no pong for 45s, force reconnect
};

/**
 * CoinbaseWebSocket - The SINGLE, CANONICAL WebSocket client for Coinbase
 * 
 * This is the only WebSocket implementation used in production.
 * Do NOT create alternative WebSocket clients for Coinbase.
 * 
 * Features:
 * - Infinite reconnection with exponential backoff + jitter
 * - Heartbeat enforcement and stall detection
 * - Idempotent subscription management
 * - Automatic resubscription on reconnect
 * - Health API for supervisor monitoring
 * 
 * @implements {ICoinbaseWsClient}
 */
export class CoinbaseWebSocket extends EventEmitter implements ICoinbaseWsClient {
  private ws: WebSocket | null = null;
  private config: CoinbaseConfig;
  private logger: Logger;
  private reconnectAttempts = 0;
  private totalReconnects = 0;
  private reconnectDelay = RECONNECT_CONFIG.initialDelayMs;
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private heartbeatTimeoutCheck: NodeJS.Timeout | null = null;
  private reconnectTimeout: NodeJS.Timeout | null = null;
  private isConnected = false;
  private isReconnecting = false;
  private isManuallyDisconnected = false;
  private wasConnectedBefore = false;
  private lastPongTime = 0;
  private lastMessageTime = 0;

  // Idempotent subscription management
  private subscriptionManager: SubscriptionManager = new SubscriptionManager();
  
  // Legacy tracking (for backwards compatibility during transition)
  private subscribedChannels: Set<string> = new Set();
  private subscribedProducts: Set<string> = new Set();

  constructor(config: CoinbaseConfig, logger: Logger) {
    super();
    this.config = config;
    this.logger = logger;
    
    // Initialize timestamps
    const now = Date.now();
    this.lastPongTime = now;
    this.lastMessageTime = now;
  }
  
  // Public getter for reconnect count (for monitoring)
  public getReconnectAttempts(): number {
    return this.reconnectAttempts;
  }

  /**
   * Get WebSocket health status for supervisor/monitoring
   * Implements ICoinbaseWsClient.getHealth()
   */
  public getHealth(): CoinbaseWsHealth {
    const now = Date.now();
    const messageAgeMs = now - this.lastMessageTime;
    
    return {
      connected: this.isConnected,
      reconnecting: this.isReconnecting,
      reconnectAttempts: this.reconnectAttempts,
      totalReconnects: this.totalReconnects,
      lastMessageAt: this.lastMessageTime || null,
      lastHeartbeatAt: this.lastPongTime || null,
      messageAgeMs,
      isStalled: this.isConnected && messageAgeMs > RECONNECT_CONFIG.heartbeatTimeoutMs,
      subscriptions: this.subscriptionManager.getDesired(),
      socketUrl: this.config.wsUrl,
    };
  }

  public connect(): void {
    if (this.ws && this.isConnected) {
      this.logger.warn('WebSocket already connected');
      return;
    }

    // Clear manual disconnect flag when explicitly connecting
    this.isManuallyDisconnected = false;
    this.isReconnecting = false;
    
    this.logger.info(`Connecting to Coinbase WebSocket at ${this.config.wsUrl}`);
    wsReconnectingGauge.set(1);
    
    try {
      this.ws = new WebSocket(this.config.wsUrl);
      
      this.ws.on('open', this.handleOpen.bind(this));
      this.ws.on('message', this.handleMessage.bind(this));
      this.ws.on('error', this.handleError.bind(this));
      this.ws.on('close', this.handleClose.bind(this));
      this.ws.on('pong', this.handlePong.bind(this));
    } catch (error) {
      this.logger.error('Failed to create WebSocket connection', {
        error: error instanceof Error ? error.message : String(error),
      });
      this.scheduleReconnect();
    }
  }

  /**
   * Force reconnect - used by supervisor when connection seems stale
   */
  public forceReconnect(): void {
    this.logger.info('Force reconnect requested');
    this.cleanupConnection();
    this.scheduleReconnect(true);
  }

  private handleOpen(): void {
    const isReconnection = this.wasConnectedBefore;
    const now = Date.now();
    
    // Structured log for observability
    this.logger.info('coinbase_ws_connected', { 
      isReconnection,
      previousAttempts: this.reconnectAttempts,
      url: this.config.wsUrl,
    });
    
    this.isConnected = true;
    this.isReconnecting = false;
    this.lastPongTime = now;
    this.lastMessageTime = now;
    
    // Update Prometheus gauges
    wsConnectedGauge.set(1);
    wsReconnectingGauge.set(0);
    
    // Reset reconnection state on successful connect
    const previousAttempts = this.reconnectAttempts;
    this.reconnectAttempts = 0;
    this.reconnectDelay = RECONNECT_CONFIG.initialDelayMs;
    
    // Track total reconnects for monitoring
    if (isReconnection) {
      this.totalReconnects++;
    }
    
    // Start heartbeat with timeout detection
    this.startHeartbeat();
    
    // Re-subscribe to channels using subscription manager
    const desired = this.subscriptionManager.getDesired();
    if (desired.length > 0) {
      this.resubscribe();
    } else if (this.subscribedChannels.size > 0 || this.subscribedProducts.size > 0) {
      // Legacy fallback
      this.resubscribe();
    }
    
    // Emit both legacy and new events for compatibility
    this.emit('open');
    this.emit('ws:connected');
    
    // Emit reconnected event if this was a reconnection
    if (isReconnection) {
      wsReconnectSuccessCounter.inc();
      this.logger.info('coinbase_ws_reconnected', {
        attempts: previousAttempts,
        totalReconnects: this.totalReconnects,
      });
      this.emit('reconnected');
      this.emit('ws:reconnected');
    }
    
    this.wasConnectedBefore = true;
  }

  /**
   * Handle pong response from server
   */
  private handlePong(): void {
    this.lastPongTime = Date.now();
    this.logger.debug('Received pong from server');
  }

  private handleMessage(data: WebSocket.Data): void {
    // Track last message time for health monitoring
    const now = Date.now();
    this.lastMessageTime = now;
    
    // Update Prometheus gauge for message age
    wsLastMessageAgeGauge.set(0);
    
    try {
      const message: WebSocketMessage = JSON.parse(data.toString());
      
      // Route message to appropriate handler
      switch (message.type) {
        case 'ticker':
          this.emit('ticker', message as Ticker);
          break;
        case 'snapshot':
        case 'l2update':
          this.handleOrderBookMessage(message);
          break;
        case 'subscriptions':
          this.logger.info('Current subscriptions:', message);
          break;
        case 'error':
          this.logger.error('WebSocket error message:', message);
          this.emit('error', new Error(message.message || 'Unknown WebSocket error'));
          break;
        default:
          this.emit('message', message);
      }
    } catch (error) {
      this.logger.error('Failed to parse WebSocket message:', error);
      this.emit('error', error as Error);
    }
  }

  private handleOrderBookMessage(message: WebSocketMessage): void {
    // This is a simplified handler - in production, you'd maintain a full order book
    const orderbook: OrderBook = {
      bids: message.bids || [],
      asks: message.asks || [],
      sequence: message.sequence || 0,
      time: message.time || new Date().toISOString()
    };
    this.emit('orderbook', orderbook);
  }

  private handleError(error: Error): void {
    this.logger.error('WebSocket error:', error);
    this.emit('error', error);
  }

  private handleClose(code: number, reason: string): void {
    // Structured log for observability
    this.logger.warn('coinbase_ws_disconnected', {
      code,
      reason,
      wasManuallyDisconnected: this.isManuallyDisconnected,
      reconnectAttempts: this.reconnectAttempts,
    });
    
    this.isConnected = false;
    wsConnectedGauge.set(0);
    
    // Clear all timers
    this.clearAllTimers();
    
    // Emit both legacy and new events
    this.emit('close', code, reason);
    this.emit('ws:disconnected', code, reason);
    
    // Do NOT reconnect if manually disconnected
    if (this.isManuallyDisconnected) {
      this.logger.info('WebSocket manually disconnected, not attempting reconnect');
      return;
    }
    
    // INFINITE RECONNECTION - we never give up
    this.scheduleReconnect();
  }

  /**
   * Schedule a reconnection attempt with exponential backoff and jitter
   * This is the core of 24/7 resilience - we NEVER stop trying to reconnect
   */
  private scheduleReconnect(immediate: boolean = false): void {
    // Don't schedule if already reconnecting or manually disconnected
    if (this.isManuallyDisconnected) {
      return;
    }

    // Clear any existing reconnect timeout
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    this.isReconnecting = true;
    this.reconnectAttempts++;
    wsReconnectCounter.inc();
    wsReconnectingGauge.set(1);

    // Calculate delay with exponential backoff + jitter
    let delay: number;
    if (immediate) {
      delay = 100; // Near-immediate reconnect for force reconnect
    } else {
      const baseDelay = RECONNECT_CONFIG.initialDelayMs * 
        Math.pow(RECONNECT_CONFIG.backoffMultiplier, Math.min(this.reconnectAttempts - 1, 10));
      const cappedDelay = Math.min(baseDelay, RECONNECT_CONFIG.maxDelayMs);
      // Add random jitter (0 to jitterMs)
      const jitter = Math.random() * RECONNECT_CONFIG.jitterMs;
      delay = cappedDelay + jitter;
    }

    // Emit reconnecting event for UI
    this.emit('ws:reconnecting', this.reconnectAttempts, Math.round(delay));

    // Structured log for observability
    this.logger.info('coinbase_ws_reconnect_attempt', {
      attempt: this.reconnectAttempts,
      delayMs: Math.round(delay),
      subscriptionCount: this.subscriptionManager.count(),
    });

    // Log with different levels based on attempt count
    if (this.reconnectAttempts <= 3) {
      this.logger.info(`Scheduling reconnect in ${Math.round(delay)}ms (attempt ${this.reconnectAttempts})`);
    } else if (this.reconnectAttempts <= 10) {
      this.logger.warn(`Reconnect attempt ${this.reconnectAttempts} in ${Math.round(delay)}ms`, {
        subscriptions: this.subscriptionManager.getDesired(),
      });
    } else {
      // Log every 10th attempt at error level after 10 failures
      if (this.reconnectAttempts % 10 === 0) {
        this.logger.error(`Still attempting reconnect after ${this.reconnectAttempts} attempts`, {
          nextDelayMs: Math.round(delay),
          totalReconnects: this.totalReconnects,
        });
        // Emit event so supervisor knows we're struggling
        this.emit('reconnect_failed', this.reconnectAttempts);
      }
    }

    this.reconnectTimeout = setTimeout(() => {
      this.reconnectTimeout = null;
      try {
        this.connect();
      } catch (err) {
        this.logger.error('Reconnect attempt failed, scheduling another', { error: String(err) });
        this.scheduleReconnect();
      }
    }, delay);
  }

  /**
   * Clean up the current connection and all timers
   */
  private cleanupConnection(): void {
    this.clearAllTimers();
    
    if (this.ws) {
      try {
        // Remove all listeners before closing to avoid triggering handleClose
        this.ws.removeAllListeners();
        if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
          this.ws.close(1000, 'Cleanup');
        }
      } catch (error) {
        this.logger.warn('Error during WebSocket cleanup', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      this.ws = null;
    }
    
    this.isConnected = false;
    wsConnectedGauge.set(0);
  }

  /**
   * Clear all timers (heartbeat, timeout checks, reconnect)
   */
  private clearAllTimers(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    if (this.heartbeatTimeoutCheck) {
      clearInterval(this.heartbeatTimeoutCheck);
      this.heartbeatTimeoutCheck = null;
    }
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
  }

  private startHeartbeat(): void {
    // Clear any existing intervals first
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }
    if (this.heartbeatTimeoutCheck) {
      clearInterval(this.heartbeatTimeoutCheck);
    }

    // Ping every 30 seconds
    this.heartbeatInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.ping();
        this.logger.debug('Sent ping to server');
      }
    }, RECONNECT_CONFIG.heartbeatIntervalMs);

    // Check for heartbeat timeout every 5 seconds
    // If no pong for heartbeatTimeoutMs, force reconnect
    this.heartbeatTimeoutCheck = setInterval(() => {
      const now = Date.now();
      const pongAge = now - this.lastPongTime;
      const messageAge = now - this.lastMessageTime;

      // Update Prometheus gauge
      wsLastMessageAgeGauge.set(messageAge / 1000);

      // If we haven't received a pong OR any message for too long, connection is dead
      if (this.isConnected && pongAge > RECONNECT_CONFIG.heartbeatTimeoutMs) {
        this.logger.warn('coinbase_ws_stalled_detected', {
          reason: 'heartbeat_timeout',
          lastPongAge: pongAge,
          timeoutMs: RECONNECT_CONFIG.heartbeatTimeoutMs,
        });
        this.emit('ws:stalled', pongAge);
        this.emit('health_degraded', 'heartbeat_timeout');
        this.forceReconnect();
      } else if (this.isConnected && messageAge > RECONNECT_CONFIG.heartbeatTimeoutMs * 4) {
        // 3+ minutes without ANY message — log but don't reconnect.
        // Ticker gaps >90s are normal for low-volume pairs on Coinbase.
        // The pong-based check above is the authoritative liveness signal.
        this.logger.debug('coinbase_ws_no_recent_messages', {
          lastMessageAge: messageAge,
        });
        this.emit('health_degraded', 'no_messages');
      }
    }, 5000);
  }

  /**
   * Subscribe to channels - IDEMPOTENT
   * Subscribing twice to the same channel/product is a no-op.
   * Subscriptions are tracked and automatically restored on reconnect.
   */
  public subscribe(channels: string[], productIds: string[]): void {
    // Use subscription manager for idempotency
    const newSubs = this.subscriptionManager.addMany(channels, productIds);
    
    // If nothing new to subscribe to, skip
    if (newSubs.length === 0) {
      this.logger.debug('Subscribe called but all channels/products already subscribed', {
        channels,
        productIds,
      });
      return;
    }

    // Also track in legacy sets for backwards compatibility
    channels.forEach(channel => this.subscribedChannels.add(channel));
    productIds.forEach(product => this.subscribedProducts.add(product));

    // If not connected, subscriptions will be sent on connect
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.logger.info('WebSocket not connected. Subscriptions queued for when connected.', {
        queuedChannels: channels,
        queuedProducts: productIds,
      });
      return;
    }

    // Send subscription message for only the NEW subscriptions
    for (const sub of newSubs) {
      const message: WebSocketChannelMessage = {
        type: 'subscribe',
        product_ids: sub.productIds,
        channels: [sub.channel]
      };

      this.ws.send(JSON.stringify(message));
      
      this.logger.info(`Subscribed to channel: ${sub.channel} for products: ${sub.productIds.join(', ')}`);
    }

    // Emit subscribed event
    this.emit('ws:subscribed', this.subscriptionManager.getDesired());
  }

  /**
   * Unsubscribe from channels
   * Updates the desired subscription set and sends unsubscribe if connected.
   */
  public unsubscribe(channels: string[], productIds: string[]): void {
    // Use subscription manager
    const removed = this.subscriptionManager.removeMany(channels, productIds);
    
    // If nothing was actually removed, skip
    if (removed.length === 0) {
      this.logger.debug('Unsubscribe called but channels/products were not subscribed');
      return;
    }

    // Update legacy sets
    channels.forEach(channel => this.subscribedChannels.delete(channel));
    productIds.forEach(product => this.subscribedProducts.delete(product));

    // If not connected, nothing to send
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.logger.info('WebSocket not connected. Unsubscribe recorded locally.');
      return;
    }

    // Send unsubscribe message for removed subscriptions
    for (const sub of removed) {
      const message: WebSocketChannelMessage = {
        type: 'unsubscribe',
        product_ids: sub.productIds,
        channels: [sub.channel]
      };

      this.ws.send(JSON.stringify(message));
      
      this.logger.info(`Unsubscribed from channel: ${sub.channel} for products: ${sub.productIds.join(', ')}`);
    }

    // Emit unsubscribed event
    this.emit('ws:unsubscribed', removed.map(r => ({ channel: r.channel, product_ids: r.productIds })));
  }

  /**
   * Resubscribe to all desired subscriptions after reconnection
   * Uses the SubscriptionManager to get the exact desired state
   */
  private resubscribe(): void {
    const desired = this.subscriptionManager.getDesired();
    
    if (desired.length === 0) {
      this.logger.debug('No subscriptions to restore after reconnection');
      return;
    }

    this.logger.info('Re-subscribing to previous channels after reconnection', {
      subscriptionCount: this.subscriptionManager.count(),
      channels: desired.map(d => d.channel),
    });

    // Send subscription messages for each channel
    for (const spec of desired) {
      try {
        const message: WebSocketChannelMessage = {
          type: 'subscribe',
          product_ids: spec.product_ids,
          channels: [spec.channel]
        };

        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify(message));
        }
      } catch (err) {
        this.logger.error('Failed to send resubscribe message', {
          channel: spec.channel,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Emit resubscribed event
    this.emit('ws:resubscribed', desired);

    // Log structured event for observability
    this.logger.info('coinbase_ws_resubscribed', {
      channelCount: desired.length,
      totalProducts: this.subscriptionManager.count(),
    });
  }

  public disconnect(code: number = 1000, reason: string = 'Manual disconnect'): void {
    this.logger.info('coinbase_ws_disconnecting', { code, reason, manual: true });
    
    // Set flag to prevent reconnection attempts
    this.isManuallyDisconnected = true;
    this.isReconnecting = false;
    
    // Clear all timers
    this.clearAllTimers();
    
    if (this.ws) {
      try {
        this.ws.close(code, reason);
      } catch (error) {
        this.logger.warn('Error closing WebSocket', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      this.ws = null;
    }
    
    this.isConnected = false;
    
    // Clear legacy tracking but NOT subscription manager (in case we reconnect)
    this.subscribedChannels.clear();
    this.subscribedProducts.clear();
    
    // Only clear subscription manager on explicit user request
    if (reason === 'Manual disconnect') {
      this.subscriptionManager.clear();
    }
    
    // Update Prometheus gauges
    wsConnectedGauge.set(0);
    wsReconnectingGauge.set(0);

    // Emit disconnected event
    this.emit('ws:disconnected', code, reason);
  }

  /**
   * Check if WebSocket is in a healthy state
   */
  public isHealthy(): boolean {
    if (!this.isConnected) {
      return false;
    }
    
    const now = Date.now();
    const messageAge = now - this.lastMessageTime;
    
    // Consider unhealthy if no message for more than 2x the heartbeat timeout
    return messageAge < RECONNECT_CONFIG.heartbeatTimeoutMs * 2;
  }

  /**
   * Get the last message timestamp
   */
  public getLastMessageTime(): number {
    return this.lastMessageTime;
  }

  /**
   * Reset connection state (used by supervisor after recovery)
   */
  public resetConnectionState(): void {
    const now = Date.now();
    this.lastMessageTime = now;
    this.lastPongTime = now;
    this.reconnectAttempts = 0;
    this.reconnectDelay = RECONNECT_CONFIG.initialDelayMs;
  }

  public isActive(): boolean {
    return this.isConnected && this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }
}
