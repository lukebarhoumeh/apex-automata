export type EquityRange = "1D" | "1W" | "1M" | "ALL";

export interface EquityPoint {
  /** Index (x-axis ordinal) or ms timestamp — series is plotted along t. */
  t: number;
  v: number;
}
