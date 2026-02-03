/**
 * @deprecated DEPRECATED - DO NOT USE
 * 
 * This WebSocket implementation is DEPRECATED and should NOT be used in production.
 * 
 * The canonical WebSocket client for Coinbase is:
 * - CoinbaseWebSocket in `exchanges/coinbase/websocket.ts`
 * 
 * This file exists only for the unused MultiExchangeConnector experimental code.
 * It will be removed in a future version.
 * 
 * Reasons for deprecation:
 * 1. Does not implement the unified ICoinbaseWsClient interface
 * 2. Lacks subscription persistence for reconnect
 * 3. Uses different event names than the standard
 * 4. Not integrated with the main trading runtime
 * 5. Connection pooling adds complexity without benefit for our use case
 * 
 * @see exchanges/coinbase/websocket.ts for the production implementation
 * @see exchanges/coinbase/ws/coinbase-ws.interface.ts for the interface contract
 */

import WebSocket from 'ws';
import { EventEmitter } from 'events';
import { Logger } from '../core/logger';
import * as net from 'net';
import * as tls from 'tls';

/**
 * @deprecated Use CoinbaseWebSocket instead
 */
export interface UltraFastWebSocketConfig {
  url: string;
  // Performance optimizations
  perMessageDeflate: boolean;
  maxPayload: number;
  tcpNoDelay: boolean;          // Disable Nagle's algorithm
  keepAlive: boolean;
  keepAliveInitialDelay: number;
  
  // Connection pooling
  useConnectionPool: boolean;
  poolSize: number;
  
  // Binary protocol support
  useBinaryProtocol: boolean;
  
  // Latency monitoring
  measureLatency: boolean;
  latencyCheckInterval: number;
}

export interface MarketDataUpdate {
  type: 'ticker' | 'trades' | 'orderbook' | 'heartbeat';
  symbol: string;
  timestamp: number;
  sequence?: number;
  data: any;
  latency?: number;
}

/**
 * @deprecated DO NOT USE - Use CoinbaseWebSocket from exchanges/coinbase/websocket.ts instead
 * 
 * This class is deprecated and will be removed in a future version.
 * It is not integrated with the main trading runtime and lacks features
 * required for 24/7 operation (subscription persistence, interface compliance).
 */
export class UltraFastWebSocket extends EventEmitter {
  private config: UltraFastWebSocketConfig;
  private logger: Logger;
  private connections: WebSocket[] = [];
  private activeConnection: WebSocket | null = null;
  private messageBuffer: MarketDataUpdate[] = [];
  private sequenceNumber: number = 0;
  private lastHeartbeat: number = Date.now();
  
  // Performance metrics
  private latencyHistory: number[] = [];
  private messageCount: number = 0;
  private bytesReceived: number = 0;
  
  // Binary protocol optimization
  private binaryDecoder: BinaryProtocolDecoder | null = null;
  
  // Connection state
  private reconnectAttempts: number = 0;
  private isConnecting: boolean = false;
  
  constructor(config: UltraFastWebSocketConfig, logger: Logger) {
    super();
    this.config = {
      perMessageDeflate: false, // Disable compression for speed
      maxPayload: 10 * 1024 * 1024, // 10MB
      tcpNoDelay: true,
      keepAlive: true,
      keepAliveInitialDelay: 10000,
      useConnectionPool: true,
      poolSize: 2,
      useBinaryProtocol: true,
      measureLatency: true,
      latencyCheckInterval: 1000,
      ...config
    };
    this.logger = logger;
    
    if (this.config.useBinaryProtocol) {
      this.binaryDecoder = new BinaryProtocolDecoder();
    }
  }
  
  public async connect(): Promise<void> {
    if (this.isConnecting) return;
    this.isConnecting = true;
    
    try {
      if (this.config.useConnectionPool) {
        await this.createConnectionPool();
      } else {
        await this.createSingleConnection();
      }
      
      if (this.config.measureLatency) {
        this.startLatencyMonitoring();
      }
      
      this.emit('connected');
    } catch (error) {
      this.logger.error('WebSocket connection failed:', error);
      this.scheduleReconnect();
    } finally {
      this.isConnecting = false;
    }
  }
  
