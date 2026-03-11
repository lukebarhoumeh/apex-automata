import 'dotenv/config';
import fetch from 'node-fetch';
import { createClient } from '@supabase/supabase-js';

const RUNTIME_API_URL = process.env.RUNTIME_API_URL || 'http://localhost:3001';
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const USER_ID = process.env.USER_ID || 'b7e8f9c2-4d6a-4c8b-9e2d-1a3b5c7d9e1f';

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

async function stage(name: string, fn: () => Promise<void>) {
  const started = Date.now();
  process.stdout.write(`▶ ${name}... `);
  try {
    await fn();
    const dur = ((Date.now() - started) / 1000).toFixed(1);
    console.log(`OK (${dur}s)`);
  } catch (err: any) {
    console.error(`FAIL: ${name}:`, err?.message || err);
    process.exit(1);
  }
}

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function postJSON(path: string, body: Record<string, any>) {
  const res = await fetch(`${RUNTIME_API_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${path} ${res.status}: ${text}`);
  }
  return res.json();
}

(async () => {
  const windowStart = new Date().toISOString();

  await stage('Runtime health', async () => {
    const res = await fetch(`${RUNTIME_API_URL}/api/health`);
    if (!res.ok) throw new Error(`/api/health ${res.status}`);
  });

  await stage('Start engine (paper)', async () => {
    await postJSON('/api/engine/start', { mode: 'paper' });
  });

  await stage('Wait for activity', async () => {
    await sleep(10_000);
  });

  await stage('Verify Supabase inserts (signals/orders/fills/positions)', async () => {
    const since = windowStart;
    const tables = ['signals', 'orders', 'fills', 'positions'];
    for (const table of tables) {
      const { count, error } = await supabase
        .from(table)
        .select('id', { count: 'exact', head: true })
        .eq('user_id', USER_ID)
        .gte('created_at', since);
      if (error) throw error;
      if (!count || count <= 0) {
        throw new Error(`No recent rows in ${table}`);
      }
    }
  });

  await stage('Stop engine', async () => {
    await postJSON('/api/engine/stop', {});
  });

  console.log('✅ Smoke test PASSED');
  process.exit(0);
})();
