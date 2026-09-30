/**
 * `orders.position_id` linkage (2026-09-29 follow-up to the P3 verification,
 * docs/research/2026-09-28_paper-persistence-verification.md §0).
 *
 * The column exists since migration 20251216000002 (`uuid REFERENCES
 * positions(id) ON DELETE SET NULL`) but was never written, so fills and
 * positions could only be joined by symbol + time (runbook §3 step 1). The
 * tracker knows, per fill, which position it moved (`Position.trades[]`, each
 * carrying the engine-side `clientOrderId` = `orders.id`), so after every
 * CONFIRMED positions write the server links the trades' orders that are not
 * linked yet: `UPDATE orders SET position_id = <position.id> WHERE id IN (…)`.
 *
 * Ordering: the FK requires the positions row to exist, so the caller runs
 * `link` only once the positions write for that snapshot has been written
 * (`PositionWriteOutcome.status === 'written'`) — never before, never after a
 * dropped stale update. The exit order is linked by the close write itself.
 *
 * Bounded and schema-tolerant: an order id is attempted once per position
 * write and remembered once RETURNING confirms it; an id the UPDATE did not
 * return (order row not persisted yet — `order:created` is async) stays
 * pending and is retried on the next write for that position (ticker updates
 * every ~1 s while open). A FAILED UPDATE is retried on a per-position
 * exponential backoff (review finding 5, 2026-09-30): after the n-th
 * consecutive failure the next attempt waits min(1 s·2^(n-1), 5 min) — writes
 * inside that window send nothing — and a success resets it. There is no
 * attempt cap (a short Supabase blip must not drop links forever), and the
 * CLOSE write always attempts regardless of backoff: it is the last write for
 * the position. The first failure logs an error; repeats log at debug, with an
 * error every `ORDER_LINK_ERROR_LOG_EVERY` failures so it never goes silent.
 * A failed close-time UPDATE is terminal (finding 6): the tracker has already
 * forgotten the position, so the linker forgets it too, logs the still-unlinked
 * ids at error and counts them as `failed`. A missing `position_id` column
 * (42703 / PGRST204) disables the linker for the process after one warn. Only
 * trades with a `clientOrderId` are linked (paper always has one; a live fill
 * that was not matched to a managed order carries only the exchange id).
 *
 * Pure (the UPDATE and the clock are injected) so it can be unit tested; the
 * production UPDATE is `createSupabaseOrderLinkUpdate` and the FK-ordering gate
 * is `linkOrdersAfterPositionWrite` (finding 8), both used by api/server.ts.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { isMissingColumnError, type PostgrestErrorLike } from '../core/postgrest-errors';
import type { PositionWriteOutcome } from './position-write-sequencer';

/** First backoff step after a failed link UPDATE (doubles per consecutive failure). */
export const ORDER_LINK_RETRY_BASE_MS = 1_000;
/** Backoff ceiling: a still-failing link is retried at least every 5 min while the position is open. */
export const ORDER_LINK_RETRY_MAX_MS = 5 * 60_000;
/** A repeated link failure logs at debug, except every Nth consecutive failure, which logs at error. */
export const ORDER_LINK_ERROR_LOG_EVERY = 10;

/** Wait before the next attempt after `failures` consecutive failures (1 s, 2 s, 4 s … capped at 5 min). */
export function orderLinkRetryDelayMs(failures: number): number {
  const exponent = Math.min(Math.max(failures - 1, 0), 30);
  return Math.min(ORDER_LINK_RETRY_BASE_MS * 2 ** exponent, ORDER_LINK_RETRY_MAX_MS);
}

/** Subset of a tracker `Position` the linker reads. */
export interface LinkablePosition {
  id: string;
  symbol?: string;
  closedAt?: unknown;
  trades?: ReadonlyArray<{ clientOrderId?: string | null }> | null;
}

export interface OrderPositionLinkResult {
  /** Order ids sent in the UPDATE. */
  attempted: string[];
  /** Order ids RETURNING confirmed (now remembered as linked). */
  linked: string[];
  /** Attempted ids the UPDATE did not return (order row not there yet) — retried next write. */
  missing: string[];
  error: PostgrestErrorLike | null;
  /** True when the `position_id` column is known missing and nothing was attempted. */
  disabled: boolean;
  /** True when an open position's link was skipped because its failure backoff has not elapsed. */
  backedOff: boolean;
}

