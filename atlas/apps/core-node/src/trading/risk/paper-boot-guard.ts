/**
 * Paper boot guard — Risk desk pins for the 2026-09-22 stand-down.
 *
 * Paper and live share one Supabase project and one `USER_ID`, and the paper
 * kill ladder's L6 (and every legacy halt) latches `risk_metrics.kill_switch_active`
 * plus an open `risk_events` halt row. Before these pins a paper restart could
 * quietly walk over that latch: `PAPER_RESET_RISK_STATE_ON_START=true` swept
 * every halt row, and a next-day boot discarded a stale latch on its own. Both
 * are exactly what a stand-down forbids, so:
 *
 *   1. `runPaperBootGuard()` — a PAPER engine start is refused while the
 *      persisted paper risk state is latched (`kill_switch_active=true`, or an
 *      open halt row such as `consecutive_losses`) unless the desk has set
 *      `RISK_CLEAR=YES`. The API answers with a structured error and never
 *      builds the engine or mints a session.
 *   2. `resolvePaperResetRiskStateOnStart()` — `PAPER_RESET_RISK_STATE_ON_START`
 *      is only honoured together with `RISK_CLEAR=YES`; on its own it is logged
 *      and ignored, so the latch and the halt rows survive the boot.
 *
 * `RISK_CLEAR` is a desk authorisation, not an operator convenience: exactly
 * `YES` (mirroring `CONFIRM_LIVE=YES`), anything else is "not cleared".
 * Soft ladder rows (L1–L5 codes) are never blockers — the in-memory ladder
 * re-derives them and the RiskEngine retires stale ones on its own.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Logger } from '../../core/logger';
import { isMissingTableError, type PostgrestErrorLike } from '../../core/postgrest-errors';
import { ExecutionModeScope } from './execution-mode-scope';
import { isLadderSoftReasonCode } from './paper-kill-ladder';
import type { ExecutionMode } from './types';

/** Env var that carries the Risk desk's CLEAR / GO authorisation. */
export const RISK_CLEAR_ENV = 'RISK_CLEAR';
/** The only value that counts as authorised. */
export const RISK_CLEAR_AUTHORIZED_VALUE = 'YES';
/** Env var that requests a clean-slate paper boot (gated by `RISK_CLEAR`). */
export const PAPER_RESET_RISK_STATE_ENV = 'PAPER_RESET_RISK_STATE_ON_START';

/** True only when the desk has set `RISK_CLEAR=YES` (exact match). */
export function isRiskClearAuthorized(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[RISK_CLEAR_ENV] === RISK_CLEAR_AUTHORIZED_VALUE;
}

export interface PaperResetGateDecision {
  /** `PAPER_RESET_RISK_STATE_ON_START === 'true'`. */
  requested: boolean;
  /** `RISK_CLEAR === 'YES'`. */
  authorized: boolean;
  /** What the engine actually does: `requested && authorized`. */
  honored: boolean;
  /** Set when the reset was requested but is being ignored. */
  ignoredReason: string | null;
}

/**
 * Gate for `PAPER_RESET_RISK_STATE_ON_START`. The flag alone never clears
 * anything any more; it needs the desk's `RISK_CLEAR=YES` next to it.
 */
export function resolvePaperResetRiskStateOnStart(env: NodeJS.ProcessEnv = process.env): PaperResetGateDecision {
  const requested = env[PAPER_RESET_RISK_STATE_ENV] === 'true';
  const authorized = isRiskClearAuthorized(env);
  const honored = requested && authorized;
  return {
    requested,
    authorized,
    honored,
    ignoredReason:
      requested && !authorized
        ? `${PAPER_RESET_RISK_STATE_ENV}=true ignored: ${RISK_CLEAR_ENV}=${RISK_CLEAR_AUTHORIZED_VALUE} is not set (Risk desk pin — the persisted kill latch and active halt risk_events are kept)`
        : null,
  };
}

