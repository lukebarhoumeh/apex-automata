// Trading API Service - connects frontend to Atlas backend

const API_URL = import.meta.env.VITE_RUNTIME_API_URL || 'http://localhost:3001';
const WS_URL = API_URL.replace('http://', 'ws://').replace('https://', 'wss://');

export interface TradingEngineStatus {
  engineRunning: boolean;
  mode: 'paper' | 'live';
  positions: any[];
  riskMetrics: any;
  activeOrders: any[];
}

class TradingApiService {
  private ws: WebSocket | null = null;
  private listeners: Map<string, Set<Function>> = new Map();
  private reconnectTimeout: NodeJS.Timeout | null = null;
  private isConnecting = false;

  constructor() {
    this.connect();
  }

  private connect() {
    if (this.isConnecting || (this.ws && this.ws.readyState === WebSocket.OPEN)) {
      return;
    }

    this.isConnecting = true;
    console.log('Connecting to trading engine WebSocket...');

    try {
      this.ws = new WebSocket(WS_URL);

      this.ws.onopen = () => {
        console.log('Connected to trading engine');
        this.isConnecting = false;
        this.emit('connected', {});
      };

      this.ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);
          this.handleMessage(message);
        } catch (error) {
          console.error('Failed to parse WebSocket message:', error);
        }
      };

      this.ws.onerror = (error) => {
        console.error('WebSocket error:', error);
        this.isConnecting = false;
      };

      this.ws.onclose = () => {
        console.log('Disconnected from trading engine');
        this.isConnecting = false;
        this.emit('disconnected', {});
        
        // Attempt to reconnect after 5 seconds
        if (!this.reconnectTimeout) {
          this.reconnectTimeout = setTimeout(() => {
            this.reconnectTimeout = null;
            this.connect();
          }, 5000);
        }
      };
    } catch (error) {
      console.error('Failed to create WebSocket connection:', error);
      this.isConnecting = false;
    }
  }

  private handleMessage(message: any) {
    const { type, data, payload } = message;
    // Backend sends payload, not data
    this.emit(type, payload || data);
  }

  private emit(event: string, data: any) {
    const listeners = this.listeners.get(event);
    if (listeners) {
      listeners.forEach(listener => listener(data));
    }
  }

  public on(event: string, callback: Function) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(callback);

    // Return unsubscribe function
    return () => {
      const listeners = this.listeners.get(event);
      if (listeners) {
        listeners.delete(callback);
      }
    };
  }

  public async getStatus(): Promise<TradingEngineStatus> {
    const response = await fetch(`${API_URL}/api/status`);
    if (!response.ok) {
      throw new Error('Failed to get status');
    }
    return response.json();
  }

  public async startEngine(
    mode: 'paper' | 'live' = 'paper',
    opts?: { confirm?: string; marketDataEnv?: 'sandbox' | 'production' }
  ): Promise<any> {
    const response = await fetch(`${API_URL}/api/engine/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode, ...opts })
    });
    
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to start engine');
    }
    
    return response.json();
  }

  public async stopEngine(): Promise<any> {
    const response = await fetch(`${API_URL}/api/engine/stop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to stop engine');
    }
    
    return response.json();
  }

  public async activateKillSwitch(): Promise<any> {
    const response = await fetch(`${API_URL}/api/engine/kill`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to activate kill switch');
    }
    
    return response.json();
  }

  public disconnect() {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}

// Export singleton instance
export const tradingApi = new TradingApiService();
