import path from 'node:path';
import WebSocket from 'ws';
import { createClient } from '@supabase/supabase-js';
import { loadEnv } from '../core/env';

async function testSupabase(url: string, key: string) {
  const supabase = createClient(url, key);
  try {
    const { data, error } = await supabase.from('symbols').select('symbol').limit(3);
    if (error) throw error;
    return { ok: true, sample: data?.map(d => d.symbol) };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e) };
  }
}

async function testCoinbaseWS() {
  return await new Promise<{ ok: boolean; receivedTicker: boolean; error?: string }>((resolve) => {
    const wsUrl = 'wss://ws-feed-public.sandbox.exchange.coinbase.com';
    const ws = new WebSocket(wsUrl);
    let receivedTicker = false;

    const timer = setTimeout(() => {
      ws.close();
      resolve({ ok: true, receivedTicker });
    }, 5000);

    ws.on('open', () => {
      ws.send(JSON.stringify({
        type: 'subscribe',
        product_ids: ['BTC-USD'],
        channels: ['ticker']
      }));
    });

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'ticker') {
          receivedTicker = true;
        }
      } catch {}
    });

    ws.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, receivedTicker: false, error: String(err) });
    });
  });
}

async function main() {
  const atlasRoot = path.resolve(process.cwd(), '../../');
  const env = loadEnv(path.resolve(atlasRoot));

  const supabaseResult = await testSupabase(env.SUPABASE_URL || '', env.SUPABASE_SERVICE_KEY || env.SUPABASE_ANON_KEY || '');
  const coinbaseResult = await testCoinbaseWS();

  // eslint-disable-next-line no-console
  console.log(JSON.stringify({
    envPresence: {
      supabaseUrl: Boolean(env.SUPABASE_URL),
      supabaseKey: Boolean(env.SUPABASE_SERVICE_KEY || env.SUPABASE_ANON_KEY),
    },
    supabase: supabaseResult,
    coinbaseWS: coinbaseResult
  }, null, 2));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(JSON.stringify({ ok: false, error: String(err) }));
  process.exit(1);
});


