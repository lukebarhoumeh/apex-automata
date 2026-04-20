export type RegimeLabel = "TRENDING" | "CHOPPY" | "RISK-OFF" | "BULL" | "BEAR" | "RANGING";
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
  timeframe: string;
  meters: readonly RegimeMeter[];
}
