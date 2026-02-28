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
import { TradeAnalytics, TradeAnalyticsConfig, SessionStats, TradeRecord } from './trade-analytics';
import { GuardrailConfig } from '../config/loadGuardrails';
import { v4 as uuidv4 } from 'uuid';
import { 
  IExecutionAdapter, 
  BrokerOrderEvent,
  getMarketDataUrls,
} from './execution';
import {
  createAdapters,
  RuntimeConfig,
  buildRuntimeConfig,
} from './execution/adapter-factory';
import { IAccountProvider } from './account';

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
  
  /**
   * New unified environment config (Step 4)
   * When provided, overrides the legacy mode/environment settings
   */
  runtime?: {
    /** Market data environment: production or sandbox (default: production) */
    marketDataEnv?: 'production' | 'sandbox';
    /** Execution environment for live mode (default: production) */
    executionEnv?: 'production' | 'sandbox';
    /** Initial equity for paper mode in USD */
    paperInitialEquityUsd?: number;
  };
}

export interface TradingEngineEvents {
  'engine:started': () => void;
  'engine:stopped': () => void;
  'engine:error': (error: Error) => void;
  'engine:heartbeat': (timestamp: number) => void;
  'engine:state_changed': (state: EngineState, reason: string) => void;
  'engine:fatal': (error: Error, context: string) => void;
  'market:ticker': (ticker: Ticker) => void;
  'market:orderbook': (orderbook: OrderBook) => void;
  'order:created': (order: ManagedOrder) => void;
  'order:filled': (order: ManagedOrder, fill: Fill) => void;
  'position:update': (position: Position) => void;
  'risk:alert': (alert: any) => void;
  'signal:generated': (signal: any) => void;
}

/**
 * Engine runtime states
 * - stopped: Engine is not running
 * - starting: Engine is initializing
 * - running: Engine is running and trading is active
 * - stopping: Engine is shutting down
 * - halted: Engine is running but trading halted due to kill switch
 */
export type EngineState = 'stopped' | 'starting' | 'running' | 'stopping' | 'halted';

// Startup grace period before data gap checks begin (ms)
const STARTUP_GRACE_PERIOD_MS = 60_000; // 60 seconds

// Heartbeat interval (ms)
const ENGINE_HEARTBEAT_INTERVAL_MS = 2000;

// Environment-specific data gap thresholds (in seconds)
const DATA_GAP_THRESHOLDS: Record<string, number> = {
  sandbox: 60,    // Very lenient for sandbox/dev
  paper: 30,      // Lenient for paper trading (brief gaps are normal)
  production: 10, // Strict for live trading, but allow brief jitter
};

export class TradingEngine extends EventEmitter {
  private config: TradingEngineConfig;
  private logger: Logger;
  private exchange: CoinbaseExchange | null = null;
  private orderManager: OrderManager | null = null;
  private positionTracker: PositionTracker | null = null;
  private riskEngine: RiskEngine | null = null;
  private positionMonitor: PositionMonitor | null = null;
  private tradeAnalytics: TradeAnalytics | null = null;
  private signalProcessor: any = null;
  private secretManager: SecretManager;
  private paperSimulator: PaperTradingSimulator | null = null;
  private isRunning = false;
  private marketPrices: Map<string, number> = new Map();
  private guardrails: GuardrailConfig;
  
  // Step 4: Unified execution adapter and account provider
  private executionAdapter: IExecutionAdapter | null = null;
  private accountProvider: IAccountProvider | null = null;
  private runtimeConfig: RuntimeConfig;
  
  // Order timing for latency tracking
  private orderTimestamps: Map<string, number> = new Map();
  private orderTimestampsCleanupInterval: NodeJS.Timeout | null = null;
  
  // Per-symbol market data timestamp tracking for data gap detection
  private lastMarketDataPerSymbol: Map<string, number> = new Map();
  private dataGapMonitor: NodeJS.Timeout | null = null;
  private engineStartTime = 0;
  
  // Active symbols that are actually subscribed (may differ from config if some aren't available)
  private activeSymbols: string[] = [];

  // Engine state tracking for 24/7 resilience
  private engineState: EngineState = 'stopped';
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private lastHeartbeatAt: number = 0;
  private startCount: number = 0;
  private stopCount: number = 0;
  private lastStartReason: string = '';
  private lastStopReason: string = '';

