/**
 * Per-position write ordering + close durability for `positions` rows
 * (P3-A, 2026-09-28).
 *
 * Two defects in the paper fill → `positions` path this module closes:
 *
 * 1. **A stale in-flight update could reopen a closed row.** `PositionTracker`
 *    emits a 1 s-debounced `position:updated` on ticks; `syncPositionToSupabase`
 *    snapshots the row (`closed_at: null`, `qty_open: size`) synchronously and
 *    fires an HTTP upsert on `id`. When the closing fill lands inside that
 *    request's RTT, `position:closed` fires a SECOND upsert for the same id.
 *    `cancelPendingPositionUpdate` only drops a not-yet-emitted timer — it
 *    cannot recall a request already on the wire — and two upserts on one id
 *    are unordered, so the stale update could complete last and REOPEN the
 *    row (→ phantom hydrate on the next session). Fix: writes are serialized
 *    per position id (a write for X waits for the previous write for X), and
 *    once a close has been issued for X every later non-close write for X is
 *    dropped (debug log) — the close carries the complete final row.
 *
 * 2. **The close write was single-shot.** Any upsert error (network, timeout,
 *    5xx, 08006 …) was logged once and forgotten; by then `PositionTracker`
 *    had already deleted the Position from memory, so nothing ever re-asserted
 *    `closed_at` and the row stayed open forever, re-hydrated as a phantom by
 *    every later session. Fix: a CLOSE write is retried with a bounded backoff
 *    schedule (`DEFAULT_CLOSE_RETRY_DELAYS_MS`: 1 initial + 4 retries), each
 *    attempt logged; a non-transient (schema / key / RLS) error is retried at
 *    most once; after the last failure an error names the position id, symbol,
 *    session_id and the remediation (`CLOSE_WRITE_REMEDIATION`). Never loops.
 *
 * Mode-agnostic persistence hygiene: the same writer serves paper and live
 * rows, and this module only orders/retries row writes that were already being
 * issued — it never sees an order, an exchange adapter or a risk gate.
 *
 * Pure and Supabase-free (the write and the sleep are injected) so ordering and
 * the retry schedule can be unit tested with in-memory doubles.
 */

import type { PostgrestErrorLike } from '../core/postgrest-errors';

export type PositionWriteKind = 'update' | 'close';

/** Result of one attempt of the injected write. */
export interface PositionWriteAttempt {
  error: PostgrestErrorLike | null;
  /** Extra diagnostic fields to carry on every log line about this write (conflict target, hint, …). */
  detail?: Record<string, unknown>;
}

export interface PositionWriteRequest {
  /** `positions.id` — the primary key every write for one position shares. */
  positionId: string;
  symbol: string;
  /** Session the row is stamped with (for the failure log); `null` when unstamped. */
  sessionId: string | null;
  /** `close` when the snapshot carries `closed_at`; everything else is `update`. */
  kind: PositionWriteKind;
  /** The actual row write (e.g. `upsertPositionRow`). May resolve `{ error }` or throw. */
  write: () => Promise<PositionWriteAttempt>;
}

export type PositionWriteStatus = 'written' | 'failed' | 'dropped';

export interface PositionWriteOutcome {
  status: PositionWriteStatus;
  kind: PositionWriteKind;
  /** Attempts actually made (0 when dropped). */
  attempts: number;
  error: PostgrestErrorLike | null;
}

/** Backoff between close-write attempts: 1 initial + 4 retries, ~12.25 s worst case. */
export const DEFAULT_CLOSE_RETRY_DELAYS_MS: ReadonlyArray<number> = [250, 1000, 3000, 8000];

/** Attempts a NON-transient (schema / key / RLS) error is allowed: the first plus one retry. */
export const NON_TRANSIENT_MAX_ATTEMPTS = 2;

/** Operator-facing remediation carried by the final close-failure log line. */
export const CLOSE_WRITE_REMEDIATION = 'row left open; reconcile manually or on next start';

/** Closed ids remembered for the stale-write drop (a Set of UUIDs; oldest evicted past this). */
export const DEFAULT_MAX_REMEMBERED_CLOSES = 10_000;

/**
 * Postgres / PostgREST codes that mean "the write did not reach the table for
 * an infrastructure reason" — the same row will succeed once the path is back.
 * Mirrors `RETRYABLE_ERROR_CODES` in `supabase-writer.ts` plus PostgREST's
 * own connection / pool errors.
 */
