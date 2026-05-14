/**
 * audit-trades CLI — Trade lifecycle integrity check.
 *
 * Sprint task: E4 (SPRINT-PLAN-FINAL.md §3 Workstream E2/E4, §10 dispatch).
 *
 * For every closed trade in `trade_log` within a date window, verifies the
 * cross-table foreign-key chain still holds:
 *
 *   trade_log.entry_order_id  →  orders.id  →  fills.order_id (≥ 1)
 *   trade_log.exit_order_id   →  orders.id  →  fills.order_id (≥ 1)   [if exit set]
 *   trade_log.symbol + time   →  positions  (overlapping opened_at/closed_at window)
 *
 * Drift between these four tables silently corrupts P&L attribution and
 * the dashboard's trade-history view. The current schema spans 42
 * migrations with documented drift (§1.8) — this script is the
 * canary that catches drift between the writers in api/server.ts and
 * the live row shapes.
 *
 * Usage (from atlas/apps/core-node/):
 *
 *   pnpm audit:trades                       # default window: last 7 days
 *   pnpm audit:trades --since 2026-05-11    # custom start date
 *   pnpm audit:trades --since 2026-05-11 --strict   # exit code 1 on any violation
 *
 * Connects via SUPABASE_URL + SUPABASE_SERVICE_KEY from the project root
 * .env (mirrors quick-check.ts and smoke.ts conventions). Read-only — never
 * writes back to the DB.
 */
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { createLogger, Logger } from '../core/logger';
import { loadEnv } from '../core/env';

interface CliArgs {
  /** Inclusive lower bound on trade_log.entry_time. */
  since: Date;
  /** When true, exit non-zero if ANY trade has at least one violation. */
  strict: boolean;
}

interface TradeLogRow {
  id: string;
  user_id: string;
  symbol: string;
  side: 'long' | 'short';
  entry_time: string;
  exit_time: string | null;
  entry_order_id: string | null;
  exit_order_id: string | null;
  signal_id: string | null;
  strategy: string | null;
  realized_pnl: number | null;
  outcome: 'win' | 'loss' | 'breakeven' | null;
}

interface ViolationDetail {
  /** Free-text describing which side of the lifecycle is missing. */
  reason: string;
  /** Optional context — DB row id or fk that failed lookup. */
  context?: Record<string, unknown>;
}

interface TradeAuditResult {
  trade: Pick<TradeLogRow, 'id' | 'symbol' | 'entry_time' | 'exit_time' | 'strategy' | 'outcome'>;
  /** Empty array = pass; one or more entries = fail. */
  violations: ViolationDetail[];
}

interface AuditSummary {
  windowStart: string;
  windowEnd: string;
  total: number;
  passed: number;
  failed: number;
  failures: TradeAuditResult[];
}

/**
 * Parse `--since` and `--strict` from process.argv.
 *
 * Defaults `since` to (now - 7 days) at 00:00:00 UTC. Throws on invalid date
 * inputs so the caller fails fast and the operator gets a clear error rather
 * than silently auditing a window of zero days.
 *
 * @param argv  Process argv slice (typically `process.argv.slice(2)`).
 * @param now   Override clock for unit tests (defaults to `new Date()`).
 * @returns     Parsed `{ since, strict }` config.
 */
export function parseCliArgs(argv: string[], now: Date = new Date()): CliArgs {
  let since: Date | null = null;
  let strict = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--strict') {
      strict = true;
      continue;
    }
    if (arg === '--since') {
      const value = argv[i + 1];
      if (!value) {
        throw new Error('--since requires a YYYY-MM-DD argument');
      }
      // Strict YYYY-MM-DD shape; reject ISO timestamps, relative ("7d"), etc.
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        throw new Error(`--since must be YYYY-MM-DD (got: ${value})`);
      }
      const parsed = new Date(`${value}T00:00:00.000Z`);
      if (Number.isNaN(parsed.getTime())) {
        throw new Error(`--since received an unparseable date: ${value}`);
      }
      since = parsed;
      i++;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      // eslint-disable-next-line no-console
      console.log(usage());
      process.exit(0);
    }
    if (arg && arg.startsWith('--')) {
      throw new Error(`Unknown flag: ${arg}`);
    }
  }

  if (!since) {
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    const floor = new Date(now.getTime() - sevenDaysMs);
    // Truncate to start-of-day UTC so re-runs within the same day are stable.
    since = new Date(Date.UTC(floor.getUTCFullYear(), floor.getUTCMonth(), floor.getUTCDate()));
  }

  return { since, strict };
}

/**
 * One-shot help text. Emitted on `--help` and on argparse failure.
 */
export function usage(): string {
  return [
    'audit-trades — Trade lifecycle integrity check',
    '',
    'Usage:',
    '  pnpm audit:trades                        Audit the last 7 days',
    '  pnpm audit:trades --since 2026-05-11     Audit from 2026-05-11 onwards (UTC)',
    '  pnpm audit:trades --strict               Exit code 1 on any violation',
    '',
    'Required env (loaded from project-root .env):',
    '  SUPABASE_URL              https://<project-ref>.supabase.co',
    '  SUPABASE_SERVICE_KEY      service_role JWT (≥ 100 chars)',
    '',
    'Output: JSON summary on stdout. Exit code 0 = clean, 1 = violations',
    'detected (only when --strict). Logs via core/logger to stderr.',
  ].join('\n');
}