  constructor(config: TradingEngineConfig, logger: Logger) {
    super();
    this.config = config;
    this.logger = logger;
    this.guardrails = config.guardrails;

    // Build unified runtime config (Step 4)
    // This decouples market data env from execution mode
    this.runtimeConfig = buildRuntimeConfig({
      executionMode: config.mode,
      // Default to production market data unless explicitly set
      marketDataEnv: config.runtime?.marketDataEnv || 'production',
      executionEnv: config.runtime?.executionEnv || config.exchange.environment,
      paperInitialEquityUsd: config.runtime?.paperInitialEquityUsd || config.guardrails.account.equity_usd,
    });

    this.logger.info('Runtime config initialized', {
      executionMode: this.runtimeConfig.executionMode,
      marketDataEnv: this.runtimeConfig.marketDataEnv,
      executionEnv: this.runtimeConfig.executionEnv,
    });

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

  public setSignalProcessor(sp: any): void {
    this.signalProcessor = sp;
  }

  public get engineRunning(): boolean {
    return this.isRunning;
  }

  public async start(reason: string = 'manual'): Promise<void> {
    // Idempotency check - prevent double-start
    if (this.isRunning || this.engineState === 'starting') {
      this.logger.warn('Trading engine already running or starting', {
        isRunning: this.isRunning,
        engineState: this.engineState,
      });
      return;
    }

    this.setEngineState('starting', reason);
    this.startCount++;
    this.lastStartReason = reason;

    try {
      this.logger.info(`Starting trading engine in ${this.config.mode} mode`, {
        reason,
        startCount: this.startCount,
      });

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
      this.initializeTradeAnalytics();

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
      
      // Start heartbeat for supervisor monitoring
      this.startHeartbeat();

      // Periodic cleanup of stale order timestamps (every 5 minutes)
      this.orderTimestampsCleanupInterval = setInterval(() => this.cleanupOrderTimestamps(), 5 * 60 * 1000);

      this.isRunning = true;
      this.setEngineState('running', 'start_complete');
      this.emit('engine:started');
      
      this.logger.info('Trading engine started successfully', {
        mode: this.config.mode,
        activeSymbols: this.activeSymbols,
        gracePeriodMs: STARTUP_GRACE_PERIOD_MS,
        startCount: this.startCount,
      });
    } catch (error) {
      this.setEngineState('stopped', 'start_failed');
      this.logger.error('Failed to start trading engine:', error);
      this.emit('engine:error', error as Error);
      throw error;
    }
  }

  /**
   * Start the engine heartbeat for supervisor monitoring
   */
  private startHeartbeat(): void {
    // Clear any existing heartbeat first (idempotency)
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }

    this.heartbeatInterval = setInterval(() => {
      try {
        this.lastHeartbeatAt = Date.now();
        this.emit('engine:heartbeat', this.lastHeartbeatAt);
      } catch (error) {
        this.logger.error('Error in heartbeat interval', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }, ENGINE_HEARTBEAT_INTERVAL_MS);

    // Emit initial heartbeat
    this.lastHeartbeatAt = Date.now();
    this.emit('engine:heartbeat', this.lastHeartbeatAt);
  }

  /**
   * Stop the engine heartbeat
   */
  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  /**
   * Set engine state and emit event
   */
  private setEngineState(state: EngineState, reason: string): void {
    const oldState = this.engineState;
    this.engineState = state;
    
    if (oldState !== state) {
      this.logger.info('Engine state changed', {
        from: oldState,
        to: state,
        reason,
      });
      this.emit('engine:state_changed', state, reason);
    }
  }

  /**
   * Get current engine state
   */
  public getEngineState(): EngineState {
    return this.engineState;
  }

  /**
   * Get last heartbeat timestamp
   */
  public getLastHeartbeatAt(): number {
    return this.lastHeartbeatAt;
  }

  /**
   * Handle fatal error from engine components
   * Routes to supervisor for recovery decision
   */
  public handleFatal(error: Error, context: string): void {
    this.logger.error('Fatal engine error', {
      context,
      error: error.message,
      stack: error.stack,
    });

    // Don't try to recover if kill switch is active
    if (this.riskEngine?.getMetrics().killSwitchActive) {
      this.logger.warn('Kill switch active, not attempting recovery');
      this.setEngineState('halted', `fatal_error_killswitch: ${context}`);
      return;
    }

    // Emit fatal event for supervisor to handle
    this.emit('engine:fatal', error, context);
  }

  public async stop(reason: string = 'manual'): Promise<void> {
    // Idempotency check - prevent double-stop
    if (!this.isRunning && this.engineState === 'stopped') {
      this.logger.warn('Trading engine already stopped');
      return;
    }

    // Prevent stop during start
    if (this.engineState === 'starting') {
      this.logger.warn('Cannot stop engine while starting, waiting...');
      // Wait a bit for start to complete
      await new Promise(resolve => setTimeout(resolve, 2000));
    }

    // Prevent double-stop
    if (this.engineState === 'stopping') {
      this.logger.warn('Trading engine already stopping');
      return;
    }

    this.setEngineState('stopping', reason);
    this.stopCount++;
    this.lastStopReason = reason;

    try {
      this.logger.info('Stopping trading engine', {
        reason,
        stopCount: this.stopCount,
      });

      // Stop heartbeat first
      this.stopHeartbeat();

      // Cancel all open orders
      if (this.orderManager) {
        const activeOrders = this.orderManager.getActiveOrders();
        for (const order of activeOrders) {
          try {
            await this.cancelOrder(order.id);
          } catch (err) {
            this.logger.warn('Failed to cancel order during stop', {
              orderId: order.id,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }
      
      // Flatten positions on shutdown if configured
      if (this.guardrails?.compliance?.flatten_on_shutdown && this.positionTracker) {
        try {
          if (!this.positionTracker.isFlatteningInProgress()) {
            await this.positionTracker.closeAllPositions();
          }
          
          // Best-effort wait for closes to be processed
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
      
      if (this.tradeAnalytics) {
        await this.tradeAnalytics.stop();
      }

      if (this.dataGapMonitor) {
        clearInterval(this.dataGapMonitor);
        this.dataGapMonitor = null;
      }

      if (this.orderTimestampsCleanupInterval) {
        clearInterval(this.orderTimestampsCleanupInterval);
        this.orderTimestampsCleanupInterval = null;
      }

      // Remove event listeners to prevent handler accumulation on restart
      this.exchange?.removeAllListeners();
      this.orderManager?.removeAllListeners();
      this.positionTracker?.removeAllListeners();
      this.riskEngine?.removeAllListeners();
      this.positionMonitor?.removeAllListeners();
      this.paperSimulator?.removeAllListeners();

      this.isRunning = false;
      this.setEngineState('stopped', 'stop_complete');
      this.emit('engine:stopped');
      
      this.logger.info('Trading engine stopped', {
        reason,
        stopCount: this.stopCount,
      });
    } catch (error) {
      this.logger.error('Error stopping trading engine:', error);
      this.setEngineState('stopped', 'stop_error');
      this.emit('engine:error', error as Error);
    }
  }

  /**
   * Get exchange instance for supervisor access (reconnection)
   */
  public getExchange(): CoinbaseExchange | null {
    return this.exchange;
  }

  /**
   * Get engine health info for supervisor
   */
  public getHealthInfo(): {
    engineState: EngineState;
    isRunning: boolean;
    lastHeartbeatAt: number;
    startCount: number;
    stopCount: number;
    lastStartReason: string;
    lastStopReason: string;
    activeSymbols: string[];
    wsHealth: any;
  } {
    return {
      engineState: this.engineState,
      isRunning: this.isRunning,
      lastHeartbeatAt: this.lastHeartbeatAt,
      startCount: this.startCount,
      stopCount: this.stopCount,
      lastStartReason: this.lastStartReason,
      lastStopReason: this.lastStopReason,
      activeSymbols: this.activeSymbols,
      wsHealth: this.exchange ? (this.exchange as any).ws?.getHealth?.() : null,
    };
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
    const maxDailyLossUsd = Math.abs(guardrails.risk.daily_loss_limit) * accountEquity;
    const maxDrawdownPercent = Math.abs(guardrails.risk.max_drawdown_limit) * 100;
    const minOrderUsd = accountEquity * guardrails.account.risk_per_trade * guardrails.account.min_notional_buffer;
    
    // Step 6: Paper/Live Parity - Use explicit config flags with parity defaults
    // All flags default to FALSE (parity behavior)
    const paperOverrides = {
      resetRiskStateOnStart: process.env.PAPER_RESET_RISK_STATE_ON_START === 'true',
      disableErrorRateLimit: process.env.PAPER_DISABLE_ERROR_RATE_LIMIT === 'true',
      disableLatencyLimit: process.env.PAPER_DISABLE_LATENCY_LIMIT === 'true',
      disableDataGapLimit: process.env.PAPER_DISABLE_DATA_GAP_LIMIT === 'true',
      disableSoftLaunch: process.env.PAPER_DISABLE_SOFT_LAUNCH === 'true',
    };
    
    const isPaper = this.config.mode === 'paper';
    
    // Log active overrides if any (transparency)
    if (isPaper) {
      const activeOverrides = Object.entries(paperOverrides)
        .filter(([, v]) => v)
        .map(([k]) => k);
      if (activeOverrides.length > 0) {
        this.logger.warn('Paper mode overrides active (divergence from live)', { activeOverrides });
      } else {
        this.logger.info('Paper mode running with full parity to live (no overrides)');
      }
    }
    
    // Step 6: Exposure and leverage are now the SAME in paper and live (parity)
    // Unless explicitly overridden, paper uses same leverage as live
    const maxTotalExposureUsd = accountEquity * guardrails.account.max_account_leverage;
    
    // Step 6: Soft launch applies to BOTH paper and live unless explicitly disabled in paper
    const enableSoftLaunch = isPaper ? !paperOverrides.disableSoftLaunch : true;
    const softLaunch = enableSoftLaunch
      ? {
          enabled: true,
          maxEntryTrades: 5,
          riskPerTradeMultiplier: 0.5,
          maxPositionSizeMultiplier: 0.5,
          maxTotalExposureMultiplier: 0.75,
          maxOrderSizeMultiplier: 0.5,
          maxDailyLossMultiplier: 0.5,
          perSymbolNotionalCapUsd: 1000,
          minOrderSizeUsd: 25,
        }
      : undefined;

    // Step 6: ignorePersistedKillSwitch is now controlled by explicit flag, not mode
    const ignorePersistedKillSwitch = isPaper && paperOverrides.resetRiskStateOnStart;
    
    // Step 6: errorRateLimit is now the SAME in paper and live (parity)
    // Unless explicitly disabled via PAPER_DISABLE_ERROR_RATE_LIMIT
    const errorRateLimit = (isPaper && paperOverrides.disableErrorRateLimit) ? 101 : 20;

    const config: RiskEngineConfig = {
      supabaseUrl: this.config.supabase.url,
      supabaseKey: this.config.supabase.serviceKey,
      userId: this.config.supabase.userId,
      ignorePersistedKillSwitch,
      limits: {
        maxPositionSize: maxPositionSizeUsd,
        maxTotalExposure: maxTotalExposureUsd,
        maxDailyLoss: maxDailyLossUsd,
        maxDrawdown: maxDrawdownPercent,
        maxOrderSize: maxPositionSizeUsd,
        minOrderSize: minOrderUsd,
        maxOpenOrders: guardrails.account.max_open_positions,
        maxLeverage: guardrails.account.max_account_leverage  // Step 6: Same in paper and live
      },
      killSwitches: {
        enabled: true,
        dailyLossLimit: maxDailyLossUsd,
        consecutiveLossLimit: 5,     // 5 losses in a row
        errorRateLimit,              // Step 6: Parity by default
        latencyLimit: guardrails.circuit_breakers.data_gap_sec * 1000
      },
      riskPerTrade: guardrails.account.risk_per_trade * 100,
      kellyFraction: 0.25,
      guardrails,
      accountEquity,
      softLaunch
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
  
  private initializeTradeAnalytics(): void {
    const analyticsConfig: TradeAnalyticsConfig = {
      supabaseUrl: this.config.supabase.url,
      supabaseKey: this.config.supabase.serviceKey,
      userId: this.config.supabase.userId,
      initialEquity: this.guardrails.account.equity_usd,
      mode: this.config.mode,
      equitySampleIntervalMs: 60_000, // Sample equity every minute
    };
    
    this.tradeAnalytics = new TradeAnalytics(analyticsConfig, this.logger);
    
    // Hook into position events for trade tracking
    this.positionTracker!.on('position:opened', (position: Position) => {
      this.tradeAnalytics!.recordEntry({
        tradeId: position.id,
        symbol: position.symbol,
        side: position.side === 'long' ? 'long' : 'short',
        entryPrice: position.averagePrice,
        size: position.size,
        strategy: position.strategy,
        signalId: position.signalId,
        reasonCode: position.metadata?.entryTag,
        entryOrderId: position.metadata?.entryOrderId,
      });
    });
    
    this.positionTracker!.on('position:updated', (position: Position) => {
      // Update open trade with current price for MFE/MAE tracking
      this.tradeAnalytics!.updateOpenTrade(
        position.id,
        position.marketPrice,
        0 // Fees already tracked in position
      );
    });
    
    this.positionTracker!.on('position:closed', (position: Position) => {
      this.tradeAnalytics!.recordExit({
        tradeId: position.id,
        exitPrice: position.exitPrice ?? position.marketPrice,
        realizedPnl: position.realizedPnL,
        fees: position.trades.reduce((sum, t) => sum + t.fee, 0),
        exitReason: position.exitReason,
        exitOrderId: position.metadata?.exitOrderId,
      });
      
      // Also record outcome to meta-filter for learning
      if (this.signalProcessor) {
        const outcome: 'win' | 'loss' | 'breakeven' = 
          position.realizedPnL > 0 ? 'win' : 
          position.realizedPnL < 0 ? 'loss' : 'breakeven';
        
        this.signalProcessor.recordTradeOutcome({
          signalId: position.signalId || position.id,
          strategy: position.strategy || 'unknown',
          symbol: position.symbol,
          direction: position.side === 'long' ? 'buy' : 'sell',
          signalStrength: position.metadata?.signalStrength || 0.5,
          entryTime: position.openTime,
          exitTime: position.closedAt || new Date(),
          pnl: position.realizedPnL,
          outcome,
          regime: position.metadata?.regime,
          hourOfDay: position.openTime.getUTCHours(),
          dayOfWeek: position.openTime.getUTCDay(),
          metaScore: position.metadata?.metaQualityScore,
          filtersPassed: [],
          filtersBlocked: [],
        });
      }
    });
    
    this.logger.info('TradeAnalytics initialized', {
      mode: this.config.mode,
      initialEquity: this.guardrails.account.equity_usd,
    });
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
      // IMPORTANT: Do NOT stop the engine on kill switch
      // Instead, transition to halted state - runtime stays alive, trading stops
      this.setEngineState('halted', `kill_switch: ${reason}`);
      // Emit event for UI to show clear indication
      this.emit('risk:alert', { type: 'kill_switch', reasons: [reason], message: reason });
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

  private cleanupOrderTimestamps(): void {
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    for (const [orderId, timestamp] of this.orderTimestamps) {
      if (timestamp < oneHourAgo) {
        this.orderTimestamps.delete(orderId);
      }
    }
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
        
        let managedOrder: ManagedOrder | null = null;

        try {
          if (!this.orderManager) {
            throw new Error('OrderManager not initialized');
          }

          // Create/track the order BEFORE simulating execution so immediate fills can be matched
          const clientOrderId = uuidv4();
          const parsedSize = request.size ? parseFloat(request.size) : 0;
          managedOrder = {
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
          const reason = error instanceof Error ? error.message : String(error);
          const normalized = reason.toLowerCase();
          const isValidationError =
            normalized.includes('insufficient') ||
            normalized.includes('order size must be greater than zero') ||
            normalized.includes('invalid order size');

          if (managedOrder) {
            managedOrder.status = 'rejected';
            managedOrder.updatedAt = new Date();
          }

          if (this.orderManager) {
            const activeOrders = this.orderManager.getActiveOrders();
            this.riskEngine!.updateOpenOrderCount(activeOrders.length);
          }

          if (isValidationError) {
            this.logger.warn('Paper order rejected', {
              reason,
              productId: request.product_id,
              side: request.side,
              size: request.size,
              price: request.price ?? null,
            });
            return null;
          }

          const errorDetails = error instanceof Error ? { message: error.message, stack: error.stack } : error;
          this.logger.error('Paper order failed:', errorDetails);
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
  
  public getRiskEngineInstance(): RiskEngine | null {
    return this.riskEngine;
  }
  
  public getPositionTrackerInstance(): PositionTracker | null {
    return this.positionTracker;
  }

  // Get active orders
  public getActiveOrders(): ManagedOrder[] {
    return this.orderManager?.getActiveOrders() || [];
  }

  // Get session statistics
  public getSessionStats(): SessionStats | null {
    return this.tradeAnalytics?.getSessionStats() || null;
  }

  // Get recent closed trades
  public getRecentTrades(limit: number = 50): TradeRecord[] {
    return this.tradeAnalytics?.getRecentTrades(limit) || [];
  }

  // Get equity curve
  public getEquityCurve(): Array<{ timestamp: number; equity: number; pnl: number }> {
    return this.tradeAnalytics?.getEquityCurve() || [];
  }

  // Record order latency for analytics
  public recordOrderLatency(orderId: string, latencyMs: number, orderType: string = 'market'): void {
    this.tradeAnalytics?.recordOrderLatency(latencyMs, orderType);
  }

  // Start tick processing timer
  public startTickProcessing(): void {
    this.tradeAnalytics?.startTickProcessing();
  }

  // End tick processing timer
  public endTickProcessing(): void {
    this.tradeAnalytics?.endTickProcessing();
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
