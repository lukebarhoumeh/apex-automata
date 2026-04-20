export interface KpiTile {
  key: string;
  label: string;
  value: string;
  delta: string;
  tone: "up" | "down" | "accent" | "neutral";
  sparkline?: readonly number[];
}