/**
 * Audit a single trade_log row against its surrounding orders / fills /
 * positions context.
 *
 * Performs four lookups in parallel; aggregates each missing reference
 * into a `ViolationDetail`. A trade with `exit_time = null` is treated
 * as still-open and skips the exit-side fill + order checks.
 *
 * @param supabase  An initialized supabase-js client (service_role).
 * @param trade     The trade_log row under audit.
 * @returns         Result with empty `violations` array on pass.
 */
export async function auditOneTrade(
  supabase: ReturnType<typeof createClient>,
  trade: TradeLogRow,
): Promise<TradeAuditResult> {
  const violations: ViolationDetail[] = [];

  type Probe = Promise<void>;
  const probes: Probe[] = [];

  // --- Entry order existence -------------------------------------------------
  if (!trade.entry_order_id) {
    violations.push({ reason: 'trade_log.entry_order_id is NULL', context: { tradeId: trade.id } });
  } else {
    probes.push(
      (async () => {
        const { data, error } = await supabase
          .from('orders')
          .select('id')
          .eq('id', trade.entry_order_id!)
          .limit(1)
          .maybeSingle();
        if (error) {
          violations.push({ reason: `orders lookup (entry) failed: ${error.message}`, context: { entry_order_id: trade.entry_order_id } });
        } else if (!data) {
          violations.push({ reason: 'entry order missing in orders table', context: { entry_order_id: trade.entry_order_id } });
        }
      })(),
    );

    // --- At least one fill for the entry order ------------------------------
    probes.push(
      (async () => {
        const { count, error } = await supabase
          .from('fills')
          .select('id', { count: 'exact', head: true })
          .eq('order_id', trade.entry_order_id!);
        if (error) {
          violations.push({ reason: `fills lookup (entry) failed: ${error.message}`, context: { entry_order_id: trade.entry_order_id } });
        } else if (!count || count <= 0) {
          violations.push({ reason: 'no fill rows for entry order', context: { entry_order_id: trade.entry_order_id } });
        }
      })(),
    );
  }

  // --- Exit-side checks (only if trade is closed) ----------------------------
  if (trade.exit_time) {
    if (!trade.exit_order_id) {
      violations.push({ reason: 'trade closed but exit_order_id is NULL', context: { tradeId: trade.id, exit_time: trade.exit_time } });
    } else {
      probes.push(
        (async () => {
          const { data, error } = await supabase
            .from('orders')
            .select('id')
            .eq('id', trade.exit_order_id!)
            .limit(1)
            .maybeSingle();
          if (error) {
            violations.push({ reason: `orders lookup (exit) failed: ${error.message}`, context: { exit_order_id: trade.exit_order_id } });
          } else if (!data) {
            violations.push({ reason: 'exit order missing in orders table', context: { exit_order_id: trade.exit_order_id } });
          }
        })(),
      );

      probes.push(
        (async () => {
          const { count, error } = await supabase
            .from('fills')
            .select('id', { count: 'exact', head: true })
            .eq('order_id', trade.exit_order_id!);
          if (error) {
            violations.push({ reason: `fills lookup (exit) failed: ${error.message}`, context: { exit_order_id: trade.exit_order_id } });
          } else if (!count || count <= 0) {
            violations.push({ reason: 'no fill rows for exit order', context: { exit_order_id: trade.exit_order_id } });
          }
        })(),
      );
    }
  }

  // --- Position with overlapping window --------------------------------------
  // We cannot point-equal compare opened_at/closed_at because of clock skew
  // between the engine, supabase, and the trade-log writer. Instead we look
  // for ANY position on (user_id, symbol) whose lifetime brackets the trade.
  probes.push(
    (async () => {
      // opened_at <= entry_time AND (closed_at IS NULL OR closed_at >= entry_time)
      // We split into two queries because supabase-js OR composition is
      // awkward for range predicates; cheaper to do two lookups and union.
      const candidatesQuery = supabase
        .from('positions')
        .select('id, opened_at, closed_at')
        .eq('user_id', trade.user_id)
        .eq('symbol', trade.symbol)
        .lte('opened_at', trade.entry_time)
        .order('opened_at', { ascending: false })
        .limit(20);

      const { data, error } = await candidatesQuery;
      if (error) {
        violations.push({ reason: `positions lookup failed: ${error.message}`, context: { symbol: trade.symbol } });
        return;
      }

      const overlapping = (data ?? []).find((row: any) => {
        if (!row.closed_at) return true; // still open — covers trade exit
        if (!trade.exit_time) return true; // trade still open, any covering position works
        return new Date(row.closed_at).getTime() >= new Date(trade.exit_time).getTime();
      });

      if (!overlapping) {
        violations.push({
          reason: 'no position overlaps trade window',
          context: { symbol: trade.symbol, entry_time: trade.entry_time, exit_time: trade.exit_time },
        });
      }
    })(),
  );

  await Promise.all(probes);

  return {
    trade: {
      id: trade.id,
      symbol: trade.symbol,
      entry_time: trade.entry_time,
      exit_time: trade.exit_time,
      strategy: trade.strategy,
      outcome: trade.outcome,
    },
    violations,
  };
}

