/**
 * Coinbase WebSocket Interface Contract
 * 
 * This is the single, unified interface for Coinbase WebSocket connections.
 * All implementations must conform to this contract.
 * 
 * IMPORTANT: There should be exactly ONE implementation of this interface
 * active in the runtime at any time. Do not create multiple WebSocket
 * connections to the same Coinbase endpoint.
 * 
 * Lifecycle: connect → authenticate (if needed) → subscribe → heartbeat → detect stall → reconnect → resubscribe
 */

import { EventEmitter } from 'events';

/**
 * Channel specification for subscriptions
 */
export interface CoinbaseChannelSpec {
  /** Channel name: ticker, level2, matches, heartbeat, user, etc. */
  channel: string;
  /** Product IDs to subscribe for this channel */
  product_ids: string[];
}

/**
 * WebSocket health status for monitoring and supervisor integration
 */
export interface CoinbaseWsHealth {
  /** Whether the WebSocket is currently connected */
  connected: boolean;
  /** Whether a reconnection attempt is in progress */
  reconnecting: boolean;
  /** Number of reconnection attempts since last successful connect */
  reconnectAttempts: number;
  /** Total number of successful reconnections since client creation */
  totalReconnects: number;
  /** Timestamp of last message received (any type) */
  lastMessageAt: number | null;
  /** Timestamp of last heartbeat/pong received */
  lastHeartbeatAt: number | null;
  /** Age of last message in milliseconds */
  messageAgeMs: number;
  /** Whether the connection appears stalled (no messages for threshold period) */
  isStalled: boolean;
  /** Current subscriptions */
  subscriptions: CoinbaseChannelSpec[];
  /** WebSocket URL being used */
  socketUrl: string;
}

/**
 * Events emitted by the Coinbase WebSocket client
 */
export interface CoinbaseWsEvents {
  // Market data events
  'market:ticker': (data: any) => void;
  'market:level2': (data: any) => void;
  'market:matches': (data: any) => void;
  'market:candle': (data: any) => void;
  
  // User events (if authenticated)
  'user:fill': (data: any) => void;
  'user:order': (data: any) => void;
  
  // Connection lifecycle events
  'ws:connected': () => void;
  'ws:disconnected': (code: number, reason: string) => void;
  'ws:reconnecting': (attempt: number, delayMs: number) => void;
  'ws:reconnected': () => void;
  'ws:stalled': (messageAgeMs: number) => void;
  'ws:error': (error: Error) => void;
  
  // Subscription events
  'ws:subscribed': (channels: CoinbaseChannelSpec[]) => void;
  'ws:unsubscribed': (channels: CoinbaseChannelSpec[]) => void;
  'ws:resubscribed': (channels: CoinbaseChannelSpec[]) => void;
}

/**
 * Configuration for the Coinbase WebSocket client
 */
export interface CoinbaseWsConfig {
  /** WebSocket URL (production or sandbox) */
  wsUrl: string;
  /** API key for authenticated channels (optional) */
  apiKey?: string;
  /** API secret for authenticated channels (optional) */
  apiSecret?: string;
  /** API passphrase for authenticated channels (optional) */
  apiPassphrase?: string;
  /** Heartbeat interval in milliseconds (default: 30000) */
  heartbeatIntervalMs?: number;
  /** Stall detection threshold in milliseconds (default: 45000) */
  stallThresholdMs?: number;
  /** Initial reconnect delay in milliseconds (default: 1000) */
  reconnectInitialDelayMs?: number;
  /** Maximum reconnect delay in milliseconds (default: 60000) */
  reconnectMaxDelayMs?: number;
  /** Random jitter to add to reconnect delay (default: 500) */
  reconnectJitterMs?: number;
}

/**
 * Unified Coinbase WebSocket client interface
 * 
 * All WebSocket implementations must implement this interface.
 */
export interface ICoinbaseWsClient extends EventEmitter {
  /**
   * Connect to the WebSocket server
   * Returns a promise that resolves when connected
   */
  connect(): void;

  /**
   * Disconnect from the WebSocket server
   * @param code Optional close code (default: 1000)
   * @param reason Optional close reason
   */
  disconnect(code?: number, reason?: string): void;

  /**
   * Subscribe to channels
   * Subscriptions are idempotent - subscribing twice to the same channel/product is a no-op
   * On reconnect, all subscriptions are automatically restored
   * 
   * @param channels Array of channels to subscribe to
   * @param productIds Array of product IDs to subscribe for
   */
  subscribe(channels: string[], productIds: string[]): void;

