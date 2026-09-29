/**
 * Schema-tolerant writes for the `strategy_name` ENUM — the enum-value form
 * of the missing-column fallback (persistence/optional-columns.ts,
 * persistence/session-stamp.ts).
 *
 * The runtime is deployed independently of Supabase migrations (staged in the
 * repo, applied by the Database Engineer with Trading Master go). Since
 * `donchian_daily_s3` joined `STRATEGY_NAME_ENUM_VALUES` (migration
 * 20260929120000_add_donchian_daily_s3_to_strategy_name_enum.sql), a runtime
 * that normalises the id onto itself would fail every orders / positions /
 * signals write for it on a database that has not applied the migration yet:
 *
 *     22P02  invalid input value for enum strategy_name: "donchian_daily_s3"
 *
 * — and for `positions` that includes the CLOSE write, which would leave the
 * row open forever (finding 3 class). So the value is written optimistically
 * and, when the enum rejects it, the same row is retried ONCE with the neutral
 * `system` tag (`STRATEGY_NAME_FALLBACK`), the miss is warned ONCE per process
 * (per value) and remembered so later writes go straight to `system` without
 * the failing round-trip. The memory expires (`reprobeMs`, default 5 min like
 * the session-stamp memory) so applying the migration under a running process
 * is picked up without a restart; the first accepted write is logged.
 *
 * Contract:
 *   1. a row whose `strategy` is already `system` (or has no `strategy` key)
 *      is written once, never retried;
 *   2. only a 22P02 that names the `strategy_name` enum AND the value just
 *      sent triggers the fallback — a bad uuid (also 22P02), another enum,
 *      another value, RLS, etc. are returned untouched, never masked;
 *   3. the input row is never mutated.
 *
 * This wrapper sits INNERMOST (directly around the Supabase call) so it
 * applies to whichever row shape the session-stamp / optional-column wrappers
 * decided on. Pure (the write is injected) so it is unit-testable without a DB.
 */

import type { PostgrestErrorLike } from '../core/postgrest-errors';
import { STRATEGY_NAME_FALLBACK } from './strategy-name';

/** Migration that adds the newest enum value; named in the warn log. */
export const STRATEGY_ENUM_MIGRATION_HINT = '20260929120000_add_donchian_daily_s3_to_strategy_name_enum.sql';

/** Default time a value stays remembered as "not in the enum" before re-probing. */
export const DEFAULT_STRATEGY_ENUM_REPROBE_MS = 5 * 60_000;

const ENUM_VALUE_ERROR = /invalid input value for enum (?:public\.)?strategy_name/i;

/**
 * True when `error` is Postgres rejecting a label for `public.strategy_name`
 * (SQLSTATE 22P02 `invalid_text_representation`, message
 * `invalid input value for enum strategy_name: "<value>"`). The code alone is
 * not enough — a malformed uuid is 22P02 too — so the message must name the
 * enum, and, when `value` is given, that exact quoted value.
 */
export function isStrategyEnumValueError(
  error: PostgrestErrorLike | null | undefined,
  value?: string,
): boolean {
  if (!error) return false;
  const message = error.message ?? '';
  if (!ENUM_VALUE_ERROR.test(message)) return false;
  if (value === undefined) return true;
  return message.includes(`"${value}"`);
}

export type StrategyEnumValueState = 'unknown' | 'present' | 'missing';

/**
 * Process-lifetime memory of which `strategy_name` labels the deployed enum
 * accepts, per value.
 *
 * `unknown` and `present` both mean "send the value"; `missing` means "write
 * `system` straight away" until `reprobeMs` has elapsed since the miss was
 * recorded, after which one optimistic attempt is made again.
 */
export class StrategyEnumValueSupport {
  private readonly state = new Map<string, { state: StrategyEnumValueState; missingSince: number | null }>();
  private readonly reprobeMs: number;
  private readonly now: () => number;

  constructor(options: { reprobeMs?: number; now?: () => number } = {}) {
    this.reprobeMs = options.reprobeMs ?? DEFAULT_STRATEGY_ENUM_REPROBE_MS;
    this.now = options.now ?? (() => Date.now());
  }