/**
 * Iterate trade_log within `[since, now]` and audit each row.
 *
 * Uses pagination with `range()` because trade_log can grow unbounded;
 * supabase-js caps a single query at 1000 rows by default.
 *
 * @param supabase  Initialized service-role client.
 * @param since     Lower bound on entry_time (inclusive).
 * @param logger    Structured logger; failures are also surfaced here.
 * @returns         Aggregated AuditSummary.
 */
export async function auditTrades(
  supabase: ReturnType<typeof createClient>,
  since: Date,
  logger: Logger,
): Promise<AuditSummary> {
  const windowStart = since.toISOString();
  const windowEnd = new Date().toISOString();

  // Page through trade_log in 500-row chunks. Sort ascending so output order
  // is reproducible across runs.
  const PAGE = 500;
  let from = 0;
  let pageNumber = 0;
  const failures: TradeAuditResult[] = [];
  let total = 0;
  let passed = 0;

  while (true) {
    const { data, error } = await supabase
      .from('trade_log')
      .select('id, user_id, symbol, side, entry_time, exit_time, entry_order_id, exit_order_id, signal_id, strategy, realized_pnl, outcome')
      .gte('entry_time', windowStart)
      .order('entry_time', { ascending: true })
      .range(from, from + PAGE - 1);

    if (error) {
      logger.error('trade_log pagination failed', { error: error.message, page: pageNumber, from });
      throw new Error(`trade_log pagination failed at offset ${from}: ${error.message}`);
    }

    const rows = (data ?? []) as unknown as TradeLogRow[];
    if (rows.length === 0) break;

    pageNumber++;
    logger.info('auditing trade_log page', { page: pageNumber, rows: rows.length, from });

    // Batch-audit within a page; each trade's probes already run in parallel
    // internally, so cap outer parallelism conservatively to avoid hammering
    // Supabase with hundreds of concurrent reads.
    const CONCURRENCY = 8;
    for (let i = 0; i < rows.length; i += CONCURRENCY) {
      const slice = rows.slice(i, i + CONCURRENCY);
      const results = await Promise.all(slice.map((row) => auditOneTrade(supabase, row)));
      for (const r of results) {
        total++;
        if (r.violations.length === 0) {
          passed++;
        } else {
          failures.push(r);
        }
      }
    }

    if (rows.length < PAGE) break;
    from += PAGE;
  }

  return { windowStart, windowEnd, total, passed, failed: failures.length, failures };
}

async function main(): Promise<void> {
  let args: CliArgs;
  try {
    args = parseCliArgs(process.argv.slice(2));
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`error: ${err instanceof Error ? err.message : String(err)}\n\n${usage()}`);
    process.exit(2);
    return;
  }

  // Mirror quick-check.ts: cwd-relative atlasRoot then loadEnv against the
  // project root .env (one level up from atlas/).
  const atlasRoot = path.resolve(process.cwd(), '../../');
  const env = loadEnv(atlasRoot);
  const logger = createLogger(path.join(atlasRoot, 'var/logs/audit-trades.jsonl'));

  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_KEY) {
    logger.error('SUPABASE_URL and SUPABASE_SERVICE_KEY are required (loaded from project-root .env)');
    process.exit(2);
    return;
  }

  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  logger.info('starting audit', { since: args.since.toISOString(), strict: args.strict });

  let summary: AuditSummary;
  try {
    summary = await auditTrades(supabase, args.since, logger);
  } catch (err) {
    logger.error('audit run aborted', { error: err instanceof Error ? err.message : String(err) });
    process.exit(2);
    return;
  }

  // Human-readable summary line on stderr (so stdout stays a clean JSON doc).
  const headline = `pass: ${summary.passed}/${summary.total} clean / fail: ${summary.failed} trades with issues`;
  // eslint-disable-next-line no-console
  console.error(headline);
  for (const f of summary.failures.slice(0, 25)) {
    const reasons = f.violations.map((v) => v.reason).join('; ');
    // eslint-disable-next-line no-console
    console.error(`  FAIL  ${f.trade.id}  ${f.trade.symbol}  ${f.trade.entry_time}  →  ${reasons}`);
  }
  if (summary.failures.length > 25) {
    // eslint-disable-next-line no-console
    console.error(`  ... ${summary.failures.length - 25} more (see stdout JSON for full list)`);
  }

  // Machine-readable summary on stdout for piping/CI.
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(summary, null, 2));

  if (args.strict && summary.failed > 0) {
    process.exit(1);
    return;
  }
  process.exit(0);
}

// Only run when invoked directly (preserves importability for tests).
const invokedDirectly = process.argv[1] && process.argv[1].endsWith('audit-trades.ts');
if (invokedDirectly) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    process.exit(2);
  });
}
