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
 *   - P3  trade_id policy: DONE (2026-09-22) — exchange trade_id (live) /
 *         `paper-${sessionId}-${seq}` (paper). See `resolveFillTradeId` for why:
 *         the simulator's per-process counter collided on `fills_user_trade_key`
 *         UNIQUE (user_id, trade_id) and every new paper session's fill #k
 *         upserted OVER the previous session's fill #k (soak audit 2026-09-22:
 *         hkub8j 18 filled orders / 5 fill rows, 3z950m 3 / 0).
 *   - P5  stamping: DONE — optional `session` input adds `session_id` / `execution_mode`
 *         (columns from migration 20260911170000; schema-tolerant fallback lives in
 *         persistence/session-stamp.ts)
 *   - P6  durable writes: `server.ts` can hand the built row to `SupabaseWriter`
 * The P2 invariant (`order_id` = client UUID, exchange id only in `external_order_id`)
 * is pinned by `__tests__/fill-row.test.ts` and must survive those extensions.
 *
 * Fee-side attribution (card SH-QMAKER-CFM-PAPER-v0 blocker 3, 2026-09-21):
 *   - `maker` is TRI-STATE: `true` maker, `false` taker, `null` unknown. The old
 *     `liquidity === 'M'` boolean silently wrote every unknown side as taker.
 *   - `fee_side` / `fee_side_source` (migration 20260921180000, STAGED) carry the
 *     explicit desk vocabulary; `server.ts` writes them schema-tolerantly via
 *     persistence/optional-columns.ts until the migration is applied.
 *   - An unresolvable side is persisted as `null` — "unlogged fee_side" — and is
 *     VOID for the card by construction, never disguised as a taker fill.
 */

import { SessionStamp, SessionStampColumns, stampSessionColumns } from './session-stamp';
import {
  FeeSide,
  FeeSideSource,
  feeSideToMakerFlag,
  resolveFeeSide,
  resolveFeeSideSource,
} from '../trading/fee-side';

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
  /** Legacy liquidity flag (`'M' | 'T'`) or adapter spelling (`'maker' | 'taker'`). */
  liquidity?: string | null;
  /** Explicit fee side when the producer already resolved it (paper simulator). Wins over `liquidity`. */
  fee_side?: string | null;
  /** Provenance of the attribution (`exchange` | `simulated` | `inferred`). */
  fee_side_source?: string | null;
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
  /** Tri-state: `true` maker, `false` taker, `null` unknown / unlogged. */
  maker: boolean | null;
  /** Explicit fee side (migration 20260921180000); `null` when unresolvable. */
  fee_side: FeeSide | null;
  /** Where `fee_side` came from; `null` when `fee_side` is null. */
  fee_side_source: FeeSideSource | null;
  filled_at: string | null | undefined;
}

/** `FillRow` plus the TASK_014 P5 session stamp (`session_id`, `execution_mode`). */
export type StampedFillRow = FillRow & SessionStampColumns;

/** Upsert conflict target used for `fills` writes (unchanged from the inline writer). */
export const FILLS_UPSERT_ON_CONFLICT = 'user_id,trade_id';

/**
 * Columns added by migration 20260921180000 (`fills_fee_side`). Written
 * schema-tolerantly: when PostgREST reports them missing the writer strips
 * them and retries with the legacy shape (see persistence/optional-columns.ts).
 */
export const FILL_FEE_SIDE_COLUMNS = ['fee_side', 'fee_side_source'] as const;

/** Error code raised when a fill arrives without a resolvable client order id. */
export const FILL_ORDER_ID_MISSING = 'FILL_ORDER_ID_MISSING';

/** Prefix of every namespaced paper `trade_id` (`paper-<sessionId>-<seq>`). */
export const PAPER_TRADE_ID_PREFIX = 'paper';

/** `fee_side_source` value the paper simulator stamps on every fill it emits. */
const SIMULATED_FEE_SIDE_SOURCE = 'simulated';

/**
 * Resolve the `fills.trade_id` value for a fill — TASK_014 P3.
 *
 * `fills` carries `fills_user_trade_key UNIQUE (user_id, trade_id)` and the
 * writer upserts on that pair (`FILLS_UPSERT_ON_CONFLICT`). Live fills are safe:
 * the exchange trade id is unique per account. Paper fills are NOT: the
 * simulator's `trade_id` is `++fillSequence`, a per-process integer that
 * restarts at 1 on every engine start (and on `reset()`), so fill #k of a new
 * paper session upserts over fill #k of the previous one — the old row's
 * `order_id` / `session_id` are rewritten and the earlier session loses the
 * fill (2026-09-22 audit: `9q7egp` fills 1–11 replaced `hkub8j` fills 1–11).
 *
 * Policy:
 *   - live (or unknown mode without a simulator marker): exchange id, unchanged
 *   - paper: `paper-<sessionId>-<seq>` — unique across sessions and processes
 *   - paper with no session stamp (must not happen after the stamp is captured
 *     at event time in server.ts, kept as a defensive floor): `paper-<order.id>-<seq>`
 *     — the client order UUID is unique per order, `seq` per fill
 *   - an already-namespaced string id is passed through untouched
 *
 * A fill counts as paper when the session runs in `paper` mode OR the fill
 * itself carries the simulator's `fee_side_source: 'simulated'` marker.
 *
 * @param input.order Engine-side order (client UUID is the fallback namespace).
 * @param input.fill Fill payload from `order:filled`.
 * @param input.session Active session stamp, if known.
 * @returns The `trade_id` column value, or `null` when the fill carries none.
 */