  public disconnect(): void {
    this.connections.forEach(ws => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
    });
    this.connections = [];
    this.activeConnection = null;
  }
  
  public send(message: any): void {
    if (!this.activeConnection || this.activeConnection.readyState !== WebSocket.OPEN) {
      this.logger.warn('No active WebSocket connection');
      return;
    }
    
    try {
      if (this.config.useBinaryProtocol && this.binaryDecoder) {
        const binaryMessage = this.binaryDecoder.encode(message);
        this.activeConnection.send(binaryMessage);
      } else {
        const jsonMessage = JSON.stringify(message);
        this.activeConnection.send(jsonMessage);
      }
    } catch (error) {
      this.logger.error('Failed to send message:', error);
    }
  }
  
  // Subscribe to market data with minimum overhead
  public subscribe(channels: string[], symbols: string[]): void {
    const subscribeMessage = {
      type: 'subscribe',
      channels,
      product_ids: symbols,
      timestamp: Date.now()
    };
    
    this.send(subscribeMessage);
  }
  
  private async createConnectionPool(): Promise<void> {
    const promises = [];
    
    for (let i = 0; i < this.config.poolSize; i++) {
      promises.push(this.createConnection(i));
    }
    
    await Promise.all(promises);
    
    // Use the first connection as active
    this.activeConnection = this.connections[0];
    
    // Load balance across connections
    this.setupLoadBalancing();
  }
  
  private async createSingleConnection(): Promise<void> {
    const ws = await this.createConnection(0);
    this.connections = [ws];
    this.activeConnection = ws;
  }
  
  private createConnection(id: number): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const options: WebSocket.ClientOptions = {
        perMessageDeflate: this.config.perMessageDeflate,
        maxPayload: this.config.maxPayload,
        handshakeTimeout: 5000,
        // Custom agent for TCP optimizations
        agent: this.createOptimizedAgent()
      };
      
      const ws = new WebSocket(this.config.url, options);
      
      // TCP optimizations
      ws.on('upgrade', (response) => {
        const socket = response.socket as net.Socket;
        
        if (this.config.tcpNoDelay) {
          socket.setNoDelay(true);
        }
        
        if (this.config.keepAlive) {
          socket.setKeepAlive(true, this.config.keepAliveInitialDelay);
        }
        
        // Additional TCP tuning
        if ('setKeepAliveInitialDelay' in socket) {
          (socket as any).setKeepAliveInitialDelay(1000);
        }
      });
      
      ws.on('open', () => {
        this.logger.info(`WebSocket connection ${id} established`);
        this.reconnectAttempts = 0;
        this.setupMessageHandlers(ws, id);
        resolve(ws);
      });
      
      ws.on('error', (error) => {
        this.logger.error(`WebSocket ${id} error:`, error);
        reject(error);
      });
      
      ws.on('close', (code, reason) => {
        this.logger.info(`WebSocket ${id} closed: ${code} - ${reason}`);
        this.handleConnectionClose(ws, id);
      });
    });
  }
  
  private createOptimizedAgent(): any {
    // Create custom HTTPS agent with optimized settings
    const agent = new (require('https').Agent)({
      keepAlive: true,
      keepAliveMsecs: 1000,
      maxSockets: 10,
      maxFreeSockets: 5,
      timeout: 60000,
      // Optimize TLS
      secureOptions: require('constants').SSL_OP_NO_TLSv1 | 
                    require('constants').SSL_OP_NO_TLSv1_1,
      ciphers: 'ECDHE-RSA-AES128-GCM-SHA256:ECDHE-RSA-AES256-GCM-SHA384'
    });
    
    return agent;
  }
  
  private setupMessageHandlers(ws: WebSocket, connectionId: number): void {
    ws.on('message', (data: WebSocket.Data) => {
      const receiveTime = this.highResTime();
      this.messageCount++;
      
      try {
        let message: any;
        
        if (this.config.useBinaryProtocol && this.binaryDecoder && Buffer.isBuffer(data)) {
          message = this.binaryDecoder.decode(data as Buffer);
          this.bytesReceived += (data as Buffer).length;
        } else {
          const text = data.toString();
          message = JSON.parse(text);
          this.bytesReceived += text.length;
        }
        
        // Calculate latency if timestamp is provided
        if (message.timestamp) {
          const latency = receiveTime - message.timestamp;
          this.updateLatencyMetrics(latency);
          message.latency = latency;
        }
        
        // Handle different message types
        this.processMessage(message, connectionId);
        
      } catch (error) {
        this.logger.error(`Failed to process message from connection ${connectionId}:`, error);
      }
    });
    
    ws.on('ping', () => {
      ws.pong();
      this.lastHeartbeat = Date.now();
    });
  }
  
  private processMessage(message: any, connectionId: number): void {
    // Fast path for market data
    if (message.type === 'ticker' || message.type === 'match' || message.type === 'l2update') {
      const marketData: MarketDataUpdate = {
        type: this.mapMessageType(message.type),
        symbol: message.product_id,
        timestamp: this.highResTime(),
        sequence: message.sequence,
        data: message,
        latency: message.latency
      };
      
      // Emit immediately for lowest latency
      this.emit('market:data', marketData);
      
      // Buffer for batch processing if needed
      if (this.messageBuffer.length < 1000) {
        this.messageBuffer.push(marketData);
      }
    } else if (message.type === 'heartbeat') {
      this.lastHeartbeat = Date.now();
      this.emit('heartbeat', { connectionId, timestamp: message.timestamp });
    } else if (message.type === 'error') {
      this.logger.error(`WebSocket error from ${connectionId}:`, message);
      this.emit('error', message);
    }
  }
  
  private mapMessageType(type: string): 'ticker' | 'trades' | 'orderbook' | 'heartbeat' {
    switch (type) {
      case 'ticker':
        return 'ticker';
      case 'match':
      case 'last_match':
        return 'trades';
      case 'l2update':
      case 'snapshot':
        return 'orderbook';
      default:
        return 'heartbeat';
    }
  }
  
  private setupLoadBalancing(): void {
    // Simple round-robin load balancing
    let currentIndex = 0;
    
    // Override send method to distribute load
    const originalSend = this.send.bind(this);
    this.send = (message: any) => {
      if (this.connections.length > 1) {
        this.activeConnection = this.connections[currentIndex];
        currentIndex = (currentIndex + 1) % this.connections.length;
      }
      originalSend(message);
    };
  }
  
  private handleConnectionClose(ws: WebSocket, id: number): void {
    const index = this.connections.indexOf(ws);
    if (index !== -1) {
      this.connections.splice(index, 1);
    }
    
    if (this.activeConnection === ws) {
      this.activeConnection = this.connections[0] || null;
    }
    
    if (this.connections.length === 0) {
      this.emit('disconnected');
      this.scheduleReconnect();
    }
  }
  
  private scheduleReconnect(): void {
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
    this.reconnectAttempts++;
    
    this.logger.info(`Scheduling reconnect in ${delay}ms (attempt ${this.reconnectAttempts})`);
    
    setTimeout(() => {
      this.connect();
    }, delay);
  }
  
  private startLatencyMonitoring(): void {
    setInterval(() => {
      if (this.latencyHistory.length > 0) {
        const avgLatency = this.latencyHistory.reduce((a, b) => a + b, 0) / this.latencyHistory.length;
        const minLatency = Math.min(...this.latencyHistory);
        const maxLatency = Math.max(...this.latencyHistory);
        
        this.emit('latency:stats', {
          average: avgLatency,
          min: minLatency,
          max: maxLatency,
          samples: this.latencyHistory.length
        });
        
        // Keep only recent samples
        if (this.latencyHistory.length > 1000) {
          this.latencyHistory = this.latencyHistory.slice(-1000);
        }
      }
      
      // Check connection health
      const timeSinceHeartbeat = Date.now() - this.lastHeartbeat;
      if (timeSinceHeartbeat > 30000) {
        this.logger.warn('No heartbeat for 30 seconds, reconnecting...');
        this.disconnect();
        this.connect();
      }
    }, this.config.latencyCheckInterval);
  }
  
  private updateLatencyMetrics(latency: number): void {
    this.latencyHistory.push(latency);
    
    // Emit warning for high latency
    if (latency > 100) {
      this.emit('latency:warning', { latency, timestamp: Date.now() });
    }
  }
  
  private highResTime(): number {
    const [seconds, nanoseconds] = process.hrtime();
    return seconds * 1000 + nanoseconds / 1000000;
  }
  
  // Get connection statistics
  public getStats(): {
    connections: number;
    messageCount: number;
    bytesReceived: number;
    avgLatency: number;
    uptime: number;
  } {
    const avgLatency = this.latencyHistory.length > 0 ?
      this.latencyHistory.reduce((a, b) => a + b, 0) / this.latencyHistory.length : 0;
    
    return {
      connections: this.connections.filter(ws => ws.readyState === WebSocket.OPEN).length,
      messageCount: this.messageCount,
      bytesReceived: this.bytesReceived,
      avgLatency,
      uptime: Date.now() - this.lastHeartbeat
    };
  }
  
  // Batch process buffered messages
  public flushMessageBuffer(): MarketDataUpdate[] {
    const messages = [...this.messageBuffer];
    this.messageBuffer = [];
    return messages;
  }
}