/** `UPDATE orders SET position_id = positionId WHERE id IN (orderIds) [AND user_id = …] RETURNING id`. */
export type OrderLinkUpdate = (positionId: string, orderIds: string[]) => Promise<{ data: Array<{ id: string }> | null; error: PostgrestErrorLike | null }>;

export interface OrderPositionLinkerOptions {
  update: OrderLinkUpdate;
  /** Clock for the failure backoff (epoch ms); defaults to `Date.now`. */
  now?: () => number;
  logger?: {
    warn: (message: string, meta?: Record<string, unknown>) => void;
    error: (message: string, meta?: Record<string, unknown>) => void;
    debug: (message: string, meta?: Record<string, unknown>) => void;
  };
}

/**
 * The production link UPDATE (review finding 8a): `UPDATE orders SET
 * position_id = positionId WHERE user_id = userId AND id IN (orderIds)
 * RETURNING id`, scoped to the runtime's USER_ID.
 */
export function createSupabaseOrderLinkUpdate(client: Pick<SupabaseClient, 'from'>, userId: string): OrderLinkUpdate {
  return async (positionId, orderIds) => {
    const { data, error } = await client
      .from('orders')
      .update({ position_id: positionId })
      .eq('user_id', userId)
      .in('id', orderIds)
      .select('id');
    return { data, error };
  };
}

/**
 * The FK-ordering gate of the `position:update` handler (review finding 8):
 * link only once the positions write for this snapshot was WRITTEN — never
 * after a dropped stale update, a failed write or no write at all (the row may
 * not exist, and `orders.position_id` REFERENCES it). Returns null when gated.
 */
export async function linkOrdersAfterPositionWrite(
  outcome: Pick<PositionWriteOutcome, 'status'> | null | undefined,
  position: LinkablePosition,
  linker: Pick<OrderPositionLinker, 'link'>,
): Promise<OrderPositionLinkResult | null> {
  if (outcome?.status !== 'written') return null;
  return linker.link(position);
}

/** Distinct `clientOrderId`s on a position's trades that are not in `alreadyLinked`. */
export function pendingOrderLinks(position: LinkablePosition, alreadyLinked: ReadonlySet<string> = new Set()): string[] {
  const out = new Set<string>();
  for (const trade of position.trades ?? []) {
    const id = trade?.clientOrderId;
    if (typeof id === 'string' && id.length > 0 && !alreadyLinked.has(id)) out.add(id);
  }
  return [...out];
}

/**
 * Link counters for `/api/status` `persistence.orderLinks` (round 3, task G).
 * `linked` = order ids RETURNING confirmed since process start; `pending` =
 * ids attempted on a still-open position and not confirmed yet (order row not
 * persisted, or the UPDATE failed) — retried on that position's next write
 * (after the failure backoff when the UPDATE failed);
 * `failed` = ids still unlinked when their position closed (the linker forgets
 * the position, so nothing retries them); `disabled` mirrors `disabled`.
 */
export interface OrderLinkCounts {
  linked: number;
  pending: number;
  failed: number;
  disabled: boolean;
}

export class OrderPositionLinker {
  private readonly linked = new Map<string, Set<string>>();
  /** Attempted-but-unconfirmed ids per OPEN position (diagnostic mirror of what the next write retries). */
  private readonly pending = new Map<string, Set<string>>();
  /** Failure backoff per OPEN position: consecutive failed UPDATEs and the earliest next attempt (epoch ms). */
  private readonly backoff = new Map<string, { failures: number; nextRetryAt: number }>();
  private linkedTotal = 0;
  private failedTotal = 0;
  private columnMissing = false;

  constructor(private readonly options: OrderPositionLinkerOptions) {}

  /** True once the schema reported `orders.position_id` missing (linker inert for the process). */
  public get disabled(): boolean {
    return this.columnMissing;
  }

