/**
 * Coinbase WebSocket Module
 * 
 * This module contains the unified WebSocket interface and implementation
 * for Coinbase exchange connectivity.
 * 
 * IMPORTANT: There should be exactly ONE WebSocket client per exchange
 * connection in the runtime. Do not create multiple instances.
 * 
 * Usage:
 * - Import CoinbaseWebSocket from '../websocket' for the implementation
 * - Import interfaces from here for type definitions
 */

export {
  ICoinbaseWsClient,
  CoinbaseWsHealth,
  CoinbaseWsConfig,
  CoinbaseWsEvents,
  CoinbaseChannelSpec,
  SubscriptionManager,
} from './coinbase-ws.interface';
