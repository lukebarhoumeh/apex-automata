/**
 * Portfolio heat — the ONE definition shared by the dashboard hero and the
 * Risk desk: open notional exposure as a percentage of live equity.
 *
 * Both surfaces read the same PnL snapshot fields (`exposureUsd`,
 * `totalEquityUsd` from `/api/status.pnl` / `/api/pnl`), so they can never
 * disagree (the hero used to hard-code `heat: 0` while Risk showed ~47%).
 */

/**
 * `exposure / equity × 100`, or `null` when equity is unknown or non-positive.
 * `null` renders as "—"; it is never coerced to 0, which would read as
 * "no risk on" while positions are live.
 */
export function computePortfolioHeatPct(
  exposureUsd: number | null | undefined,
  equityUsd: number | null | undefined,
): number | null {
  if (typeof equityUsd !== "number" || !Number.isFinite(equityUsd) || equityUsd <= 0) return null;
  if (typeof exposureUsd !== "number" || !Number.isFinite(exposureUsd)) return null;
  return (Math.abs(exposureUsd) / equityUsd) * 100;
}

/** `12.3%` or "—" for an unknown heat. */
export function formatHeatPct(heat: number | null, digits = 1): string {
  return heat === null ? "—" : `${heat.toFixed(digits)}%`;
}
