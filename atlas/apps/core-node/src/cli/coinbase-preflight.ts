/**
 * Coinbase Advanced Trade — READ-ONLY live preflight.
 *
 * Verifies against the REAL account everything the live execution path needs
 * before a single order is sent:
 *   1. Credential shape   — CDP key name + ES256 (P-256) EC private key
 *   2. Clock skew         — JWT nbf/exp is a 120s window
 *   3. Key permissions    — can_view / can_trade / can_transfer
 *   4. Balances           — USD + USDC available/hold (live equity source of truth)
 *   5. Fee tier           — maker/taker rates (FeeModel + EV-gate inputs)
 *   6. Product specs      — increments, min sizes, trading status per symbol
 *   7. Repo client parity — AdvancedTradeRestClient.getAccounts() (its JWT variant)
 *
 * NEVER places, modifies, or cancels orders. NEVER prints secrets or tokens.
 *
 * Usage (from atlas/apps/core-node):
 *   pnpm exec tsx src/cli/coinbase-preflight.ts
 *   pnpm exec tsx src/cli/coinbase-preflight.ts --symbols BTC-USD,ETH-USD --json
 *
 * Exit code: 0 = no FAIL checks, 1 = at least one FAIL.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import dotenv from 'dotenv';
import type { Logger } from '../core/logger';
import { AdvancedTradeRestClient } from '../exchanges/coinbase/advanced-trade-client';

const HOST = 'api.coinbase.com';
const BASE_URL = `https://${HOST}`;
const KEY_NAME_RE = /^organizations\/[0-9a-f-]{36}\/apiKeys\/[0-9a-f-]{36}$/i;
const STABLE_QUOTES = new Set(['USD', 'USDC']);
const HIGH_TAKER_FEE = 0.0075; // >= 75 bps/side: 15m strategies cannot clear this (see Sprint 9 analysis)

type Verdict = 'PASS' | 'WARN' | 'FAIL' | 'INFO';

interface Check {
  name: string;
  verdict: Verdict;
  detail: string;
  data?: unknown;
}

interface CliArgs {
  symbols: string[];
  json: boolean;
}

interface Auth {
  keyName: string;
  privateKey: crypto.KeyObject;
}

interface HttpResult<T> {
  status: number;
  ok: boolean;
  body: T | null;
  error?: string;
}

interface CbMoney {
  value: string;
  currency: string;
}

interface CbAccount {
  uuid: string;
  currency: string;
  available_balance: CbMoney;
  hold: CbMoney;
}

interface CbAccountsPage {
  accounts: CbAccount[];
  has_next: boolean;
  cursor: string;
}

interface CbKeyPermissions {
  can_view: boolean;
  can_trade: boolean;
  can_transfer: boolean;
  portfolio_uuid: string;
  portfolio_type: string;
}

interface CbTransactionSummary {
  total_volume: number;
  total_fees: number;
  fee_tier: {
    pricing_tier: string;
    taker_fee_rate: string;
    maker_fee_rate: string;
  };
}

interface CbProduct {
  product_id: string;
  price: string;
  base_increment: string;
  quote_increment: string;
  base_min_size: string;
  quote_min_size: string;
  status: string;
  trading_disabled: boolean;
  cancel_only: boolean;
  limit_only: boolean;
  post_only: boolean;
  view_only?: boolean;
}

interface CbServerTime {
  epochSeconds: string;
}

/** Silent logger so the repo client can never echo request headers (JWTs) to stdout. */
const SILENT_LOGGER: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/** Parse CLI flags. */
function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { symbols: ['BTC-USD', 'ETH-USD', 'SOL-USD'], json: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--json') {
      args.json = true;
    } else if (flag === '--symbols' && argv[i + 1]) {
      args.symbols = argv[++i]
        .split(',')
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean);
    }
  }
  return args;
}

