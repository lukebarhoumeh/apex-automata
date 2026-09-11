/**
 * Compute the raw volume-weighted entry fill price for a position.
 *
 * `position.averagePrice` from PositionTracker is the cost-BASIS — it has the
 * entry fee rolled in (added for LONG, subtracted for SHORT) so end-to-end
 * P&L math nets out correctly without explicit fee adjustments at close.
 *
 * That cost-basis interpretation is correct internally, but it makes the
 * `positions.entry_price` column on the dashboard look like the trade
 * filled at a wildly different price than it actually did. For Coinbase
 * Advanced makerFee=0.0025 (25 bps), a SHORT cost-basis sits 25 bps BELOW
 * the actual fill, which makes naive `(stop - entry) / (entry - tp)` R/R
 * computations look broken — and in extreme cases makes a correctly-placed
 * take-profit look like it's on the WRONG side of entry.
 *
 * This helper recovers the actual fill VWAP from `position.trades` so the
 * `entry_price` column means what every trader expects: the average price
 * at which my entry orders filled. Cost-basis stays available internally
 * via `position.averagePrice` for P&L math.
 *
 * Limitation: for a position that flipped sides mid-life (e.g. a LONG that
 * was over-sold into a SHORT in a single trade), trades from BOTH the
 * original close and the new open share the same `side` and would be
 * averaged together. That edge case is uncommon in this engine and yields
 * a result no worse than today's cost-basis behavior; falls back to
 * `position.averagePrice` if the entry-side trade list is empty.
 */

interface TradeLike {
  side?: 'buy' | 'sell';
  size?: number;
  price?: number;
}

interface PositionLike {
  side?: 'long' | 'short' | 'flat';
  averagePrice?: number;
  trades?: TradeLike[];
  metadata?: Record<string, unknown>;
}

/** Metadata key PositionTracker.hydrateOpenPositions stamps with the persisted `entry_price`. */
export const HYDRATED_ENTRY_PRICE_KEY = 'hydratedEntryPrice';

export function computeRawEntryFillPrice(position: PositionLike): number {
  const fallback = Number.isFinite(position.averagePrice) ? (position.averagePrice as number) : 0;

  const entrySide: 'buy' | 'sell' | null =
    position.side === 'short' ? 'sell' : position.side === 'long' ? 'buy' : null;
  if (!entrySide) return fallback;

  const trades = position.trades ?? [];
  let totalNotional = 0;
  let totalSize = 0;

  for (const t of trades) {
    if (t.side !== entrySide) continue;
    const tSize = Number(t.size);
    const tPrice = Number(t.price);
    if (Number.isFinite(tSize) && Number.isFinite(tPrice) && tSize > 0 && tPrice > 0) {
      totalNotional += tSize * tPrice;
      totalSize += tSize;
    }
  }

  return totalSize > 0 ? totalNotional / totalSize : fallback;
}

/**
 * Entry price to persist on `positions.entry_price`, or `0` when none is known.
 *
 * Order: raw entry-fill VWAP (`computeRawEntryFillPrice`) → the `entry_price` the
 * position was hydrated with (`metadata.hydratedEntryPrice`) → `averagePrice`.
 *
 * The hydrated fallback matters on close: PositionTracker zeroes `averagePrice`
 * when a position goes flat, and a position hydrated from Supabase has no entry
 * fill in `trades`, so without it the close write was skipped and the row stayed
 * `closed_at IS NULL` forever — re-hydrated as a phantom open position by every
 * later session (found by the paper-UI honesty smoke test, PR #64).
 */
export function resolvePersistedEntryPrice(position: PositionLike): number {
  const raw = computeRawEntryFillPrice(position);
  if (Number.isFinite(raw) && raw > 0) return raw;

  const hydrated = Number(position.metadata?.[HYDRATED_ENTRY_PRICE_KEY]);
  if (Number.isFinite(hydrated) && hydrated > 0) return hydrated;

  const avg = Number(position.averagePrice);
  return Number.isFinite(avg) && avg > 0 ? avg : 0;
}
