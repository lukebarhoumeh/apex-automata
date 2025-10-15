import WebSocket from 'ws';
import { EventEmitter } from 'events';
import { Logger } from '../../core/logger';
import { 
  CoinbaseConfig, 
  WebSocketMessage, 
  WebSocketChannelMessage,
  Ticker,
  OrderBook
} from './types';

export interface WebSocketEvents {
  ticker: (ticker: Ticker) => void;
  orderbook: (orderbook: OrderBook) => void;
  error: (error: Error) => void;
  open: () => void;
  close: (code: number, reason: string) => void;
  message: (data: WebSocketMessage) => void;
}

export class CoinbaseWebSocket extends EventEmitter {
  private ws: WebSocket | null = null;
  private config: CoinbaseConfig;
  private logger: Logger;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectDelay = 1000; // Start with 1 second
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private isConnected = false;
  private subscribedChannels: Set<string> = new Set();
  private subscribedProducts: Set<string> = new Set();

  constructor(config: CoinbaseConfig, logger: Logger) {
    super();
    this.config = config;
    this.logger = logger;
  }

  public connect(): void {
    if (this.ws && this.isConnected) {
      this.logger.warn('WebSocket already connected');
      return;
    }

    this.logger.info(`Connecting to Coinbase WebSocket at ${this.config.wsUrl}`);
    
    this.ws = new WebSocket(this.config.wsUrl);
    
    this.ws.on('open', this.handleOpen.bind(this));
    this.ws.on('message', this.handleMessage.bind(this));
    this.ws.on('error', this.handleError.bind(this));
    this.ws.on('close', this.handleClose.bind(this));
  }

  private handleOpen(): void {
    this.logger.info('WebSocket connection established');
    this.isConnected = true;
    this.reconnectAttempts = 0;
    this.reconnectDelay = 1000;
    
    // Start heartbeat
    this.startHeartbeat();
    
    // Re-subscribe to channels if reconnecting
    if (this.subscribedChannels.size > 0 || this.subscribedProducts.size > 0) {
      this.resubscribe();
    }
    
    this.emit('open');
  }

  private handleMessage(data: WebSocket.Data): void {
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
    this.logger.warn(`WebSocket closed. Code: ${code}, Reason: ${reason}`);
    this.isConnected = false;
    
    // Clear heartbeat
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    
    this.emit('close', code, reason);
    
    // Attempt to reconnect with exponential backoff
    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++;
      const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);
      
      this.logger.info(`Attempting to reconnect in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);
      
      setTimeout(() => {
        this.connect();
      }, delay);
    } else {
      this.logger.error('Max reconnection attempts reached. Manual intervention required.');
    }
  }

  private startHeartbeat(): void {
    this.heartbeatInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.ping();
      }
    }, 30000); // Ping every 30 seconds
  }

  public subscribe(channels: string[], productIds: string[]): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.logger.error('WebSocket not connected. Cannot subscribe.');
      return;
    }

    const message: WebSocketChannelMessage = {
      type: 'subscribe',
      product_ids: productIds,
      channels: channels
    };

    this.ws.send(JSON.stringify(message));
    
    // Track subscriptions for reconnection
    channels.forEach(channel => this.subscribedChannels.add(channel));
    productIds.forEach(product => this.subscribedProducts.add(product));
    
    this.logger.info(`Subscribed to channels: ${channels.join(', ')} for products: ${productIds.join(', ')}`);
  }

  public unsubscribe(channels: string[], productIds: string[]): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.logger.error('WebSocket not connected. Cannot unsubscribe.');
      return;
    }

    const message: WebSocketChannelMessage = {
      type: 'unsubscribe',
      product_ids: productIds,
      channels: channels
    };

    this.ws.send(JSON.stringify(message));
    
    // Remove from tracked subscriptions
    channels.forEach(channel => this.subscribedChannels.delete(channel));
    productIds.forEach(product => this.subscribedProducts.delete(product));
    
    this.logger.info(`Unsubscribed from channels: ${channels.join(', ')} for products: ${productIds.join(', ')}`);
  }

  private resubscribe(): void {
    if (this.subscribedChannels.size > 0 && this.subscribedProducts.size > 0) {
      this.logger.info('Re-subscribing to previous channels after reconnection');
      this.subscribe(
        Array.from(this.subscribedChannels),
        Array.from(this.subscribedProducts)
      );
    }
  }

  public disconnect(): void {
    this.logger.info('Disconnecting WebSocket');
    
    // Don't try to reconnect if manually disconnecting
    this.reconnectAttempts = this.maxReconnectAttempts;
    
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    
    if (this.ws) {
      this.ws.close(1000, 'Manual disconnect');
      this.ws = null;
    }
    
    this.isConnected = false;
    this.subscribedChannels.clear();
    this.subscribedProducts.clear();
  }

  public isActive(): boolean {
    return this.isConnected && this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }
}
