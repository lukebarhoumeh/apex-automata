import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { createLogger } from '../core/logger';
import { TradingEngine, TradingEngineConfig } from '../trading/trading-engine';
import { SignalProcessor } from '../strategies/signal-processor';
import { createClient } from '@supabase/supabase-js';
import path from 'path';
import { loadEnv } from '../core/env';
import client from 'prom-client';
import { OHLCV } from '../indicators/technical';
import { loadGuardrails } from '../config/loadGuardrails';
import { OrderRequest } from '../exchanges/coinbase';

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

// Middleware
app.use(cors());
app.use(express.json());

// Prometheus metrics
client.collectDefaultMetrics({ prefix: 'atlas_' });

const engineRunningGauge = new client.Gauge({
  name: 'atlas_engine_running',
  help: '1 if trading engine is running, 0 otherwise'
});

const killSwitchActiveGauge = new client.Gauge({
  name: 'atlas_kill_switch_active',
  help: '1 if kill switch is active, 0 otherwise'
});

const ordersCreatedCounter = new client.Counter({
  name: 'atlas_orders_created_total',
  help: 'Total number of orders created'
});

const ordersFilledCounter = new client.Counter({
  name: 'atlas_orders_filled_total',
  help: 'Total number of orders filled'
});

const dbConnectionGauge = new client.Gauge({
  name: 'atlas_db_connection_status',
  help: '1 if connected to database, 0 otherwise'
});

const exposureGauge = new client.Gauge({
  name: 'atlas_exposure_usd',
  help: 'Current portfolio exposure in USD'
});

const dailyPnlGauge = new client.Gauge({
  name: 'atlas_daily_pnl_usd',
  help: 'Daily profit and loss in USD'
});

// Runtime status state (UI contract)
type Regime = 'trend' | 'chop';
const runtimeState = {
  paused: false,
  dailyStopHit: false,
  killSwitch: {
    active: false,
    reasons: [] as string[],
    since: null as number | null,
  },
  wsLatencyMs: 0,
  restLatencyMs: 0,
  spreadPctile: 0,
  regime: 'chop' as Regime,
  risk: {
    exposureUsd: 0,
    dailyPnLUsd: 0,
    maxDrawdownPct: 0,
    killSwitchActive: false
  }
};

// In-memory configs (will be persisted/hot-reloaded later)
let riskConfig: any = null;
let signalsConfig: any = null;

// Load environment
const atlasRoot = path.resolve(process.cwd(), '../..');
const env = loadEnv(atlasRoot);
const guardrails = loadGuardrails(atlasRoot);

// Logger
const logger = createLogger(path.join(atlasRoot, 'var/logs/api-server.jsonl'));

// Fixed USER_ID for single-user mode
const USER_ID = 'b7e8f9c2-4d6a-4c8b-9e2d-1a3b5c7d9e1f';
const INITIAL_BALANCE = 50000; // Starting balance for paper trading
logger.info('Using fixed USER_ID for single-user mode:', USER_ID);

// Supabase client
const supabase = createClient(
  env.SUPABASE_URL || '',
  env.SUPABASE_SERVICE_KEY || ''
);

// Trading engine instance
let tradingEngine: TradingEngine | null = null;
let signalProcessor: SignalProcessor | null = null;

// WebSocket clients
const wsClients = new Set<any>();

// Broadcast to all WebSocket clients
function broadcast(data: any) {
  const message = JSON.stringify(data);
  wsClients.forEach(client => {
    if (client.readyState === 1) { // OPEN
      client.send(message);
    }
  });
}

// Simple minute-bar aggregator for ticker → OHLCV candles
const candleAggregates: Map<string, {
  bucketMs: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}> = new Map();

function floorToMinute(timestampIso: string): number {
  const d = new Date(timestampIso);
  d.setSeconds(0, 0);
  return d.getTime();
}

function processTickerForCandles(ticker: { product_id: string; price: string; last_size?: string; time: string; }): void {
  if (!signalProcessor) return;
  const symbol = ticker.product_id;
  const price = parseFloat(ticker.price);
  const size = ticker.last_size ? parseFloat(ticker.last_size) : 0;
  const bucketMs = floorToMinute(ticker.time);

  const key = symbol;
  const agg = candleAggregates.get(key);

  if (!agg || agg.bucketMs !== bucketMs) {
    // Flush previous bucket
    if (agg) {
      const candle: OHLCV = {
        time: agg.bucketMs,
        open: agg.open,
        high: agg.high,
        low: agg.low,
        close: agg.close,
        volume: agg.volume,
      };
      try {
        signalProcessor.addCandle(symbol, candle);
        logger.debug(`Added candle for ${symbol}: O=${candle.open} H=${candle.high} L=${candle.low} C=${candle.close} V=${candle.volume}`);
      } catch (err) {
        logger.error('Failed to add candle to signal processor', err);
      }
    }

    // Start new bucket
    candleAggregates.set(key, {
      bucketMs,
      open: price,
      high: price,
      low: price,
      close: price,
      volume: size,
    });
    return;
  }

  // Update existing bucket
  agg.high = Math.max(agg.high, price);
  agg.low = Math.min(agg.low, price);
  agg.close = price;
  agg.volume += size;
}

