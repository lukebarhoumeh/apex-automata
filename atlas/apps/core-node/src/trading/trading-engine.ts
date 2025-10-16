import { EventEmitter } from 'events';
import { Logger } from '../core/logger';
import { AppConfig } from '../core/types';
import { CoinbaseExchange, CoinbaseConfig, Ticker, OrderBook, Fill, OrderRequest } from '../exchanges/coinbase';
import { OrderManager, OrderManagerConfig, ManagedOrder } from './order-manager';
import { PositionTracker, PositionTrackerConfig, Position } from './position-tracker';
import { RiskEngine, RiskEngineConfig, RiskMetrics } from './risk-engine';
import { SecretManager, SecretConfig } from '../config/secrets';
import { PaperTradingSimulator, PaperTradingConfig } from './paper-trading-simulator';

export interface TradingEngineConfig {
  mode: 'paper' | 'live';
  exchange: {
    name: 'coinbase';
    environment: 'production' | 'sandbox';
  };
  products: string[]; // e.g., ['BTC-USD', 'ETH-USD']
  supabase: {
    url: string;
    serviceKey: string;
    anonKey: string;
  };
  security: {
    encryptionKey: string;
  };
}

export interface TradingEngineEvents {
  'engine:started': () => void;
  'engine:stopped': () => void;
  'engine:error': (error: Error) => void;
  'market:ticker': (ticker: Ticker) => void;
  'market:orderbook': (orderbook: OrderBook) => void;
  'order:created': (order: ManagedOrder) => void;
  'order:filled': (order: ManagedOrder, fill: Fill) => void;
  'position:update': (position: Position) => void;
  'risk:alert': (alert: any) => void;
  'signal:generated': (signal: any) => void;
}

export class TradingEngine extends EventEmitter {
  private config: TradingEngineConfig;
  private logger: Logger;
  private exchange: CoinbaseExchange | null = null;
  private orderManager: OrderManager | null = null;
  private positionTracker: PositionTracker | null = null;
  private riskEngine: RiskEngine | null = null;
  private secretManager: SecretManager;
  private paperSimulator: PaperTradingSimulator | null = null;
  private isRunning = false;
  private marketPrices: Map<string, number> = new Map();

  constructor(config: TradingEngineConfig, logger: Logger) {
    super();
    this.config = config;
    this.logger = logger;

    // Initialize secret manager
    this.secretManager = new SecretManager(
      {
        supabaseUrl: config.supabase.url,
        supabaseServiceKey: config.supabase.serviceKey,
        encryptionKey: config.security.encryptionKey
      },
      logger
    );
  }

  public async start(): Promise<void> {
    if (this.isRunning) {
      this.logger.warn('Trading engine already running');
      return;
    }

    try {
      this.logger.info(`Starting trading engine in ${this.config.mode} mode`);

      // Initialize paper trading simulator if in paper mode
      if (this.config.mode === 'paper') {
        this.initializePaperSimulator();
      }

      // Initialize exchange
      await this.initializeExchange();

      // Initialize components
      this.initializeOrderManager();
      this.initializePositionTracker();
      this.initializeRiskEngine();

      // Setup event handlers
      this.setupEventHandlers();

      // Connect to exchange
      await this.exchange!.connect();

      // Wait a bit for WebSocket to fully establish
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Subscribe to market data
      this.subscribeToMarketData();

      this.isRunning = true;
      this.emit('engine:started');
      
      this.logger.info('Trading engine started successfully');
    } catch (error) {
      this.logger.error('Failed to start trading engine:', error);
      this.emit('engine:error', error as Error);
      throw error;
    }
  }