  /**
   * Link the not-yet-linked orders of `position` to it. Call only after the
   * positions write for this snapshot succeeded. Never throws.
   */
  public async link(position: LinkablePosition): Promise<OrderPositionLinkResult> {
    const positionId = String(position.id);
    const base: OrderPositionLinkResult = { attempted: [], linked: [], missing: [], error: null, disabled: this.columnMissing, backedOff: false };
    if (this.columnMissing) return base;

    const known = this.linked.get(positionId) ?? new Set<string>();
    const attempted = pendingOrderLinks(position, known);
    if (attempted.length === 0) {
      if (position.closedAt) this.forget(positionId);
      return base;
    }

    // The failure backoff applies to OPEN positions only: the close is the
    // last write for the position, so it always attempts.
    const retry = this.backoff.get(positionId);
    if (!position.closedAt && retry && this.now() < retry.nextRetryAt) {
      return { ...base, backedOff: true };
    }

    let data: Array<{ id: string }> | null = null;
    let error: PostgrestErrorLike | null = null;
    try {
      ({ data, error } = await this.options.update(positionId, attempted));
    } catch (thrown) {
      error = { message: thrown instanceof Error ? thrown.message : String(thrown) };
    }

    if (error) {
      if (isMissingColumnError(error, 'position_id')) {
        this.columnMissing = true;
        // Nothing will ever be retried: the counters report `disabled`, not a pending backlog.
        this.pending.clear();
        this.backoff.clear();
        this.options.logger?.warn('orders: position_id column missing — fills ↔ positions stay joinable by symbol + time only (migration 20251216000002)', {
          code: error.code,
          message: error.message,
        });
        return { ...base, attempted, disabled: true };
      }
      if (position.closedAt) {
        // The close is the last write for this position and the tracker has
        // already forgotten it: nothing will retry, so these ids stay unlinked.
        this.forget(positionId);
        this.failedTotal += attempted.length;
        this.options.logger?.error('orders: position closed with orders still unlinked (link write failed)', {
          positionId,
          symbol: position.symbol,
          orderIds: attempted,
          code: error.code,
          message: error.message,
        });
        return { ...base, attempted, error };
      }
      const failures = (retry?.failures ?? 0) + 1;
      const nextRetryInMs = orderLinkRetryDelayMs(failures);
      this.backoff.set(positionId, { failures, nextRetryAt: this.now() + nextRetryInMs });
      this.pending.set(positionId, new Set(attempted));
      const meta = { positionId, symbol: position.symbol, orderIds: attempted, code: error.code, message: error.message, failures, nextRetryInMs };
      const message = 'orders: position_id link write failed (will retry on the next write for this position)';
      if (failures === 1 || failures % ORDER_LINK_ERROR_LOG_EVERY === 0) this.options.logger?.error(message, meta);
      else this.options.logger?.debug(message, meta);
      return { ...base, attempted, error };
    }

    // The UPDATE answered: the failure streak (if any) is over.
    this.backoff.delete(positionId);

    const returned = new Set((data ?? []).map((row) => row.id));
    const linked = attempted.filter((id) => returned.has(id));
    const missing = attempted.filter((id) => !returned.has(id));
    for (const id of linked) known.add(id);
    this.linkedTotal += linked.length;
    if (position.closedAt) {
      this.forget(positionId);
      this.failedTotal += missing.length;
      if (missing.length > 0) {
        this.options.logger?.warn('orders: position closed with orders still unlinked (order rows not persisted at link time)', {
          positionId,
          symbol: position.symbol,
          orderIds: missing,
        });
      }
    } else {
      this.linked.set(positionId, known);
      if (missing.length > 0) {
        this.pending.set(positionId, new Set(missing));
        this.options.logger?.debug('orders: position_id link deferred — order row not persisted yet', { positionId, orderIds: missing });
      } else {
        this.pending.delete(positionId);
      }
    }
    return { ...base, attempted, linked, missing };
  }

  /** Drop every per-position entry (the position closed). */
  private forget(positionId: string): void {
    this.linked.delete(positionId);
    this.pending.delete(positionId);
    this.backoff.delete(positionId);
  }

  private now(): number {
    return this.options.now ? this.options.now() : Date.now();
  }

  /** Current memory (for diagnostics and tests). */
  public snapshot(): { positions: number; disabled: boolean } {
    return { positions: this.linked.size, disabled: this.columnMissing };
  }

  /** Cumulative link counters for `/api/status` `persistence.orderLinks`. */
  public linkCounts(): OrderLinkCounts {
    let pending = 0;
    for (const ids of this.pending.values()) pending += ids.size;
    return { linked: this.linkedTotal, pending, failed: this.failedTotal, disabled: this.columnMissing };
  }
}