// Periodic update for account metrics (every 5 minutes)
setInterval(async () => {
if (tradingEngine?.engineRunning) {
    await updateAccountMetrics();
  }
}, 5 * 60 * 1000);

// Periodic StatusUpdate broadcast for frontend
setInterval(() => {
  if (wsClients.size === 0) return;
  
  // TODO: Calculate actual latency and spread from exchange data
  // For now, using mock values
if (tradingEngine?.engineRunning) {
    runtimeState.wsLatencyMs = Math.round(50 + Math.random() * 20);
    runtimeState.restLatencyMs = Math.round(100 + Math.random() * 50);
    runtimeState.spreadPctile = Math.round(Math.random() * 100);
    // Simple regime detection based on mock volatility
    runtimeState.regime = Math.random() > 0.7 ? 'trend' : 'chop';
  }
  
  broadcast({
    type: 'StatusUpdate',
    payload: {
      mode: (tradingEngine?.getConfig().mode || 'paper'),
      paused: runtimeState.paused,
      dailyStopHit: runtimeState.dailyStopHit,
      killSwitch: runtimeState.killSwitch,
      wsLatencyMs: runtimeState.wsLatencyMs,
      restLatencyMs: runtimeState.restLatencyMs,
      spreadPctile: runtimeState.spreadPctile,
      regime: runtimeState.regime,
    }
  });
}, 1500);

// WebSocket connection handler
wss.on('connection', (ws) => {
  logger.info('New WebSocket client connected');
  wsClients.add(ws);

  ws.on('close', () => {
    logger.info('WebSocket client disconnected');
    wsClients.delete(ws);
  });

  ws.on('error', (error) => {
    logger.error('WebSocket error:', error);
  });

  // Send initial StatusUpdate
  ws.send(JSON.stringify({
    type: 'StatusUpdate',
    payload: {
      mode: (tradingEngine?.getConfig().mode || 'paper'),
      paused: runtimeState.paused,
      dailyStopHit: runtimeState.dailyStopHit,
      killSwitch: runtimeState.killSwitch,
      wsLatencyMs: runtimeState.wsLatencyMs,
      restLatencyMs: runtimeState.restLatencyMs,
      spreadPctile: runtimeState.spreadPctile,
      regime: runtimeState.regime,
    }
  }));
});

// API Routes