/** Walk up from cwd to the first .env (repo root in this monorepo). */
function findEnvFile(startDir: string): string | null {
  let dir = startDir;
  for (let depth = 0; depth < 8; depth++) {
    const candidate = path.join(dir, '.env');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

/**
 * Spec-exact Advanced Trade JWT (docs.cdp.coinbase.com, API key authentication):
 * header {alg, kid, nonce, typ}; claims {sub, iss:"cdp", nbf, exp:+120, uri:"METHOD host/path"}.
 * Query strings are excluded from `uri`.
 */
function signJwt(auth: Auth, method: string, requestPath: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'ES256', kid: auth.keyName, nonce: crypto.randomBytes(16).toString('hex'), typ: 'JWT' };
  const claims = { sub: auth.keyName, iss: 'cdp', nbf: now, exp: now + 120, uri: `${method} ${HOST}${requestPath}` };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const signature = crypto.sign('sha256', Buffer.from(signingInput), {
    key: auth.privateKey,
    dsaEncoding: 'ieee-p1363', // raw R||S, as JWS ES256 requires
  });
  return `${signingInput}.${b64url(signature)}`;
}

function extractError(body: unknown, fallback: string): string {
  if (body && typeof body === 'object') {
    const record = body as Record<string, unknown>;
    for (const key of ['message', 'error_details', 'error']) {
      const value = record[key];
      if (typeof value === 'string' && value.length > 0) return value;
    }
  }
  return fallback.slice(0, 200);
}

/** GET against Advanced Trade. `auth=null` for public endpoints. */
async function cbGet<T>(requestPath: string, auth: Auth | null, query = ''): Promise<HttpResult<T>> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': 'apex-automata-preflight/1.0',
  };
  if (auth) headers.Authorization = `Bearer ${signJwt(auth, 'GET', requestPath)}`;

  try {
    const res = await fetch(`${BASE_URL}${requestPath}${query}`, { headers, signal: AbortSignal.timeout(15_000) });
    const text = await res.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    return {
      status: res.status,
      ok: res.ok,
      body: body as T | null,
      error: res.ok ? undefined : extractError(body, text || res.statusText),
    };
  } catch (err) {
    return { status: 0, ok: false, body: null, error: err instanceof Error ? err.message : String(err) };
  }
}

function num(value: string | number | undefined): number {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(value ?? '');
  return Number.isFinite(parsed) ? parsed : 0;
}

function bps(rate: string | undefined): string {
  return `${(num(rate) * 10_000).toFixed(1)} bps`;
}

/** Load + shape-check credentials. Returns null auth when unusable. */
function checkCredentials(checks: Check[]): Auth | null {
  const keyName = (process.env.COINBASE_API_KEY ?? '').trim();
  const secret = (process.env.COINBASE_API_SECRET ?? '').replace(/\\n/g, '\n').trim();
  const apiVersion = (process.env.COINBASE_API_VERSION ?? 'exchange').trim();

  checks.push({
    name: 'env.COINBASE_API_VERSION',
    verdict: apiVersion === 'advanced' ? 'PASS' : 'FAIL',
    detail: apiVersion === 'advanced' ? 'advanced (Advanced Trade / CDP keys)' : `"${apiVersion}" — legacy Exchange API cannot authenticate CDP keys`,
  });

  if (!KEY_NAME_RE.test(keyName)) {
    checks.push({ name: 'credentials.key_name', verdict: 'FAIL', detail: 'COINBASE_API_KEY is not a CDP key name (organizations/{org}/apiKeys/{id})' });
    return null;
  }
  checks.push({ name: 'credentials.key_name', verdict: 'PASS', detail: `CDP key …${keyName.slice(-6)}` });

  let privateKey: crypto.KeyObject;
  try {
    privateKey = crypto.createPrivateKey({ key: secret, format: 'pem' });
  } catch {
    checks.push({ name: 'credentials.private_key', verdict: 'FAIL', detail: 'COINBASE_API_SECRET is not a parseable PEM private key' });
    return null;
  }

  const keyType = privateKey.asymmetricKeyType;
  const curve = privateKey.asymmetricKeyDetails?.namedCurve;
  if (keyType !== 'ec' || curve !== 'prime256v1') {
    checks.push({
      name: 'credentials.private_key',
      verdict: 'FAIL',
      detail: `key type ${keyType ?? '?'}/${curve ?? '?'} — Advanced Trade requires ECDSA P-256 (Ed25519 is NOT supported)`,
    });
    return null;
  }
  checks.push({ name: 'credentials.private_key', verdict: 'PASS', detail: 'ECDSA P-256 (ES256) PEM' });
  return { keyName, privateKey };
}