  public async stop(): Promise<void> {
    if (!this.isRunning) {
      this.logger.warn('Trading engine not running');
      return;
    }

    try {
      this.logger.info('Stopping trading engine');

      // Cancel all open orders
      if (this.orderManager) {
        const activeOrders = this.orderManager.getActiveOrders();
        for (const order of activeOrders) {
          await this.orderManager.cancelOrder(order.id);
        }
      }

      // Disconnect from exchange
      if (this.exchange) {
        this.exchange.disconnect();
      }

      // Stop components
      if (this.positionTracker) {
        this.positionTracker.stopUpdateLoop();
      }

      if (this.riskEngine) {
        this.riskEngine.stop();
      }

      this.isRunning = false;
      this.emit('engine:stopped');
      
      this.logger.info('Trading engine stopped');
    } catch (error) {
      this.logger.error('Error stopping trading engine:', error);
      this.emit('engine:error', error as Error);
    }
  }

  private async initializeExchange(): Promise<void> {
    let credentials;
    
    try {
      // Get exchange credentials
      credentials = await this.secretManager.getExchangeCredentials(
        this.config.exchange.name,
        this.config.exchange.environment
      );
    } catch (error) {
      this.logger.warn('Failed to retrieve exchange credentials:', error);
      credentials = null;
    }

    // Allow paper mode without stored credentials (market-data only)
    if (!credentials && this.config.mode === 'paper') {
      this.logger.warn('No exchange credentials found in Supabase. Proceeding in paper mode with market data only.');
      credentials = {
        apiKey: '',
        apiSecret: '',
        apiPassphrase: undefined,
        exchange: this.config.exchange.name,
        environment: this.config.exchange.environment,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
    }

    if (!credentials) {
      throw new Error(`No credentials found for ${this.config.exchange.name} (${this.config.exchange.environment})`);
    }

    // Configure Coinbase
    const coinbaseConfig: CoinbaseConfig = {
      apiKey: credentials.apiKey,
      apiSecret: credentials.apiSecret,
      apiPassphrase: credentials.apiPassphrase,
      environment: this.config.exchange.environment,
      wsUrl: this.config.exchange.environment === 'production'
        ? 'wss://ws-feed.exchange.coinbase.com'
        : 'wss://ws-feed-public.sandbox.exchange.coinbase.com',
      restUrl: this.config.exchange.environment === 'production'
        ? 'https://api.exchange.coinbase.com'
        : 'https://api-public.sandbox.exchange.coinbase.com'
    };

    this.exchange = new CoinbaseExchange(coinbaseConfig, this.logger);
  }

  private initializeOrderManager(): void {
    const config: OrderManagerConfig = {
      supabaseUrl: this.config.supabase.url,
      supabaseKey: this.config.supabase.serviceKey,
      defaultTimeInForce: 'GTC',
      maxOrderRetries: 3,
      postOnlyRetries: 5,
      twapConfig: {
        minSliceSize: 0.001,
        maxSliceSize: 0.1,
        sliceDuration: 60000, // 1 minute
        randomizeSize: true,
        randomizeTime: true
      }
    };

    this.orderManager = new OrderManager(config, this.logger, this.exchange!);
  }

  private initializePositionTracker(): void {
    const config: PositionTrackerConfig = {
      supabaseUrl: this.config.supabase.url,
      supabaseKey: this.config.supabase.serviceKey,
      updateInterval: 5000, // 5 seconds
      pnlCalculationMethod: 'fifo'
    };

    this.positionTracker = new PositionTracker(config, this.logger);
  }

  private initializeRiskEngine(): void {
    const config: RiskEngineConfig = {
      supabaseUrl: this.config.supabase.url,
      supabaseKey: this.config.supabase.serviceKey,
      limits: {
        maxPositionSize: 10000,      // $10k per position
        maxTotalExposure: 30000,     // $30k total
        maxDailyLoss: 1000,          // $1k daily loss
        maxDrawdown: 10,             // 10% drawdown
        maxOrderSize: 5000,          // $5k per order
        minOrderSize: 10,            // $10 minimum
        maxOpenOrders: 10,           // 10 concurrent orders
        maxLeverage: 1               // No leverage
      },
      killSwitches: {
        enabled: true,
        dailyLossLimit: 1500,        // $1.5k
        consecutiveLossLimit: 5,     // 5 losses in a row
        errorRateLimit: 20,          // 20% error rate
        latencyLimit: 1000           // 1 second
      },
      riskPerTrade: 1,               // 1% risk per trade
      kellyFraction: 0.25            // Quarter Kelly
    };

    this.riskEngine = new RiskEngine(config, this.logger, this.positionTracker!);
  }

  private initializePaperSimulator(): void {
    const config: PaperTradingConfig = {
      initialBalances: new Map([
        ['USD', 10000],  // Start with $10k
        ['BTC', 0],
        ['ETH', 0]
      ]),
      makerFee: 0.004,  // 0.4%
      takerFee: 0.006,  // 0.6%
      slippage: 0.001,  // 0.1%
      latencyMs: 100    // 100ms simulated latency
    };

    this.paperSimulator = new PaperTradingSimulator(config, this.logger);
    
    // Listen for fills from simulator
    this.paperSimulator.on('fill', (fill: Fill) => {
      this.handleFill(fill);
    });
    
    this.logger.info('Paper trading simulator initialized');
  }

  private setupEventHandlers(): void {
    // Exchange events
    this.exchange!.on('ticker', this.handleTicker.bind(this));
    this.exchange!.on('orderbook', this.handleOrderBook.bind(this));
    this.exchange!.on('fill', this.handleFill.bind(this));
    this.exchange!.on('error', (error) => this.emit('engine:error', error));

    // Order manager events
    this.orderManager!.on('order:created', (order) => this.emit('order:created', order));
    this.orderManager!.on('order:filled', (order, fill) => this.emit('order:filled', order, fill));

    // Position tracker events
    this.positionTracker!.on('position:updated', (position) => this.emit('position:update', position));

    // Risk engine events
    this.riskEngine!.on('risk:alert', (symbol, alert) => this.emit('risk:alert', { symbol, alert }));
    this.riskEngine!.on('risk:killswitch:triggered', async (reason) => {
      this.logger.error(`Kill switch triggered: ${reason}`);
      await this.stop();
    });
  }

  private subscribeToMarketData(): void {
    // Subscribe to ticker for all products
    this.exchange!.subscribeTicker(this.config.products);
    
    // Note: level2 orderbook requires authentication in sandbox
    // For paper trading, ticker data is sufficient
  }

  private handleTicker(ticker: Ticker): void {
    // Update market price
    const price = parseFloat(ticker.price);
    this.marketPrices.set(ticker.product_id, price);
    
    // Update position tracker
    this.positionTracker!.updateMarketPrice(ticker.product_id, price);
    
    // Update paper simulator if in paper mode
    if (this.config.mode === 'paper' && this.paperSimulator) {
      this.paperSimulator.updateFromTicker(ticker);
    }
    
    // Emit ticker event
    this.emit('market:ticker', ticker);
  }

  private handleOrderBook(orderbook: OrderBook): void {
    // Emit orderbook event
    this.emit('market:orderbook', orderbook);
  }

  private async handleFill(fill: Fill): Promise<void> {
    // Update position tracker
    await this.positionTracker!.processFill(fill);
    
    // Update risk engine metrics
    this.riskEngine!.recordOrderResult(fill.order_id, true, 0);
  }

  // Public API for placing orders
  public async createOrder(request: Omit<OrderRequest, 'client_oid'>): Promise<ManagedOrder | null> {
    if (!this.isRunning) {
      throw new Error('Trading engine not running');
    }

    try {
      // Get current price
      const currentPrice = this.marketPrices.get(request.product_id) || parseFloat(request.price || '0');

      // Pre-trade risk check
      const riskCheck = await this.riskEngine!.checkOrder(request, currentPrice);
      
      if (!riskCheck.passed) {
        this.logger.warn(`Order rejected by risk engine: ${riskCheck.reason}`);
        return null;
      }

      // Paper trading mode
      if (this.config.mode === 'paper' && this.paperSimulator) {
        this.logger.info('Paper trading mode - simulating order execution');
        
        try {
          const paperOrder = await this.paperSimulator.placeOrder(request);
          
          // Create managed order from paper order
          const managedOrder: ManagedOrder = {
            id: paperOrder.id,
            clientOrderId: request.client_oid || paperOrder.id,
            exchangeOrderId: paperOrder.id,
            product: request.product_id,
            side: request.side,
            type: request.type,
            size: parseFloat(request.size),
            price: request.price ? parseFloat(request.price) : undefined,
            status: paperOrder.status,
            filledSize: parseFloat(paperOrder.filled_size),
            executedValue: parseFloat(paperOrder.executed_value),
            fee: parseFloat(paperOrder.fill_fees),
            createdAt: new Date(paperOrder.created_at),
            updatedAt: new Date(paperOrder.created_at),
            fills: []
          };
          
          // Track order in order manager
          await this.orderManager!.trackPaperOrder(managedOrder);
          
          return managedOrder;
        } catch (error) {
          this.logger.error('Paper order failed:', error);
          throw error;
        }
      }

      // Place order
      const order = await this.orderManager!.createOrder(request);
      
      // Update open order count
      const activeOrders = this.orderManager!.getActiveOrders();
      this.riskEngine!.updateOpenOrderCount(activeOrders.length);

      return order;
    } catch (error) {
      this.logger.error('Failed to create order:', error);
      this.riskEngine!.recordOrderResult('', false, 0);
      throw error;
    }
  }

  // Create TWAP order
  public async createTWAPOrder(
    request: Omit<OrderRequest, 'client_oid' | 'size'> & {
      totalSize: string;
      duration: number;
      numSlices?: number;
    }
  ): Promise<any> {
    if (!this.isRunning) {
      throw new Error('Trading engine not running');
    }

    try {
      // Get current price
      const currentPrice = this.marketPrices.get(request.product_id) || parseFloat(request.price || '0');

      // Risk check for total size
      const orderRequest: OrderRequest = {
        ...request,
        size: request.totalSize,
        client_oid: ''
      };

      const riskCheck = await this.riskEngine!.checkOrder(orderRequest, currentPrice);
      
      if (!riskCheck.passed) {
        this.logger.warn(`TWAP order rejected by risk engine: ${riskCheck.reason}`);
        return null;
      }

      // Paper trading mode
      if (this.config.mode === 'paper') {
        this.logger.info('Paper trading mode - simulating TWAP execution');
        // TODO: Implement paper trading simulation
        return null;
      }

      // Create TWAP order
      return await this.orderManager!.createTWAPOrder(request);
    } catch (error) {
      this.logger.error('Failed to create TWAP order:', error);
      throw error;
    }
  }

  // Cancel order
  public async cancelOrder(orderId: string): Promise<boolean> {
    if (!this.isRunning) {
      throw new Error('Trading engine not running');
    }

    return await this.orderManager!.cancelOrder(orderId);
  }

  // Get current positions
  public getPositions(): Position[] {
    return this.positionTracker?.getPositions() || [];
  }

  // Get open positions
  public getOpenPositions(): Position[] {
    return this.positionTracker?.getOpenPositions() || [];
  }

  // Get risk metrics
  public getRiskMetrics(): RiskMetrics | null {
    return this.riskEngine?.getMetrics() || null;
  }

  // Get active orders
  public getActiveOrders(): ManagedOrder[] {
    return this.orderManager?.getActiveOrders() || [];
  }

  // Emergency stop
  public async emergencyStop(reason: string): Promise<void> {
    this.logger.error(`Emergency stop triggered: ${reason}`);
    
    if (this.riskEngine) {
      this.riskEngine.activateKillSwitch(reason);
    }

    await this.stop();
  }
}
