/**
 * Paper smoke against a running runtime API (`RUNTIME_API_URL`).
 *
 * Start paper -> wait -> verify Supabase inserts -> stop. Teardown is
 * unconditional (Risk desk pin, 2026-09-22): whenever `/api/engine/start`
 * succeeded, `/api/engine/stop` — which runs `tradingEngine.stop()` and
 * `closeTradingSession()` on the server — is called before this process
 * exits, on the success path AND after any failed stage, and the
 * `trading_sessions` row is checked for `ended_at`. A smoke must never leave
 * a paper engine running or a session row open behind it.
 *
 * This CLI never asks for a risk reset: `PAPER_RESET_RISK_STATE_ON_START` is
 * server-side env and is gated there behind `RISK_CLEAR=YES`. A latched paper
 * risk state makes the start stage fail with the server's 423
 * `PAPER_BOOT_RISK_LATCHED` message; the smoke reports it and exits non-zero.
 */
import 'dotenv/config';
import fetch from 'node-fetch';
import { createClient } from '@supabase/supabase-js';

const RUNTIME_API_URL = process.env.RUNTIME_API_URL || 'http://localhost:3001';
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const USER_ID = process.env.USER_ID || 'b7e8f9c2-4d6a-4c8b-9e2d-1a3b5c7d9e1f';
const ACTIVITY_WAIT_MS = Number(process.env.SMOKE_ACTIVITY_WAIT_MS || 10_000);

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

class SmokeStageError extends Error {
  constructor(public readonly stage: string, cause: unknown) {
    super(`${stage}: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'SmokeStageError';
  }
}

async function stage(name: string, fn: () => Promise<void>): Promise<void> {
  const started = Date.now();
  process.stdout.write(`▶ ${name}... `);
  try {
    await fn();
    const dur = ((Date.now() - started) / 1000).toFixed(1);
    console.log(`OK (${dur}s)`);
  } catch (err) {
    console.error(`FAIL: ${name}:`, err instanceof Error ? err.message : err);
    throw new SmokeStageError(name, err);
  }
}

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class HttpError extends Error {
  constructor(public readonly path: string, public readonly status: number, public readonly body: string) {
    super(`${path} ${status}: ${body}`);
    this.name = 'HttpError';
  }
}

async function postJSON(path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await fetch(`${RUNTIME_API_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new HttpError(path, res.status, text);
  }
  return (await res.json()) as Record<string, unknown>;
}

/**
 * Stop the engine via the API (server-side: `tradingEngine.stop()` +
 * `closeTradingSession()`), then confirm the `trading_sessions` row we
 * started is closed. Returns false when the engine may still be running.
 */
async function teardown(sessionId: string | null): Promise<boolean> {
  let stopped = false;
  try {
    await postJSON('/api/engine/stop', {});
    stopped = true;
    console.log('■ Teardown: engine stopped + session closed via /api/engine/stop');
  } catch (err) {
    if (err instanceof HttpError && err.status === 400 && /not running/i.test(err.body)) {
      stopped = true;
      console.log('■ Teardown: engine was not running (nothing to stop)');
    } else {
      console.error('■ Teardown FAILED: /api/engine/stop did not succeed — the paper engine may still be running:', err instanceof Error ? err.message : err);
    }
  }

  if (!sessionId) return stopped;

  try {
    const { data, error } = await supabase
      .from('trading_sessions')
      .select('session_id, ended_at')
      .eq('session_id', sessionId)
      .maybeSingle();
    if (error) {
      console.warn(`■ Teardown: could not verify trading_sessions.${sessionId} (${error.message}); relying on /api/engine/stop`);
    } else if (!data) {
      console.warn(`■ Teardown: no trading_sessions row for ${sessionId} (insert may have failed); nothing to close`);
    } else if (!data.ended_at) {
      console.error(`■ Teardown FAILED: trading_sessions.${sessionId} is still open (ended_at NULL) after /api/engine/stop`);
      return false;
    } else {
      console.log(`■ Teardown: trading_sessions.${sessionId} closed at ${data.ended_at}`);
    }
  } catch (err) {
    console.warn('■ Teardown: trading_sessions verification threw; relying on /api/engine/stop', err instanceof Error ? err.message : err);
  }
  return stopped;
}

(async () => {
  const windowStart = new Date().toISOString();
  let engineStarted = false;
  let sessionId: string | null = null;
  let failure: unknown = null;

  try {
    await stage('Runtime health', async () => {
      const res = await fetch(`${RUNTIME_API_URL}/api/health`);
      if (!res.ok) throw new Error(`/api/health ${res.status}`);
    });

    await stage('Start engine (paper)', async () => {
      try {
        const body = await postJSON('/api/engine/start', { mode: 'paper' });
        engineStarted = true;
        sessionId = typeof body.sessionId === 'string' ? body.sessionId : null;
      } catch (err) {
        if (err instanceof HttpError && err.status === 423) {
          throw new Error(
            `paper start refused by the server's paper boot guard (persisted kill latch / active halt risk_events; ` +
              `stand-down holds until Risk CLEAR — no reset is attempted by this smoke): ${err.body}`,
          );
        }
        throw err;
      }
    });

    await stage('Wait for activity', async () => {
      await sleep(ACTIVITY_WAIT_MS);
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
  } catch (err) {
    failure = err;
  }

  // Unconditional teardown: engine.stop + closeTradingSession happen on the
  // server inside /api/engine/stop; we call it whenever the start succeeded,
  // regardless of which stage failed.
  let teardownOk = true;
  if (engineStarted) {
    teardownOk = await teardown(sessionId);
  }

  if (failure) {
    console.error(`❌ Smoke test FAILED (${failure instanceof SmokeStageError ? failure.stage : 'unexpected error'})`);
    process.exit(1);
  }
  if (!teardownOk) {
    console.error('❌ Smoke test FAILED: stages passed but teardown could not confirm the engine stopped / session closed');
    process.exit(1);
  }
  console.log('✅ Smoke test PASSED');
  process.exit(0);
})();