async function checkClock(checks: Check[]): Promise<void> {
  const res = await cbGet<CbServerTime>('/api/v3/brokerage/time', null);
  if (!res.ok || !res.body) {
    checks.push({ name: 'clock.skew', verdict: 'WARN', detail: `could not read server time (${res.status} ${res.error ?? ''})` });
    return;
  }
  const skewSec = Math.abs(Date.now() / 1000 - num(res.body.epochSeconds));
  const verdict: Verdict = skewSec <= 5 ? 'PASS' : skewSec <= 30 ? 'WARN' : 'FAIL';
  checks.push({ name: 'clock.skew', verdict, detail: `${skewSec.toFixed(2)}s vs Coinbase` });
}

async function checkPermissions(checks: Check[], auth: Auth): Promise<boolean> {
  const res = await cbGet<CbKeyPermissions>('/api/v3/brokerage/key_permissions', auth);
  if (!res.ok || !res.body) {
    checks.push({ name: 'auth.jwt', verdict: 'FAIL', detail: `HTTP ${res.status}: ${res.error ?? 'no body'}` });
    return false;
  }
  checks.push({ name: 'auth.jwt', verdict: 'PASS', detail: 'spec-exact ES256 JWT accepted (HTTP 200)' });

  const p = res.body;
  checks.push({ name: 'key.can_view', verdict: p.can_view ? 'PASS' : 'FAIL', detail: String(p.can_view) });
  checks.push({
    name: 'key.can_trade',
    verdict: p.can_trade ? 'PASS' : 'FAIL',
    detail: p.can_trade ? 'true' : 'false — live orders will be rejected; enable Trade on the CDP key',
  });
  checks.push({
    name: 'key.can_transfer',
    verdict: p.can_transfer ? 'WARN' : 'PASS',
    detail: p.can_transfer ? 'true — a trading bot key should NOT be able to move funds; recreate with View+Trade only' : 'false (good)',
  });
  checks.push({ name: 'key.portfolio', verdict: 'INFO', detail: `${p.portfolio_type} …${p.portfolio_uuid.slice(-6)}` });
  return true;
}