const TRANSIENT_ERROR_CODES = new Set([
  '08000', // connection_exception
  '08001', // sqlclient_unable_to_establish_sqlconnection
  '08003', // connection_does_not_exist
  '08004', // sqlserver_rejected_establishment_of_sqlconnection
  '08006', // connection_failure
  '08007', // transaction_resolution_unknown
  '57P01', // admin_shutdown
  '57P02', // crash_shutdown
  '57P03', // cannot_connect_now
  '40001', // serialization_failure
  '40P01', // deadlock_detected
  '53000', // insufficient_resources
  '53100', // disk_full
  '53200', // out_of_memory
  '53300', // too_many_connections
  'PGRST000', // PostgREST: could not connect to the database
  'PGRST001', // PostgREST: could not query the database for the schema cache (connection)
  'PGRST002', // PostgREST: could not query the database for the schema cache (retrying)
  'PGRST003', // PostgREST: timed out waiting for a pool connection
]);

const TRANSIENT_MESSAGE = /timeout|timed out|network|connection|fetch failed|ECONNREFUSED|ECONNRESET|EAI_AGAIN|socket hang up|service unavailable|bad gateway|gateway time-?out/i;

/**
 * True when `error` is worth retrying on the same row: a connection / pool /
 * timeout failure or an HTTP 5xx relayed as the code. Schema and key errors
 * (42P10, 23505, PGRST204, 42703, 42501, 22P02 …) return false — retrying them
 * cannot change the answer.
 */
export function isTransientPositionWriteError(error: PostgrestErrorLike | null | undefined): boolean {
  if (!error) return false;
  const code = String(error.code ?? '');
  if (TRANSIENT_ERROR_CODES.has(code)) return true;
  if (/^5\d\d$/.test(code)) return true;
  return TRANSIENT_MESSAGE.test(error.message ?? '');
}

function errorFromThrown(thrown: unknown): PostgrestErrorLike {
  const code = (thrown as { code?: unknown } | null)?.code;
  return {
    code: typeof code === 'string' ? code : undefined,
    message: thrown instanceof Error ? thrown.message : String(thrown),
  };
}

/** Minimal logger surface this module needs (`Logger` from core/logger satisfies it). */
export interface PositionWriteSequencerLogger {
  debug: (message: string, meta?: unknown) => void;
  info: (message: string, meta?: unknown) => void;
  warn: (message: string, meta?: unknown) => void;
  error: (message: string, meta?: unknown) => void;
}

export interface PositionWriteSequencerOptions {
  logger?: PositionWriteSequencerLogger;
  /** Backoff schedule for close writes; its length is the retry count. Default `DEFAULT_CLOSE_RETRY_DELAYS_MS`. */
  closeRetryDelaysMs?: ReadonlyArray<number>;
  /** Injected for fake timers in tests. Default `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
  /** Bound on the closed-id memory. Default `DEFAULT_MAX_REMEMBERED_CLOSES`. */
  maxRememberedCloses?: number;
}

export interface PositionWriteSequencerSnapshot {
  /** Position ids with a write in flight or queued. */
  pendingIds: number;
  /** Position ids for which a close write has been issued (bounded memory). */
  rememberedCloses: number;
}

/**
 * Orders `positions` writes per position id and makes the close write durable.
 *
 * - `enqueue` returns once the write has been written, dropped, or has
 *   exhausted its attempts — it never rejects (failures are logged and
 *   surfaced in the outcome), so callers can `await` it without a guard.
 * - Different position ids do not wait on each other.
 * - A close write for X is retried per `closeRetryDelaysMs`; a non-close write
 *   is single-shot, exactly as before this module existed.
 */
export class PositionWriteSequencer {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly closedIds = new Set<string>();
  private readonly logger?: PositionWriteSequencerLogger;
  private readonly closeRetryDelaysMs: ReadonlyArray<number>;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxRememberedCloses: number;

  constructor(options: PositionWriteSequencerOptions = {}) {
    this.logger = options.logger;
    this.closeRetryDelaysMs = options.closeRetryDelaysMs ?? DEFAULT_CLOSE_RETRY_DELAYS_MS;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.maxRememberedCloses = options.maxRememberedCloses ?? DEFAULT_MAX_REMEMBERED_CLOSES;
  }

