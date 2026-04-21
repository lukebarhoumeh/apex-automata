export interface PortfolioRisk {
  equity: number;
  exposure: number;
  heat: number;
  heatCap: number;
  dd: number;
  ddCap: number;
  var95: number;
  var99: number;
  expectedShortfall: number;
  consecLosses: number;
  consecCap: number;
  netBeta: number;
}

export interface RiskRadarAxis {
  k: string;
  v: number;
}

export interface SymbolCap {
  s: string;
  used: number;
  cap: number;
  pct: number;
}

export interface ExposureNode {
  label: string;
  value: number;
  children?: readonly ExposureNode[];
}

export interface KillLadderRow {
  lvl: number;
  at: string;
  action: string;
  tripped: boolean;
}

export interface RiskData {
  portfolio: PortfolioRisk;
  symbolCaps: readonly SymbolCap[];
  radar: readonly RiskRadarAxis[];
  corr: readonly (readonly number[])[];
  corrLabels: readonly string[];
  tree: ExposureNode;
  killLadder: readonly KillLadderRow[];
}