/** Shape of the `risk_metrics` row the guard reads (only the columns it uses). */
export interface PersistedRiskMetricsRow {
  kill_switch_active?: boolean | null;
  consecutive_losses?: number | string | null;
  daily_pnl?: number | string | null;
  updated_at?: string | null;
  execution_mode?: string | null;
}

/** Shape of a `risk_events` row the guard reads (only the columns it uses). */
export interface PersistedRiskEventRow {
  id?: string | null;
  event_type?: string | null;
  details?: Record<string, unknown> | null;
  triggered_at?: string | null;
  cleared_at?: string | null;
  active?: boolean | null;
  execution_mode?: string | null;
}

export type PaperBootBlocker =
  | {
      kind: 'kill_switch_active';
      source: 'risk_metrics';
      updatedAt: string | null;
      consecutiveLosses: number | null;
      dailyPnl: number | null;
    }
  | {
      kind: 'active_halt_event';
      source: 'risk_events';
      id: string | null;
      eventType: string;
      triggeredAt: string | null;
      ladderLevel: number | null;
    };

export type PaperBootGuardCode =
  /** Paper start may proceed: nothing latched. */
  | 'PAPER_BOOT_ALLOWED'
  /** Latched, but the desk set `RISK_CLEAR=YES` — proceeding under authorisation. */
  | 'PAPER_BOOT_RISK_CLEAR_OVERRIDE'
  /** Not a paper start; the guard does not apply. */
  | 'PAPER_BOOT_NOT_APPLICABLE'
  /** Refused: persisted paper risk state is latched and there is no `RISK_CLEAR=YES`. */
  | 'PAPER_BOOT_RISK_LATCHED'
  /** Refused: the persisted risk state could not be read, so it cannot be proven clear. */
  | 'PAPER_BOOT_RISK_STATE_UNVERIFIED';

export interface PaperBootGuardVerdict {
  allowed: boolean;
  code: PaperBootGuardCode;
  /** HTTP status the API answers with (200 when allowed). */
  httpStatus: 200 | 423 | 503;
  /** Operator-facing one-liner when refused (or overriding). */
  error: string | null;
  remediation: string | null;
  riskClearAuthorized: boolean;
  blockers: PaperBootBlocker[];
  warnings: string[];
}

export interface PaperBootRiskStateReads {
  latestRiskMetrics: PersistedRiskMetricsRow | null;
  /** Open (`cleared_at IS NULL`) rows for the user in paper scope, newest first. */
  openRiskEvents: PersistedRiskEventRow[];
  /** Non-schema read failures; any of these makes the verdict unverifiable. */
  readErrors: Array<{ table: 'risk_metrics' | 'risk_events'; code: string | null; message: string | null }>;
  /** Tables missing from this snapshot (nothing persisted there, nothing latched). */
  missingTables: Array<'risk_metrics' | 'risk_events'>;
}

export const PAPER_BOOT_REMEDIATION =
  'Stand-down holds until Risk CLEAR. Once the desk has cleared, set RISK_CLEAR=YES in the API server environment and ' +
  'restart it (add PAPER_RESET_RISK_STATE_ON_START=true only if the desk also authorised resetting the persisted paper ' +
  'risk state). Never set either against the shared prod paper Supabase during stand-down.';

const toNumberOrNull = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
};

/**
 * True for a `risk_events` row that still represents an open halt: a real
 * halt code (never a soft ladder rung), not yet cleared, and not retired.
 */
export function isOpenHaltRiskEvent(row: PersistedRiskEventRow): boolean {
  if (!row || typeof row.event_type !== 'string' || row.event_type.length === 0) return false;
  if (isLadderSoftReasonCode(row.event_type)) return false;
  if (row.cleared_at) return false;
  if (row.active === false) return false;
  const details = row.details ?? {};
  // Defensive: an audit row for a resume is not a halt even if it shares the code.
  if (details.eventType === 'resume') return false;
  return true;
}

/**
 * Pure verdict: given what is persisted and the env, may a paper engine start?
 */
