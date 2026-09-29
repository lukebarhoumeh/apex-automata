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
 * return (order row not persisted yet — `order:created` is async) or a failed
 * UPDATE stays pending and is retried on the next write for that position
 * (ticker updates every ~1 s while open). A missing `position_id` column
 * (42703 / PGRST204) disables the linker for the process after one warn. Only
 * trades with a `clientOrderId` are linked (paper always has one; a live fill
 * that was not matched to a managed order carries only the exchange id).
 *
 * Pure and Supabase-free (the UPDATE is injected) so it can be unit tested.
 */

import { isMissingColumnError, type PostgrestErrorLike } from '../core/postgrest-errors';

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
}

export interface OrderPositionLinkerOptions {
  /** `UPDATE orders SET position_id = positionId WHERE id IN (orderIds) [AND user_id = …] RETURNING id`. */
  update: (positionId: string, orderIds: string[]) => Promise<{ data: Array<{ id: string }> | null; error: PostgrestErrorLike | null }>;
  logger?: {
    warn: (message: string, meta?: Record<string, unknown>) => void;
    error: (message: string, meta?: Record<string, unknown>) => void;
    debug: (message: string, meta?: Record<string, unknown>) => void;
  };
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

export class OrderPositionLinker {
  private readonly linked = new Map<string, Set<string>>();
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
    const base: OrderPositionLinkResult = { attempted: [], linked: [], missing: [], error: null, disabled: this.columnMissing };
    if (this.columnMissing) return base;

    const known = this.linked.get(positionId) ?? new Set<string>();
    const attempted = pendingOrderLinks(position, known);
    if (attempted.length === 0) {
      if (position.closedAt) this.linked.delete(positionId);
      return base;
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
        this.options.logger?.warn('orders: position_id column missing — fills ↔ positions stay joinable by symbol + time only (migration 20251216000002)', {
          code: error.code,
          message: error.message,
        });
        return { ...base, attempted, disabled: true };
      }
      this.options.logger?.error('orders: position_id link write failed (will retry on the next write for this position)', {
        positionId,
        symbol: position.symbol,
        orderIds: attempted,
        code: error.code,
        message: error.message,
      });
      return { ...base, attempted, error };
    }

    const returned = new Set((data ?? []).map((row) => row.id));
    const linked = attempted.filter((id) => returned.has(id));
    const missing = attempted.filter((id) => !returned.has(id));
    for (const id of linked) known.add(id);
    if (position.closedAt) {
      this.linked.delete(positionId);
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
        this.options.logger?.debug('orders: position_id link deferred — order row not persisted yet', { positionId, orderIds: missing });
      }
    }
    return { ...base, attempted, linked, missing };
  }

  /** Current memory (for diagnostics and tests). */
  public snapshot(): { positions: number; disabled: boolean } {
    return { positions: this.linked.size, disabled: this.columnMissing };
  }
}