// Binary protocol decoder for maximum performance
class BinaryProtocolDecoder {
  // Message type constants
  private static readonly MSG_TICKER = 0x01;
  private static readonly MSG_TRADE = 0x02;
  private static readonly MSG_ORDERBOOK = 0x03;
  private static readonly MSG_HEARTBEAT = 0x04;
  
  encode(message: any): Buffer {
    // Simple binary encoding (in production, use more sophisticated protocol)
    const json = JSON.stringify(message);
    const jsonBuffer = Buffer.from(json, 'utf8');
    const buffer = Buffer.allocUnsafe(5 + jsonBuffer.length);
    
    // Header: 1 byte type, 4 bytes length
    buffer.writeUInt8(this.getMessageType(message), 0);
    buffer.writeUInt32LE(jsonBuffer.length, 1);
    jsonBuffer.copy(buffer, 5);
    
    return buffer;
  }
  
  decode(buffer: Buffer): any {
    if (buffer.length < 5) {
      throw new Error('Invalid binary message: too short');
    }
    
    const messageType = buffer.readUInt8(0);
    const length = buffer.readUInt32LE(1);
    
    if (buffer.length < 5 + length) {
      throw new Error('Invalid binary message: incomplete');
    }
    
    const jsonBuffer = buffer.slice(5, 5 + length);
    const message = JSON.parse(jsonBuffer.toString('utf8'));
    
    return message;
  }
  