  /**
   * Queue one write behind every earlier write for the same position id.
   *
   * @param request The write; `request.write` must capture its row snapshot
   *   BEFORE this call (the sequencer may run it much later).
   */
  public enqueue(request: PositionWriteRequest): Promise<PositionWriteOutcome> {
    const { positionId, kind } = request;

    if (kind !== 'close' && this.closedIds.has(positionId)) {
      return Promise.resolve(this.drop(request, 'enqueued after the close'));
    }
    if (kind === 'close') this.rememberClose(positionId);

    const previous = this.tails.get(positionId) ?? Promise.resolve();
    const run = previous.then(() => this.execute(request));
    const settled: Promise<void> = run.then(
      () => undefined,
      // `execute` never rejects; this keeps the chain alive if it ever did.
      () => undefined,
    );
    this.tails.set(positionId, settled);
    void settled.then(() => {
      if (this.tails.get(positionId) === settled) this.tails.delete(positionId);
    });
    return run;
  }

  /** True once a close write has been issued for this position id. */
  public hasCloseIssued(positionId: string): boolean {
    return this.closedIds.has(positionId);
  }

  /** Resolves when every write queued so far for `positionId` has settled. */
  public async idle(positionId: string): Promise<void> {
    await this.tails.get(positionId);
  }

  /** Current state (for `/api/status`-style diagnostics and tests). */
  public snapshot(): PositionWriteSequencerSnapshot {
    return { pendingIds: this.tails.size, rememberedCloses: this.closedIds.size };
  }

  private rememberClose(positionId: string): void {
    if (this.closedIds.has(positionId)) return;
    this.closedIds.add(positionId);
    while (this.closedIds.size > this.maxRememberedCloses) {
      const oldest = this.closedIds.values().next().value;
      if (oldest === undefined) break;
      this.closedIds.delete(oldest);
    }
  }

  private drop(request: PositionWriteRequest, why: string): PositionWriteOutcome {
    this.logger?.debug(`positions: dropping stale ${request.kind} write — a close has already been issued for this position (${why})`, {
      positionId: request.positionId,
      symbol: request.symbol,
      sessionId: request.sessionId,
    });
    return { status: 'dropped', kind: request.kind, attempts: 0, error: null };
  }

  private async execute(request: PositionWriteRequest): Promise<PositionWriteOutcome> {
    const { positionId, symbol, sessionId, kind } = request;

    // A non-close write queued BEFORE the close but reaching the head after it
    // was issued is equally stale: the close carries the complete final row.
    if (kind !== 'close' && this.closedIds.has(positionId)) {
      return this.drop(request, 'a close was issued while it was queued');
    }

    const scheduleAttempts = kind === 'close' ? this.closeRetryDelaysMs.length + 1 : 1;
    let attempts = 0;
    let lastError: PostgrestErrorLike | null = null;
    let lastDetail: Record<string, unknown> | undefined;

    for (;;) {
      attempts++;
      let result: PositionWriteAttempt;
      let thrown = false;
      try {
        result = await request.write();
      } catch (error) {
        thrown = true;
        result = { error: errorFromThrown(error) };
      }

      if (!result.error) {
        if (attempts > 1) {
          this.logger?.info('positions: close write succeeded after retry', { positionId, symbol, sessionId, attempts, ...(result.detail ?? {}) });
        }
        return { status: 'written', kind, attempts, error: null };
      }

      lastError = result.error;
      lastDetail = result.detail;
      const transient = thrown || isTransientPositionWriteError(result.error);
      const maxAttempts = transient ? scheduleAttempts : Math.min(scheduleAttempts, NON_TRANSIENT_MAX_ATTEMPTS);
      if (attempts >= maxAttempts) break;

      const delayMs = this.closeRetryDelaysMs[attempts - 1];
      this.logger?.warn('positions: close write failed; retrying', {
        positionId,
        symbol,
        sessionId,
        attempt: attempts,
        maxAttempts,
        nextDelayMs: delayMs,
        transient,
        code: result.error.code,
        message: result.error.message,
        ...(result.detail ?? {}),
      });
      await this.sleep(delayMs);
    }

    if (kind === 'close') {
      this.logger?.error(`positions: close write failed after ${attempts} attempt(s) — ${CLOSE_WRITE_REMEDIATION}`, {
        positionId,
        symbol,
        sessionId,
        attempts,
        code: lastError?.code,
        message: lastError?.message,
        remediation: CLOSE_WRITE_REMEDIATION,
        ...(lastDetail ?? {}),
      });
    } else {
      // Same message as before this module existed (log consumers grep for it).
      this.logger?.error('Failed to sync position to Supabase:', {
        error: lastError?.message,
        code: lastError?.code,
        positionId,
        symbol,
        sessionId,
        ...(lastDetail ?? {}),
      });
    }
    return { status: 'failed', kind, attempts, error: lastError };
  }
}
