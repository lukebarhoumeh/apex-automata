import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { createLogger } from '../core/logger';
import { TradingEngine, TradingEngineConfig, EngineState } from '../trading/trading-engine';
import { SignalProcessor } from '../strategies/signal-processor';
import { createClient } from '@supabase/supabase-js';
import path from 'path';
import { loadAndValidateEnv } from '../core/env';
import client from 'prom-client';
import { OHLCV } from '../indicators/technical';
import { loadGuardrails } from '../config/loadGuardrails';
import { validateSchemaOrFail } from '../config/validateSchema';
import { OrderRequest } from '../exchanges/coinbase';
import { MetricsTracker } from '../trading/metrics-tracker';
import { SecretManager } from '../config/secrets';
import { CoinbaseExchange } from '../exchanges/coinbase';
import { TradeOutcomeCollector } from '../ml/trade-outcome-collector';
import { EngineSupervisor, SupervisorState, RestartReason } from '../runtime/engine-supervisor';

const app = express();
const server = createServer(app);
// Use noServer mode for explicit path handling
const wss = new WebSocketServer({ noServer: true });

// Handle WebSocket upgrade for both root and /events paths
server.on('upgrade', (request, socket, head) => {
  const pathname = new URL(request.url || '/', `http://${request.headers.host}`).pathname;
  
  // Accept connections on both root path and /events path for compatibility
  if (pathname === '/' || pathname === '/events' || pathname === '/ws') {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  } else {
    socket.destroy();
  }
});

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
  },
  // Warmup state (C1-6)
  warmupComplete: false,
  candlesBuffered: {} as Record<string, number>,
  // 24/7 Resilience fields
  runtimeAlive: true,
  engineState: 'stopped' as EngineState,
  engineDesiredState: 'stopped' as EngineState,
  lastMarketDataAt: 0,
  lastEngineHeartbeatAt: 0,
  restartCount: 0,
  lastRestartReason: null as string | null,
  lastRestartAt: null as number | null,
};

let engineOperationInProgress = false;

// Interval references for cleanup on shutdown
let metricsInterval: NodeJS.Timeout | null = null;
let statusBroadcastInterval: NodeJS.Timeout | null = null;

// In-memory configs (will be persisted/hot-reloaded later)
let riskConfig: any = null;
let signalsConfig: any = null;

// Load and validate environment - fails fast with clear errors if misconfigured
const atlasRoot = path.resolve(process.cwd(), '../..');
const env = loadAndValidateEnv(atlasRoot);
const guardrails = loadGuardrails(atlasRoot);

// Logger
const logger = createLogger(path.join(atlasRoot, 'var/logs/api-server.jsonl'));

// Real-time metrics tracker (replaces mock values)
const metricsTracker = new MetricsTracker({
  spreadWindowSize: 100,
  latencyWindowSize: 50,
  regimeAtrPeriod: 14,
  regimeAtrThreshold: 0.015,
}, logger);

// Fixed USER_ID for single-user mode
const USER_ID = 'b7e8f9c2-4d6a-4c8b-9e2d-1a3b5c7d9e1f';
const INITIAL_BALANCE = 50000; // Starting balance for paper trading
logger.info('Using fixed USER_ID for single-user mode:', USER_ID);

const DEFAULT_LIVE_CONFIRM_PHRASE = 'ENABLE LIVE';

// Supabase client
const supabase = createClient(
  env.SUPABASE_URL || '',
  env.SUPABASE_SERVICE_KEY || ''
);

// Trading engine instance
let tradingEngine: TradingEngine | null = null;
let signalProcessor: SignalProcessor | null = null;
let tradeOutcomeCollector: TradeOutcomeCollector | null = null;

// Engine Supervisor for 24/7 resilience
const supervisor = new EngineSupervisor({}, logger);

