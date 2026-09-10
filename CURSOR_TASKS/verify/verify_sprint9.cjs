#!/usr/bin/env node
/**
 * Sprint 9 static verification — TASK_010 … TASK_018.
 *
 * Usage (repo root):
 *   node CURSOR_TASKS/verify/verify_sprint9.cjs            # all tasks, summary
 *   node CURSOR_TASKS/verify/verify_sprint9.cjs --task 010 # one task, exit 1 on any FAIL
 *
 * Static checks only (files, symbols, removed hazards). Tests are verified separately:
 *   cd atlas/apps/core-node && pnpm test
 */
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const core = 'atlas/apps/core-node/src';

const args = process.argv.slice(2);
const taskArgIdx = args.indexOf('--task');
const only = taskArgIdx >= 0 ? String(args[taskArgIdx + 1] || '').padStart(3, '0') : null;

const abs = (rel) => path.join(root, rel);
const exists = (rel) => fs.existsSync(abs(rel));
const read = (rel) => (exists(rel) ? fs.readFileSync(abs(rel), 'utf8') : '');
const has = (rel, needle) => {
  const text = read(rel);
  return needle instanceof RegExp ? needle.test(text) : text.includes(needle);
};
const lacks = (rel, needle) => exists(rel) && !has(rel, needle);

function listFiles(relDir, pattern) {
  const dir = abs(relDir);
  if (!fs.existsSync(dir)) return [];
  const out = [];
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (pattern.test(entry.name)) out.push(full);
    }
  };
  walk(dir);
  return out;
}
const anyFileContains = (relDir, filePattern, needle) =>
  listFiles(relDir, filePattern).some((f) => fs.readFileSync(f, 'utf8').includes(needle));

