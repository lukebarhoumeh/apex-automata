/**
 * Primary regime word — the desk vocabulary `/api/status.regime` uses
 * (`trend` | `chop`). Finer detector states (ranging, weak_trend, …) go in
 * `MarketRegime.subtitle`; the primary word never says "Ranging" while the
 * status chip says chop.
 */
export type RegimeLabel = "Trend" | "Chop" | "—";
export type RegimeMeterTone = "up" | "down" | "warn" | "info" | "default";

export interface RegimeMeter {
  key: string;
  label: string;
  value: number;
  cap: number;
  display: string;
  tone: RegimeMeterTone;
}

export interface MarketRegime {
  label: RegimeLabel | string;
  /** Detector detail under the desk word, e.g. "ranging conditions"; null when none. */
  subtitle: string | null;
  /** Raw detector regime (`ranging`, `strong_trend`, …) for tooltips; null when unknown. */
  detectorRegime: string | null;
  timeframe: string;
  meters: readonly RegimeMeter[];
}
