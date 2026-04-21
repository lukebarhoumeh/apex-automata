export interface BacktestConfig {
  strategy: string;
  symbols: readonly string[];
  from: string;
  to: string;
  initialCapital: number;
  riskPerTrade: number;
  metaThreshold: number;
  slippageBps: number;
  feeBps: number;
}

export interface BacktestResults {
  finalEquity: number;
  totalReturn: number;
  cagr: number;
  sharpe: number;
  sortino: number;
  maxDD: number;
  winRate: number;
  trades: number;
  avgR: number;
  profitFactor: number;
  avgHoldHrs: number;
  turnover: number;
}

export interface BacktestEquityPoint {
  i: number;
  v: number;
  peak: number;
  dd: number;
}

export interface MonthlyReturn {
  m: string;
  r: number;
}

export interface BacktestTrade {
  id: string;
  sym: string;
  side: "LONG" | "SHORT";
  entry: number;
  exit: number;
  r: number;
  pnl: number;
  dur: string;
  date: string;
}

export interface RDistBucket {
  bucket: string;
  n: number;
}

export interface BacktestData {
  preset: string;
  config: BacktestConfig;
  results: BacktestResults;
  equity: readonly BacktestEquityPoint[];
  monthlyReturns: readonly MonthlyReturn[];
  trades: readonly BacktestTrade[];
  rDist: readonly RDistBucket[];
}