// Prometheus metrics endpoint
app.get('/metrics', async (req, res) => {
  try {
    res.set('Content-Type', client.register.contentType);
    res.end(await client.register.metrics());
  } catch (error) {
    res.status(500).end(error);
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Alias for frontend health check
app.get('/api/health', (req, res) => {
  res.json({ ok: true, timestamp: Date.now() });
});

// Get trading engine status (UI contract)
app.get('/api/status', (req, res) => {
  res.json({
    mode: (tradingEngine?.getConfig().mode || 'paper'),
    paused: runtimeState.paused,
    dailyStopHit: runtimeState.dailyStopHit,
    killSwitch: runtimeState.killSwitch,
    wsLatencyMs: runtimeState.wsLatencyMs,
   restLatencyMs: runtimeState.restLatencyMs,
   spreadPctile: runtimeState.spreadPctile,
   regime: runtimeState.regime,
    risk: runtimeState.risk
  });
});

// Start trading engine
app.post('/api/engine/start', async (req, res) => {
  try {
    const { mode = 'paper' } = req.body;

    if (tradingEngine) {
      return res.status(400).json({ error: 'Trading engine already running' });
    }

    logger.info(`Starting trading engine in ${mode} mode`);

    // Configure trading engine
    const engineConfig: TradingEngineConfig = {
      mode: mode as 'paper' | 'live',
      exchange: {
        name: 'coinbase',
        environment: mode === 'live' ? 'production' : 'sandbox'
      },
      products: ['BTC-USD', 'ETH-USD', 'SOL-USD'],
      supabase: {
        url: env.SUPABASE_URL || '',
        serviceKey: env.SUPABASE_SERVICE_KEY || '',
        anonKey: env.SUPABASE_ANON_KEY || ''
      },
      security: {
        encryptionKey: env.ENCRYPTION_KEY || ''
      },
      guardrails
    };

    // Create trading engine
    tradingEngine = new TradingEngine(engineConfig, logger);
    
    // Update metrics
    engineRunningGauge.set(1);

    // Set up event listeners to update frontend
    tradingEngine.on('market:ticker', (ticker) => {
      broadcast({ type: 'TickerUpdate', payload: ticker });
      
      // Update Supabase (for frontend queries)
      updateSupabasePrice(ticker.product_id, parseFloat(ticker.price));

      // Feed bar aggregator → signal processor
      processTickerForCandles({
        product_id: ticker.product_id,
        price: ticker.price,
        last_size: (ticker as any).last_size,
        time: ticker.time,
      });
    });

    tradingEngine.on('order:created', async (order) => {
      ordersCreatedCounter.inc();
      broadcast({ type: 'OrderUpdate', payload: order });
      await syncOrderToSupabase(order);
    });

    tradingEngine.on('order:filled', async (order, fill) => {
      ordersFilledCounter.inc();
      broadcast({ type: 'Fill', payload: fill });
      await syncFillToSupabase(fill);
      // Update account metrics after fills
      await updateAccountMetrics();
    });

    tradingEngine.on('position:update', async (position) => {
      broadcast({ type: 'PositionUpdate', payload: position });
      await syncPositionToSupabase(position);
    });

    tradingEngine.on('risk:alert', async (alert) => {
      if (alert?.type === 'kill_switch') {
        killSwitchActiveGauge.set(1);
        runtimeState.killSwitch.active = true;
        runtimeState.killSwitch.reasons = Array.isArray(alert?.reasons) ? alert.reasons : [alert?.message || 'Kill switch'];
        runtimeState.killSwitch.since = Date.now();
      }
      broadcast({ type: 'RiskEvent', payload: alert });
      await createSupabaseAlert(alert);
    });

    tradingEngine.on('risk:metrics', (metrics: any) => {
      runtimeState.risk = {
        exposureUsd: metrics.currentExposure ?? 0,
        dailyPnLUsd: metrics.dailyPnL ?? 0,
        maxDrawdownPct: metrics.maxDrawdown ?? 0,
        killSwitchActive: Boolean(metrics.killSwitchActive)
      };
      exposureGauge.set(runtimeState.risk.exposureUsd);
      dailyPnlGauge.set(runtimeState.risk.dailyPnLUsd);
      killSwitchActiveGauge.set(runtimeState.risk.killSwitchActive ? 1 : 0);
      broadcast({ type: 'RiskMetrics', payload: metrics });
    });

    // Initialize signal processor
    const strategyGuard = guardrails.strategy;
    const signalConfig = {
      supabaseUrl: env.SUPABASE_URL || '',
      supabaseKey: env.SUPABASE_SERVICE_KEY || '',
      strategies: {
        breakout: {
          enabled: true,
          period: strategyGuard.donchian_len,
          atrPeriod: strategyGuard.atr_len_15m,
          atrMultiplier: strategyGuard.stop_init_atr,
          volumeThreshold: 1.5
        },
        vwapMeanReversion: {
          enabled: true,
          deviationEntry: 2,
          deviationExit: 0.5,
          minVolume: 1000
        },
        momentum: {
          enabled: strategyGuard.mode.includes('momentum'),
          rsiPeriod: 14,
          rsiOverbought: 70,
          rsiOversold: 30,
          macdFast: 12,
          macdSlow: 26,
          macdSignal: 9
        }
      },
      metaLabeling: {
        enabled: false,
        threshold: 0.5
      }
    };

    signalProcessor = new SignalProcessor(signalConfig, logger);

    // Listen for signals and create orders
    signalProcessor.on('signal:generated', async (signal) => {
      logger.info('Signal generated', signal);
      broadcast({ type: 'Signal', payload: signal });
      
      // Store signal in Supabase
      await syncSignalToSupabase(signal);
      
      // Create order if risk checks pass
      try {
        if (runtimeState.paused || runtimeState.dailyStopHit || runtimeState.killSwitch.active) {
          logger.warn('Signal suppressed due to runtime state (paused/dailyStop/killSwitch)');
          return;
        }

        const signalTime = signal.timestamp instanceof Date ? signal.timestamp : new Date(signal.timestamp ?? Date.now());
        const entryPrice = signal.price;
        const fallbackStop = signal.direction === 'buy'
          ? entryPrice * 0.985
          : entryPrice * 1.015;
        const stopPrice = signal.stopLoss ?? fallbackStop;

        // Time filter guardrail
        if (guardrails.filters.time_filter_enabled) {
          const hour = signalTime.getUTCHours();
          const hours = guardrails.filters.allowed_hours_utc;
          let withinWindow = true;
          if (hours.length === 2) {
            const [start, end] = hours;
            if (start <= end) {
              withinWindow = hour >= start && hour <= end;
            } else {
              withinWindow = hour >= start || hour <= end;
            }
          } else {
            withinWindow = hours.includes(hour);
          }
          if (!withinWindow) {
            logger.info('Signal filtered by trading hours guardrail', { hour, allowed: hours });
            return;
          }
        }

        // ATR volatility filter
        const atrMin = guardrails.filters.atr_volatility_min;
        const atrMax = guardrails.filters.atr_volatility_max;
        const atrValue = (signal.metadata?.indicators as Record<string, number> | undefined)?.atr;
        if (typeof atrValue === 'number' && atrValue > 0) {
          const atrPct = atrValue / entryPrice;
          if (atrPct < atrMin || atrPct > atrMax) {
            logger.info('Signal filtered by ATR guardrail', { atrPct, atrMin, atrMax, symbol: signal.symbol });
            return;
          }
        }

        if (guardrails.filters.funding_bias_enabled) {
          logger.debug('Funding bias guardrail enabled (spot mode stub) - no action taken');
        }

        const computedSize = tradingEngine!.computeOrderSize(signal.symbol, entryPrice, stopPrice);
        if (!Number.isFinite(computedSize) || computedSize <= 0) {
          logger.warn('Guardrail sizing returned zero size, skipping signal', {
            signalId: signal.id,
            symbol: signal.symbol,
            entryPrice,
            stopPrice
          });
          return;
        }

        const orderTypeSetting = guardrails.execution.order_type;
        let orderType: 'limit' | 'market' = 'limit';
        let postOnly = orderTypeSetting === 'post_only';
        let limitPrice = entryPrice;

        if (orderTypeSetting === 'market') {
          orderType = 'market';
          postOnly = false;
        } else if (orderTypeSetting === 'marketable_limit') {
          const priceOffsetBps = guardrails.execution.price_offset_ticks;
          const priceDelta = entryPrice * (priceOffsetBps / 10000);
          limitPrice = signal.direction === 'buy' ? entryPrice + priceDelta : entryPrice - priceDelta;
          if (limitPrice <= 0) {
            limitPrice = entryPrice;
          }
        }

        const baseOrder = {
          product_id: signal.symbol,
          side: signal.direction,
          type: orderType,
          size: computedSize.toFixed(6)
        };

        const orderRequest = orderType === 'limit'
          ? { ...baseOrder, price: limitPrice.toFixed(2), post_only: postOnly }
          : baseOrder;
        const limitPriceStr = orderType === 'limit' ? (orderRequest as { price: string }).price : undefined;

        logger.info('Sizing order from signal', {
          signalId: signal.id,
          symbol: signal.symbol,
          direction: signal.direction,
          entryPrice,
          stopPrice,
          size: computedSize,
          orderType,
          notionalUsd: (computedSize * entryPrice),
          limitPrice: limitPriceStr
        });

        const order = await tradingEngine!.createOrder(orderRequest);
        if (order) {
          logger.info('Order placed from signal', { orderId: order.id, signal: signal.id });
        }
      } catch (error) {
        logger.error('Failed to place order from signal:', error);
      }
    });

    // Start the engine
    await tradingEngine.start();

    res.json({ 
      success: true, 
      message: `Trading engine started in ${mode} mode` 
    });

  } catch (error) {
    logger.error('Failed to start trading engine:', error);
    res.status(500).json({ error: 'Failed to start trading engine' });
  }
});

// Stop trading engine
app.post('/api/engine/stop', async (req, res) => {
  try {
    if (!tradingEngine) {
      return res.status(400).json({ error: 'Trading engine not running' });
    }

    await tradingEngine.stop();
    tradingEngine = null;
    signalProcessor = null;
    
    // Update metrics
    engineRunningGauge.set(0);

    res.json({ success: true, message: 'Trading engine stopped' });

  } catch (error) {
    logger.error('Failed to stop trading engine:', error);
    res.status(500).json({ error: 'Failed to stop trading engine' });
  }
});

// Emergency kill switch
app.post('/api/engine/kill', async (req, res) => {
  try {
    if (tradingEngine) {
      await tradingEngine.emergencyStop('User activated kill switch');
      tradingEngine = null;
      signalProcessor = null;
      engineRunningGauge.set(0);
    }
    
    // Update metrics
    killSwitchActiveGauge.set(1);
    runtimeState.killSwitch.active = true;
    runtimeState.killSwitch.reasons = ['User activated kill switch'];
    runtimeState.killSwitch.since = Date.now();

    // Update risk events in Supabase
    await supabase
      .from('risk_events')
      .insert({
        user_id: USER_ID,
        event_type: 'kill_switch',
        details: { reason: 'User activated kill switch' },
        active: true,
        triggered_at: new Date().toISOString()
      });

    res.json({ success: true, message: 'Kill switch activated' });

  } catch (error) {
    logger.error('Failed to activate kill switch:', error);
    res.status(500).json({ error: 'Failed to activate kill switch' });
  }
});

// Control: pause
app.post('/api/control/pause', (req, res) => {
  runtimeState.paused = true;
  broadcast({ type: 'StatusUpdate', payload: { ...runtimeState, mode: (tradingEngine?.getConfig().mode || 'paper') } });
  res.json({ ok: true });
});

// Control: resume
app.post('/api/control/resume', (req, res) => {
  runtimeState.paused = false;
  broadcast({ type: 'StatusUpdate', payload: { ...runtimeState, mode: (tradingEngine?.getConfig().mode || 'paper') } });
  res.json({ ok: true });
});

// Control: close-all - close all open positions
app.post('/api/control/close-all', async (req, res) => {
  const { reason, confirm } = req.body || {};
  if (confirm !== 'CLOSE ALL') {
    return res.status(400).json({ ok: false, error: "Confirmation phrase 'CLOSE ALL' required" });
  }
  
  logger.warn('Close-all requested', { reason });
  
  if (!tradingEngine) {
    return res.json({ ok: true, submitted: 0 });
  }
  
  try {
    const positions = tradingEngine.getOpenPositions();
    let submitted = 0;
    
    for (const position of positions) {
      const side: 'buy' | 'sell' = position.side === 'long' ? 'sell' : 'buy';
      const closeOrder: Omit<OrderRequest, 'client_oid'> = {
        product_id: position.symbol,
        side,
        type: 'market',
        size: Math.abs(position.size).toString()
      };
      
      const order = await tradingEngine.createOrder(closeOrder);
      if (order) {
        submitted++;
        logger.info(`Closing position ${position.symbol}`, { orderId: order.id });
      }
    }
    
    res.json({ ok: true, submitted });
  } catch (error) {
    logger.error('Failed to close all positions:', error);
    res.status(500).json({ ok: false, error: 'Failed to close positions' });
  }
});

// Config: risk
app.post('/api/config/risk', (req, res) => {
  riskConfig = req.body || {};
  logger.info('Risk config updated', { riskConfig });
  res.json({ ok: true });
});

// Config: signals
app.post('/api/config/signals', (req, res) => {
  signalsConfig = req.body || {};
  logger.info('Signals config updated', { signalsConfig });
  res.json({ ok: true });
});

// Backtest endpoint
app.post('/api/backtest/run', async (req, res) => {
  try {
    const { startDate, endDate, symbols, strategies, initialCapital, risk = {} } = req.body;
    
    // Validate inputs
    if (!startDate || !endDate || !symbols || !strategies || !initialCapital) {
      return res.status(400).json({ 
        error: 'Missing required parameters: startDate, endDate, symbols, strategies, initialCapital' 
      });
    }

    logger.info('Starting backtest', { startDate, endDate, symbols, strategies, initialCapital });

    // Import BacktestEngine dynamically
    const { BacktestEngine } = await import('../backtesting/backtest-engine');
    
    // Create backtest config
    const normalizedSymbols: string[] = Array.isArray(symbols) ? symbols : [symbols];
    const strategyConfig = {
      breakout: {
        enabled: strategies?.breakout?.enabled ?? true,
        parameters: strategies?.breakout?.parameters ?? {}
      },
      vwapMeanReversion: {
        enabled: strategies?.vwapMeanReversion?.enabled ?? false,
        parameters: strategies?.vwapMeanReversion?.parameters ?? {}
      },
      momentum: {
        enabled: strategies?.momentum?.enabled ?? false,
        parameters: strategies?.momentum?.parameters ?? {}
      }
    };

    const riskConfigBacktest = {
      maxPositionSize: risk.maxPositionSize ?? 10000,
      maxTotalExposure: risk.maxTotalExposure ?? 50000,
      stopLossPercent: risk.stopLossPercent ?? 0.02,
      takeProfitPercent: risk.takeProfitPercent ?? 0.04
    };

    const backtestConfig = {
      startDate: new Date(startDate),
      endDate: new Date(endDate),
      initialCapital: Number(initialCapital),
      commission: 0.001, // 0.1% commission
      slippage: 0.0005, // 0.05% slippage
      products: normalizedSymbols,
      signals: strategyConfig,
      risk: riskConfigBacktest
    };

    // Create backtest engine
    const backtestEngine = new BacktestEngine(backtestConfig, logger);

    // Mock data provider - generates synthetic price data for backtesting
    const dataProvider = async (product: string, start: Date, end: Date) => {
      logger.info(`Generating mock historical data for ${product} from ${start} to ${end}`);
      
      // Generate synthetic OHLCV data
      const bars = [];
      const basePrice = product === 'BTC-USD' ? 60000 : product === 'ETH-USD' ? 3000 : 100;
      let currentPrice = basePrice;
      
      // Generate 5-minute bars
      const current = new Date(start);
      const endTime = new Date(end);
      
      while (current <= endTime) {
        // Random walk with mean reversion
        const volatility = 0.001; // 0.1% per 5 minutes
        const drift = (basePrice - currentPrice) / basePrice * 0.001; // Mean reversion
        const change = (Math.random() - 0.5 + drift) * volatility;
        
        currentPrice = currentPrice * (1 + change);
        
        // Generate OHLCV
        const open = currentPrice;
        const close = currentPrice * (1 + (Math.random() - 0.5) * volatility);
        const high = Math.max(open, close) * (1 + Math.random() * volatility * 0.5);
        const low = Math.min(open, close) * (1 - Math.random() * volatility * 0.5);
        const volume = 100 + Math.random() * 900; // Random volume 100-1000
        
        bars.push({
          timestamp: current.toISOString(),
          open,
          high,
          low,
          close,
          volume
        });
        
        currentPrice = close;
        current.setMinutes(current.getMinutes() + 5); // 5-minute intervals
      }
      
      logger.info(`Generated ${bars.length} bars for ${product}`);
      return bars;
    };

    // Load historical data
    await backtestEngine.loadHistoricalData(dataProvider);

    // Run backtest
    const result = await backtestEngine.run();

    // Calculate additional metrics for frontend
    const equityCurve = result.equityCurve || [];
    const trades = result.trades || [];
    const metrics = result.metrics || {};

    // Format response for frontend
    const response = {
      config: {
        startDate,
        endDate,
        symbols: normalizedSymbols,
        strategies: strategyConfig,
        initialCapital: Number(initialCapital)
      },
      results: {
        totalReturn: metrics.netProfit || 0,
        sharpeRatio: metrics.sharpeRatio || 0,
        maxDrawdown: metrics.maxDrawdownPercent || 0,
        winRate: metrics.winRate || 0,
        profitFactor: metrics.profitFactor || 0,
        totalTrades: trades.length,
        avgWin: metrics.averageWin || 0,
        avgLoss: metrics.averageLoss || 0,
        expectancyPerTrade: trades.length > 0 ? (metrics.netProfit || 0) / trades.length : 0,
        equityCurve: equityCurve.map((point: any) => ({
          date: point.date,
          equity: point.equity
        }))
      }
    };

    res.json(response);
  } catch (error) {
    logger.error('Backtest failed:', error);
    
    // Provide more detailed error response
    const errorDetails = error instanceof Error ? {
      message: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    } : { message: 'Unknown error' };
    
    res.status(500).json({ 
      error: 'Backtest failed', 
      details: errorDetails.message,
      hint: 'Check that your date range is valid and not too large (max 30 days recommended)'
    });
  }
});

// Helper functions to sync with Supabase

async function notifyAlertChannels(alert: { severity: string; title: string; message: string }) {
  for (const channel of guardrails.ui.alert_channels) {
    // Placeholder: integrate real transports (telegram/email/etc.)
    logger.info(`[Alert:${channel}] ${alert.title}`, { severity: alert.severity, message: alert.message });
  }
}

async function updateSupabasePrice(symbol: string, price: number) {
  // Update a price cache table or use for position calculations
  // This is just for real-time price updates if needed
}

async function updateAccountMetrics() {
  try {
    const { data, error } = await supabase.rpc('upsert_account_metrics', {
      p_user_id: USER_ID
    });
    
    if (error) {
      // Silently ignore if RPC doesn't exist
      if (error.code !== 'PGRST202') {
        logger.error('Failed to update account metrics:', error);
      }
    }
  } catch (error) {
    logger.error('Error updating account metrics:', error);
  }
}

// Initialize account metrics with starting balance
async function initializeAccountMetrics() {
  try {
    const today = new Date().toISOString().split('T')[0];
    
    // Check if metrics exist for today
    const { data: existing, error: checkError } = await supabase
      .from('account_metrics')
      .select('id')
      .eq('user_id', USER_ID)
      .eq('date', today)
      .maybeSingle();
    
    if (checkError && checkError.code !== 'PGRST205') {
      logger.error('Failed to check account metrics:', checkError);
      return;
    }
    
    // If no metrics exist for today, create them
    if (!existing) {
      const { error: insertError } = await supabase
        .from('account_metrics')
        .insert({
          user_id: USER_ID,
          date: today,
          total_equity: INITIAL_BALANCE,
          daily_pnl: 0,
          daily_pnl_r: 0,
          risk_heat: 0,
          spread_percentile: 0,
          open_positions_count: 0,
          wins_today: 0,
          losses_today: 0
        });
      
      if (insertError && insertError.code !== 'PGRST205') {
        logger.error('Failed to initialize account metrics:', insertError);
      } else {
        logger.info('Initialized account metrics for today with starting balance:', INITIAL_BALANCE);
      }
    }
  } catch (error) {
    logger.error('Error initializing account metrics:', error);
  }
}

async function syncOrderToSupabase(order: any) {
  const mapOrderStatus = (status?: string) => {
    switch ((status || '').toLowerCase()) {
      case 'open':
      case 'active':
        return 'working';
      case 'partially_filled':
        return 'partially_filled';
      case 'filled':
      case 'done':
        return 'filled';
      case 'cancelled':
      case 'canceled':
        return 'canceled';
      case 'expired':
        return 'expired';
      case 'failed':
      case 'rejected':
        return 'rejected';
      case 'placing':
      case 'pending':
      default:
        return 'new';
    }
  };

  const mapOrderType = (type?: string) => {
    switch ((type || '').toLowerCase()) {
      case 'market':
        return 'market';
      case 'stop':
        return 'stop';
      case 'twap_child':
      case 'twap-slice':
        return 'twap_child';
      case 'twap':
      case 'twap_parent':
        return 'twap_parent';
      case 'post_only':
        return 'post_only';
      case 'ioc':
        return 'ioc';
      case 'limit':
      default:
        return 'limit';
    }
  };

  const normalizeStrategy = (strategy?: string) => {
    const candidate = (strategy || '').toLowerCase();
    const validStrategies = ['breakout', 'vwap_mr', 'obi_scalper'];
    if (validStrategies.includes(candidate)) {
      return candidate;
    }
    if (candidate === 'vwapmeanreversion') {
      return 'vwap_mr';
    }
    return 'breakout';
  };

  const sizeValue = Number(order.size ?? order.quantity ?? 0);
  const normalizedQuantity = Number.isFinite(sizeValue) ? sizeValue : 0;

  try {
    const { error } = await supabase
      .from('orders')
      .upsert({
        id: order.id,
        user_id: USER_ID,
        external_order_id: order.exchangeOrderId,
        symbol: order.productId || order.product || order.symbol,
        side: ((order.side || 'buy').toLowerCase() === 'sell' ? 'sell' : 'buy') as 'buy' | 'sell',
        type: mapOrderType(order.type) as any,
        status: mapOrderStatus(order.status) as any,
        price: order.price ? parseFloat(order.price) : null,
        quantity: normalizedQuantity,
        strategy: normalizeStrategy(order.strategy) as any,
        meta_prob: order.metaProb || null,
        created_at: order.createdAt ? order.createdAt.toISOString() : new Date().toISOString(),
        updated_at: order.updatedAt ? order.updatedAt.toISOString() : new Date().toISOString()
      });

    if (error) {
      logger.error('Failed to sync order to Supabase:', error);
    }
  } catch (error) {
    logger.error('Error syncing order:', error);
  }
}

async function syncFillToSupabase(fill: any) {
  try {
    const { error } = await supabase
      .from('fills')
      .insert({
        user_id: USER_ID,
        order_id: fill.order_id,
        trade_id: fill.trade_id,
        price: parseFloat(fill.price),
        quantity: parseFloat(fill.size),
        fee_currency: 'USD',
        fee_amount: parseFloat(fill.fee),
        maker: fill.liquidity === 'M',
        filled_at: fill.created_at
      });

    if (error) {
      logger.error('Failed to sync fill to Supabase:', error);
    }
  } catch (error) {
    logger.error('Error syncing fill:', error);
  }
}

async function syncPositionToSupabase(position: any) {
  try {
    // Map backend Position interface to Supabase positions table
    const mappedPosition = {
      id: position.id || `pos_${position.symbol}_${Date.now()}`,
      user_id: USER_ID,
      symbol: position.symbol || position.product,
      strategy: position.strategy || 'breakout', // Default strategy
      side: position.side === 'flat' ? 'flat' : position.side, // position_side enum
      qty_open: Math.abs(position.size || 0),
      entry_price: position.averagePrice || position.avgPrice || 0,
      stop_price_at_entry: position.stopPrice || position.entry_price * 0.98, // Default 2% stop
      opened_at: position.openTime ? position.openTime.toISOString() : new Date().toISOString(),
      closed_at: position.closedAt || null,
      exit_price: position.exitPrice || null,
      realized_pnl_usd: position.realizedPnL || position.realizedPnl || 0,
      realized_r: position.realizedR || null
    };

    const { error } = await supabase
      .from('positions')
      .upsert(mappedPosition);

    if (error) {
      logger.error('Failed to sync position to Supabase:', error);
    }
  } catch (error) {
    logger.error('Error syncing position:', error);
  }
}

async function syncSignalToSupabase(signal: any) {
  try {
    const { error } = await supabase
      .from('signals')
      .insert({
        id: signal.id || `sig_${signal.symbol}_${Date.now()}`,
        user_id: USER_ID,
        symbol: signal.symbol,
        strategy: signal.strategy, // strategy_name enum
        decided_at: signal.timestamp ? signal.timestamp.toISOString() : new Date().toISOString(),
        side: signal.direction === 'buy' ? 'long' : signal.direction === 'sell' ? 'short' : signal.side, // position_side enum
        score: signal.strength || signal.score || 0,
        confidence: signal.confidence || signal.strength || 0,
        meta_prob: signal.metaLabel || signal.metaProb || null,
        features: signal.metadata || signal.features || {},
        allowed: signal.allowed !== false, // Default to true if signal was generated
        reason: signal.reason || (signal.metadata && signal.metadata.reason) || null,
        created_at: new Date().toISOString()
      });

    if (error) {
      logger.error('Failed to sync signal to Supabase:', error);
    }
  } catch (error) {
    logger.error('Error syncing signal:', error);
  }
}

async function createSupabaseAlert(alert: any) {
  try {
    const { error } = await supabase
      .from('alerts')
      .insert({
        user_id: USER_ID,
        severity: alert.severity || 'warning', // alert_severity enum: info, warning, error, critical
        title: alert.title || alert.type || 'Risk Alert',
        message: alert.message || JSON.stringify(alert),
        data: alert.data || alert,
        created_at: new Date().toISOString()
      });

    if (error) {
      logger.error('Failed to create alert in Supabase:', error);
    }
    await notifyAlertChannels({
      severity: alert.severity || 'warning',
      title: alert.title || alert.type || 'Risk Alert',
      message: alert.message || JSON.stringify(alert),
    });
  } catch (error) {
    logger.error('Error creating alert:', error);
  }
}

// Check database connection on startup
(async () => {
  try {
    const { error } = await supabase.from('symbols').select('count').limit(1);
    if (error) {
      logger.error('Database connection failed:', error);
      dbConnectionGauge.set(0);
    } else {
      logger.info('Database connection successful');
      dbConnectionGauge.set(1);
    }
  } catch (error) {
    logger.error('Database connection check failed:', error);
    dbConnectionGauge.set(0);
  }
})();

// Initialize account metrics on startup
initializeAccountMetrics().catch(err => {
  logger.error('Failed to initialize account metrics on startup:', err);
});

// Start server
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  logger.info(`API server listening on port ${PORT}`);
  console.log(`
    🚀 AtlasBot API Server Running
    ================================
    HTTP API: http://localhost:${PORT}
    WebSocket: ws://localhost:${PORT}
    Metrics: http://localhost:${PORT}/metrics
    Health: http://localhost:${PORT}/health
    
    Endpoints:
    - GET  /api/status
    - POST /api/engine/start
    - POST /api/engine/stop
    - POST /api/engine/kill
    - GET  /metrics (Prometheus)
    - GET  /health
  `);
});
