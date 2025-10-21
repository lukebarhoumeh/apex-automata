import path from 'node:path';
import fs from 'node:fs';
import yargs from 'yargs/yargs';
import { hideBin } from 'yargs/helpers';
import { loadConfig } from '@/config/loadConfig';
import { loadEnv } from '@/core/env';
import { createLogger } from '@/core/logger';
import { TradingEngine, TradingEngineConfig } from '@/trading/trading-engine';
import { SignalProcessor } from '@/strategies/signal-processor';
import { loadGuardrails } from '@/config/loadGuardrails';

async function main() {
  const argv = await yargs(hideBin(process.argv))
    .scriptName('atlas')
    .usage('$0 [options]')
    .option('config', {
      type: 'string',
      describe: 'Path to YAML config (paper/live)',
      default: path.resolve(process.cwd(), '../../config/paper.local.yaml'),
    })
    .help()
    .parse();

  // Always show help banner once for Sprint 0 acceptance
  // eslint-disable-next-line no-console
  console.log('\nUsage: atlas --config ../../config/paper.local.yaml\n');

  const configPath = path.resolve(String(argv.config));
  const atlasRoot = path.resolve(path.dirname(configPath), '..');

  // Ensure var directories
  const varDirs = ['logs', 'bars', 'state', 'models'].map((d) => path.join(atlasRoot, 'var', d));
  for (const d of varDirs) fs.mkdirSync(d, { recursive: true });

  const env = loadEnv(atlasRoot);
  const cfg = loadConfig(configPath);
  const guardrails = loadGuardrails(atlasRoot);

  const logger = createLogger(path.join(atlasRoot, 'var/logs/atlas_app.jsonl'));

  logger.info('Atlas CLI bootstrap complete', {
    root: atlasRoot,
    mode: cfg.mode,
    symbols: cfg.symbols,
    hasSecrets: Boolean(env.COINBASE_API_KEY && env.COINBASE_API_SECRET && env.COINBASE_API_PASSPHRASE),
  });

  // Configure trading engine
  const engineConfig: TradingEngineConfig = {
    mode: cfg.mode as 'paper' | 'live',
    exchange: {
      name: 'coinbase',
      environment: cfg.mode === 'live' ? 'production' : 'sandbox'
    },
    products: cfg.symbols,
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

  // Create and start trading engine
  const engine = new TradingEngine(engineConfig, logger);
  
  // Handle graceful shutdown
  process.on('SIGINT', async () => {
    logger.info('Received SIGINT, shutting down gracefully...');
    await engine.stop();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    logger.info('Received SIGTERM, shutting down gracefully...');
    await engine.stop();
    process.exit(0);
  });

  try {
    // Start the trading engine
    await engine.start();
    
    logger.info('Trading engine started successfully');
    
    // Keep the process running
    setInterval(() => {
      // Health check
      const metrics = engine.getRiskMetrics();
      if (metrics) {
        logger.info('System health', {
          exposure: metrics.currentExposure,
          dailyPnL: metrics.dailyPnL,
          killSwitch: metrics.killSwitchActive
        });
      }
    }, 60000); // Log every minute
    
  } catch (error) {
    logger.error('Failed to start trading engine:', error);
    process.exit(1);
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