// Set up supervisor callbacks
supervisor.setRestartEngineCallback(async (reason: RestartReason): Promise<boolean> => {
  logger.info('Supervisor requested engine restart', { reason });
  
  if (!tradingEngine) {
    logger.warn('No trading engine to restart');
    return false;
  }
  
  try {
    const config = tradingEngine.getConfig();
    const mode = config.mode;
    
    // Stop current engine
    await tradingEngine.stop(`supervisor_restart: ${reason}`);
    
    // Wait a moment before restarting
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // Restart engine
    await tradingEngine.start(`supervisor_restart: ${reason}`);
    
    return true;
  } catch (error) {
    logger.error('Failed to restart engine via supervisor', {
      reason,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
});

supervisor.setReconnectExchangeCallback(async (): Promise<boolean> => {
  logger.info('Supervisor requested exchange reconnect');
  
  if (!tradingEngine) {
    logger.warn('No trading engine for exchange reconnect');
    return false;
  }
  
  try {
    const exchange = tradingEngine.getExchange();
    if (exchange && typeof (exchange as any).forceWsReconnect === 'function') {
      (exchange as any).forceWsReconnect();
      return true;
    } else if (exchange) {
      // Fallback to direct WS client access
      const wsClient = (exchange as any).getWsClient?.();
      if (wsClient && typeof wsClient.forceReconnect === 'function') {
        wsClient.forceReconnect();
        return true;
      }
    }
    return false;
  } catch (error) {
    logger.error('Failed to reconnect exchange via supervisor', {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
});

// Start the supervisor
supervisor.start();

// WebSocket clients
const wsClients = new Set<any>();

// Broadcast to all WebSocket clients
function broadcast(data: any) {
  const envelope = (data && typeof data === 'object' && !Array.isArray(data))
    ? (Object.prototype.hasOwnProperty.call(data, 'timestamp') ? data : { ...data, timestamp: Date.now() })
    : { type: 'Alert', payload: data, timestamp: Date.now() };
  const message = JSON.stringify(envelope);
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

  if (!Number.isFinite(price)) {
    logger.warn('Skipping ticker with non-finite price', { symbol, price: ticker.price });
    return;
  }

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
        metricsTracker.addCandle(symbol, candle);
        tradingEngine?.notifyNewCandle(symbol);
        logger.debug(`Added candle for ${symbol}: O=${candle.open} H=${candle.high} L=${candle.low} C=${candle.close} V=${candle.volume}`);
        broadcast({
          type: 'CandleUpdate',
          payload: {
            symbol,
            timeframe: '1m',
            open: candle.open,
            high: candle.high,
            low: candle.low,
            close: candle.close,
            volume: candle.volume,
            timestamp: candle.time,
          }
        });
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
metricsInterval = setInterval(async () => {
  try {
    if (tradingEngine?.engineRunning) {
      await updateAccountMetrics();
    }
  } catch (err) {
    logger.error('Failed to handle periodic updateAccountMetrics', { error: String(err) });
  }
}, 5 * 60 * 1000);

// Periodic StatusUpdate broadcast for frontend with supervisor state
statusBroadcastInterval = setInterval(() => {
  if (wsClients.size === 0) return;
  
  // Use real metrics from tracker
  if (tradingEngine?.engineRunning) {
    const realMetrics = metricsTracker.getMetrics();
    runtimeState.wsLatencyMs = realMetrics.wsLatencyMs;
    runtimeState.restLatencyMs = realMetrics.restLatencyMs;
    runtimeState.spreadPctile = realMetrics.spreadPctile;
    runtimeState.regime = realMetrics.regime;
  }
  
  // Get supervisor state for enhanced runtime visibility
  const supervisorState = supervisor.getState();
  runtimeState.runtimeAlive = supervisorState.runtimeAlive;
  runtimeState.engineState = tradingEngine?.getEngineState() || 'stopped';
  runtimeState.lastMarketDataAt = supervisorState.lastMarketDataAt;
  runtimeState.lastEngineHeartbeatAt = supervisorState.lastEngineHeartbeatAt;
  runtimeState.restartCount = supervisorState.restartCount;
  runtimeState.lastRestartReason = supervisorState.lastRestartReason;
  runtimeState.lastRestartAt = supervisorState.lastRestartAt;
  
  // Sync kill switch state from supervisor
  if (supervisorState.killSwitch.active && !runtimeState.killSwitch.active) {
    runtimeState.killSwitch = supervisorState.killSwitch;
  }
  
  const isEngineRunning = tradingEngine !== null && tradingEngine.engineRunning;
  
  // Build PnL snapshot for broadcast
  const pnlSnapshot = buildPnLSnapshot();
  
  // Broadcast PnL snapshot as separate event so the frontend pnl:snapshot handler picks it up
  if (pnlSnapshot) {
    broadcast({ type: 'PnLSnapshot', payload: pnlSnapshot });
  }
  
  broadcast({
    type: 'StatusUpdate',
    payload: {
      engineRunning: isEngineRunning,
      mode: isEngineRunning ? tradingEngine!.getConfig().mode : null,
      paused: runtimeState.paused,
      dailyStopHit: runtimeState.dailyStopHit,
      killSwitch: runtimeState.killSwitch,
      wsLatencyMs: runtimeState.wsLatencyMs,
      restLatencyMs: runtimeState.restLatencyMs,
      spreadPctile: runtimeState.spreadPctile,
      regime: runtimeState.regime,
      risk: runtimeState.risk,
      pnl: pnlSnapshot,
      activeSymbols: tradingEngine?.getActiveSymbols() || [],
      warmupComplete: runtimeState.warmupComplete,
      candlesBuffered: runtimeState.candlesBuffered,
      // 24/7 Resilience fields
      runtimeAlive: runtimeState.runtimeAlive,
      engineState: runtimeState.engineState,
      engineDesiredState: supervisorState.engineDesiredState,
      lastMarketDataAt: runtimeState.lastMarketDataAt,
      lastEngineHeartbeatAt: runtimeState.lastEngineHeartbeatAt,
      restartCount: runtimeState.restartCount,
      lastRestartReason: runtimeState.lastRestartReason,
      lastRestartAt: runtimeState.lastRestartAt,
      timestamp: Date.now(),
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

  // Send initial StatusUpdate (must match periodic broadcast payload)
  const isEngineRunningOnConnect = tradingEngine !== null && tradingEngine.engineRunning;
  const supervisorStateOnConnect = supervisor.getState();
  const pnlSnapshotOnConnect = buildPnLSnapshot();
  
  ws.send(JSON.stringify({
    type: 'StatusUpdate',
    timestamp: Date.now(),
    payload: {
      engineRunning: isEngineRunningOnConnect,
      mode: isEngineRunningOnConnect ? tradingEngine!.getConfig().mode : null,
      paused: runtimeState.paused,
      dailyStopHit: runtimeState.dailyStopHit,
      killSwitch: runtimeState.killSwitch,
      wsLatencyMs: runtimeState.wsLatencyMs,
      restLatencyMs: runtimeState.restLatencyMs,
      spreadPctile: runtimeState.spreadPctile,
      regime: runtimeState.regime,
      risk: runtimeState.risk,
      pnl: pnlSnapshotOnConnect,
      activeSymbols: tradingEngine?.getActiveSymbols() || [],
      warmupComplete: runtimeState.warmupComplete,
      candlesBuffered: runtimeState.candlesBuffered,
      runtimeAlive: runtimeState.runtimeAlive,
      engineState: runtimeState.engineState,
      engineDesiredState: supervisorStateOnConnect.engineDesiredState,
      lastMarketDataAt: runtimeState.lastMarketDataAt,
      lastEngineHeartbeatAt: runtimeState.lastEngineHeartbeatAt,
      restartCount: runtimeState.restartCount,
      lastRestartReason: runtimeState.lastRestartReason,
      lastRestartAt: runtimeState.lastRestartAt,
      timestamp: Date.now(),
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

// Build PnL snapshot from trading engine state for frontend consumption
function buildPnLSnapshot(): Record<string, unknown> | null {
  if (!tradingEngine?.engineRunning) return null;
  
  const riskEngine = tradingEngine.getRiskEngineInstance();
  const positionTracker = tradingEngine.getPositionTrackerInstance();
  if (!riskEngine || !positionTracker) return null;
  
  const riskMetrics = riskEngine.getMetrics();
  const riskStatus = riskEngine.getRiskStatus();
  const portfolio = positionTracker.getPortfolioSummary();
  const config = tradingEngine.getConfig();
  const accountEquity = config.guardrails?.account?.equity_usd ?? 50_000;
  
  const totalEquity = riskEngine.getCurrentEquityForSizing();
  const dailyPnlUsd = riskMetrics.dailyPnL;
  const riskUnitUsd = riskStatus.riskUnitUsd ?? (accountEquity * 0.01);
  const dailyPnlR = riskUnitUsd > 0 ? dailyPnlUsd / riskUnitUsd : 0;
  
  return {
    ts: Date.now(),
    userId: config.supabase?.userId ?? '',
    sessionId: `paper-${new Date().toISOString().split('T')[0]}`,
    executionMode: config.mode ?? 'paper',
    riskDay: new Date().toISOString().split('T')[0],
    sessionStartEquityUsd: accountEquity,
    dayStartEquityUsd: riskStatus.dayStartEquityUsd ?? accountEquity,
    realizedPnlUsd: portfolio.totalRealizedPnL,
    unrealizedPnlUsd: portfolio.totalUnrealizedPnL,
    totalEquityUsd: totalEquity,
    dailyPnlUsd,
    dailyPnlR,
    riskUnitUsd,
    openPositionsCount: portfolio.positionCount,
    exposureUsd: riskMetrics.currentExposure,
    maxDrawdownPct: riskMetrics.maxDrawdown,
  };
}

// Dedicated PnL snapshot endpoint
app.get('/api/pnl', (req, res) => {
  const snapshot = buildPnLSnapshot();
  if (!snapshot) {
    return res.status(503).json({ error: 'Engine not running' });
  }
  res.json(snapshot);
});

// Get trading engine status (UI contract) with 24/7 resilience fields
app.get('/api/status', (req, res) => {
  const isEngineRunning = tradingEngine !== null && tradingEngine.engineRunning;
  const supervisorState = supervisor.getState();
  
  // Get comprehensive exchange health if available
  const exchange = tradingEngine?.getExchange();
  const wsHealth = exchange ? (exchange as any).getWsHealth?.() : null;
  const exchangeHealth = exchange ? (exchange as any).getExchangeHealth?.() : null;
  const restHealth = exchange ? (exchange as any).getRestHealth?.() : null;
  const reconcilerState = exchange ? (exchange as any).getReconcilerState?.() : null;
  
  // Include PnL snapshot for frontend consumption
  const pnlSnapshot = buildPnLSnapshot();
  
  res.json({
    engineRunning: isEngineRunning,
    mode: isEngineRunning ? tradingEngine!.getConfig().mode : null,
    paused: runtimeState.paused,
    dailyStopHit: runtimeState.dailyStopHit,
    killSwitch: supervisorState.killSwitch.active ? supervisorState.killSwitch : runtimeState.killSwitch,
    wsLatencyMs: runtimeState.wsLatencyMs,
    restLatencyMs: runtimeState.restLatencyMs,
    spreadPctile: runtimeState.spreadPctile,
    regime: runtimeState.regime,
    risk: runtimeState.risk,
    pnl: pnlSnapshot,
    activeSymbols: tradingEngine?.getActiveSymbols() || [],
    warmupComplete: runtimeState.warmupComplete ?? false,
    candlesBuffered: runtimeState.candlesBuffered ?? {},
    // 24/7 Resilience fields - ALWAYS present for UI staleness detection
    runtimeAlive: true,
    engineState: tradingEngine?.getEngineState() || 'stopped',
    engineDesiredState: supervisorState.engineDesiredState,
    lastMarketDataAt: supervisorState.lastMarketDataAt,
    lastEngineHeartbeatAt: supervisorState.lastEngineHeartbeatAt,
    restartCount: supervisorState.restartCount,
    lastRestartReason: supervisorState.lastRestartReason,
    lastRestartAt: supervisorState.lastRestartAt,
    timestamp: Date.now(), // Explicit timestamp for UI staleness detection
    // WebSocket health - single source of truth
    ws: wsHealth ? {
      connected: wsHealth.connected,
      reconnecting: wsHealth.reconnecting,
      reconnectAttempts: wsHealth.reconnectAttempts,
      lastMessageAt: wsHealth.lastMessageAt,
      messageAgeMs: wsHealth.messageAgeMs,
      isStalled: wsHealth.isStalled,
      subscriptionCount: wsHealth.subscriptions?.length ?? 0,
    } : null,
    // REST health
    rest: restHealth ? {
      circuitOpen: restHealth.circuitOpen,
      rateLimited: restHealth.rateLimited,
      consecutiveFailures: restHealth.consecutiveFailures,
      degraded: restHealth.degraded,
      degradedReasons: restHealth.degradedReasons,
    } : null,
    // Comprehensive exchange health
    exchangeHealth: exchangeHealth ? {
      degraded: exchangeHealth.degraded,
      degradedReasons: exchangeHealth.degradedReasons,
      allowsEntries: exchange ? (exchange as any).allowsNewEntries?.() : true,
      allowsExits: exchange ? (exchange as any).allowsExits?.() : true,
    } : null,
    // Reconciler state
    reconciler: reconcilerState ? {
      running: reconcilerState.running,
      lastOrderReconcileAt: reconcilerState.lastOrderReconcileAt,
      lastFillReconcileAt: reconcilerState.lastFillReconcileAt,
      degraded: reconcilerState.degraded,
      degradedReason: reconcilerState.degradedReason,
    } : null,
  });
});

// Get supervisor status for advanced monitoring
app.get('/api/supervisor/status', (req, res) => {
  const supervisorState = supervisor.getState();
  const engineHealth = tradingEngine?.getHealthInfo();
  
  res.json({
    supervisor: supervisorState,
    engine: engineHealth || null,
    config: supervisor.getConfig(),
  });
});

// Get comprehensive exchange health status
app.get('/api/exchange/health', (req, res) => {
  const exchange = tradingEngine?.getExchange();
  
  if (!exchange) {
    return res.json({
      available: false,
      message: 'Exchange not initialized (engine not running)',
    });
  }

  const exchangeHealth = (exchange as any).getExchangeHealth?.() ?? null;
  const wsHealth = (exchange as any).getWsHealth?.() ?? null;
  const restHealth = (exchange as any).getRestHealth?.() ?? null;
  const reconcilerState = (exchange as any).getReconcilerState?.() ?? null;
  const gapFillerStatus = (exchange as any).getGapFillerStatus?.() ?? [];

  res.json({
    available: true,
    health: exchangeHealth,
    ws: wsHealth,
    rest: restHealth,
    reconciler: reconcilerState,
    gapFiller: {
      trackedSymbols: gapFillerStatus,
      hasStaleData: gapFillerStatus.some((s: any) => s.isStale),
    },
    allowsEntries: (exchange as any).allowsNewEntries?.() ?? true,
    allowsExits: (exchange as any).allowsExits?.() ?? true,
  });
});

// Force exchange REST circuit breaker reset
app.post('/api/exchange/reset-circuit', (req, res) => {
  const exchange = tradingEngine?.getExchange();
  
  if (!exchange) {
    return res.status(400).json({ error: 'Exchange not available' });
  }

  try {
    (exchange as any).forceCloseRestCircuit?.();
    logger.info('Exchange REST circuit breaker force reset via API');
    res.json({ success: true, message: 'Circuit breaker reset' });
  } catch (error) {
    logger.error('Failed to reset circuit breaker:', error);
    res.status(500).json({ error: 'Failed to reset circuit breaker' });
  }
});

// Trigger immediate reconciliation
app.post('/api/exchange/reconcile', async (req, res) => {
  const exchange = tradingEngine?.getExchange();
  
  if (!exchange) {
    return res.status(400).json({ error: 'Exchange not available' });
  }

  try {
    await (exchange as any).triggerReconciliation?.();
    logger.info('Reconciliation triggered via API');
    res.json({ success: true, message: 'Reconciliation triggered' });
  } catch (error) {
    logger.error('Failed to trigger reconciliation:', error);
    res.status(500).json({ error: 'Failed to trigger reconciliation' });
  }
});

// Reset supervisor restart tracking (for manual intervention)
app.post('/api/supervisor/reset-restarts', (req, res) => {
  supervisor.resetRestartTracking();
  logger.info('Supervisor restart tracking reset via API');
  res.json({ success: true, message: 'Restart tracking reset' });
});

// Deactivate kill switch (resume trading)
app.post('/api/killswitch/deactivate', async (req, res) => {
  const { confirm } = req.body;
  
  if (confirm !== 'RESUME TRADING') {
    return res.status(400).json({ 
      error: "Confirmation phrase 'RESUME TRADING' required to deactivate kill switch" 
    });
  }
  
  try {
    supervisor.deactivateKillSwitch();
    
    if (tradingEngine) {
      tradingEngine.getRiskEngineInstance()?.deactivateKillSwitch();
    }
    
    runtimeState.killSwitch.active = false;
    runtimeState.killSwitch.reasons = [];
    runtimeState.killSwitch.since = null;
    
    killSwitchActiveGauge.set(0);
    
    // Broadcast kill switch deactivated
    broadcast({
      type: 'KillSwitchDeactivated',
      payload: {
        timestamp: Date.now(),
      }
    });
    
    logger.info('Kill switch deactivated via API');
    res.json({ success: true, message: 'Kill switch deactivated - trading can resume' });
  } catch (error) {
    logger.error('Failed to deactivate kill switch:', error);
    res.status(500).json({ error: 'Failed to deactivate kill switch' });
  }
});

// Start trading engine
app.post('/api/engine/start', async (req, res) => {
  if (engineOperationInProgress) {
    return res.status(409).json({ error: 'Engine operation already in progress' });
  }
  engineOperationInProgress = true;
  try {
    const { mode = 'paper', marketDataEnv, confirm } = req.body || {};
    const requestedMarketEnv = marketDataEnv === 'sandbox' ? 'sandbox' : 'production';

    if (tradingEngine) {
      return res.status(400).json({ error: 'Trading engine already running' });
    }

    // Enhanced gating for live mode (hard stop unless explicitly confirmed)
    if (mode === 'live') {
      if (env.CONFIRM_LIVE !== 'YES') {
        return res.status(403).json({
          error: 'Live trading is blocked. Set CONFIRM_LIVE=YES in your environment and restart the API server.',
        });
      }
      
      const expectedPhrase = DEFAULT_LIVE_CONFIRM_PHRASE;
      if (confirm !== expectedPhrase) {
        return res.status(400).json({
          error: `Confirmation phrase '${expectedPhrase}' required to start live trading`,
        });
      }
    }

    // Clone guardrails so live preflight can safely adjust session-specific parameters
    const engineGuardrails = structuredClone(guardrails);

    // Live preflight checklist (fails fast with explicit errors)
    if (mode === 'live') {
      const preflight = await runLivePreflight({
        engineGuardrails,
        products: ['BTC-USD', 'ETH-USD', 'SOL-USD'],
      });
      if (!preflight.ok) {
        return res.status(400).json({
          error: preflight.error,
          details: preflight.details,
          warnings: preflight.warnings,
        });
      }
    }

    // Step 4: Unified environment config
    // Paper mode now uses production market data by default
    const resolvedMarketDataEnv = requestedMarketEnv === 'sandbox' ? 'sandbox' : 'production';
    
    const engineConfig: TradingEngineConfig = {
      mode: mode as 'paper' | 'live',
      exchange: {
        name: 'coinbase',
        // For market data connectivity (used by WS/REST for price data)
        environment: resolvedMarketDataEnv
      },
      products: ['BTC-USD', 'ETH-USD', 'SOL-USD'],
      supabase: {
        url: env.SUPABASE_URL || '',
        serviceKey: env.SUPABASE_SERVICE_KEY || '',
        anonKey: env.SUPABASE_ANON_KEY || '',
        userId: USER_ID
      },
      security: {
        encryptionKey: env.ENCRYPTION_KEY || ''
      },
      guardrails: engineGuardrails,
      // New unified runtime config
      runtime: {
        marketDataEnv: resolvedMarketDataEnv,
        executionEnv: mode === 'live' ? 'production' : 'production', // Paper ignores this
        paperInitialEquityUsd: engineGuardrails.account.equity_usd,
      }
    };

    logger.info(`Starting trading engine in ${mode} mode`, {
      marketDataEnv: resolvedMarketDataEnv,
      executionMode: mode,
    });

    // Create trading engine
    tradingEngine = new TradingEngine(engineConfig, logger);
    
    // Update metrics
    engineRunningGauge.set(1);

    // Connect engine to supervisor for 24/7 monitoring
    tradingEngine.on('engine:heartbeat', (timestamp) => {
      supervisor.recordEngineHeartbeat();
    });

    tradingEngine.on('engine:state_changed', (state, reason) => {
      supervisor.setActualState(state as any, reason);
      
      // Broadcast state change to UI
      broadcast({
        type: 'EngineStateChanged',
        payload: {
          state,
          reason,
          timestamp: Date.now(),
        }
      });
    });

    tradingEngine.on('engine:fatal', (error, context) => {
      logger.error('Engine fatal error received', { context, error: error.message });
      broadcast({
        type: 'EngineError',
        payload: {
          context,
          error: error.message,
          timestamp: Date.now(),
        }
      });
    });

    // Set up event listeners to update frontend
    tradingEngine.on('market:ticker', (ticker) => {
      // Record market data for supervisor monitoring
      supervisor.recordMarketData();
      const toNumber = (value: unknown, fallback: number): number => {
        const parsed = typeof value === 'number' ? value : parseFloat(String(value ?? ''));
        return Number.isFinite(parsed) ? parsed : fallback;
      };

      const price = toNumber(ticker.price, NaN);
      if (!Number.isFinite(price)) {
        logger.warn('Skipping ticker with non-finite price', { product_id: ticker.product_id, price: ticker.price });
        return;
      }

      const bid = toNumber((ticker as any).best_bid ?? (ticker as any).bestBid, price);
      const ask = toNumber((ticker as any).best_ask ?? (ticker as any).bestAsk, price);
      const volume = toNumber((ticker as any).last_size ?? (ticker as any).volume_24h, 0);
      const ts = ticker.time ? new Date(ticker.time).getTime() : Date.now();
      const timestamp = Number.isFinite(ts) ? ts : Date.now();

      const normalizedTicker = {
        symbol: ticker.product_id,
        price,
        bid,
        ask,
        volume,
        timestamp,
      };

      broadcast({ type: 'TickerUpdate', payload: normalizedTicker });
      
      // Update Supabase (for frontend queries)
      updateSupabasePrice(ticker.product_id, normalizedTicker.price);

      // Feed bar aggregator → signal processor
      processTickerForCandles({
        product_id: ticker.product_id,
        price: ticker.price,
        last_size: (ticker as any).last_size,
        time: ticker.time,
      });
    });

    tradingEngine.on('order:created', async (order) => {
      try {
        ordersCreatedCounter.inc();
        broadcast({ type: 'OrderUpdate', payload: order });
        await syncOrderToSupabase(order);
      } catch (err) {
        logger.error('Failed to handle order:created', { error: String(err) });
      }
    });

    tradingEngine.on('order:filled', async (order, fill) => {
      try {
        ordersFilledCounter.inc();
        // Broadcast order status update + fill
        broadcast({ type: 'OrderUpdate', payload: order });
        broadcast({ type: 'Fill', payload: fill });
        await syncOrderToSupabase(order);
        await syncFillToSupabase(fill);
        // Update account metrics after fills
        await updateAccountMetrics();
      } catch (err) {
        logger.error('Failed to handle order:filled', { error: String(err) });
      }
    });

    tradingEngine.on('position:update', async (position) => {
      try {
        broadcast({ type: 'PositionUpdate', payload: position });
        await syncPositionToSupabase(position);
        
        // Record outcome for ML training when position is closed
        if (position.side === 'flat' && tradeOutcomeCollector?.isEnabled()) {
          try {
            await tradeOutcomeCollector.recordOutcome(position);
          } catch (error) {
            logger.error('Failed to record trade outcome', {
              positionId: position.id,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      } catch (err) {
        logger.error('Failed to handle position:update', { error: String(err) });
      }
    });

    tradingEngine.on('risk:alert', async (alert) => {
      try {
        if (alert?.type === 'kill_switch') {
          killSwitchActiveGauge.set(1);
          runtimeState.killSwitch.active = true;
          runtimeState.killSwitch.reasons = Array.isArray(alert?.reasons) ? alert.reasons : [alert?.message || 'Kill switch'];
          runtimeState.killSwitch.since = Date.now();
        }
        broadcast({ type: 'RiskEvent', payload: alert });
        await createSupabaseAlert(alert);
      } catch (err) {
        logger.error('Failed to handle risk:alert', { error: String(err) });
      }
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
      
      // Sync kill switch state from risk engine to runtimeState
      if (runtimeState.risk.killSwitchActive && !runtimeState.killSwitch.active) {
        runtimeState.killSwitch.active = true;
        runtimeState.killSwitch.reasons = [`Daily loss: $${Math.abs(runtimeState.risk.dailyPnLUsd).toFixed(2)}`];
        runtimeState.killSwitch.since = runtimeState.killSwitch.since || Date.now();
      }
      
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
          volumeThreshold: 1.1
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

    // Set up data loader from exchange for historical data
    // Uses Coinbase public REST endpoint (no auth required) for fast warmup
    signalProcessor.setDataLoader(async (symbol: string, limit: number) => {
      // Try primary: exchange REST client (works with credentials)
      if (tradingEngine) {
        try {
          const exchange = (tradingEngine as any).exchange;
          if (exchange) {
            const end = new Date();
            const start = new Date(end.getTime() - limit * 60 * 1000);
            
            const candles = await exchange.getCandles(symbol, {
              start: start.toISOString(),
              end: end.toISOString(),
              granularity: 60,
            });
            
            if (candles && candles.length > 0) {
              return candles.map((c: any) => ({
                time: c.time * 1000,
                open: c.open,
                high: c.high,
                low: c.low,
                close: c.close,
                volume: c.volume,
              }));
            }
          }
        } catch (error) {
          logger.warn(`Exchange REST candle fetch failed for ${symbol}, trying public API fallback`);
        }
      }
      
      // Fallback: Coinbase public REST API (no auth required)
      // Works in paper mode without credentials — essential for fast warmup
      try {
        const end = Math.floor(Date.now() / 1000);
        const start = end - (limit * 60);
        const url = `https://api.exchange.coinbase.com/products/${symbol}/candles?granularity=60&start=${start}&end=${end}`;
        
        logger.info(`Loading historical candles from public API for ${symbol}`, { limit });
        
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15000);
        
        const response = await fetch(url, {
          headers: { 'User-Agent': 'AtlasBot/1.0' },
          signal: controller.signal,
        });
        clearTimeout(timeout);
        
        if (!response.ok) {
          logger.warn(`Public candle API returned ${response.status} for ${symbol}`);
          return [];
        }
        
        const data = await response.json() as number[][];
        
        // Coinbase public API returns: [time, low, high, open, close, volume]
        // Each element is an array of 6 numbers, newest first
        if (!Array.isArray(data) || data.length === 0) {
          return [];
        }
        
        const candles = data
          .filter((c: any) => Array.isArray(c) && c.length >= 6)
          .map((c: number[]) => ({
            time: c[0] * 1000, // Convert to milliseconds
            open: c[3],
            high: c[2],
            low: c[1],
            close: c[4],
            volume: c[5],
          }))
          .sort((a: any, b: any) => a.time - b.time); // Sort oldest first
        
        logger.info(`Loaded ${candles.length} historical candles from public API for ${symbol}`);
        return candles;
      } catch (error) {
        logger.warn(`Public API candle fetch failed for ${symbol}:`, error);
        return [];
      }
    });
    
    // Load per-symbol strategy overrides from guardrails
    if (guardrails.per_symbol) {
      signalProcessor.loadPerSymbolOverridesFromGuardrails(guardrails.per_symbol);
      logger.info('Loaded per-symbol strategy overrides', {
        symbols: Object.keys(guardrails.per_symbol),
      });
    }

    // Initialize trade outcome collector for ML training data
    tradeOutcomeCollector = new TradeOutcomeCollector({
      supabaseUrl: env.SUPABASE_URL || '',
      supabaseKey: env.SUPABASE_SERVICE_KEY || '',
      sessionId: `session_${Date.now()}`,
      enabled: true,
      profitThreshold: 0,
    }, logger);
    
    logger.info('Trade outcome collector initialized', {
      enabled: tradeOutcomeCollector.isEnabled(),
    });
    
    // Listen for warmup events
    signalProcessor.on('warmup:complete', (symbol: string) => {
      logger.info(`Warmup complete for ${symbol}`);
      runtimeState.candlesBuffered[symbol] = signalProcessor!.getCandleCount(symbol);
      runtimeState.warmupComplete = signalProcessor!.isAllWarmedUp();
      broadcast({ 
        type: 'WarmupUpdate', 
        payload: { 
          symbol, 
          complete: true, 
          candlesBuffered: runtimeState.candlesBuffered,
          allWarmedUp: runtimeState.warmupComplete,
        } 
      });
    });
    
    signalProcessor.on('warmup:progress', (symbol: string, loaded: number, required: number) => {
      runtimeState.candlesBuffered[symbol] = loaded;
      broadcast({ 
        type: 'WarmupUpdate', 
        payload: { 
          symbol, 
          complete: false, 
          loaded, 
          required,
          candlesBuffered: runtimeState.candlesBuffered,
        } 
      });
    });

    // Listen for regime updates and broadcast
    signalProcessor.on('regime:updated', (symbol: string, regimeState: any) => {
      runtimeState.regime = regimeState.regime;
      broadcast({
        type: 'RegimeUpdate',
        payload: {
          symbol,
          regime: regimeState.regime,
          confidence: regimeState.confidence,
          trendDirection: regimeState.trendDirection,
          adx: regimeState.adx,
          choppiness: regimeState.choppiness,
          mtfAlignment: regimeState.mtfAlignment,
        },
      });
    });

    signalProcessor.on('regime:changed', (symbol: string, oldRegime: string, newRegime: string) => {
      logger.info('Regime changed', { symbol, from: oldRegime, to: newRegime });
      broadcast({
        type: 'RegimeChanged',
        payload: {
          symbol,
          oldRegime,
          newRegime,
          timestamp: Date.now(),
        },
      });
    });

    // Listen for regime-filtered signals
    signalProcessor.on('signal:regime_filtered', (signal: any, regimeState: any, reason: string) => {
      broadcast({
        type: 'SignalFiltered',
        payload: {
          signal,
          regime: regimeState.regime,
          reason,
          filterType: 'regime',
        },
      });
    });

    // Listen for meta-filtered signals (trade quality)
    signalProcessor.on('signal:meta_filtered', (signal: any, result: any, reason: string) => {
      broadcast({
        type: 'SignalFiltered',
        payload: {
          signal,
          qualityScore: result.qualityScore,
          coldStreakActive: result.coldStreakActive,
          reason,
          filterType: 'meta',
          rulesEvaluated: result.rulesEvaluated?.map((r: any) => ({
            rule: r.rule,
            passed: r.passed,
            reason: r.reason,
          })),
        },
      });
    });

    // Listen for signals and create orders
    signalProcessor.on('signal:generated', async (signal) => {
      try {
        logger.info('Signal generated', signal);
        broadcast({ type: 'Signal', payload: signal });

        // Capture signal context for ML training
        if (tradeOutcomeCollector?.isEnabled()) {
          const regimeState = signalProcessor!.getRegimeState(signal.symbol);
          const indicators = signal.metadata?.indicators as Record<string, number> || {};
          
          tradeOutcomeCollector.captureSignalContext(
            {
              id: signal.id,
              symbol: signal.symbol,
              strategy: signal.strategy,
              direction: signal.direction,
              strength: signal.strength,
              price: signal.price,
              stopLoss: signal.stopLoss,
              takeProfit: signal.takeProfit,
              timestamp: signal.timestamp,
              metadata: signal.metadata || {},
            },
            regimeState || {
              regime: 'ranging',
              confidence: 0.5,
              adx: 0,
              plusDI: 0,
              minusDI: 0,
              atrPercent: 0,
              bbWidth: 0,
              choppiness: 0,
              trendDirection: 'neutral',
              directionConsistency: 0.5,
              mtfAlignment: 0,
              lastUpdated: new Date(),
              regimeSince: new Date(),
            },
            indicators,
            {
              volumeRatio: indicators.volumeRatio,
              metaFilterScore: signal.metadata?.metaQualityScore as number,
              coldStreakActive: signal.metadata?.coldStreakActive as boolean,
              positionMultiplier: signal.metadata?.positionMultiplier as number,
            }
          );
        }
        
        // Store signal in Supabase
        await syncSignalToSupabase(signal);
        
        // Create order if risk checks pass
        try {
        const shortAllowed = Boolean(guardrails.strategy.allow_short);
        const isExitSignal = signal.direction === 'sell' && !shortAllowed;
        
        // Suppress NEW entries when paused/dailyStop/killSwitch, but always allow exits.
        if (!isExitSignal && (runtimeState.paused || runtimeState.dailyStopHit || runtimeState.killSwitch.active)) {
          logger.warn('Signal suppressed due to runtime state (paused/dailyStop/killSwitch)');
          return;
        }

        const signalTime = signal.timestamp instanceof Date ? signal.timestamp : new Date(signal.timestamp ?? Date.now());
        const entryPrice = signal.price;
        const fallbackStop = signal.direction === 'buy'
          ? entryPrice * 0.985
          : entryPrice * 1.015;
        const stopPrice = signal.stopLoss ?? fallbackStop;

        // If shorts are disabled (spot mode), treat SELL signals as "exit long" signals.
        if (isExitSignal) {
          const openPosition = tradingEngine!.getOpenPositions().find(p => p.symbol === signal.symbol && p.side === 'long' && p.size > 0);
          if (!openPosition) {
            logger.info('Sell signal ignored (no long position to exit)', { symbol: signal.symbol, signalId: signal.id, strategy: signal.strategy });
            return;
          }
          
          const closeOrder: Omit<OrderRequest, 'client_oid'> = {
            product_id: signal.symbol,
            side: 'sell',
            type: 'market',
            size: openPosition.size.toString(),
          };
          
          const exit = await tradingEngine!.createOrder(closeOrder, {
            strategy: signal.strategy,
            metadata: {
              tag: 'signal_exit',
              signalId: signal.id,
              signalTimestamp: signalTime.toISOString(),
              reason: 'sell_signal_exit_long',
            }
          });
          
          if (exit) {
            logger.info('Exited long position from sell signal', { orderId: exit.id, symbol: signal.symbol, size: openPosition.size });
          }
          return;
        }

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
          logger.warn('Guardrail sizing returned zero/invalid size, skipping signal', {
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

        const order = await tradingEngine!.createOrder(orderRequest, {
          strategy: signal.strategy,
          metadata: {
            tag: 'entry',
            signalId: signal.id,
            signalTimestamp: signalTime.toISOString(),
            stopPrice,
            takeProfit: signal.takeProfit,
            intendedEntryPrice: entryPrice,
            notionalUsd: computedSize * entryPrice,
          }
        });
        if (order) {
          logger.info('Order placed from signal', { orderId: order.id, signal: signal.id });
        }
      } catch (error) {
        logger.error('Failed to place order from signal:', error);
      }
      } catch (err) {
        logger.error('Failed to handle signal:generated', { error: String(err) });
      }
    });

    // Start the engine
    await tradingEngine.start('api_request');
    
    // Update supervisor state
    supervisor.setDesiredState('running', mode as any);
    supervisor.setActualState('running', 'engine_started');
    
    // Load historical data for warmup (don't await - do in background)
    const activeSymbols = tradingEngine.getActiveSymbols();
    logger.info(`Starting warmup for ${activeSymbols.length} symbols`);
    
    Promise.all(
      activeSymbols.map(symbol => 
        signalProcessor!.loadHistoricalData(symbol).catch(err => {
          logger.warn(`Warmup failed for ${symbol}:`, err);
        })
      )
    ).then(() => {
      logger.info('All symbol warmup attempts completed');
      runtimeState.warmupComplete = signalProcessor!.isAllWarmedUp();
      runtimeState.candlesBuffered = signalProcessor!.getAllCandleCounts();
    });

    res.json({
      success: true,
      message: `Trading engine started in ${mode} mode`,
      activeSymbols,
    });

  } catch (error) {
    const errorDetails = {
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      name: error instanceof Error ? error.name : typeof error,
    };
    logger.error('Failed to start trading engine:', errorDetails);
    res.status(500).json({ error: 'Failed to start trading engine', details: errorDetails });
  } finally {
    engineOperationInProgress = false;
  }
});

type LivePreflightResult =
  | { ok: true; warnings: string[] }
  | { ok: false; error: string; details?: Record<string, any>; warnings: string[] };

async function runLivePreflight(input: {
  engineGuardrails: typeof guardrails;
  products: string[];
}): Promise<LivePreflightResult> {
  const warnings: string[] = [];
  
  // Validate API version and credentials
  const apiVersion = env.COINBASE_API_VERSION || 'exchange';
  
  if (!env.COINBASE_API_KEY || !env.COINBASE_API_SECRET) {
    return {
      ok: false,
      error: 'Missing COINBASE_API_KEY / COINBASE_API_SECRET for live trading',
      warnings,
    };
  }
  
  if (apiVersion === 'exchange' && !env.COINBASE_API_PASSPHRASE) {
    return {
      ok: false,
      error: 'Missing COINBASE_API_PASSPHRASE for live trading (required for legacy Coinbase Exchange API auth)',
      warnings,
    };
  }
  
  if (apiVersion === 'advanced') {
    // Advanced Trade API uses JWT with EC private key — validate key format
    const secret = env.COINBASE_API_SECRET || '';
    const cleanSecret = secret.replace(/\\n/g, '\n').trim();
    if (!cleanSecret.includes('BEGIN EC PRIVATE KEY') && !cleanSecret.includes('BEGIN PRIVATE KEY')) {
      return {
        ok: false,
        error: 'COINBASE_API_SECRET must be an EC private key in PEM format for Advanced Trade API',
        warnings,
      };
    }
    warnings.push('Using Coinbase Advanced Trade API (JWT auth with ES256)');
  }
  
  // Ensure exchange credentials are stored in Supabase (the trading engine loads secrets from Supabase).
  const secretManager = new SecretManager(
    {
      supabaseUrl: env.SUPABASE_URL || '',
      supabaseServiceKey: env.SUPABASE_SERVICE_KEY || '',
      encryptionKey: env.ENCRYPTION_KEY || '',
    },
    logger
  );
  
  try {
    let credentialsOk = false;
    try {
      const existing = await secretManager.getExchangeCredentials('coinbase', 'production');
      credentialsOk = Boolean(existing?.apiKey && existing?.apiSecret);
    } catch (err) {
      // Likely encryption key mismatch or corrupt record; we'll re-seed from env below.
      warnings.push('Existing exchange credentials could not be decrypted; re-seeding from environment');
    }
    
    if (!credentialsOk) {
      await secretManager.storeExchangeCredentials('coinbase', {
        apiKey: env.COINBASE_API_KEY,
        apiSecret: env.COINBASE_API_SECRET,
        apiPassphrase: env.COINBASE_API_PASSPHRASE,
        environment: 'production',
      });
    }
  } catch (error) {
    return {
      ok: false,
      error: 'Failed to ensure exchange credentials are available in Supabase',
      details: { message: error instanceof Error ? error.message : String(error) },
      warnings,
    };
  }
  
  // Fetch credentials from Supabase and validate live REST connectivity.
  let credentials: { apiKey: string; apiSecret: string; apiPassphrase?: string } | null = null;
  try {
    const fetched = await secretManager.getExchangeCredentials('coinbase', 'production');
    credentials = fetched ? { apiKey: fetched.apiKey, apiSecret: fetched.apiSecret, apiPassphrase: fetched.apiPassphrase } : null;
  } catch (error) {
    return {
      ok: false,
      error: 'Failed to load exchange credentials from Supabase (decryption or schema issue)',
      details: { message: error instanceof Error ? error.message : String(error) },
      warnings,
    };
  }
  
  if (!credentials) {
    return { ok: false, error: 'No Coinbase production credentials found', warnings };
  }
  
  try {
    const exchange = new CoinbaseExchange(
      {
        apiKey: credentials.apiKey,
        apiSecret: credentials.apiSecret,
        apiPassphrase: credentials.apiPassphrase,
        environment: 'production',
        wsUrl: 'wss://ws-feed.exchange.coinbase.com',
        restUrl: 'https://api.exchange.coinbase.com',
      },
      logger
    );
    
    // REST ping (safe): list accounts + validate required products exist
    const accounts = await exchange.getAccounts();
    const usd = accounts.find(a => a.currency === 'USD');
    const usdBalance = usd ? Number.parseFloat(usd.balance) : NaN;
    if (!Number.isFinite(usdBalance) || usdBalance <= 0) {
      warnings.push('Could not determine positive USD balance from Coinbase accounts (equity sanity check skipped)');
    } else {
      const configuredEquity = input.engineGuardrails.account.equity_usd;
      if (usdBalance < configuredEquity * 0.95) {
        // Safety: scale down equity to avoid over-risking the live account.
        input.engineGuardrails.account.equity_usd = usdBalance;
        warnings.push(`Guardrails equity_usd scaled down for live session (${configuredEquity} → ${usdBalance})`);
      }
    }
    
    const products = await exchange.getProducts();
    const productIds = new Set(products.map(p => p.id));
    const missing = input.products.filter(p => !productIds.has(p));
    if (missing.length > 0) {
      return {
        ok: false,
        error: `Live preflight failed: missing products on Coinbase: ${missing.join(', ')}`,
        warnings,
      };
    }
  } catch (error) {
    return {
      ok: false,
      error: 'Live preflight failed: Coinbase REST connectivity check failed',
      details: { message: error instanceof Error ? error.message : String(error) },
      warnings,
    };
  }
  
  return { ok: true, warnings };
}

// Stop trading engine
app.post('/api/engine/stop', async (req, res) => {
  if (engineOperationInProgress) {
    return res.status(409).json({ error: 'Engine operation already in progress' });
  }
  engineOperationInProgress = true;
  try {
    if (!tradingEngine) {
      return res.status(400).json({ error: 'Trading engine not running' });
    }

    // Update supervisor state first
    supervisor.setDesiredState('stopped');
    
    await tradingEngine.stop('api_request');
    tradingEngine = null;
    signalProcessor = null;
    
    // Update supervisor actual state
    supervisor.setActualState('stopped', 'api_stop_request');
    
    // Update metrics
    engineRunningGauge.set(0);

    res.json({ success: true, message: 'Trading engine stopped' });

  } catch (error) {
    logger.error('Failed to stop trading engine:', error);
    res.status(500).json({ error: 'Failed to stop trading engine' });
  } finally {
    engineOperationInProgress = false;
  }
});

// Emergency kill switch
app.post('/api/engine/kill', async (req, res) => {
  if (engineOperationInProgress) {
    return res.status(409).json({ error: 'Engine operation already in progress' });
  }
  engineOperationInProgress = true;
  try {
    const reason = 'User activated kill switch';
    
    // Activate kill switch via supervisor (this halts trading but keeps runtime alive)
    supervisor.activateKillSwitch([reason]);
    
    if (tradingEngine) {
      // Do NOT stop the engine - just halt trading
      // The engine stays alive for market data and status updates
      tradingEngine.getRiskEngineInstance()?.activateKillSwitch(reason);
    }
    
    // Update metrics
    killSwitchActiveGauge.set(1);
    runtimeState.killSwitch.active = true;
    runtimeState.killSwitch.reasons = [reason];
    runtimeState.killSwitch.since = Date.now();

    // Update risk events in Supabase
    await supabase
      .from('risk_events')
      .insert({
        user_id: USER_ID,
        event_type: 'kill_switch',
        details: { reason },
        active: true,
        triggered_at: new Date().toISOString()
      });

    // Broadcast kill switch event
    broadcast({
      type: 'KillSwitchTriggered',
      payload: {
        active: true,
        reasons: [reason],
        since: runtimeState.killSwitch.since,
        timestamp: Date.now(),
      }
    });

    res.json({ 
      success: true, 
      message: 'Kill switch activated - trading halted, runtime still active',
      engineStillAlive: tradingEngine !== null,
    });

  } catch (error) {
    logger.error('Failed to activate kill switch:', error);
    res.status(500).json({ error: 'Failed to activate kill switch' });
  } finally {
    engineOperationInProgress = false;
  }
});

// Control: pause
app.post('/api/control/pause', (req, res) => {
  runtimeState.paused = true;
  const isRunning = tradingEngine !== null && tradingEngine.engineRunning;
  broadcast({ type: 'StatusUpdate', payload: { ...runtimeState, engineRunning: isRunning, mode: isRunning ? tradingEngine!.getConfig().mode : null } });
  res.json({ ok: true });
});

// Control: resume
app.post('/api/control/resume', (req, res) => {
  runtimeState.paused = false;
  const isRunning = tradingEngine !== null && tradingEngine.engineRunning;
  broadcast({ type: 'StatusUpdate', payload: { ...runtimeState, engineRunning: isRunning, mode: isRunning ? tradingEngine!.getConfig().mode : null } });
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

// ============================================================================
// Analytics Endpoints - Real-time Performance Tracking & Telemetry
// ============================================================================

// Get session statistics
app.get('/api/analytics/session', (req, res) => {
  if (!tradingEngine || !tradingEngine.engineRunning) {
    return res.status(400).json({ error: 'Trading engine not running' });
  }
  
  const stats = tradingEngine.getSessionStats();
  if (!stats) {
    return res.status(400).json({ error: 'Analytics not available' });
  }
  
  // Return stats without equity curve (large payload)
  const { equityCurve, ...statsWithoutCurve } = stats;
  res.json(statsWithoutCurve);
});

// Get equity curve data
app.get('/api/analytics/equity-curve', (req, res) => {
  if (!tradingEngine) {
    return res.status(400).json({ error: 'Trading engine not running' });
  }
  
  const curve = tradingEngine.getEquityCurve();
  const stats = tradingEngine.getSessionStats();
  
  res.json({
    equityCurve: curve,
    highWaterMark: stats?.highWaterMark ?? 0,
    currentEquity: stats?.totalPnl ? guardrails.account.equity_usd + stats.totalPnl : guardrails.account.equity_usd,
    maxDrawdown: stats?.maxDrawdown ?? 0,
  });
});

// Get recent trades
app.get('/api/analytics/trades', (req, res) => {
  if (!tradingEngine) {
    return res.status(400).json({ error: 'Trading engine not running' });
  }
  
  const limit = Math.min(parseInt(req.query.limit as string) || 50, 500);
  const trades = tradingEngine.getRecentTrades(limit);
  
  res.json({ trades });
});

// Get historical trade log from database
app.get('/api/analytics/trade-history', async (req, res) => {
  const startDate = req.query.start as string || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const endDate = req.query.end as string || new Date().toISOString().split('T')[0];
  const limit = Math.min(parseInt(req.query.limit as string) || 100, 1000);
  
  try {
    const { data, error } = await supabase
      .from('trade_log')
      .select('*')
      .eq('user_id', USER_ID)
      .gte('entry_time', `${startDate}T00:00:00Z`)
      .lte('entry_time', `${endDate}T23:59:59Z`)
      .order('entry_time', { ascending: false })
      .limit(limit);
    
    if (error) {
      // Table may not exist yet
      if (error.code === '42P01') {
        return res.json({ trades: [], message: 'Trade log table not yet created' });
      }
      throw error;
    }
    
    res.json({ trades: data || [] });
  } catch (error) {
    logger.error('Failed to fetch trade history:', error);
    res.status(500).json({ error: 'Failed to fetch trade history' });
  }
});

// Get daily trade summary
app.get('/api/analytics/daily-summary', async (req, res) => {
  const days = Math.min(parseInt(req.query.days as string) || 30, 365);
  const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  
  try {
    // First try the view
    const { data, error } = await supabase
      .from('daily_trade_summary')
      .select('*')
      .eq('user_id', USER_ID)
      .gte('trade_date', startDate)
      .order('trade_date', { ascending: false });
    
    if (error) {
      // View/table may not exist
      if (error.code === '42P01' || error.code === 'PGRST116') {
        return res.json({ summary: [], message: 'Daily summary not yet available' });
      }
      throw error;
    }
    
    res.json({ summary: data || [] });
  } catch (error) {
    logger.error('Failed to fetch daily summary:', error);
    res.status(500).json({ error: 'Failed to fetch daily summary' });
  }
});

// Get historical sessions
app.get('/api/analytics/sessions', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
  
  try {
    const { data, error } = await supabase
      .from('trading_sessions')
      .select('*')
      .eq('user_id', USER_ID)
      .order('start_time', { ascending: false })
      .limit(limit);
    
    if (error) {
      if (error.code === '42P01') {
        return res.json({ sessions: [], message: 'Sessions table not yet created' });
      }
      throw error;
    }
    
    res.json({ sessions: data || [] });
  } catch (error) {
    logger.error('Failed to fetch sessions:', error);
    res.status(500).json({ error: 'Failed to fetch sessions' });
  }
});

// Get real-time system metrics (for Grafana / monitoring)
app.get('/api/analytics/system-metrics', (req, res) => {
  const memoryUsage = process.memoryUsage();
  const uptime = process.uptime();
  const realMetrics = metricsTracker.getMetrics();
  
  const engineStats = tradingEngine?.getSessionStats();
  const riskMetrics = tradingEngine?.getRiskMetrics();
  
  res.json({
    system: {
      uptimeSeconds: uptime,
      memoryUsedMB: Math.round(memoryUsage.heapUsed / 1024 / 1024),
      memoryTotalMB: Math.round(memoryUsage.heapTotal / 1024 / 1024),
      rssMB: Math.round(memoryUsage.rss / 1024 / 1024),
    },
    latency: {
      wsLatencyMs: realMetrics.wsLatencyMs,
      restLatencyMs: realMetrics.restLatencyMs,
    },
    market: {
      spreadBps: realMetrics.spreadBps,
      spreadPctile: realMetrics.spreadPctile,
      regime: realMetrics.regime,
      atr: realMetrics.atr,
    },
    trading: {
      engineRunning: tradingEngine?.engineRunning ?? false,
      mode: tradingEngine?.getConfig().mode ?? null,
      totalTrades: engineStats?.totalTrades ?? 0,
      winRate: engineStats?.winRate ?? 0,
      sessionPnl: engineStats?.totalPnl ?? 0,
      maxDrawdown: engineStats?.maxDrawdown ?? 0,
    },
    risk: {
      exposureUsd: riskMetrics?.currentExposure ?? 0,
      dailyPnl: riskMetrics?.dailyPnL ?? 0,
      killSwitchActive: riskMetrics?.killSwitchActive ?? false,
      consecutiveLosses: riskMetrics?.consecutiveLosses ?? 0,
    },
  });
});

// ============ Regime Detection Endpoints ============

// Get current regime state for all symbols
// Alias for /api/regime/state for consistency
app.get('/api/regime/status', (req, res) => {
  if (!signalProcessor) {
    return res.status(400).json({ error: 'Signal processor not running' });
  }
  
  const allStates = signalProcessor.getAllRegimeStates();
  const statesObj: Record<string, any> = {};
  
  for (const [symbol, state] of allStates) {
    statesObj[symbol] = {
      regime: state.regime,
      confidence: state.confidence,
      trendDirection: state.trendDirection,
      adx: state.adx,
      choppiness: state.choppiness,
      lastUpdated: state.lastUpdated,
    };
  }

  res.json({
    regimes: statesObj,
    count: allStates.size,
  });
});

app.get('/api/regime/state', (req, res) => {
  if (!signalProcessor) {
    return res.status(400).json({ error: 'Signal processor not running' });
  }

  const allStates = signalProcessor.getAllRegimeStates();
  const statesObj: Record<string, any> = {};
  
  for (const [symbol, state] of allStates) {
    statesObj[symbol] = {
      regime: state.regime,
      confidence: state.confidence,
      trendDirection: state.trendDirection,
      adx: state.adx,
      plusDI: state.plusDI,
      minusDI: state.minusDI,
      atrPercent: state.atrPercent,
      bbWidth: state.bbWidth,
      choppiness: state.choppiness,
      directionConsistency: state.directionConsistency,
      mtfAlignment: state.mtfAlignment,
      lastUpdated: state.lastUpdated,
      regimeSince: state.regimeSince,
    };
  }

  res.json({
    states: statesObj,
    summary: {
      trending: Array.from(allStates.entries())
        .filter(([, s]) => s.regime === 'strong_trend' || s.regime === 'weak_trend')
        .map(([symbol]) => symbol),
      ranging: Array.from(allStates.entries())
        .filter(([, s]) => s.regime === 'ranging' || s.regime === 'choppy')
        .map(([symbol]) => symbol),
    },
  });
});

// Get regime state for a specific symbol
app.get('/api/regime/state/:symbol', (req, res) => {
  if (!signalProcessor) {
    return res.status(400).json({ error: 'Signal processor not running' });
  }

  const { symbol } = req.params;
  const state = signalProcessor.getRegimeState(symbol);

  if (!state) {
    return res.status(404).json({ error: `No regime data for symbol: ${symbol}` });
  }

  res.json(state);
});

// Get regime filter statistics
app.get('/api/regime/filter/stats', (req, res) => {
  if (!signalProcessor) {
    return res.status(400).json({ error: 'Signal processor not running' });
  }

  res.json(signalProcessor.getRegimeFilterStats());
});

// Enable/disable regime filtering
app.post('/api/regime/filter/toggle', (req, res) => {
  if (!signalProcessor) {
    return res.status(400).json({ error: 'Signal processor not running' });
  }

  const { enabled } = req.body;
  if (typeof enabled !== 'boolean') {
    return res.status(400).json({ error: 'enabled must be a boolean' });
  }

  signalProcessor.setRegimeFilterEnabled(enabled);
  
  res.json({ 
    success: true, 
    message: `Regime filtering ${enabled ? 'enabled' : 'disabled'}`,
    enabled,
  });
});

// Update regime filter configuration
app.post('/api/regime/filter/config', (req, res) => {
  if (!signalProcessor) {
    return res.status(400).json({ error: 'Signal processor not running' });
  }

  const config = req.body;
  signalProcessor.updateRegimeFilterConfig(config);

  logger.info('Regime filter config updated via API', { config });
  
  res.json({ 
    success: true, 
    message: 'Regime filter configuration updated',
    config: signalProcessor.getRegimeFilterStats().config,
  });
});

// ============ Meta Filter (Trade Quality) Endpoints ============

// Get meta filter statistics
app.get('/api/metafilter/stats', (req, res) => {
  if (!signalProcessor) {
    return res.status(400).json({ error: 'Signal processor not running' });
  }

  res.json(signalProcessor.getMetaFilterStats());
});

// Get strategy performance
app.get('/api/metafilter/performance', (req, res) => {
  if (!signalProcessor) {
    return res.status(400).json({ error: 'Signal processor not running' });
  }

  const performances = signalProcessor.getAllStrategyPerformances();
  const result: Record<string, any> = {};
  
  for (const [strategy, perf] of performances) {
    result[strategy] = {
      totalTrades: perf.totalTrades,
      wins: perf.wins,
      losses: perf.losses,
      breakeven: perf.breakeven,
      winRate: perf.winRate,
      avgWinPnl: perf.avgWinPnl,
      avgLossPnl: perf.avgLossPnl,
      profitFactor: perf.profitFactor,
      consecutiveLosses: perf.consecutiveLosses,
      consecutiveWins: perf.consecutiveWins,
      maxConsecutiveLosses: perf.maxConsecutiveLosses,
      avgWinningStrength: perf.avgWinningStrength,
      strengthPercentile25: perf.strengthPercentile25,
      strengthPercentile50: perf.strengthPercentile50,
      lastTradeTime: perf.lastTradeTime,
    };
  }

  res.json({
    strategies: result,
    totalStrategies: performances.size,
  });
});

// Get performance for a specific strategy
app.get('/api/metafilter/performance/:strategy', (req, res) => {
  if (!signalProcessor) {
    return res.status(400).json({ error: 'Signal processor not running' });
  }

  const { strategy } = req.params;
  const perf = signalProcessor.getStrategyPerformance(strategy);

  if (!perf) {
    return res.status(404).json({ error: `No performance data for strategy: ${strategy}` });
  }

  res.json(perf);
});

// Get recent filter decisions (for ML training data export)
app.get('/api/metafilter/decisions', (req, res) => {
  if (!signalProcessor) {
    return res.status(400).json({ error: 'Signal processor not running' });
  }

  const limit = parseInt(req.query.limit as string) || 50;
  const decisions = signalProcessor.getRecentFilterDecisions(limit);

  res.json({
    decisions,
    count: decisions.length,
  });
});

// Enable/disable meta filter
app.post('/api/metafilter/toggle', (req, res) => {
  if (!signalProcessor) {
    return res.status(400).json({ error: 'Signal processor not running' });
  }

  const { enabled } = req.body;
  if (typeof enabled !== 'boolean') {
    return res.status(400).json({ error: 'enabled must be a boolean' });
  }

  signalProcessor.setMetaFilterEnabled(enabled);
  
  res.json({ 
    success: true, 
    message: `Meta filter ${enabled ? 'enabled' : 'disabled'}`,
    enabled,
  });
});

// Update meta filter configuration
app.post('/api/metafilter/config', (req, res) => {
  if (!signalProcessor) {
    return res.status(400).json({ error: 'Signal processor not running' });
  }

  const config = req.body;
  signalProcessor.updateMetaFilterConfig(config);

  logger.info('Meta filter config updated via API', { config });
  
  res.json({ 
    success: true, 
    message: 'Meta filter configuration updated',
    config: signalProcessor.getMetaFilterStats().config,
  });
});

// Record a trade outcome (for learning)
app.post('/api/metafilter/outcome', (req, res) => {
  if (!signalProcessor) {
    return res.status(400).json({ error: 'Signal processor not running' });
  }

  const outcome = req.body;
  
  // Validate required fields
  if (!outcome.signalId || !outcome.strategy || !outcome.symbol || !outcome.outcome) {
    return res.status(400).json({ 
      error: 'Missing required fields: signalId, strategy, symbol, outcome' 
    });
  }

  // Add timestamps if not provided
  outcome.entryTime = outcome.entryTime ? new Date(outcome.entryTime) : new Date();
  outcome.exitTime = outcome.exitTime ? new Date(outcome.exitTime) : new Date();
  outcome.hourOfDay = outcome.hourOfDay ?? new Date().getUTCHours();
  outcome.dayOfWeek = outcome.dayOfWeek ?? new Date().getUTCDay();
  outcome.filtersPassed = outcome.filtersPassed ?? [];
  outcome.filtersBlocked = outcome.filtersBlocked ?? [];

  signalProcessor.recordTradeOutcome(outcome);

  logger.info('Trade outcome recorded', { 
    signalId: outcome.signalId, 
    strategy: outcome.strategy, 
    outcome: outcome.outcome,
    pnl: outcome.pnl,
  });
  
  res.json({ 
    success: true, 
    message: 'Trade outcome recorded',
    performance: signalProcessor.getStrategyPerformance(outcome.strategy),
  });
});

// ============ Strategy Plugin Management Endpoints ============

// Get all registered strategies
app.get('/api/strategies', (req, res) => {
  if (!signalProcessor) {
    return res.status(400).json({ error: 'Signal processor not running' });
  }

  const strategies = signalProcessor.getRegisteredStrategies();
  res.json({
    strategies: strategies.map(s => ({
      id: s.id,
      name: s.name,
      description: s.description,
      version: s.version,
      category: s.category,
      tags: s.tags,
      enabled: s.enabled,
      config: s.config,
      stats: s.getStats?.(),
    })),
    total: strategies.length,
    enabled: signalProcessor.getEnabledStrategies().length,
  });
});

// Get strategy registry stats
app.get('/api/strategies/stats', (req, res) => {
  if (!signalProcessor) {
    return res.status(400).json({ error: 'Signal processor not running' });
  }

  res.json(signalProcessor.getStrategyRegistryStats());
});

// Get a specific strategy
app.get('/api/strategies/:strategyId', (req, res) => {
  if (!signalProcessor) {
    return res.status(400).json({ error: 'Signal processor not running' });
  }

  const { strategyId } = req.params;
  const info = signalProcessor.getStrategyInfo(strategyId);

  if (!info) {
    return res.status(404).json({ error: `Strategy not found: ${strategyId}` });
  }

  res.json({
    id: info.plugin.id,
    name: info.plugin.name,
    description: info.plugin.description,
    version: info.plugin.version,
    author: info.plugin.author,
    category: info.plugin.category,
    tags: info.plugin.tags,
    enabled: info.registration.enabled,
    config: info.plugin.config,
    configSchema: info.plugin.configSchema,
    requiredIndicators: info.plugin.requiredIndicators,
    regimeCompatibility: info.plugin.regimeCompatibility,
    registration: info.registration,
    stats: info.stats,
    state: info.state,
  });
});

// Enable a strategy
app.post('/api/strategies/:strategyId/enable', (req, res) => {
  if (!signalProcessor) {
    return res.status(400).json({ error: 'Signal processor not running' });
  }

  const { strategyId } = req.params;
  const success = signalProcessor.enableStrategy(strategyId);

  if (!success) {
    return res.status(404).json({ error: `Strategy not found: ${strategyId}` });
  }

  logger.info(`Strategy enabled via API: ${strategyId}`);
  res.json({ success: true, message: `Strategy ${strategyId} enabled` });
});

// Disable a strategy
app.post('/api/strategies/:strategyId/disable', (req, res) => {
  if (!signalProcessor) {
    return res.status(400).json({ error: 'Signal processor not running' });
  }

  const { strategyId } = req.params;
  const success = signalProcessor.disableStrategy(strategyId);

  if (!success) {
    return res.status(404).json({ error: `Strategy not found: ${strategyId}` });
  }

  logger.info(`Strategy disabled via API: ${strategyId}`);
  res.json({ success: true, message: `Strategy ${strategyId} disabled` });
});

// Update strategy configuration
app.post('/api/strategies/:strategyId/config', (req, res) => {
  if (!signalProcessor) {
    return res.status(400).json({ error: 'Signal processor not running' });
  }

  const { strategyId } = req.params;
  const config = req.body;

  const success = signalProcessor.updateStrategyConfig(strategyId, config);

  if (!success) {
    return res.status(404).json({ error: `Strategy not found: ${strategyId}` });
  }

  logger.info(`Strategy config updated via API: ${strategyId}`, { config });
  
  const updatedInfo = signalProcessor.getStrategyInfo(strategyId);
  res.json({ 
    success: true, 
    message: `Strategy ${strategyId} config updated`,
    config: updatedInfo?.plugin.config,
  });
});

// Export all strategy configurations
app.get('/api/strategies/config/export', (req, res) => {
  if (!signalProcessor) {
    return res.status(400).json({ error: 'Signal processor not running' });
  }

  const configs = signalProcessor.exportStrategyConfigs();
  res.json({
    exported: new Date().toISOString(),
    strategies: configs,
  });
});

// Import strategy configurations
app.post('/api/strategies/config/import', (req, res) => {
  if (!signalProcessor) {
    return res.status(400).json({ error: 'Signal processor not running' });
  }

  const { strategies } = req.body;
  if (!strategies || typeof strategies !== 'object') {
    return res.status(400).json({ error: 'Invalid import format. Expected: { strategies: {...} }' });
  }

  signalProcessor.importStrategyConfigs(strategies);
  
  logger.info('Strategy configs imported via API');
  res.json({ 
    success: true, 
    message: 'Strategy configurations imported',
    imported: Object.keys(strategies),
  });
});

// Toggle plugin strategy mode
app.post('/api/strategies/plugin-mode', (req, res) => {
  if (!signalProcessor) {
    return res.status(400).json({ error: 'Signal processor not running' });
  }

  const { enabled } = req.body;
  if (typeof enabled !== 'boolean') {
    return res.status(400).json({ error: 'enabled must be a boolean' });
  }

  signalProcessor.setPluginStrategiesEnabled(enabled);
  
  res.json({ 
    success: true, 
    message: `Plugin strategy mode ${enabled ? 'enabled' : 'disabled'}`,
    pluginModeEnabled: signalProcessor.isPluginStrategiesEnabled(),
  });
});

// ============ ML Trade Outcome Collector Endpoints ============

// Get outcome collector status and stats
app.get('/api/ml/outcomes/status', (req, res) => {
  if (!tradeOutcomeCollector) {
    return res.status(400).json({ error: 'Trade outcome collector not initialized' });
  }

  res.json({
    enabled: tradeOutcomeCollector.isEnabled(),
    stats: tradeOutcomeCollector.getStats(),
  });
});

// Get pending signal contexts (for debugging)
app.get('/api/ml/outcomes/pending/:symbol', (req, res) => {
  if (!tradeOutcomeCollector) {
    return res.status(400).json({ error: 'Trade outcome collector not initialized' });
  }

  const { symbol } = req.params;
  const context = tradeOutcomeCollector.getPendingContext(symbol);

  if (!context) {
    return res.status(404).json({ error: `No pending context for ${symbol}` });
  }

  res.json({ symbol, context });
});

// ============ Signal Arbiter Endpoints ============

// Get arbiter status and stats
app.get('/api/arbiter/status', (req, res) => {
  if (!signalProcessor) {
    return res.status(400).json({ error: 'Signal processor not running' });
  }

  const arbiter = signalProcessor.getSignalArbiter();
  
  res.json({
    enabled: signalProcessor.isArbiterEnabled(),
    config: arbiter.getConfig(),
    stats: arbiter.getStats(),
    symbolStates: arbiter.getAllSymbolStates(),
  });
});

// Enable/disable arbiter
app.post('/api/arbiter/toggle', (req, res) => {
  if (!signalProcessor) {
    return res.status(400).json({ error: 'Signal processor not running' });
  }

  const { enabled } = req.body;
  
  if (typeof enabled !== 'boolean') {
    return res.status(400).json({ error: 'enabled must be a boolean' });
  }

  signalProcessor.setArbiterEnabled(enabled);
  
  res.json({
    success: true,
    enabled: signalProcessor.isArbiterEnabled(),
  });
});

// Update arbiter configuration
app.post('/api/arbiter/config', (req, res) => {
  if (!signalProcessor) {
    return res.status(400).json({ error: 'Signal processor not running' });
  }

  const config = req.body;
  
  if (!config || typeof config !== 'object') {
    return res.status(400).json({ error: 'Request body must be a config object' });
  }

  signalProcessor.updateArbiterConfig(config);
  
  const arbiter = signalProcessor.getSignalArbiter();
  res.json({
    success: true,
    config: arbiter.getConfig(),
  });
});

// Reset cooldown for a symbol
app.post('/api/arbiter/reset-cooldown/:symbol', (req, res) => {
  if (!signalProcessor) {
    return res.status(400).json({ error: 'Signal processor not running' });
  }

  const { symbol } = req.params;
  signalProcessor.resetArbiterCooldown(symbol);
  
  res.json({
    success: true,
    message: `Cooldown reset for ${symbol}`,
  });
});

// Clear all arbiter state
app.post('/api/arbiter/clear', (req, res) => {
  if (!signalProcessor) {
    return res.status(400).json({ error: 'Signal processor not running' });
  }

  signalProcessor.clearArbiterState();
  
  res.json({
    success: true,
    message: 'All arbiter state cleared',
  });
});

// ============ Per-Symbol Strategy Override Endpoints ============

// Get all per-symbol overrides for all strategies
app.get('/api/strategies/symbol-overrides', (req, res) => {
  if (!signalProcessor) {
    return res.status(400).json({ error: 'Signal processor not running' });
  }

  const overrides = signalProcessor.getAllSymbolOverrides();
  res.json({ overrides });
});

// Get effective config for a strategy on a specific symbol
app.get('/api/strategies/:strategyId/effective-config/:symbol', (req, res) => {
  if (!signalProcessor) {
    return res.status(400).json({ error: 'Signal processor not running' });
  }

  const { strategyId, symbol } = req.params;
  const effectiveConfig = signalProcessor.getEffectiveStrategyConfig(strategyId, symbol);

  if (!effectiveConfig) {
    return res.status(404).json({ error: `Strategy ${strategyId} not found` });
  }

  res.json({
    strategyId,
    symbol,
    effectiveConfig,
  });
});

// Set per-symbol overrides for a specific strategy
app.post('/api/strategies/:strategyId/symbol-overrides/:symbol', (req, res) => {
  if (!signalProcessor) {
    return res.status(400).json({ error: 'Signal processor not running' });
  }

  const { strategyId, symbol } = req.params;
  const overrides = req.body;

  if (!overrides || typeof overrides !== 'object') {
    return res.status(400).json({ error: 'Request body must be an object with parameter overrides' });
  }

  const success = signalProcessor.setStrategySymbolOverrides(strategyId, symbol, overrides);

  if (!success) {
    return res.status(404).json({ error: `Strategy ${strategyId} not found or not a BaseStrategy` });
  }

  // Get the new effective config to return
  const effectiveConfig = signalProcessor.getEffectiveStrategyConfig(strategyId, symbol);

  res.json({
    success: true,
    message: `Updated overrides for ${strategyId} on ${symbol}`,
    strategyId,
    symbol,
    appliedOverrides: overrides,
    effectiveConfig,
  });
});

// Bulk update per-symbol overrides for multiple strategies/symbols
app.post('/api/strategies/symbol-overrides/bulk', (req, res) => {
  if (!signalProcessor) {
    return res.status(400).json({ error: 'Signal processor not running' });
  }

  const { overrides } = req.body;

  if (!overrides || typeof overrides !== 'object') {
    return res.status(400).json({ 
      error: 'Request body must have "overrides" object with format: { symbol: { strategyId: { params } } }' 
    });
  }

  signalProcessor.loadPerSymbolOverrides(overrides);

  res.json({
    success: true,
    message: 'Bulk updated per-symbol strategy overrides',
    symbols: Object.keys(overrides),
  });
});

// ============ Extended Risk Control Endpoints ============

// Get risk controller status
app.get('/api/risk/status', (req, res) => {
  const riskEngine = tradingEngine?.getRiskEngineInstance();
  if (!riskEngine) {
    return res.status(400).json({ error: 'Risk engine not running' });
  }

  const metrics = riskEngine.getMetrics();
  const positionTracker = tradingEngine?.getPositionTrackerInstance();
  const positions = positionTracker?.getOpenPositions() || [];
  
  res.json({
    tradingAllowed: !metrics.killSwitchActive,
    killSwitchActive: metrics.killSwitchActive,
    metrics: {
      currentExposure: metrics.currentExposure,
      dailyPnL: metrics.dailyPnL,
      dailyLossPercentage: metrics.dailyLossPercentage,
      maxDrawdown: metrics.maxDrawdown,
      consecutiveLosses: metrics.consecutiveLosses,
      openOrders: metrics.openOrderCount,
      lastUpdated: metrics.lastUpdated,
    },
    positions: {
      open: positions.length,
      max: (riskEngine as any).maxOpenPositionsLimit || 5,
    },
  });
});

// Get risk analytics 
app.get('/api/risk/analytics', (req, res) => {
  const riskEngine = tradingEngine?.getRiskEngineInstance();
  if (!riskEngine) {
    return res.status(400).json({ error: 'Risk engine not running' });
  }

  const metrics = riskEngine.getMetrics();
  const positionTracker = tradingEngine?.getPositionTrackerInstance();
  const summary = positionTracker?.getPortfolioSummary();
  const sessionStats = tradingEngine?.getSessionStats();
  
  res.json({
    session: {
      trades: sessionStats?.totalTrades ?? summary?.positionCount ?? 0,
      wins: sessionStats?.winningTrades ?? 0,
      losses: sessionStats?.losingTrades ?? 0,
      winRate: sessionStats?.winRate ?? 0,
      profitFactor: sessionStats?.profitFactor ?? 0,
    },
    equity: {
      current: summary?.totalValue || 0,
      dailyPnL: metrics.dailyPnL,
      maxDrawdown: sessionStats?.maxDrawdown ?? metrics.maxDrawdown,
    },
    streaks: {
      consecutiveWins: 0, // Not tracked in SessionStats; risk engine tracks losses only
      consecutiveLosses: metrics.consecutiveLosses,
      maxConsecutiveLosses: metrics.consecutiveLosses,
    },
    riskMetrics: metrics,
  });
});

// Get blocked symbols
app.get('/api/risk/blocked/symbols', (req, res) => {
  const riskEngine = tradingEngine?.getRiskEngineInstance();
  if (!riskEngine) {
    return res.status(400).json({ error: 'Risk engine not running' });
  }

  const blocked: string[] = [];
  // Access internal state
  const blockedSymbols = (riskEngine as any).blockedSymbols;
  if (blockedSymbols instanceof Set) {
    blocked.push(...blockedSymbols);
  }
  
  res.json({
    blockedSymbols: blocked,
    count: blocked.length,
  });
});

// Unblock a symbol
app.post('/api/risk/unblock/symbol/:symbol', (req, res) => {
  const riskEngine = tradingEngine?.getRiskEngineInstance();
  if (!riskEngine) {
    return res.status(400).json({ error: 'Risk engine not running' });
  }

  const { symbol } = req.params;
  const blockedSymbols = (riskEngine as any).blockedSymbols as Set<string>;
  
  if (blockedSymbols?.has(symbol)) {
    blockedSymbols.delete(symbol);
    logger.info(`Symbol manually unblocked: ${symbol}`);
    res.json({ success: true, message: `Symbol ${symbol} unblocked` });
  } else {
    res.json({ success: false, message: `Symbol ${symbol} was not blocked` });
  }
});

// Get per-symbol daily loss
app.get('/api/risk/symbols/:symbol', (req, res) => {
  const riskEngine = tradingEngine?.getRiskEngineInstance();
  if (!riskEngine) {
    return res.status(400).json({ error: 'Risk engine not running' });
  }

  const { symbol } = req.params;
  const dailyLoss = riskEngine.getSymbolDailyLoss(symbol);
  const isBlocked = riskEngine.isSymbolBlocked(symbol);
  
  res.json({
    symbol,
    dailyLoss,
    isBlocked,
  });
});

// Reset daily tracking
app.post('/api/risk/reset/daily', async (req, res) => {
  const riskEngine = tradingEngine?.getRiskEngineInstance();
  if (!riskEngine) {
    return res.status(400).json({ error: 'Risk engine not running' });
  }

  // Reset full daily metrics including P&L
  await riskEngine.resetDailyMetrics();
  logger.info('Daily risk metrics fully reset via API');
  
  res.json({
    success: true,
    message: 'Daily tracking reset (P&L, per-symbol losses, and blocks cleared)',
  });
});

// Get soft launch status
app.get('/api/risk/soft-launch', (req, res) => {
  const riskEngine = tradingEngine?.getRiskEngineInstance();
  if (!riskEngine) {
    return res.status(400).json({ error: 'Risk engine not running' });
  }

  const softLaunchActive = (riskEngine as any).isSoftLaunchActive?.() || false;
  const softLaunchTrades = (riskEngine as any).softLaunchEntryTrades || 0;
  const softLaunchConfig = (riskEngine as any).config?.softLaunch;
  
  res.json({
    active: softLaunchActive,
    tradesDone: softLaunchTrades,
    maxTrades: softLaunchConfig?.maxEntryTrades || 0,
    config: softLaunchConfig || null,
  });
});

// Toggle kill switch manually
app.post('/api/risk/killswitch', (req, res) => {
  const riskEngine = tradingEngine?.getRiskEngineInstance();
  if (!riskEngine) {
    return res.status(400).json({ error: 'Risk engine not running' });
  }

  const { active, reason } = req.body;
  
  if (typeof active !== 'boolean') {
    return res.status(400).json({ error: 'active must be a boolean' });
  }

  if (active) {
    riskEngine.activateKillSwitch(reason || 'Manual activation via API');
    logger.warn('Kill switch activated via API', { reason });
  } else {
    riskEngine.deactivateKillSwitch();
    logger.info('Kill switch deactivated via API');
  }
  
  res.json({
    success: true,
    killSwitchActive: active,
    message: active ? 'Kill switch activated' : 'Kill switch deactivated',
  });
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
          time: current.getTime(),
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
      // RPC doesn't exist is less severe
      if (error.code === 'PGRST202' || error.code === '42883') {
        logger.debug('upsert_account_metrics RPC not available');
      } else {
        logger.error('Failed to update account metrics:', {
          code: error.code,
          message: error.message,
          details: error.details,
        });
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
      .upsert({
        user_id: USER_ID,
        order_id: fill.order_id,
        trade_id: fill.trade_id !== undefined ? String(fill.trade_id) : null,
        price: parseFloat(fill.price),
        quantity: parseFloat(fill.size),
        fee_currency: 'USD',
        fee_amount: parseFloat(fill.fee),
        maker: fill.liquidity === 'M',
        filled_at: fill.created_at
      }, { onConflict: 'user_id,trade_id' });

    if (error) {
      logger.error('Failed to sync fill to Supabase:', error);
    }
  } catch (error) {
    logger.error('Error syncing fill:', error);
  }
}

async function syncPositionToSupabase(position: any) {
  try {
    const symbol = position.symbol || position.product;
    const side = position.side as 'long' | 'short' | 'flat' | undefined;
    const entryPriceRaw = Number(position.averagePrice ?? position.avgPrice ?? position.entry_price ?? 0);
    const entryPrice = Number.isFinite(entryPriceRaw) ? entryPriceRaw : 0;

    // Supabase schema expects position_side enum ('long'|'short'); skip invalid/flat snapshots
    if (!symbol || (side !== 'long' && side !== 'short') || entryPrice <= 0) {
      return;
    }

    const openedAt = position.openTime instanceof Date
      ? position.openTime.toISOString()
      : new Date(position.openTime ?? Date.now()).toISOString();
    const closedAt = position.closedAt
      ? (position.closedAt instanceof Date ? position.closedAt.toISOString() : new Date(position.closedAt).toISOString())
      : null;
    const exitPriceRaw = Number(position.exitPrice ?? position.exit_price ?? 0);
    const exitPrice = Number.isFinite(exitPriceRaw) && exitPriceRaw > 0 ? exitPriceRaw : null;

    // Default stop/target if strategy-specific levels aren't provided
    const defaultStop = side === 'long' ? entryPrice * 0.98 : entryPrice * 1.02;
    const defaultTakeProfit = side === 'long' ? entryPrice * 1.03 : entryPrice * 0.97;

    const mappedPosition = {
      id: position.id, // must be UUID-compatible
      user_id: USER_ID,
      symbol,
      strategy: (position.strategy || 'breakout') as any,
      side,
      qty_open: Math.abs(Number(position.size || 0)),
      entry_price: entryPrice,
      stop_price_at_entry: Number(position.stopPrice ?? position.stop_price_at_entry ?? defaultStop),
      take_profit_price: Number(position.takeProfit ?? position.take_profit_price ?? defaultTakeProfit),
      opened_at: openedAt,
      closed_at: closedAt,
      exit_price: exitPrice,
      exit_reason: position.exitReason ?? position.exit_reason ?? null,
      realized_pnl_usd: Number(position.realizedPnL ?? position.realizedPnl ?? position.realized_pnl_usd ?? 0),
    };

    const { error } = await supabase
      .from('positions')
      .upsert(mappedPosition, { onConflict: 'user_id,symbol' });

    if (error) {
      logger.error('Failed to sync position to Supabase:', error);
    }
  } catch (error) {
    logger.error('Error syncing position:', error);
  }
}

async function syncSignalToSupabase(signal: any) {
  try {
    const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    const maybeId = (typeof signal.id === 'string' && uuidV4.test(signal.id)) ? signal.id : undefined;

    const decidedAt = signal.timestamp instanceof Date
      ? signal.timestamp.toISOString()
      : new Date(signal.timestamp ?? Date.now()).toISOString();

    const direction = (signal.direction || signal.side) as string | undefined;
    const side = direction === 'buy'
      ? 'long'
      : direction === 'sell'
        ? 'short'
        : (signal.side === 'long' || signal.side === 'short' ? signal.side : null);

    const { error } = await supabase
      .from('signals')
      .insert({
        ...(maybeId ? { id: maybeId } : {}),
        user_id: USER_ID,
        symbol: signal.symbol,
        strategy: signal.strategy, // strategy_name enum
        decided_at: decidedAt,
        side, // position_side enum
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

// Check database connection and validate schema on startup
(async () => {
  try {
    // First check basic connectivity
    const { error } = await supabase.from('symbols').select('count').limit(1);
    if (error && error.code !== '42P01') {
      // Ignore missing symbols table, check actual connection
      logger.warn('Symbols table check returned error:', error.message);
    }
    
    logger.info('Database connection successful');
    dbConnectionGauge.set(1);

    // Validate required schema (tables and RPCs)
    // allowLimitedMode: true means we warn but don't crash if schema is incomplete
    await validateSchemaOrFail(supabase, logger, { allowLimitedMode: true });
    
  } catch (error) {
    if (error instanceof Error && error.name === 'SchemaValidationError') {
      logger.error('Schema validation failed:', error.message);
      logger.error('The trading engine will not function correctly. Please run migrations.');
      dbConnectionGauge.set(0);
      // In production, you might want to: process.exit(1);
    } else {
      logger.error('Database connection check failed:', error);
      dbConnectionGauge.set(0);
    }
  }
})();

// Initialize account metrics on startup
initializeAccountMetrics().catch(err => {
  logger.error('Failed to initialize account metrics on startup:', err);
});

// Global error handlers for stability - 24/7 resilience
process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception - keeping server alive:', {
    error: error.message,
    stack: error.stack,
  });
  
  // Notify supervisor of error (for potential recovery)
  if (tradingEngine && !supervisor.isKillSwitchActive()) {
    tradingEngine.handleFatal(error, 'uncaughtException');
  }
  
  // Broadcast error to UI
  broadcast({
    type: 'SystemError',
    payload: {
      type: 'uncaughtException',
      message: error.message,
      timestamp: Date.now(),
    }
  });
  
  // Don't exit - try to keep running
});

process.on('unhandledRejection', (reason, promise) => {
  const message = reason instanceof Error ? reason.message : String(reason);
  logger.error('Unhandled Rejection:', {
    reason: message,
    stack: reason instanceof Error ? reason.stack : undefined,
  });
  
  // Broadcast error to UI
  broadcast({
    type: 'SystemError',
    payload: {
      type: 'unhandledRejection',
      message,
      timestamp: Date.now(),
    }
  });
  
  // Don't exit - try to keep running
});

// Graceful shutdown handler
async function gracefulShutdown(signal: string) {
  logger.info(`${signal} received, shutting down gracefully...`);
  
  try {
    // Clear periodic intervals
    if (metricsInterval) { clearInterval(metricsInterval); metricsInterval = null; }
    if (statusBroadcastInterval) { clearInterval(statusBroadcastInterval); statusBroadcastInterval = null; }

    // Stop supervisor first
    supervisor.stop();
    
    // Stop trading engine
    if (tradingEngine) {
      await tradingEngine.stop(`${signal}_shutdown`);
    }
    
    // Close server
    server.close(() => {
      logger.info('Server closed');
      process.exit(0);
    });
    
    // Force exit after 10 seconds if graceful shutdown hangs
    setTimeout(() => {
      logger.error('Graceful shutdown timed out, forcing exit');
      process.exit(1);
    }, 10000);
  } catch (error) {
    logger.error('Error during shutdown:', error);
    process.exit(1);
  }
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

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
