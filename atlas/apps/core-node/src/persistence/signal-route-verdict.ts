/**
 * Persist the router's verdict onto an already-inserted `signals` row.
 *
 * Write ordering is fixed by the schema: `orders.signal_id` is a foreign key
 * to `signals.id`, and the engine's `order:created` handler upserts the order
 * row concurrently with routing. The canonical signal row therefore has to be
 * INSERTed before the router runs (as `syncSignalToSupabase` has always done)
 * and the verdict — `allowed`, `routed_exchange`, `reason` — is applied
 * afterwards as an UPDATE keyed on the signal's UUID.
 *
 * Schema tolerance: `signals.routed_exchange` landed with migration
 * `20260305015203_add_exchange_id.sql`. Should a deployment lack it, the
 * update is retried once without that column so `allowed` / `reason` still
 * reflect the verdict instead of the whole patch being lost.
 *
 * Pure and Supabase-free (the actual update is injected) so it is unit
 * testable without a database.
 */

import { isMissingColumnError, PostgrestErrorLike } from '../core/postgrest-errors';
import { signalRouteColumns, type SignalRouteColumns, type SignalRouteVerdict } from '../exchanges/signal-route';

export const ROUTED_EXCHANGE_COLUMN = 'routed_exchange' as const;

/** Column-level patch the verdict applies (same keys as `SignalRouteColumns`). */
export type SignalRouteVerdictPatch = SignalRouteColumns;

export interface SignalRouteVerdictWriteResult {
  error: PostgrestErrorLike | null;
  /** True when an update was attempted (a usable signal id was available). */
  attempted: boolean;
  /** True when the first attempt hit a missing `routed_exchange` column and the legacy shape was retried. */
  fellBack: boolean;
  /** The patch that was ultimately sent (after any fallback), or `null` when nothing was attempted. */
  patch: Record<string, unknown> | null;
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * True when `id` is the UUID the canonical insert used as `signals.id`, i.e.
 * the row can be addressed for the verdict update. Mirrors the
 * `maybeId` check in `syncSignalToSupabase`.
 */
export function isAddressableSignalId(id: unknown): id is string {
  return typeof id === 'string' && UUID_V4.test(id);
}

/**
 * Build the `signals` UPDATE patch for a verdict.
 * @param verdict Router verdict.
 * @param includeRoutedExchange Set false to build the legacy (pre-migration) shape.
 */
export function buildSignalRouteVerdictPatch(
  verdict: SignalRouteVerdict,
  includeRoutedExchange = true,
): Record<string, unknown> {
  const columns = signalRouteColumns(verdict);
  const patch: Record<string, unknown> = { allowed: columns.allowed };
  // A placed signal keeps the strategy's own reason text (inserted with the row).
  if (columns.reason !== null) patch.reason = columns.reason;
  if (includeRoutedExchange) patch[ROUTED_EXCHANGE_COLUMN] = columns.routed_exchange;
  return patch;
}

/**
 * Apply a router verdict to the persisted `signals` row.
 *
 * @param params.signalId The signal's id; must be the UUID used on insert, otherwise nothing is written.
 * @param params.verdict Router verdict to persist.
 * @param params.update The actual Supabase UPDATE for one patch shape, already scoped to the row.
 * @param params.logger Optional; a schema fallback is logged at warn, an unaddressable id at warn.
 */
export async function writeSignalRouteVerdict(params: {
  signalId: unknown;
  verdict: SignalRouteVerdict;
  update: (patch: Record<string, unknown>) => Promise<{ error: PostgrestErrorLike | null }>;
  logger?: { warn: (message: string, meta?: Record<string, unknown>) => void };
}): Promise<SignalRouteVerdictWriteResult> {
  const { signalId, verdict, update, logger } = params;

  if (!isAddressableSignalId(signalId)) {
    logger?.warn('signals: routing verdict not persisted — signal id is not the row UUID', {
      signalId: String(signalId),
      outcome: verdict.outcome,
    });
    return { error: null, attempted: false, fellBack: false, patch: null };
  }

  const stamped = buildSignalRouteVerdictPatch(verdict, true);
  const first = await update(stamped);
  if (!first.error) {
    return { error: null, attempted: true, fellBack: false, patch: stamped };
  }

  if (!isMissingColumnError(first.error, ROUTED_EXCHANGE_COLUMN)) {
    return { error: first.error, attempted: true, fellBack: false, patch: stamped };
  }

  logger?.warn(`signals: ${ROUTED_EXCHANGE_COLUMN} column missing — persisting verdict without it (apply migration 20260305015203)`, {
    code: first.error.code,
    message: first.error.message,
  });
  const legacy = buildSignalRouteVerdictPatch(verdict, false);
  const { error } = await update(legacy);
  return { error, attempted: true, fellBack: true, patch: legacy };
}
