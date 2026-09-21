export interface PortfolioRisk {
  // null when backend has no live equity to report (engine stopped / pnl snapshot unavailable).
  // Consumers must render an empty-state ("--") rather than a hardcoded fallback so we never lie about live equity.
  equity: number | null;
  exposure: number;
  /**
   * exposure / equity × 100 (shared definition: lib/portfolio-heat). null when
   * equity is unknown — render "—", never a 0 that reads as "flat".
   */
  heat: number | null;
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
  /** Open notional (USD) from the engine's positions; null when no per-symbol source is available. */
  used: number | null;
  /** guardrails per_symbol max_notional_usd; null when the symbol has no configured cap. */
  cap: number | null;
  /** used / cap × 100; null when either side is unknown. */
  pct: number | null;
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
