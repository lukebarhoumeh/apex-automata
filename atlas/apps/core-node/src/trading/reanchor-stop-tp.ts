/**
 * Re-anchor signal-time stop/take-profit prices to the actual fill price.
 *
 * Strategies emit absolute `stopLoss` / `takeProfit` anchored to `signal.price`
 * (the candle close at signal generation). The order can then fill at a
 * different price (limit offset, paper-sim slippage, market drift between
 * signal and fill). Without re-anchoring, the same absolute prices yield the
 * wrong distance from the actual entry — destroying R/R, and in extreme
 * cases putting the take-profit on the wrong side of entry (auto-trip).
 *
 * This helper preserves the strategy-intended SIGNED DISTANCE from the
 * intended-entry reference and reapplies it around the actual fill price.
 *
 * No-ops cleanly when the intended-entry reference is missing, so it's safe
 * to call on every fill — only entry orders carry `intendedEntryPrice` in
 * their metadata.
 */
export interface ReanchorInput {
  fillPrice: number;
  intendedEntryPrice?: number;
  stopPrice?: number;
  takeProfit?: number;
}

export interface ReanchorOutput {
  stopPrice?: number;
  takeProfit?: number;
}

export function reanchorStopAndTakeProfit(input: ReanchorInput): ReanchorOutput {
  const { fillPrice, intendedEntryPrice, stopPrice, takeProfit } = input;

  if (
    !Number.isFinite(fillPrice) ||
    fillPrice <= 0 ||
    typeof intendedEntryPrice !== 'number' ||
    !Number.isFinite(intendedEntryPrice) ||
    intendedEntryPrice <= 0
  ) {
    return { stopPrice, takeProfit };
  }

  const reanchor = (price: number | undefined): number | undefined => {
    if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) {
      return price;
    }
    return fillPrice + (price - intendedEntryPrice);
  };

  return {
    stopPrice: reanchor(stopPrice),
    takeProfit: reanchor(takeProfit),
  };
}