const TASKS = {
  '010': {
    title: 'Advanced Trade live execution adapter',
    checks: [
      ['Adapter class exists', () => has(`${core}/trading/execution/coinbase-advanced-adapter.ts`, 'class CoinbaseAdvancedExecutionAdapter')],
      ['Adapter implements IExecutionAdapter', () => has(`${core}/trading/execution/coinbase-advanced-adapter.ts`, 'implements IExecutionAdapter')],
      ['User stream on advanced-trade-ws-user', () => has(`${core}/exchanges/coinbase/advanced-trade-user-stream.ts`, 'advanced-trade-ws-user.coinbase.com')],
      ['JWT uses ieee-p1363 signatures', () => has(`${core}/exchanges/coinbase/advanced-trade-client.ts`, 'ieee-p1363')],
      ['JWT no longer sends aud claim', () => lacks(`${core}/exchanges/coinbase/advanced-trade-client.ts`, /aud\s*:\s*\[/)],
      ['createOrder handles success:false / error_response', () => has(`${core}/exchanges/coinbase/advanced-trade-client.ts`, 'error_response')],
      ['Order preview endpoint wired', () => has(`${core}/exchanges/coinbase/advanced-trade-client.ts`, 'orders/preview')],
      ['Factory fails closed for legacy live', () => has(`${core}/trading/execution/adapter-factory.ts`, 'LIVE_REQUIRES_ADVANCED_TRADE')],
      ['Preflight no longer hard-codes legacy REST URL', () => lacks(`${core}/api/server.ts`, 'https://api.exchange.coinbase.com')],
      ['Adapter tests exist', () => exists(`${core}/__tests__/coinbase-advanced-adapter.test.ts`)],
    ],
  },
  '011': {
    title: 'Live account truth (equity, fee tier, specs)',
    checks: [
      ['LiveAccountTruth service exists', () => has(`${core}/trading/account/live-account-truth.ts`, 'LiveAccountSnapshot')],
      ['Fee tier pulled from transaction_summary (runtime, not CLI)', () => has(`${core}/trading/account/live-account-truth.ts`, 'transaction_summary')],
      ['FeeModel runtime override', () => has(`${core}/core/fee-model.ts`, 'withRuntimeOverride')],
      ['EV gate has enforce|shadow mode', () => anyFileContains(core, /\.ts$/, 'ev_gate_mode')],
      ['Live start refuses unknown account truth', () => anyFileContains(core, /\.ts$/, 'ACCOUNT_TRUTH_UNAVAILABLE')],
      ['cb:preflight script registered', () => has('atlas/apps/core-node/package.json', '"cb:preflight"')],
      ['Account truth tests exist', () => exists(`${core}/__tests__/live-account-truth.test.ts`)],
    ],
  },
  '012': {
    title: 'Live profiles, spot long-only, perps off in live',
    checks: [
      ['Canary profile exists', () => exists('atlas/config/guardrails.live-canary.yaml')],
      ['1K profile exists', () => exists('atlas/config/guardrails.live-1k.yaml')],
      ['Canary profile disables shorts', () => has('atlas/config/guardrails.live-canary.yaml', 'allow_short: false')],
      ['Profile overlay loader (GUARDRAILS_FILE)', () => anyFileContains(core, /\.ts$/, 'GUARDRAILS_FILE')],
      ['Live requires live profile', () => anyFileContains(core, /\.ts$/, 'LIVE_PROFILE_REQUIRED')],
      ['Spot short blocked telemetry', () => anyFileContains(core, /\.ts$/, 'spot_short_blocked')],
      ['Legacy CLI configs moved', () => exists('atlas/config/legacy-cli')],
    ],
  },
  '013': {
    title: 'Exchange-side protection + reconciliation',
    checks: [
      ['Reconciler exists', () => has(`${core}/trading/execution/live-reconciler.ts`, 'RECONCILE_DIVERGENCE')],
      ['Entries attach trigger_bracket_gtc', () => has(`${core}/trading/execution/coinbase-advanced-adapter.ts`, 'trigger_bracket_gtc')],
      ['Protection-unavailable guard', () => anyFileContains(core, /\.ts$/, 'PROTECTION_UNAVAILABLE')],
      ['Live drills runbook', () => exists('docs/runbooks/live-drills.md')],
    ],
  },
  '014': {
    title: 'Persistence fixes for live',
    checks: [
      ['Live persistence migration file', () => listFiles('supabase/migrations', /_live_persistence\.sql$/).length > 0],
      ['Positions upsert on id', () => has(`${core}/api/server.ts`, /from\('positions'\)[\s\S]{0,400}onConflict:\s*'id'/)],
      ['POSITIONS_HISTORY_PRESERVE gate removed', () => lacks(`${core}/api/server.ts`, 'POSITIONS_HISTORY_PRESERVE')],
      // P2: either inline in server.ts, or routed through the pure persistence/fill-row.ts mapper.
      ['Fill writes map order_id=client UUID + external_order_id', () =>
        (has(`${core}/api/server.ts`, /order_id:\s*order\.id/) && has(`${core}/api/server.ts`, /external_order_id:\s*fill\./)) ||
        (has(`${core}/api/server.ts`, 'buildFillRow(') &&
          has(`${core}/persistence/fill-row.ts`, /order_id:\s*order\.id/) &&
          has(`${core}/persistence/fill-row.ts`, /external_order_id:\s*resolveFillExternalOrderId\(/))],
      ['Separate LIVE_USER_ID', () => anyFileContains(core, /\.ts$/, 'LIVE_USER_ID')],
      ['Risk restore filters by execution_mode', () => has(`${core}/trading/risk-engine.ts`, /\.eq\(\s*['"]execution_mode['"]/)],
      ['Persistence tests exist', () => exists(`${core}/__tests__/persistence-live-fixes.test.ts`)],
    ],
  },
  '015': {
    title: 'Control-plane security',
    checks: [
      ['Control API token enforced', () => has(`${core}/api/server.ts`, 'CONTROL_API_TOKEN')],
      ['Constant-time token compare', () => has(`${core}/api/server.ts`, 'timingSafeEqual')],
      ['CORS restricted to dashboard origin', () => has(`${core}/api/server.ts`, 'DASHBOARD_ORIGIN') && lacks(`${core}/api/server.ts`, 'app.use(cors())')],
      ['env.example documents token', () => has('env.example', 'CONTROL_API_TOKEN')],
      ['journal-entry verifies caller (or removed)', () => !exists('supabase/functions/journal-entry/index.ts') || has('supabase/functions/journal-entry/index.ts', 'getUser')],
    ],
  },
  '016': {
    title: 'Dashboard live safety',
    checks: [
      ['controlApi client', () => exists('src/services/controlApi.ts')],
      ['ModeBanner component', () => exists('src/components/apex/shell/ModeBanner.tsx')],
      ['ConfirmPhraseDialog component', () => exists('src/components/apex/shell/ConfirmPhraseDialog.tsx')],
      ['No random marks in PositionsTable', () => listFiles('src', /^PositionsTable\.tsx$/).every((f) => !fs.readFileSync(f, 'utf8').includes('Math.random'))],
      ['No random marks in ActivePositionsStrip', () => listFiles('src', /^ActivePositionsStrip\.tsx$/).every((f) => !fs.readFileSync(f, 'utf8').includes('Math.random'))],
      ['Demo data banner exists', () => anyFileContains('src', /\.tsx$/, 'DemoDataBanner')],
      ['Page error boundary exists', () => anyFileContains('src', /\.tsx$/, 'getDerivedStateFromError')],
    ],
  },
  '017': {
    title: 'Backtest integrity',
    checks: [
      ['Loader fails on missing data', () => has(`${core}/backtesting/data-loader.ts`, 'DATA_UNAVAILABLE')],
      ['Synthetic requires explicit flag', () => has(`${core}/cli/backtest.ts`, 'allow-synthetic')],
      ['Bar aggregation flag', () => has(`${core}/cli/backtest.ts`, 'bar-minutes')],
      ['Fee tier flag', () => has(`${core}/cli/backtest.ts`, 'fee-tier')],
      ['EV gate in backtest engine', () => has(`${core}/backtesting/backtest-engine.ts`, 'evaluateEvGate')],
    ],
  },
  '018': {
    title: 'Edge experiments',
    checks: [
      ['E1–E6 research doc', () => listFiles('docs/research', /_e1-e6-edge-experiments\.md$/).length > 0],
    ],
  },
};

let totalFail = 0;
const summary = [];
for (const [id, task] of Object.entries(TASKS)) {
  if (only && id !== only) continue;
  console.log(`\n=== TASK_${id} — ${task.title} ===`);
  let pass = 0;
  let fail = 0;
  for (const [label, fn] of task.checks) {
    let ok = false;
    try {
      ok = Boolean(fn());
    } catch {
      ok = false;
    }
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
    if (ok) pass++;
    else fail++;
  }
  totalFail += fail;
  summary.push({ id, title: task.title, pass, fail, status: fail === 0 ? 'DONE' : pass === 0 ? 'PENDING' : 'IN_PROGRESS' });
}

console.log('\n=== Sprint 9 summary ===');
for (const s of summary) {
  console.log(`  TASK_${s.id}  ${s.status.padEnd(11)} ${String(s.pass).padStart(2)}/${s.pass + s.fail}  ${s.title}`);
}
if (only && !summary.length) {
  console.error(`Unknown task ${only}`);
  process.exit(2);
}
process.exit(totalFail === 0 ? 0 : 1);
