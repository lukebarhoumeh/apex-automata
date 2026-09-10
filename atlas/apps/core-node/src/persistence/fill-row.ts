/**
 * `public.fills` row mapping — TASK_014 defect P2.
 *
 * `fills.order_id` is a FK to `orders.id`, which is the engine's client UUID
 * (`ManagedOrder.id`). Live fills used to be written with the *exchange* order id
 * in `order_id`, so every live fill violated the FK and was dropped; the
 * `external_order_id` column (migration 20251216000001) was never populated.
 *
 * Paper only worked by accident: the simulator echoes the client UUID as its
 * order id, so `fill.order_id === order.id` there.
 *
 * This module is the single place that decides which identifier goes where:
 *   - `order_id`          ← `order.id`          (client UUID, FK target — always)
 *   - `external_order_id` ← exchange order id   (never written into `order_id`)
 *
 * Pure and side-effect free so it can be unit-tested without Supabase.
 * Everything other than the two id columns is carried over unchanged from the
 * previous inline writer (P3 trade-id collisions, mode stamping, etc. are
 * separate TASK_014 defects and intentionally not addressed here).
 *
 * Handoff — broader TASK_014 (P1, P3–P8) is owned separately. Extend here rather
 * than re-inlining the row in server.ts:
 *   - P3  trade_id policy: exchange trade_id (live) / `paper-${sessionId}-${seq}` (paper)
 *   - P5  stamping: add `execution_mode` / `session_id` inputs and columns
 *   - P6  durable writes: `server.ts` can hand the built row to `SupabaseWriter`
 * The P2 invariant (`order_id` = client UUID, exchange id only in `external_order_id`)
 * is pinned by `__tests__/fill-row.test.ts` and must survive those extensions.
 */

/** The engine-side order the fill belongs to (`ManagedOrder` shape, structurally typed). */
export interface FillRowOrderRef {
  /** Client UUID — `orders.id`, the FK target. */
  id: string;
  /** Exchange-assigned order id as recorded by OrderManager, when known. */
  exchangeOrderId?: string | null;
}

/**
 * The fill as delivered on `order:filled`. Accepts both the legacy Coinbase `Fill`
 * message (`order_id`, `trade_id`, `liquidity: 'M'|'T'`, `created_at`) and the
 * exchange-id field carried by adapter `FillEvent`s (`exchangeOrderId`).
 */
export interface FillRowFillRef {
  /** Exchange order id as carried by execution-adapter `FillEvent`s. */
  exchangeOrderId?: string | null;
  /** Exchange order id as carried by legacy Coinbase `Fill` messages. */
  order_id?: string | null;
  trade_id?: string | number | null;
  price: string | number;
  size: string | number;
  fee?: string | number | null;
  liquidity?: string | null;
  created_at?: string | null;
}

/** Column shape written to `public.fills`. */
export interface FillRow {
  user_id: string;
  order_id: string;
  external_order_id: string | null;
  trade_id: string | null;
  price: number;
  quantity: number;
  fee_currency: string;
  fee_amount: number;
  maker: boolean;
  filled_at: string | null | undefined;
}

/** Upsert conflict target used for `fills` writes (unchanged from the inline writer). */
export const FILLS_UPSERT_ON_CONFLICT = 'user_id,trade_id';

/** Error code raised when a fill arrives without a resolvable client order id. */
export const FILL_ORDER_ID_MISSING = 'FILL_ORDER_ID_MISSING';

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Resolve the exchange-side order id for `fills.external_order_id`.
 *
 * Priority: the fill's own adapter-style `exchangeOrderId`, then the fill's legacy
 * `order_id` (what the exchange said this fill belongs to), then the id OrderManager
 * bound to the order. Returns `null` when none is present.
 *
 * @param order Engine-side order (`ManagedOrder`).
 * @param fill Fill payload from `order:filled`.
 */
export function resolveFillExternalOrderId(
  order: Pick<FillRowOrderRef, 'exchangeOrderId'>,
  fill: FillRowFillRef,
): string | null {
  if (nonEmptyString(fill.exchangeOrderId)) return fill.exchangeOrderId;
  if (nonEmptyString(fill.order_id)) return fill.order_id;
  if (nonEmptyString(order.exchangeOrderId)) return order.exchangeOrderId;
  return null;
}

/**
 * Build the `public.fills` row for an `order:filled` event.
 *
 * `order_id` is always the client UUID (`order.id`) so the FK to `orders.id` holds in
 * live as well as paper; the exchange's id is preserved in `external_order_id`.
 *
 * @param input.userId Owning `user_id`.
 * @param input.order Engine-side order the fill belongs to.
 * @param input.fill Fill payload.
 * @throws {Error} `FILL_ORDER_ID_MISSING` when `order.id` is absent — the fill must not be
 *   written with the exchange id in `order_id` (that is the P2 defect), so fail loudly instead.
 */
export function buildFillRow(input: { userId: string; order: FillRowOrderRef; fill: FillRowFillRef }): FillRow {
  const { userId, order, fill } = input;

  if (!nonEmptyString(order?.id)) {
    throw new Error(
      `${FILL_ORDER_ID_MISSING}: cannot persist fill without the client order id (orders.id). ` +
        `Refusing to substitute the exchange order id (${resolveFillExternalOrderId(order ?? {}, fill) ?? 'unknown'}).`,
    );
  }

  return {
    user_id: userId,
    order_id: order.id,
    external_order_id: resolveFillExternalOrderId(order, fill),
    trade_id: fill.trade_id !== undefined ? String(fill.trade_id) : null,
    price: Number.parseFloat(String(fill.price)),
    quantity: Number.parseFloat(String(fill.size)),
    fee_currency: 'USD',
    fee_amount: Number.parseFloat(String(fill.fee)),
    maker: fill.liquidity === 'M',
    filled_at: fill.created_at,
  };
}
