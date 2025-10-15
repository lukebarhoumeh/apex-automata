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

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

// Middleware
app.use(cors());
app.use(express.json());

// Load environment
const atlasRoot = path.resolve(process.cwd(), '../..');
const env = loadEnv(atlasRoot);

// Logger
const logger = createLogger(path.join(atlasRoot, 'var/logs/api-server.jsonl'));

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

  // Send initial status
  ws.send(JSON.stringify({
    type: 'status',
    data: {
      engineRunning: !!tradingEngine,
      mode: tradingEngine?.config?.mode || 'paper'
    }
  }));
});

// API Routes

// Get trading engine status
app.get('/api/status', (req, res) => {
  res.json({
    engineRunning: !!tradingEngine,
    mode: tradingEngine?.config?.mode || 'paper',
    positions: tradingEngine?.getPositions() || [],
    riskMetrics: tradingEngine?.getRiskMetrics() || null,
    activeOrders: tradingEngine?.getActiveOrders() || []
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
      products: ['BTC-USD', 'ETH-USD'],
      supabase: {
        url: env.SUPABASE_URL || '',
        serviceKey: env.SUPABASE_SERVICE_KEY || '',
        anonKey: env.SUPABASE_ANON_KEY || ''
      },
      security: {
        encryptionKey: env.ENCRYPTION_KEY || ''
      }
    };

    // Create trading engine
    tradingEngine = new TradingEngine(engineConfig, logger);

    // Set up event listeners to update frontend
    tradingEngine.on('market:ticker', (ticker) => {
      broadcast({ type: 'ticker', data: ticker });
      
      // Update Supabase (for frontend queries)
      updateSupabasePrice(ticker.product_id, parseFloat(ticker.price));
    });

    tradingEngine.on('order:created', async (order) => {
      broadcast({ type: 'order:created', data: order });
      await syncOrderToSupabase(order);
    });

    tradingEngine.on('order:filled', async (order, fill) => {
      broadcast({ type: 'order:filled', data: { order, fill } });
      await syncFillToSupabase(fill);
    });

    tradingEngine.on('position:update', async (position) => {
      broadcast({ type: 'position:update', data: position });
      await syncPositionToSupabase(position);
    });

    tradingEngine.on('risk:alert', async (alert) => {
      broadcast({ type: 'risk:alert', data: alert });
      await createSupabaseAlert(alert);
    });

    // Initialize signal processor
    const signalConfig = {
      supabaseUrl: env.SUPABASE_URL || '',
      supabaseKey: env.SUPABASE_SERVICE_KEY || '',
      strategies: {
        breakout: {
          enabled: true,
          period: 20,
          atrPeriod: 14,
          atrMultiplier: 2,
          volumeThreshold: 1.5
        },
        vwapMeanReversion: {
          enabled: true,
          deviationEntry: 2,
          deviationExit: 0.5,
          minVolume: 1000
        },
        momentum: {
          enabled: false,
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
      broadcast({ type: 'signal', data: signal });
      
      // Store signal in Supabase
      await syncSignalToSupabase(signal);

      // Create order if risk checks pass
      try {
        const orderRequest = {
          product_id: signal.symbol,
          side: signal.direction,
          type: 'limit' as const,
          size: '0.001', // Small size for paper trading
          price: signal.price.toFixed(2),
          post_only: true
        };

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
    }

    // Update risk events in Supabase
    await supabase
      .from('risk_events')
      .insert({
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

// Helper functions to sync with Supabase

async function updateSupabasePrice(symbol: string, price: number) {
  // Update a price cache table or use for position calculations
  // This is just for real-time price updates if needed
}

async function syncOrderToSupabase(order: any) {
  try {
    const { error } = await supabase
      .from('orders')
      .upsert({
        id: order.id,
        external_order_id: order.exchangeOrderId,
        symbol: order.product,
        side: order.side,
        type: order.type,
        status: order.status,
        price: order.price,
        quantity: order.size,
        created_at: order.createdAt.toISOString(),
        updated_at: order.updatedAt.toISOString()
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
    const { error } = await supabase
      .from('positions')
      .upsert({
        symbol: position.product,
        side: position.side > 0 ? 'long' : 'short',
        qty_open: Math.abs(position.size),
        entry_price: position.avgPrice,
        opened_at: position.openedAt || new Date().toISOString(),
        realized_pnl_usd: position.realizedPnl
      });

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
        id: signal.id,
        symbol: signal.symbol,
        strategy: signal.strategy,
        decided_at: signal.timestamp.toISOString(),
        side: signal.direction === 'buy' ? 'long' : 'short',
        score: signal.strength,
        confidence: signal.strength, // Using strength as confidence for now
        meta_prob: signal.metaLabel,
        features: signal.metadata,
        allowed: true, // Signal was generated, so it was allowed
        reason: signal.metadata.reason,
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
        severity: 'warning',
        title: 'Risk Alert',
        message: JSON.stringify(alert),
        data: alert,
        created_at: new Date().toISOString()
      });

    if (error) {
      logger.error('Failed to create alert in Supabase:', error);
    }
  } catch (error) {
    logger.error('Error creating alert:', error);
  }
}

// Start server
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  logger.info(`API server listening on port ${PORT}`);
  console.log(`
    🚀 AtlasBot API Server Running
    ================================
    HTTP API: http://localhost:${PORT}
    WebSocket: ws://localhost:${PORT}
    
    Endpoints:
    - GET  /api/status
    - POST /api/engine/start
    - POST /api/engine/stop
    - POST /api/engine/kill
  `);
});