  private getMessageType(message: any): number {
    switch (message.type) {
      case 'ticker': return BinaryProtocolDecoder.MSG_TICKER;
      case 'trade': return BinaryProtocolDecoder.MSG_TRADE;
      case 'orderbook': return BinaryProtocolDecoder.MSG_ORDERBOOK;
      case 'heartbeat': return BinaryProtocolDecoder.MSG_HEARTBEAT;
      default: return 0x00;
    }
  }
}

// WebSocket connection manager for multiple exchanges
export class MultiExchangeWebSocketManager extends EventEmitter {
  private connections: Map<string, UltraFastWebSocket> = new Map();
  private logger: Logger;
  
  constructor(logger: Logger) {
    super();
    this.logger = logger;
  }
  
  public async addExchange(name: string, config: UltraFastWebSocketConfig): Promise<void> {
    if (this.connections.has(name)) {
      this.logger.warn(`Exchange ${name} already connected`);
      return;
    }
    
    const ws = new UltraFastWebSocket(config, this.logger);
    
    // Forward events with exchange name
    ws.on('market:data', (data) => {
      this.emit('market:data', { exchange: name, ...data });
    });
    
    ws.on('connected', () => {
      this.emit('exchange:connected', name);
    });
    
    ws.on('disconnected', () => {
      this.emit('exchange:disconnected', name);
    });
    
    ws.on('latency:warning', (data) => {
      this.emit('latency:warning', { exchange: name, ...data });
    });
    
    this.connections.set(name, ws);
    await ws.connect();
  }
  
  public removeExchange(name: string): void {
    const ws = this.connections.get(name);
    if (ws) {
      ws.disconnect();
      this.connections.delete(name);
    }
  }
  
  public getConnection(name: string): UltraFastWebSocket | undefined {
    return this.connections.get(name);
  }
  
  public getAllStats(): Record<string, any> {
    const stats: Record<string, any> = {};
    
    for (const [name, ws] of this.connections) {
      stats[name] = ws.getStats();
    }
    
    return stats;
  }
  
  public disconnectAll(): void {
    for (const ws of this.connections.values()) {
      ws.disconnect();
    }
    this.connections.clear();
  }
}