export function resolveFillTradeId(input: {
  order: Pick<FillRowOrderRef, 'id'>;
  fill: Pick<FillRowFillRef, 'trade_id' | 'fee_side_source'>;
  session?: SessionStamp | null;
}): string | null {
  const { order, fill, session } = input;
  if (fill.trade_id === undefined || fill.trade_id === null) return null;

  const raw = String(fill.trade_id);
  if (raw.startsWith(`${PAPER_TRADE_ID_PREFIX}-`)) return raw;

  const isPaper = session?.executionMode === 'paper' || fill.fee_side_source === SIMULATED_FEE_SIDE_SOURCE;
  if (!isPaper) return raw;

  const namespace = nonEmptyString(session?.sessionId) ? session!.sessionId : order.id;
  return `${PAPER_TRADE_ID_PREFIX}-${namespace}-${raw}`;
}

/**
 * Resolve the fee side + provenance for a fill.
 *
 * Priority: an explicit `fill.fee_side` (paper simulator, future adapters)
 * wins over the legacy `liquidity` flag. Provenance comes from
 * `fill.fee_side_source` when the producer stamped it; a legacy `liquidity`
 * value without provenance is treated as exchange-reported (that is what the
 * Coinbase `Fill` message carries). An unresolvable side yields
 * `{ feeSide: null, source: null }` — never a default of taker.
 *
 * @param fill Fill payload from `order:filled`.
 */
export function resolveFillFeeSide(fill: Pick<FillRowFillRef, 'liquidity' | 'fee_side' | 'fee_side_source'>): {
  feeSide: FeeSide | null;
  source: FeeSideSource | null;
} {
  const explicit = resolveFeeSide(fill.fee_side);
  const feeSide = explicit ?? resolveFeeSide(fill.liquidity);
  if (feeSide === null) return { feeSide: null, source: null };
  const source = resolveFeeSideSource(fill.fee_side_source) ?? 'exchange';
  return { feeSide, source };
}

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
 * @param input.session Optional active-session stamp (TASK_014 P5). When given, the row
 *   also carries `session_id` / `execution_mode`; omit it to build the legacy shape.
 *   It is also the namespace for paper `trade_id`s (P3, `resolveFillTradeId`) — pass
 *   the stamp captured at `order:filled` time so a shutdown flatten's fills keep it.
 * @throws {Error} `FILL_ORDER_ID_MISSING` when `order.id` is absent — the fill must not be
 *   written with the exchange id in `order_id` (that is the P2 defect), so fail loudly instead.
 */
export function buildFillRow(input: {
  userId: string;
  order: FillRowOrderRef;
  fill: FillRowFillRef;
  session: SessionStamp;
}): StampedFillRow;
export function buildFillRow(input: {
  userId: string;
  order: FillRowOrderRef;
  fill: FillRowFillRef;
  session?: SessionStamp | null;
}): FillRow;
export function buildFillRow(input: {
  userId: string;
  order: FillRowOrderRef;
  fill: FillRowFillRef;
  session?: SessionStamp | null;
}): FillRow | StampedFillRow {
  const { userId, order, fill, session } = input;

  if (!nonEmptyString(order?.id)) {
    throw new Error(
      `${FILL_ORDER_ID_MISSING}: cannot persist fill without the client order id (orders.id). ` +
        `Refusing to substitute the exchange order id (${resolveFillExternalOrderId(order ?? {}, fill) ?? 'unknown'}).`,
    );
  }

  const { feeSide, source } = resolveFillFeeSide(fill);

  const row: FillRow = {
    user_id: userId,
    order_id: order.id,
    external_order_id: resolveFillExternalOrderId(order, fill),
    trade_id: resolveFillTradeId({ order, fill, session }),
    price: Number.parseFloat(String(fill.price)),
    quantity: Number.parseFloat(String(fill.size)),
    fee_currency: 'USD',
    fee_amount: Number.parseFloat(String(fill.fee)),
    maker: feeSideToMakerFlag(feeSide),
    fee_side: feeSide,
    fee_side_source: source,
    filled_at: fill.created_at,
  };

  return stampSessionColumns(row as unknown as Record<string, unknown>, session) as unknown as FillRow | StampedFillRow;
}
