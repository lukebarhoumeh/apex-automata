import { EventEmitter } from 'events';
import { Logger } from '../core/logger';
import { AppConfig } from '../core/types';
import { CoinbaseExchange, CoinbaseConfig, Ticker, OrderBook, Fill, OrderRequest } from '../exchanges/coinbase';
import { OrderManager, OrderManagerConfig, ManagedOrder } from './order-manager';
import { PositionTracker, PositionTrackerConfig, Position } from './position-tracker';
import { RiskEngine, RiskEngineConfig, RiskMetrics } from './risk-engine';
import { SecretManager, SecretConfig } from '../config/secrets';
import { PaperTradingSimulator, PaperTradingConfig } from './paper-trading-simulator';
import { PositionMonitor, PositionMonitorConfig } from './position-monitor';
import { GuardrailConfig } from '../config/loadGuardrails';
import { v4 as uuidv4 } from 'uuid';

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
    userId?: string;
  };
  security: {
    encryptionKey: string;
  };
  guardrails: GuardrailConfig;
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

// Startup grace period before data gap checks begin (ms)
const STARTUP_GRACE_PERIOD_MS = 60_000; // 60 seconds

// Environment-specific data gap thresholds (in seconds)
const DATA_GAP_THRESHOLDS: Record<string, number> = {
  sandbox: 30,    // More lenient for sandbox/dev
  production: 2,  // Strict for live trading
};

export class TradingEngine extends EventEmitter {
  private config: TradingEngineConfig;
  private logger: Logger;
  private exchange: CoinbaseExchange | null = null;
  private orderManager: OrderManager | null = null;
  private positionTracker: PositionTracker | null = null;
  private riskEngine: RiskEngine | null = null;
  private positionMonitor: PositionMonitor | null = null;
  private secretManager: SecretManager;
  private paperSimulator: PaperTradingSimulator | null = null;
  private isRunning = false;
  private marketPrices: Map<string, number> = new Map();
  private guardrails: GuardrailConfig;
  
  // Per-symbol market data timestamp tracking for data gap detection
  private lastMarketDataPerSymbol: Map<string, number> = new Map();
  private dataGapMonitor: NodeJS.Timeout | null = null;
  private engineStartTime = 0;
  
  // Active symbols that are actually subscribed (may differ from config if some aren't available)
  private activeSymbols: string[] = [];

  constructor(config: TradingEngineConfig, logger: Logger) {
    super();
    this.config = config;
    this.logger = logger;
    this.guardrails = config.guardrails;

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

  public getConfig(): TradingEngineConfig {
    return this.config;
  }

  public get engineRunning(): boolean {
    return this.isRunning;
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
      this.initializePositionMonitor();

      // Setup event handlers
      this.setupEventHandlers();

      // Connect to exchange
      await this.exchange!.connect();

      // Wait a bit for WebSocket to fully establish
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Validate products and subscribe to market data
      await this.validateAndSubscribeToMarketData();
      
      // Record engine start time for grace period
      this.engineStartTime = Date.now();
      
      // Initialize per-symbol data timestamps
      for (const symbol of this.activeSymbols) {
        this.lastMarketDataPerSymbol.set(symbol, Date.now());
      }
      
      this.startDataGapMonitor();

      this.isRunning = true;
      this.emit('engine:started');
      
      this.logger.info('Trading engine started successfully', {
        mode: this.config.mode,
        activeSymbols: this.activeSymbols,
        gracePeriodMs: STARTUP_GRACE_PERIOD_MS,
      });
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
          await this.cancelOrder(order.id);
        }
      }
      