export function evaluatePaperBootGuard(input: {
  mode: ExecutionMode | string;
  reads: PaperBootRiskStateReads;
  env?: NodeJS.ProcessEnv;
}): PaperBootGuardVerdict {
  const env = input.env ?? process.env;
  const riskClearAuthorized = isRiskClearAuthorized(env);
  const warnings: string[] = [];

  if (input.mode !== 'paper') {
    return {
      allowed: true,
      code: 'PAPER_BOOT_NOT_APPLICABLE',
      httpStatus: 200,
      error: null,
      remediation: null,
      riskClearAuthorized,
      blockers: [],
      warnings,
    };
  }

  const { latestRiskMetrics, openRiskEvents, readErrors, missingTables } = input.reads;
  for (const table of missingTables) {
    warnings.push(`${table} table not present on this snapshot; nothing persisted there to latch`);
  }

  const blockers: PaperBootBlocker[] = [];
  if (latestRiskMetrics && Boolean(latestRiskMetrics.kill_switch_active)) {
    blockers.push({
      kind: 'kill_switch_active',
      source: 'risk_metrics',
      updatedAt: latestRiskMetrics.updated_at ?? null,
      consecutiveLosses: toNumberOrNull(latestRiskMetrics.consecutive_losses),
      dailyPnl: toNumberOrNull(latestRiskMetrics.daily_pnl),
    });
  }
  for (const row of openRiskEvents) {
    if (!isOpenHaltRiskEvent(row)) continue;
    blockers.push({
      kind: 'active_halt_event',
      source: 'risk_events',
      id: row.id ?? null,
      eventType: row.event_type as string,
      triggeredAt: row.triggered_at ?? null,
      ladderLevel: toNumberOrNull(row.details?.ladderLevel),
    });
  }

  const describeBlockers = (): string => {
    const parts: string[] = [];
    const latch = blockers.find((b) => b.kind === 'kill_switch_active');
    if (latch) parts.push('risk_metrics.kill_switch_active=true');
    const haltCodes = blockers
      .filter((b): b is Extract<PaperBootBlocker, { kind: 'active_halt_event' }> => b.kind === 'active_halt_event')
      .map((b) => b.eventType);
    if (haltCodes.length > 0) parts.push(`active halt risk_events: ${[...new Set(haltCodes)].join(', ')}`);
    return parts.join('; ');
  };

  if (readErrors.length > 0) {
    const detail = readErrors.map((e) => `${e.table}${e.code ? ` [${e.code}]` : ''}: ${e.message ?? 'unknown error'}`).join('; ');
    if (riskClearAuthorized) {
      warnings.push(`persisted risk state could not be fully read (${detail}); proceeding under ${RISK_CLEAR_ENV}=${RISK_CLEAR_AUTHORIZED_VALUE}`);
    } else {
      return {
        allowed: false,
        code: 'PAPER_BOOT_RISK_STATE_UNVERIFIED',
        httpStatus: 503,
        error:
          `PAPER start refused: the persisted paper risk state could not be verified (${detail}). ` +
          `A paper session must not start on an unverifiable kill latch; retry when Supabase is reachable or set ${RISK_CLEAR_ENV}=${RISK_CLEAR_AUTHORIZED_VALUE} (desk-authorised) to override.`,
        remediation: PAPER_BOOT_REMEDIATION,
        riskClearAuthorized: false,
        blockers,
        warnings,
      };
    }
  }

  if (blockers.length === 0) {
    return {
      allowed: true,
      code: 'PAPER_BOOT_ALLOWED',
      httpStatus: 200,
      error: null,
      remediation: null,
      riskClearAuthorized,
      blockers,
      warnings,
    };
  }

  if (riskClearAuthorized) {
    return {
      allowed: true,
      code: 'PAPER_BOOT_RISK_CLEAR_OVERRIDE',
      httpStatus: 200,
      error: `PAPER start proceeding under ${RISK_CLEAR_ENV}=${RISK_CLEAR_AUTHORIZED_VALUE} with latched risk state (${describeBlockers()})`,
      remediation: null,
      riskClearAuthorized: true,
      blockers,
      warnings,
    };
  }

  return {
    allowed: false,
    code: 'PAPER_BOOT_RISK_LATCHED',
    httpStatus: 423,
    error:
      `PAPER start refused: persisted paper risk state is latched (${describeBlockers()}). ` +
      `Stand-down holds until Risk CLEAR — set ${RISK_CLEAR_ENV}=${RISK_CLEAR_AUTHORIZED_VALUE} (desk-authorised) and restart the API server to start paper.`,
    remediation: PAPER_BOOT_REMEDIATION,
    riskClearAuthorized: false,
    blockers,
    warnings,
  };
}

