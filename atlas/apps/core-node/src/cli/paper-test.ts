import path from 'node:path';
import { createLogger } from '../core/logger';
import { TradingEngine, TradingEngineConfig } from '../trading/trading-engine';
import { SignalProcessor } from '../strategies/signal-processor';

async function main() {
  const logger = createLogger(path.resolve(process.cwd(), '../../var/logs/paper_test.jsonl'));

  logger.info('Starting paper trading test');

  // Configure trading engine for paper mode
  const engineConfig: TradingEngineConfig = {
    mode: 'paper',
    exchange: {
      name: 'coinbase',
      environment: 'sandbox'
    },
    products: ['BTC-USD', 'ETH-USD'],
    supabase: {
      url: process.env.SUPABASE_URL || '',
      serviceKey: process.env.SUPABASE_SERVICE_KEY || '',
      anonKey: process.env.SUPABASE_ANON_KEY || ''
    },
    security: {
      encryptionKey: process.env.ENCRYPTION_KEY || 'test-encryption-key-32-chars-long'
    }
  };

  // Create trading engine
  const engine = new TradingEngine(engineConfig, logger);

  // Configure signal processor
  const signalConfig = {
    supabaseUrl: engineConfig.supabase.url,
    supabaseKey: engineConfig.supabase.serviceKey,
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

  const signalProcessor = new SignalProcessor(signalConfig, logger);

  // Listen for signals and place orders
  signalProcessor.on('signal:generated', async (signal) => {
    logger.info('Signal generated', {
      symbol: signal.symbol,
      strategy: signal.strategy,
      direction: signal.direction,
      price: signal.price
    });

    try {
      // Create order request
      const orderRequest = {
        product_id: signal.symbol,
        side: signal.direction,
        type: 'limit' as const,
        size: '0.001', // Small test size
        price: signal.price.toFixed(2),
        post_only: true
      };

      // Place order through trading engine
      const order = await engine.createOrder(orderRequest);
      
      if (order) {
        logger.info('Order placed', {
          orderId: order.id,
          product: order.product,
          side: order.side,
          price: order.price,
          size: order.size
        });
      }
    } catch (error) {
      logger.error('Failed to place order:', error);
    }
  });

  // Start trading engine
  await engine.start();

  // Monitor positions and P&L
  setInterval(() => {
    const positions = engine.getPositions();
    const riskMetrics = engine.getRiskMetrics();
    const activeOrders = engine.getActiveOrders();

    logger.info('System status', {
      positions: positions.length,
      activeOrders: activeOrders.length,
      exposure: riskMetrics?.currentExposure,
      dailyPnL: riskMetrics?.dailyPnL
    });

    // Log positions
    positions.forEach(pos => {
      logger.info('Position', {
        product: pos.product,
        side: pos.side,
        size: pos.size,
        avgPrice: pos.avgPrice,
        unrealizedPnl: pos.unrealizedPnl,
        realizedPnl: pos.realizedPnl
      });
    });
  }, 30000); // Every 30 seconds

  // Graceful shutdown
  process.on('SIGINT', async () => {
    logger.info('Shutting down paper trading test...');
    await engine.stop();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    logger.info('Shutting down paper trading test...');
    await engine.stop();
    process.exit(0);
  });

  // Keep process running
  logger.info('Paper trading test running. Press Ctrl+C to stop.');
}

main().catch((err) => {
  console.error('Paper trading test failed:', err);
  process.exit(1);
});