  /**
   * Unsubscribe from channels
   * @param channels Array of channels to unsubscribe from
   * @param productIds Array of product IDs to unsubscribe
   */
  unsubscribe(channels: string[], productIds: string[]): void;

  /**
   * Force a reconnection
   * Used by supervisor when connection appears stale
   */
  forceReconnect(): void;

  /**
   * Get current health status
   * Used by supervisor and status endpoints
   */
  getHealth(): CoinbaseWsHealth;

  /**
   * Check if connected and healthy
   */
  isActive(): boolean;

  /**
   * Check if connection is healthy (not stalled)
   */
  isHealthy(): boolean;

  /**
   * Get last message timestamp
   */
  getLastMessageTime(): number;

  /**
   * Reset connection state (used after recovery)
   */
  resetConnectionState(): void;
}

/**
 * Subscription manager for idempotent subscription handling
 */
export class SubscriptionManager {
  private desiredSubscriptions: Map<string, Set<string>> = new Map();

  /**
   * Add a subscription to the desired set
   * @returns true if this is a new subscription, false if already subscribed
   */
  public add(channel: string, productId: string): boolean {
    if (!this.desiredSubscriptions.has(channel)) {
      this.desiredSubscriptions.set(channel, new Set());
    }
    const channelSubs = this.desiredSubscriptions.get(channel)!;
    if (channelSubs.has(productId)) {
      return false; // Already subscribed
    }
    channelSubs.add(productId);
    return true;
  }

  /**
   * Add multiple subscriptions
   * @returns channels and products that are actually new
   */
  public addMany(channels: string[], productIds: string[]): { channel: string; productIds: string[] }[] {
    const newSubs: { channel: string; productIds: string[] }[] = [];
    
    for (const channel of channels) {
      const newProducts: string[] = [];
      for (const productId of productIds) {
        if (this.add(channel, productId)) {
          newProducts.push(productId);
        }
      }
      if (newProducts.length > 0) {
        newSubs.push({ channel, productIds: newProducts });
      }
    }
    
    return newSubs;
  }

  /**
   * Remove a subscription from the desired set
   * @returns true if subscription was removed, false if wasn't subscribed
   */
  public remove(channel: string, productId: string): boolean {
    const channelSubs = this.desiredSubscriptions.get(channel);
    if (!channelSubs || !channelSubs.has(productId)) {
      return false;
    }
    channelSubs.delete(productId);
    if (channelSubs.size === 0) {
      this.desiredSubscriptions.delete(channel);
    }
    return true;
  }

  /**
   * Remove multiple subscriptions
   * @returns channels and products that were actually removed
   */
  public removeMany(channels: string[], productIds: string[]): { channel: string; productIds: string[] }[] {
    const removed: { channel: string; productIds: string[] }[] = [];
    
    for (const channel of channels) {
      const removedProducts: string[] = [];
      for (const productId of productIds) {
        if (this.remove(channel, productId)) {
          removedProducts.push(productId);
        }
      }
      if (removedProducts.length > 0) {
        removed.push({ channel, productIds: removedProducts });
      }
    }
    
    return removed;
  }

  /**
   * Get all desired subscriptions as channel specs
   */
  public getDesired(): CoinbaseChannelSpec[] {
    const specs: CoinbaseChannelSpec[] = [];
    
    for (const [channel, products] of this.desiredSubscriptions) {
      if (products.size > 0) {
        specs.push({
          channel,
          product_ids: Array.from(products),
        });
      }
    }
    
    return specs;
  }

  /**
   * Check if a specific subscription exists
   */
  public has(channel: string, productId: string): boolean {
    return this.desiredSubscriptions.get(channel)?.has(productId) ?? false;
  }

  /**
   * Get count of total subscriptions
   */
  public count(): number {
    let total = 0;
    for (const products of this.desiredSubscriptions.values()) {
      total += products.size;
    }
    return total;
  }

  /**
   * Clear all subscriptions
   */
  public clear(): void {
    this.desiredSubscriptions.clear();
  }

  /**
   * Get all channels
   */
  public getChannels(): string[] {
    return Array.from(this.desiredSubscriptions.keys());
  }

  /**
   * Get all products for a channel
   */
  public getProducts(channel: string): string[] {
    return Array.from(this.desiredSubscriptions.get(channel) || []);
  }
}