      // Flatten positions on shutdown if configured
      if (this.guardrails?.compliance?.flatten_on_shutdown && this.positionTracker) {
        try {
          if (!this.positionTracker.isFlatteningInProgress()) {
            await this.positionTracker.closeAllPositions();
          }
          
          // Best-effort wait for closes to be processed (paper fills are immediate; live fills rely on polling/WS).
          const timeoutMs = Math.max(5000, (this.guardrails.execution.order_timeout_sec || 5) * 1000 * 3);
          await this.waitForPositionsToClose(timeoutMs);
        } catch (err) {
          this.logger.error('Flatten-on-shutdown failed:', err);
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
      
      if (this.positionMonitor) {
        this.positionMonitor.stop();
      }

      if (this.dataGapMonitor) {
        clearInterval(this.dataGapMonitor);
        this.dataGapMonitor = null;
      }

      this.isRunning = false;
      this.emit('engine:stopped');
      
      this.logger.info('Trading engine stopped');
    } catch (error) {
      this.logger.error('Error stopping trading engine:', error);
      this.emit('engine:error', error as Error);
    }
  }

  private async waitForPositionsToClose(timeoutMs: number): Promise<void> {
    const started = Date.now();
    const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
    
    while (Date.now() - started < timeoutMs) {
      const open = this.positionTracker?.getOpenPositions() || [];
      if (open.length === 0) {
        return;
      }
      await sleep(250);
    }
    
    const remaining = this.positionTracker?.getOpenPositions() || [];
    if (remaining.length > 0) {
      this.logger.warn('Timeout waiting for positions to close', {
        remaining: remaining.map(p => ({ symbol: p.symbol, side: p.side, size: p.size })),
        timeoutMs,
      });
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
    // Calculate risk limits from guardrails
    const accountEquity = this.guardrails.account.equity_usd;
    const maxPositionValue = accountEquity * this.guardrails.risk.max_position_exposure_pct;
    const maxUnrealizedLoss = accountEquity * Math.abs(this.guardrails.risk.daily_loss_limit);
    const maxDrawdownPct = Math.abs(this.guardrails.risk.max_drawdown_limit) * 100;
    
    const config: PositionTrackerConfig = {
      supabaseUrl: this.config.supabase.url,
      supabaseKey: this.config.supabase.serviceKey,
      updateInterval: 5000, // 5 seconds
      pnlCalculationMethod: 'fifo',
      // Risk limits from guardrails
      maxPositionValueUsd: maxPositionValue,
      maxUnrealizedLossUsd: maxUnrealizedLoss,
      drawdownWarningPct: maxDrawdownPct * 0.5, // Warning at half of max drawdown
      drawdownCriticalPct: maxDrawdownPct,
    };

    this.positionTracker = new PositionTracker(config, this.logger);
    
    // Set up order creator for flatten operations
    // Note: This uses a self-reference that will work after all components are initialized
    this.positionTracker.setOrderCreator(async (symbol, side, size, tag) => {
      try {
        const order = await this.createOrder({
          product_id: symbol,
          side,
          type: 'market',
          size: size.toString(),
        }, {
          strategy: 'system',
          metadata: {
            tag: tag || 'flatten',
            reason: tag === 'flatten' ? 'flatten' : 'position_action',
          }
        });
        
        if (order) {
          // Tag the order as a flatten order in metadata
          if (tag === 'flatten') {
            this.logger.info(`Flatten order created for ${symbol}`, { orderId: order.id });
          }
          return order.id;
        }
        return null;
      } catch (error) {
        this.logger.error(`Failed to create flatten order for ${symbol}:`, error);
        return null;
      }
    });
  }

  private initializeRiskEngine(): void {
    const guardrails = this.config.guardrails;
    const accountEquity = guardrails.account.equity_usd;
    const maxPositionSizeUsd = accountEquity * guardrails.risk.max_position_exposure_pct;
    const maxTotalExposureUsd = accountEquity * guardrails.account.max_account_leverage;
    const maxDailyLossUsd = Math.abs(guardrails.risk.daily_loss_limit) * accountEquity;
    const maxDrawdownPercent = Math.abs(guardrails.risk.max_drawdown_limit) * 100;
    const minOrderUsd = accountEquity * guardrails.account.risk_per_trade * guardrails.account.min_notional_buffer;

    const config: RiskEngineConfig = {
      supabaseUrl: this.config.supabase.url,
      supabaseKey: this.config.supabase.serviceKey,
      userId: this.config.supabase.userId,
      limits: {
        maxPositionSize: maxPositionSizeUsd,
        maxTotalExposure: maxTotalExposureUsd,
        maxDailyLoss: maxDailyLossUsd,
        maxDrawdown: maxDrawdownPercent,
        maxOrderSize: maxPositionSizeUsd,
        minOrderSize: minOrderUsd,
        maxOpenOrders: guardrails.account.max_open_positions,
        maxLeverage: guardrails.account.max_account_leverage
      },
      killSwitches: {
        enabled: true,
        dailyLossLimit: maxDailyLossUsd,
        consecutiveLossLimit: 5,     // 5 losses in a row
        errorRateLimit: 20,          // 20% error rate
        latencyLimit: guardrails.circuit_breakers.data_gap_sec * 1000
      },
      riskPerTrade: guardrails.account.risk_per_trade * 100,
      kellyFraction: 0.25,
      guardrails,
      accountEquity
    };

    this.riskEngine = new RiskEngine(config, this.logger, this.positionTracker!);
  }
  
  private initializePositionMonitor(): void {
    const config: PositionMonitorConfig = {
      guardrails: this.guardrails,
      checkIntervalMs: 1000, // Check positions every second
    };
    
    this.positionMonitor = new PositionMonitor(config, this.logger, this.positionTracker!);
    
    // Set up order creator for exit orders
    this.positionMonitor.setOrderCreator(async (symbol, side, size) => {
      try {
        const order = await this.createOrder({
          product_id: symbol,
          side,
          type: 'market',
          size: size.toString(),
        }, {
          strategy: 'system',
          metadata: {
            tag: 'exit',
            reason: 'position_exit',
          }
        });
        return order !== null;
      } catch (error) {
        this.logger.error('Position monitor failed to create exit order:', error);
        return false;
      }
    });
    
    // Listen for exit events
    this.positionMonitor.on('exit:triggered', (condition) => {
      this.emit('position:exit:triggered', condition);
    });
    
    this.positionMonitor.on('exit:executed', (positionId, condition) => {
      this.logger.info('Position exit executed', { positionId, type: condition.type });
    });
    
    this.positionMonitor.on('exit:failed', (positionId, error) => {
      this.logger.error('Position exit failed', { positionId, error: error.message });
    });
    
    // Start monitoring
    this.positionMonitor.start();
    
    this.logger.info('Position monitor initialized');
  }

  private initializePaperSimulator(): void {
    const config: PaperTradingConfig = {
      initialBalances: new Map([
        ['USD', this.guardrails.account.equity_usd],
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
      // Re-emit through the exchange event pipeline so OrderManager + engine handlers stay consistent.
      // This ensures paper fills produce order:filled events just like live trading.
      if (this.exchange) {
        this.exchange.emit('fill', fill);
      } else {
        void this.handleFill(fill);
      }
    });
    
    this.logger.info('Paper trading simulator initialized');
  }

  private setupEventHandlers(): void {
    // Exchange events
    this.exchange!.on('ticker', this.handleTicker.bind(this));
    this.exchange!.on('orderbook', this.handleOrderBook.bind(this));
    this.exchange!.on('fill', this.handleFill.bind(this));
    this.exchange!.on('error', (error) => this.emit('engine:error', error));
    
    // Handle WebSocket reconnection - reset data gap tracking
    this.exchange!.on('reconnected', () => {
      this.logger.info('Exchange reconnected - resetting data gap tracking');
      this.resetDataGapTracking();
    });

    // Order manager events
    this.orderManager!.on('order:created', (order) => this.emit('order:created', order));
    this.orderManager!.on('order:filled', (order, fill) => this.emit('order:filled', order, fill));

    // Position tracker events
    this.positionTracker!.on('position:opened', (position) => this.emit('position:update', position));
    this.positionTracker!.on('position:updated', (position) => this.emit('position:update', position));
    this.positionTracker!.on('position:closed', (position) => this.emit('position:update', position));

    // Risk engine events
    this.riskEngine!.on('risk:alert', (symbol, alert) => this.emit('risk:alert', { symbol, alert }));
    this.riskEngine!.on('risk:killswitch:triggered', async (reason) => {
      this.logger.error(`Kill switch triggered: ${reason}`);
      await this.stop();
    });
    this.riskEngine!.on('risk:metrics:update', (metrics) => this.emit('risk:metrics', metrics));
  }

  private async validateAndSubscribeToMarketData(): Promise<void> {
    const configuredProducts = this.config.products;
    
    // Try to fetch available products from exchange
    let availableProductIds: Set<string>;
    try {
      const products = await this.exchange!.getProducts();
      availableProductIds = new Set(products.map(p => p.id));
      this.logger.info(`Exchange has ${availableProductIds.size} available products`);
    } catch (error) {
      // If we can't fetch products (e.g., no auth in sandbox), use all configured
      this.logger.warn('Could not fetch available products from exchange, using all configured:', error);
      availableProductIds = new Set(configuredProducts);
    }
    
    // Intersect configured with available
    const validProducts: string[] = [];
    const skippedProducts: string[] = [];
    
    for (const product of configuredProducts) {
      if (availableProductIds.has(product)) {
        validProducts.push(product);
      } else {
        skippedProducts.push(product);
      }
    }
    
    // Log skipped products
    if (skippedProducts.length > 0) {
      this.logger.warn(`Skipping unavailable products: ${skippedProducts.join(', ')}`);
    }
    
    if (validProducts.length === 0) {
      this.logger.error('No valid products available for subscription');
      throw new Error('No valid products available - check exchange environment and product configuration');
    }
    
    // Set active symbols
    this.activeSymbols = validProducts;
    
    // Subscribe to ticker for all valid products
    this.exchange!.subscribeTicker(this.activeSymbols);
    
    this.logger.info(`Subscribed to ${this.activeSymbols.length} symbols: ${this.activeSymbols.join(', ')}`);
    
    // Note: level2 orderbook requires authentication in sandbox
    // For paper trading, ticker data is sufficient
  }
  
  // Deprecated - use validateAndSubscribeToMarketData instead
  private subscribeToMarketData(): void {
    // Call async version and don't await (for backwards compatibility during transition)
    this.validateAndSubscribeToMarketData().catch(error => {
      this.logger.error('Failed to validate and subscribe to market data:', error);
    });
  }
  
  // Public getter for active symbols (used by API/status endpoints)
  public getActiveSymbols(): string[] {
    return [...this.activeSymbols];
  }
  
  // Notify engine components that a new candle has been produced for a symbol (used for time stops).
  public notifyNewCandle(symbol: string): void {
    if (this.positionMonitor) {
      this.positionMonitor.incrementBarCount(symbol);
    }
  }

  private startDataGapMonitor(): void {
    if (this.dataGapMonitor) {
      clearInterval(this.dataGapMonitor);
    }
    
    // Use environment-specific threshold or fall back to config
    const envThreshold = DATA_GAP_THRESHOLDS[this.config.exchange.environment];
    const configThreshold = this.guardrails.circuit_breakers.data_gap_sec;
    const dataGapSec = envThreshold ?? configThreshold;
    const gapMs = dataGapSec * 1000;
    
    if (gapMs <= 0) {
      this.logger.warn('Data gap monitoring disabled (threshold <= 0)');
      return;
    }
    
    this.logger.info(`Data gap monitor started: threshold=${dataGapSec}s, gracePeriod=${STARTUP_GRACE_PERIOD_MS}ms`);
    
    // Check more frequently than the threshold
    const checkIntervalMs = Math.max(1000, gapMs / 2);
    
    this.dataGapMonitor = setInterval(() => {
      if (!this.isRunning) {
        return;
      }
      
      // Skip checks during startup grace period
      const timeSinceStart = Date.now() - this.engineStartTime;
      if (timeSinceStart < STARTUP_GRACE_PERIOD_MS) {
        return;
      }
      
      // Check each symbol's last data timestamp
      const now = Date.now();
      const staleSymbols: Array<{ symbol: string; elapsedMs: number }> = [];
      let allSymbolsStale = true;
      
      for (const symbol of this.activeSymbols) {
        const lastTs = this.lastMarketDataPerSymbol.get(symbol) || 0;
        const elapsed = now - lastTs;
        
        if (elapsed > gapMs) {
          staleSymbols.push({ symbol, elapsedMs: elapsed });
        } else {
          allSymbolsStale = false;
        }
      }
      
      // Only trigger kill switch if ALL active symbols have stale data
      if (staleSymbols.length > 0 && allSymbolsStale && this.activeSymbols.length > 0) {
        const symbolDetails = staleSymbols
          .map(s => `${s.symbol}(${Math.round(s.elapsedMs / 1000)}s)`)
          .join(', ');
        
        this.logger.error(`Market data gap detected on ALL symbols: ${symbolDetails} - triggering kill switch`);
        this.riskEngine?.activateKillSwitch(`Market data gap detected: ${symbolDetails}`);
      } else if (staleSymbols.length > 0) {
        // Log warning for partial staleness
        const symbolDetails = staleSymbols
          .map(s => `${s.symbol}(${Math.round(s.elapsedMs / 1000)}s)`)
          .join(', ');
        this.logger.warn(`Stale data on some symbols (not all): ${symbolDetails}`);
      }
    }, checkIntervalMs);
  }
  
  // Reset data gap tracking (called after WS reconnect)
  public resetDataGapTracking(): void {
    const now = Date.now();
    for (const symbol of this.activeSymbols) {
      this.lastMarketDataPerSymbol.set(symbol, now);
    }
    this.logger.info('Data gap tracking reset after reconnection');
  }

  private handleTicker(ticker: Ticker): void {
    // Update per-symbol data timestamp for data gap tracking
    this.lastMarketDataPerSymbol.set(ticker.product_id, Date.now());

    // Update market price
    const price = parseFloat(ticker.price);
    this.marketPrices.set(ticker.product_id, price);

    // Update position tracker
    this.positionTracker!.updateMarketPrice(ticker.product_id, price);
    
    // Update position monitor for stop/target checking
    if (this.positionMonitor) {
      this.positionMonitor.updatePrice(ticker.product_id, price);
    }

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
    // Try to associate fills with their originating managed order (for stop/target + strategy metadata)
    const managedOrder = this.orderManager?.getOrderByExchangeOrderId(fill.order_id);
    await this.positionTracker!.processFill(fill, {
      strategy: managedOrder?.strategy,
      signalId: managedOrder?.metadata?.signalId,
      stopPrice: managedOrder?.metadata?.stopPrice,
      takeProfit: managedOrder?.metadata?.takeProfit,
      tag: managedOrder?.metadata?.tag,
    });
    
    // Update risk engine metrics
    this.riskEngine!.recordOrderResult(fill.order_id, true, 0);
    
    // Update open order count after fills (both paper + live)
    const activeOrders = this.orderManager?.getActiveOrders() || [];
    this.riskEngine!.updateOpenOrderCount(activeOrders.length);
  }

  // Public API for placing orders
  public async createOrder(
    request: Omit<OrderRequest, 'client_oid'>,
    context?: {
      strategy?: string;
      metadata?: Record<string, any>;
    }
  ): Promise<ManagedOrder | null> {
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
          if (!this.orderManager) {
            throw new Error('OrderManager not initialized');
          }

          // Create/track the order BEFORE simulating execution so immediate fills can be matched
          const clientOrderId = uuidv4();
          const parsedSize = request.size ? parseFloat(request.size) : 0;
          const managedOrder: ManagedOrder = {
            id: clientOrderId,
            clientOrderId,
            exchangeOrderId: undefined,
            product: request.product_id,
            productId: request.product_id,
            side: request.side,
            type: request.type,
            size: Number.isFinite(parsedSize) ? parsedSize : 0,
            price: request.price ? parseFloat(request.price) : undefined,
            status: 'pending',
            filledSize: 0,
            executedValue: 0,
            fee: 0,
            createdAt: new Date(),
            updatedAt: new Date(),
            fills: [],
            metadata: context?.metadata ?? {},
            strategy: context?.strategy,
          };

          await this.orderManager.trackPaperOrder(managedOrder);

          const paperOrder = await this.paperSimulator.placeOrder({
            ...(request as any),
            client_oid: clientOrderId,
          } as OrderRequest);
          
          // Best-effort state sync from simulator response (fills/events may have already updated the order)
          managedOrder.exchangeOrderId = paperOrder.id;
          const responseCreatedAt = new Date(paperOrder.created_at);
          if (Number.isFinite(responseCreatedAt.getTime())) {
            managedOrder.updatedAt = new Date(Math.max(managedOrder.updatedAt.getTime(), responseCreatedAt.getTime()));
          }
          const currentStatus = String(managedOrder.status || '').toLowerCase();
          const terminalStatuses = new Set(['filled', 'done', 'cancelled', 'canceled', 'rejected', 'failed']);
          if (!terminalStatuses.has(currentStatus)) {
            managedOrder.status = paperOrder.status;
          }
          const filled = Number.parseFloat(paperOrder.filled_size);
          const executed = Number.parseFloat(paperOrder.executed_value);
          const fees = Number.parseFloat(paperOrder.fill_fees);
          if (Number.isFinite(filled) && filled > managedOrder.filledSize) {
            managedOrder.filledSize = filled;
          }
          if (Number.isFinite(executed) && executed > managedOrder.executedValue) {
            managedOrder.executedValue = executed;
          }
          if (Number.isFinite(fees) && fees > managedOrder.fee) {
            managedOrder.fee = fees;
          }
          
          // Update open order count after this order (paper mode)
          const activeOrders = this.orderManager.getActiveOrders();
          this.riskEngine!.updateOpenOrderCount(activeOrders.length);
          
          return managedOrder;
        } catch (error) {
          this.logger.error('Paper order failed:', error);
          throw error;
        }
      }

      // Place order
      const order = await this.orderManager!.createOrder(request, {
        metadata: context?.metadata,
        strategy: context?.strategy,
      });
      
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

    // Paper mode cancellations must go through the simulator (no authenticated REST available)
    if (this.config.mode === 'paper' && this.paperSimulator && this.orderManager) {
      const cancelled = await this.paperSimulator.cancelOrder(orderId);
      if (cancelled) {
        this.orderManager.cancelLocalOrder(orderId);
      }
      // Update open order count after cancel attempt
      const activeOrders = this.orderManager.getActiveOrders();
      this.riskEngine!.updateOpenOrderCount(activeOrders.length);
      return cancelled;
    }
    
    const result = await this.orderManager!.cancelOrder(orderId);
    const activeOrders = this.orderManager!.getActiveOrders();
    this.riskEngine!.updateOpenOrderCount(activeOrders.length);
    return result;
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

  public computeOrderSize(productId: string, entryPrice: number, stopPrice: number): number {
    if (!this.riskEngine) {
      return 0;
    }
    return this.riskEngine.computeOrderSize(productId, entryPrice, stopPrice);
  }
}
