import path from 'node:path';
import { createLogger } from '../core/logger';
import { loadEnv } from '../core/env';
import { TradingEngine, TradingEngineConfig } from '../trading/trading-engine';
import { loadGuardrails } from '../config/loadGuardrails';

async function main() {
  const atlasRoot = path.resolve(process.cwd(), '../../');
  const env = loadEnv(path.resolve(atlasRoot));
  const guardrails = loadGuardrails(atlasRoot);
  const logger = createLogger(path.join(atlasRoot, 'var/logs/diagnose.jsonl'));

  logger.info('Starting diagnostics');

  // Report env presence (do not log secrets)
  logger.info('Env presence', {
    hasSupabaseUrl: Boolean(env.SUPABASE_URL),
    hasSupabaseServiceKey: Boolean(env.SUPABASE_SERVICE_KEY),
    hasAnonKey: Boolean(env.SUPABASE_ANON_KEY),
    hasEncryptionKey: Boolean(env.ENCRYPTION_KEY),
    hasCoinbaseKey: Boolean(env.COINBASE_API_KEY),
  });

  const engineConfig: TradingEngineConfig = {
    mode: 'paper',
    exchange: { name: 'coinbase', environment: 'sandbox' },
    products: ['BTC-USD'],
    supabase: {
      url: env.SUPABASE_URL || '',
      serviceKey: env.SUPABASE_SERVICE_KEY || '',
      anonKey: env.SUPABASE_ANON_KEY || ''
    },
    security: { encryptionKey: env.ENCRYPTION_KEY || '00000000000000000000000000000000' },
    guardrails
  };

  const engine = new TradingEngine(engineConfig, logger);

  let receivedTicker = false;

  engine.on('market:ticker', () => {
    receivedTicker = true;
  });

  // Start engine and wait briefly for ticker
  await engine.start();
  await new Promise(resolve => setTimeout(resolve, 5000));

  // Print results
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({
    ok: true,
    supabaseConfigured: Boolean(env.SUPABASE_URL && env.SUPABASE_SERVICE_KEY),
    websocketReceivingTicker: receivedTicker
  }, null, 2));

  await engine.stop();
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(JSON.stringify({ ok: false, error: String(err) }));
  process.exit(1);
});

