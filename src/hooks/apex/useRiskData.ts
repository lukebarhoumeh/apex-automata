import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type {
  ExposureNode,
  KillLadderRow,
  PortfolioRisk,
  RiskData,
  RiskRadarAxis,
  SymbolCap,
} from "@/types/risk";

const API_URL = import.meta.env.VITE_RUNTIME_API_URL || "http://localhost:3001";

async function fetchJsonOrNull<T>(path: string): Promise<T | null> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`);
  } catch {
    throw new Error(`network error: ${path}`);
  }
  // 400 (/api/risk/*) and 503 (/api/pnl) are both "engine not running" signals — treat as no-data.
  if (res.status === 400 || res.status === 503) return null;
  if (res.status === 429) throw new Error(`rate-limited: ${path}`);
  if (res.status >= 500) throw new Error(`server error ${res.status}: ${path}`);
  if (!res.ok) return null;
  return (await res.json()) as T;
}

interface BackendRiskStatus {
  tradingAllowed: boolean;
  killSwitchActive: boolean;
  metrics: {
    currentExposure: number;
    dailyPnL: number;
    dailyLossPercentage: number;
    maxDrawdown: number;
    consecutiveLosses: number;
    openOrders: number;
    lastUpdated: string;
  };
  positions: { open: number; max: number };
}

// Canonical PnL snapshot fields we consume. /api/pnl returns 503 when the engine is stopped,
// in which case we render empty-state rather than fabricating equity.
interface BackendPnL {
  totalEquityUsd: number;
  exposureUsd: number;
  maxDrawdownPct: number; // ALREADY in percent units (e.g., 1.11 means 1.11%)
}

// Canonical /api/status payload (only fields we read here).
// status.risk.maxDrawdownPct is the same number as pnl.maxDrawdownPct, but /api/status is
// always 200 even with the engine stopped, so it gives us a stable zero floor for the UI.
interface BackendStatus {
  killSwitch?: { active: boolean };
  risk?: {
    exposureUsd: number;
    dailyPnLUsd: number;
    maxDrawdownPct: number; // percent units
    killSwitchActive: boolean;
  };
  pnl?: BackendPnL | null;
}

interface BackendBlockedSymbols {
  blockedSymbols: readonly string[];
  count: number;
}

// ============================================================
// Static per-guardrails config (must match atlas/config/guardrails.yaml)
// ============================================================
// These mirror guardrails.yaml and would ideally come from a new endpoint
// like GET /api/config/risk — but for now we hard-code the ceilings so the
// UI can render a correct picture of the live state vs. the thresholds.

const HEAT_CAP_PCT = 3.0;
const DD_CAP_PCT = 15.0;
const CONSEC_CAP = 5;

// Per-symbol max notional from guardrails per_symbol.*.max_notional_usd
const PER_SYMBOL_CAP: Record<string, number> = {
  "BTC-USD": 3_000,
  "ETH-USD": 3_000,
  "SOL-USD": 3_000,
  "AVAX-USD": 3_000,
  "LINK-USD": 3_000,
  "ARB-USD": 3_000,
};

const KILL_LADDER_TEMPLATE: readonly Omit<KillLadderRow, "tripped">[] = [
  { lvl: 1, at: "DD > 3%", action: "Reduce new size 50%" },
  { lvl: 2, at: "DD > 5%", action: "No new entries" },
  { lvl: 3, at: "3 consec losses", action: "Pause strategy" },
  { lvl: 4, at: "DD > 8%", action: "Flatten all positions" },
  { lvl: 5, at: "Venue rejects x5", action: "Cold shutdown + page" },
];

// ============================================================
// Mappers
// ============================================================

function buildPortfolio(
  status: BackendStatus | null,
  pnl: BackendPnL | null,
  riskStatus: BackendRiskStatus | null,
): PortfolioRisk {
  // Equity: read from the canonical PnL snapshot (/api/pnl.totalEquityUsd or /api/status.pnl).
  // When the snapshot is null (engine stopped → /api/pnl 503), keep equity null so the UI
  // renders an empty-state ("--") instead of pretending we still have a hardcoded $10k.
  const pnlSnapshot = pnl ?? status?.pnl ?? null;
  const equity = pnlSnapshot?.totalEquityUsd ?? null;

  // Drawdown: backend already returns percent units in `maxDrawdownPct` (e.g., 1.11 means 1.11%).
  // Use it directly — no "is this a fraction or a percent?" heuristic. /api/status is always
  // 200 so its risk.maxDrawdownPct gives us a stable zero when the engine is stopped.
  const dd = pnlSnapshot?.maxDrawdownPct ?? status?.risk?.maxDrawdownPct ?? 0;

  // Exposure: prefer the live PnL snapshot; fall back to /api/risk/status. Both are USD.
  const exposure =
    pnlSnapshot?.exposureUsd ?? riskStatus?.metrics.currentExposure ?? 0;

  // Heat: only meaningful when we have real equity. Otherwise show 0 (no equity → no heat).
  const heat = equity && equity > 0 ? (exposure / equity) * 100 : 0;

  const consecLosses = riskStatus?.metrics.consecutiveLosses ?? 0;

  return {
    equity,
    exposure,
    heat,
    heatCap: HEAT_CAP_PCT,
    dd,
    ddCap: DD_CAP_PCT,
    var95: 0,
    var99: 0,
    expectedShortfall: 0,
    consecLosses,
    consecCap: CONSEC_CAP,
    netBeta: 0,
  };
}

function buildRadar(
  portfolio: PortfolioRisk,
  blocked: number,
  openPositions: number,
  maxPositions: number,
): RiskRadarAxis[] {
  const concentration = maxPositions > 0 ? (openPositions / maxPositions) * 100 : 0;
  const ddPct = (portfolio.dd / Math.max(portfolio.ddCap, 0.001)) * 100;
  const heatPct = (portfolio.heat / Math.max(portfolio.heatCap, 0.001)) * 100;
  const liquidityPenalty = Math.min(100, blocked * 25);
  const consecPct = (portfolio.consecLosses / Math.max(portfolio.consecCap, 1)) * 100;

  return [
    { k: "Concentration", v: Math.min(100, concentration) },
    { k: "Drawdown", v: Math.min(100, ddPct) },
    { k: "Heat", v: Math.min(100, heatPct) },
    { k: "Losses", v: Math.min(100, consecPct) },
    { k: "Leverage", v: 0 },
    { k: "Liquidity", v: liquidityPenalty },
  ];
}

function buildKillLadder(portfolio: PortfolioRisk, killActive: boolean): KillLadderRow[] {
  const ddPct = portfolio.dd;
  const consec = portfolio.consecLosses;
  return KILL_LADDER_TEMPLATE.map((row) => {
    let tripped = false;
    switch (row.lvl) {
      case 1:
        tripped = ddPct > 3;
        break;
      case 2:
        tripped = ddPct > 5;
        break;
      case 3:
        tripped = consec >= 3;
        break;
      case 4:
        tripped = ddPct > 8;
        break;
      case 5:
        tripped = killActive;
        break;
    }
    return { ...row, tripped };
  });
}

function buildEmptyTree(): ExposureNode {
  return {
    label: "Portfolio",
    value: 0,
    children: [{ label: "No open positions", value: 0 }],
  };
}

function buildSymbolCaps(): SymbolCap[] {
  // With no open-exposure-per-symbol feed, show configured caps at zero use.
  // Once /api/risk/analytics grows a per-symbol breakdown, we'll plug that in.
  return Object.entries(PER_SYMBOL_CAP).map(([s, cap]) => ({
    s,
    used: 0,
    cap,
    pct: 0,
  }));
}

// Minimal placeholder correlation matrix (6x6 identity) — correlation view
// isn't driven by the backend yet. Keep symbolic so the panel renders cleanly.
const CORR_LABELS = ["BTC", "ETH", "SOL", "AVAX", "LINK", "ARB"] as const;
const IDENTITY_CORR: readonly (readonly number[])[] = CORR_LABELS.map((_, i) =>
  CORR_LABELS.map((__, j) => (i === j ? 1 : 0)),
);

// ============================================================
// Hook
// ============================================================

export function useRiskData() {
  return useQuery<RiskData>({
    queryKey: ["apex", "risk-data"],
    queryFn: async () => {
      const [status, pnl, riskStatus, blocked] = await Promise.all([
        fetchJsonOrNull<BackendStatus>("/api/status"),
        fetchJsonOrNull<BackendPnL>("/api/pnl"),
        fetchJsonOrNull<BackendRiskStatus>("/api/risk/status"),
        fetchJsonOrNull<BackendBlockedSymbols>("/api/risk/blocked/symbols"),
      ]);

      const portfolio = buildPortfolio(status, pnl, riskStatus);
      const openPositions = riskStatus?.positions.open ?? 0;
      const maxPositions = riskStatus?.positions.max ?? 4;
      const blockedCount = blocked?.count ?? 0;
      const killSwitchActive =
        status?.killSwitch?.active ||
        status?.risk?.killSwitchActive ||
        riskStatus?.killSwitchActive ||
        false;

      return {
        portfolio,
        symbolCaps: buildSymbolCaps(),
        radar: buildRadar(portfolio, blockedCount, openPositions, maxPositions),
        corr: IDENTITY_CORR,
        corrLabels: [...CORR_LABELS],
        tree: buildEmptyTree(),
        killLadder: buildKillLadder(portfolio, killSwitchActive),
      };
    },
    staleTime: 3_000,
    refetchInterval: 8_000,
    placeholderData: keepPreviousData,
  });
}
