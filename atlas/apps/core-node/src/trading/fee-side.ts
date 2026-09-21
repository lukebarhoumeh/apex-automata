/**
 * Fee-side (maker / taker) attribution vocabulary — card SH-QMAKER-CFM-PAPER-v0
 * blocker 3.
 *
 * Every fill the runtime persists must say which side of the book it took
 * liquidity from, because the fee book is priced per side (maker 9.5 / taker
 * 10 bps on CFM; 25 / 40 on paper spot) and the card's kill bars are written
 * in this vocabulary: "any chase / taker fill → VOID", "unlogged fee_side →
 * VOID". An UNKNOWN side must therefore stay unknown (`null`) — it is never
 * coerced to taker the way the legacy `maker: liquidity === 'M'` boolean did.
 *
 * Pure: no I/O, no logging.
 */

/** Which side of the book the fill took. */
export type FeeSide = 'maker' | 'taker';

/**
 * Where the attribution came from:
 *   - `exchange`  — reported by the venue (REST `liquidity_indicator`, legacy `liquidity`).
 *   - `simulated` — decided by the paper simulator from the order/quote geometry.
 *   - `inferred`  — derived locally (e.g. post-only limit ⇒ maker) with no venue confirmation.
 */
export type FeeSideSource = 'exchange' | 'simulated' | 'inferred';

const FEE_SIDE_SOURCES: ReadonlySet<string> = new Set<FeeSideSource>(['exchange', 'simulated', 'inferred']);

/**
 * Normalise any of the liquidity spellings the runtime sees into a `FeeSide`,
 * or `null` when the value does not unambiguously name a side.
 *
 *   resolveFeeSide('M')      === 'maker'   (legacy Coinbase `Fill.liquidity`)
 *   resolveFeeSide('TAKER')  === 'taker'   (Advanced Trade `liquidity_indicator`)
 *   resolveFeeSide('maker')  === 'maker'   (adapter `FillEvent.liquidity`)
 *   resolveFeeSide('UNKNOWN_LIQUIDITY_INDICATOR') === null
 *   resolveFeeSide(undefined) === null
 */
export function resolveFeeSide(raw: unknown): FeeSide | null {
  if (typeof raw !== 'string') return null;
  switch (raw.trim().toUpperCase()) {
    case 'M':
    case 'MAKER':
      return 'maker';
    case 'T':
    case 'TAKER':
      return 'taker';
    default:
      return null;
  }
}

/** Narrow an arbitrary value to a known `FeeSideSource`, else `null`. */
export function resolveFeeSideSource(raw: unknown): FeeSideSource | null {
  if (typeof raw !== 'string') return null;
  const lower = raw.trim().toLowerCase();
  return FEE_SIDE_SOURCES.has(lower) ? (lower as FeeSideSource) : null;
}

/**
 * Tri-state `fills.maker` column value for a resolved side: `true` maker,
 * `false` taker, `null` unknown (unlogged — VOID for the card).
 */
export function feeSideToMakerFlag(side: FeeSide | null): boolean | null {
  if (side === null) return null;
  return side === 'maker';
}