async function checkBalances(checks: Check[], auth: Auth): Promise<void> {
  const accounts: CbAccount[] = [];
  let cursor = '';
  for (let page = 0; page < 10; page++) {
    const query = `?limit=250${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const res = await cbGet<CbAccountsPage>('/api/v3/brokerage/accounts', auth, query);
    if (!res.ok || !res.body) {
      checks.push({ name: 'balances', verdict: 'FAIL', detail: `HTTP ${res.status}: ${res.error ?? 'no body'}` });
      return;
    }
    accounts.push(...res.body.accounts);
    if (!res.body.has_next || !res.body.cursor) break;
    cursor = res.body.cursor;
  }

  const nonZero = accounts
    .map((a) => ({ currency: a.currency, available: num(a.available_balance.value), hold: num(a.hold.value) }))
    .filter((a) => a.available > 0 || a.hold > 0);

  const stable = nonZero.filter((a) => STABLE_QUOTES.has(a.currency));
  const stableAvailable = stable.reduce((sum, a) => sum + a.available, 0);
  const stableHold = stable.reduce((sum, a) => sum + a.hold, 0);

  checks.push({
    name: 'balances.usd_usdc',
    verdict: stableAvailable >= 100 ? 'PASS' : stableAvailable > 0 ? 'WARN' : 'FAIL',
    detail: `available $${stableAvailable.toFixed(2)} (hold $${stableHold.toFixed(2)}) across ${stable.map((a) => a.currency).join('+') || 'none'}`,
    data: stable,
  });
  const cryptoHoldings = nonZero.filter((a) => !STABLE_QUOTES.has(a.currency));
  checks.push({
    name: 'balances.crypto',
    verdict: 'INFO',
    detail: cryptoHoldings.length ? cryptoHoldings.map((a) => `${a.currency} ${a.available}`).join(', ') : 'none',
    data: cryptoHoldings,
  });
}

async function checkFeeTier(checks: Check[], auth: Auth): Promise<void> {
  const res = await cbGet<CbTransactionSummary>('/api/v3/brokerage/transaction_summary', auth);
  if (!res.ok || !res.body) {
    checks.push({ name: 'fees.tier', verdict: 'FAIL', detail: `HTTP ${res.status}: ${res.error ?? 'no body'}` });
    return;
  }
  const tier = res.body.fee_tier;
  const taker = num(tier.taker_fee_rate);
  checks.push({
    name: 'fees.tier',
    verdict: taker >= HIGH_TAKER_FEE ? 'WARN' : 'INFO',
    detail: `${tier.pricing_tier}: maker ${bps(tier.maker_fee_rate)} / taker ${bps(tier.taker_fee_rate)} · 30d volume $${num(res.body.total_volume).toFixed(2)}`,
    data: { maker: num(tier.maker_fee_rate), taker, volume30d: num(res.body.total_volume) },
  });
}

async function checkProducts(checks: Check[], auth: Auth, symbols: string[]): Promise<void> {
  for (const symbol of symbols) {
    const res = await cbGet<CbProduct>(`/api/v3/brokerage/products/${symbol}`, auth);
    if (!res.ok || !res.body) {
      checks.push({ name: `product.${symbol}`, verdict: 'FAIL', detail: `HTTP ${res.status}: ${res.error ?? 'not found'}` });
      continue;
    }
    const p = res.body;
    const tradable = p.status.toLowerCase() === 'online' && !p.trading_disabled && !p.cancel_only && !p.view_only;
    const minNotional = Math.max(num(p.quote_min_size), num(p.base_min_size) * num(p.price));
    checks.push({
      name: `product.${symbol}`,
      verdict: tradable ? (p.limit_only || p.post_only ? 'WARN' : 'PASS') : 'FAIL',
      detail: `px ${p.price} · base_inc ${p.base_increment} · quote_inc ${p.quote_increment} · min ≈ $${minNotional.toFixed(2)}${p.limit_only ? ' · LIMIT-ONLY' : ''}${p.post_only ? ' · POST-ONLY' : ''}`,
      data: {
        base_increment: p.base_increment,
        quote_increment: p.quote_increment,
        base_min_size: p.base_min_size,
        quote_min_size: p.quote_min_size,
      },
    });
  }
}

async function checkRepoClient(checks: Check[], auth: Auth): Promise<void> {
  const client = new AdvancedTradeRestClient(
    { apiKey: auth.keyName, apiSecret: process.env.COINBASE_API_SECRET ?? '', environment: 'production' },
    SILENT_LOGGER,
  );
  try {
    const accounts = await client.getAccounts();
    checks.push({
      name: 'repo.AdvancedTradeRestClient',
      verdict: 'PASS',
      detail: `getAccounts() OK (${accounts.length} accounts on first page — client does not paginate)`,
    });
  } catch (err) {
    const status = (err as { response?: { status?: number } }).response?.status;
    checks.push({
      name: 'repo.AdvancedTradeRestClient',
      verdict: 'FAIL',
      detail: `getAccounts() failed${status ? ` (HTTP ${status})` : ''} — its JWT variant (aud claim / DER→raw) is rejected`,
    });
  }
}

function render(checks: Check[]): void {
  const icon: Record<Verdict, string> = { PASS: '✅', WARN: '⚠️ ', FAIL: '❌', INFO: 'ℹ️ ' };
  const width = Math.max(...checks.map((c) => c.name.length));
  // eslint-disable-next-line no-console
  console.log('\nCoinbase Advanced Trade — read-only live preflight\n');
  for (const c of checks) {
    // eslint-disable-next-line no-console
    console.log(`${icon[c.verdict]} ${c.verdict.padEnd(4)}  ${c.name.padEnd(width)}  ${c.detail}`);
  }
  const fails = checks.filter((c) => c.verdict === 'FAIL').length;
  const warns = checks.filter((c) => c.verdict === 'WARN').length;
  // eslint-disable-next-line no-console
  console.log(`\n${fails === 0 ? 'READY (no FAIL)' : `NOT READY — ${fails} FAIL`} · ${warns} WARN\n`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const envPath = findEnvFile(process.cwd());
  if (envPath) dotenv.config({ path: envPath });

  const checks: Check[] = [
    { name: 'env.file', verdict: envPath ? 'PASS' : 'FAIL', detail: envPath ?? 'no .env found walking up from cwd' },
  ];

  const auth = checkCredentials(checks);
  await checkClock(checks);

  if (auth) {
    const authed = await checkPermissions(checks, auth);
    if (authed) {
      await checkBalances(checks, auth);
      await checkFeeTier(checks, auth);
      await checkProducts(checks, auth, args.symbols);
    }
    await checkRepoClient(checks, auth);
  }

  if (args.json) {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ generatedAt: new Date().toISOString(), checks }, null, 2));
  } else {
    render(checks);
  }
  process.exit(checks.some((c) => c.verdict === 'FAIL') ? 1 : 0);
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error('preflight crashed:', err instanceof Error ? err.message : String(err));
  process.exit(2);
});