/**
 * Read the persisted paper risk state the guard decides on. Paper-scoped via
 * `ExecutionModeScope` (legacy unscoped fallback pre-migration); `PGRST116`
 * (no row) is "nothing persisted"; a missing table is recorded, not an error.
 * Never throws — a thrown client error is folded into `readErrors`.
 */
export async function readPaperBootRiskState(
  supabase: SupabaseClient,
  opts: { userId: string; logger: Logger },
): Promise<PaperBootRiskStateReads> {
  const scope = new ExecutionModeScope('paper', opts.logger);
  const reads: PaperBootRiskStateReads = {
    latestRiskMetrics: null,
    openRiskEvents: [],
    readErrors: [],
    missingTables: [],
  };

  const noteError = (table: 'risk_metrics' | 'risk_events', error: PostgrestErrorLike | null | undefined): boolean => {
    if (!error) return false;
    if (error.code === 'PGRST116') return false;
    if (isMissingTableError(error)) {
      reads.missingTables.push(table);
      return true;
    }
    reads.readErrors.push({ table, code: error.code ?? null, message: error.message ?? null });
    return true;
  };

  const metricsQuery = (scoped: boolean) => {
    let query = supabase
      .from('risk_metrics')
      .select('*')
      .eq('user_id', opts.userId)
      .order('updated_at', { ascending: false })
      .limit(1);
    if (scoped) {
      query = query.eq('execution_mode', 'paper');
    }
    return query.maybeSingle();
  };

  try {
    const { data, error } = await scope.query('risk_metrics', 'select', () => metricsQuery(true), () => metricsQuery(false));
    if (!noteError('risk_metrics', error) && data) {
      reads.latestRiskMetrics = data as PersistedRiskMetricsRow;
    }
  } catch (err) {
    reads.readErrors.push({ table: 'risk_metrics', code: null, message: err instanceof Error ? err.message : String(err) });
  }

  const eventsQuery = (scoped: boolean) => {
    let query = supabase
      .from('risk_events')
      .select('*')
      .eq('user_id', opts.userId)
      .is('cleared_at', null);
    if (scoped) {
      query = query.eq('execution_mode', 'paper');
    }
    return query.order('triggered_at', { ascending: false }).limit(100);
  };

  try {
    const { data, error } = await scope.query('risk_events', 'select', () => eventsQuery(true), () => eventsQuery(false));
    if (!noteError('risk_events', error) && Array.isArray(data)) {
      reads.openRiskEvents = data as PersistedRiskEventRow[];
    }
  } catch (err) {
    reads.readErrors.push({ table: 'risk_events', code: null, message: err instanceof Error ? err.message : String(err) });
  }

  return reads;
}

/**
 * Read + evaluate in one call for the API boundary. Paper only; other modes
 * return `PAPER_BOOT_NOT_APPLICABLE` without touching Supabase.
 */
export async function runPaperBootGuard(
  supabase: SupabaseClient,
  opts: { userId: string; mode: ExecutionMode | string; logger: Logger; env?: NodeJS.ProcessEnv },
): Promise<PaperBootGuardVerdict> {
  if (opts.mode !== 'paper') {
    return evaluatePaperBootGuard({
      mode: opts.mode,
      env: opts.env,
      reads: { latestRiskMetrics: null, openRiskEvents: [], readErrors: [], missingTables: [] },
    });
  }
  const reads = await readPaperBootRiskState(supabase, { userId: opts.userId, logger: opts.logger });
  return evaluatePaperBootGuard({ mode: opts.mode, reads, env: opts.env });
}