  /** Whether the next write should carry `value` (vs. the `system` fallback). */
  public shouldSend(value: string): boolean {
    const entry = this.state.get(value);
    if (!entry || entry.state !== 'missing') return true;
    if (entry.missingSince !== null && this.now() - entry.missingSince >= this.reprobeMs) {
      // Re-probe window: try the real value once more.
      return true;
    }
    return false;
  }

  /** Record that the enum rejected `value`. */
  public markMissing(value: string): void {
    this.state.set(value, { state: 'missing', missingSince: this.now() });
  }

  /** Record that a write carrying `value` succeeded. */
  public markPresent(value: string): void {
    this.state.set(value, { state: 'present', missingSince: null });
  }

  /** Current knowledge for one value (diagnostics and tests). */
  public getState(value: string): StrategyEnumValueState {
    return this.state.get(value)?.state ?? 'unknown';
  }

  /** Snapshot of every value this instance has learned about. */
  public snapshot(): Record<string, StrategyEnumValueState> {
    const out: Record<string, StrategyEnumValueState> = {};
    for (const [value, entry] of this.state) out[value] = entry.state;
    return out;
  }
}

export interface StrategyEnumWriteResult {
  error: PostgrestErrorLike | null;
  /** The `strategy` value the final write carried. */
  strategy: string;
  /** True when the row was written with `system` because the enum lacks its value. */
  fellBack: boolean;
}

/**
 * Persist `row`, falling back to `strategy = system` when the deployed
 * `strategy_name` enum does not have the row's value yet.
 *
 * @param params.table Table name, for the log line.
 * @param params.row Full row; `strategy` (if present) is the value to protect.
 * @param params.support Shared per-value presence memory.
 * @param params.write The Supabase call for one row shape.
 * @param params.logger Optional; the first miss per value is warned, the first accepted re-probe is logged at info.
 * @param params.migrationHint Migration id named in the warn log.
 */
export async function writeWithStrategyEnumFallback<T extends Record<string, unknown>>(params: {
  table: string;
  row: T;
  support: StrategyEnumValueSupport;
  write: (row: Record<string, unknown>) => Promise<{ error: PostgrestErrorLike | null }>;
  logger?: {
    warn: (message: string, meta?: Record<string, unknown>) => void;
    info?: (message: string, meta?: Record<string, unknown>) => void;
  };
  migrationHint?: string;
}): Promise<StrategyEnumWriteResult> {
  const { table, row, support, write, logger } = params;
  const migrationHint = params.migrationHint ?? STRATEGY_ENUM_MIGRATION_HINT;
  const strategy = typeof row.strategy === 'string' ? row.strategy : STRATEGY_NAME_FALLBACK;

  if (strategy === STRATEGY_NAME_FALLBACK) {
    const { error } = await write(row);
    return { error, strategy, fellBack: false };
  }

  if (!support.shouldSend(strategy)) {
    const { error } = await write({ ...row, strategy: STRATEGY_NAME_FALLBACK });
    return { error, strategy: STRATEGY_NAME_FALLBACK, fellBack: true };
  }

  const wasMissing = support.getState(strategy) === 'missing';
  const first = await write(row);
  if (!first.error) {
    support.markPresent(strategy);
    if (wasMissing) {
      logger?.info?.(`${table}: strategy_name enum now accepts '${strategy}' — writing it from now on`, {
        table,
        strategy,
      });
    }
    return { error: null, strategy, fellBack: false };
  }
  if (!isStrategyEnumValueError(first.error, strategy)) {
    return { error: first.error, strategy, fellBack: false };
  }

  support.markMissing(strategy);
  if (!wasMissing) {
    logger?.warn(
      `${table}: strategy_name enum lacks '${strategy}' — writing '${STRATEGY_NAME_FALLBACK}' until migration ${migrationHint} is applied`,
      {
        table,
        strategy,
        fallback: STRATEGY_NAME_FALLBACK,
        code: first.error.code,
        message: first.error.message,
        migration: migrationHint,
      },
    );
  }

  const { error } = await write({ ...row, strategy: STRATEGY_NAME_FALLBACK });
  return { error, strategy: STRATEGY_NAME_FALLBACK, fellBack: true };
}
