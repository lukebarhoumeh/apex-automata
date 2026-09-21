/**
 * Paper Execution Terminal — FE honesty (zero demo numbers).
 *
 * A  No hard-coded demo numbers: Risk exposure-tree TOTAL is the runtime
 *    exposure only (no +$86,162), PnL snapshots are never fabricated from a
 *    $50,000 anchor (missing → null → "—").
 * B  Open positions are session-scoped via GET /api/positions (engine opens,
 *    hydrated flagged); empty without a session.
 * C  Strategy cards: signals emitted (sessionStats, #72) / closed (session) /
 *    open (live, hydrated included) are three distinct counts with desk copy;
 *    closed-only P&L is labelled; hydrated longs never read as "flat".
 * D  Every rate is "—" at zero closes (never 0% / 0.00R / 0/0).
 * +  Heat is one SoT (exposure / equity) for hero and Risk; regime primary
 *    word is "Chop" (never "Ranging" while status says chop); equity curve
 *    marks to market with the session snapshot.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import {
  buildDashboardKpis,
  buildEquityPoints,
  deskRegime,
  mapEnginePosition,
  mapSessionOpenPositions,
  mapSessionStats,
  mapStrategyCards,
  markToMarketEquity,
} from "@/hooks/apex/useDashboardData";
import { mapStrategyConfigs } from "@/hooks/apex/useSignalsData";
import { buildExposureTree, buildPortfolio } from "@/hooks/apex/useRiskData";
import { normalizeSnapshot, snapshotFromStatus } from "@/hooks/usePnLSnapshot";
import { computePortfolioHeatPct, formatHeatPct } from "@/lib/portfolio-heat";
import { markStatusLabel, openPositionsSubtitle, resolvePositionMark } from "@/lib/position-pnl";
import {
  blotterApiUrl,
  buildSessionBlotterOrFilter,
  fetchSessionOpenPositions,
  type EngineOpenPosition,
} from "@/lib/session-blotter-fetch";
import {
  formatExpectancyR,
  formatWinLoss,
  formatWinRate,
  heroSessionSentence,
  resolveStrategySessionCounts,
  strategyCardFooter,
} from "@/lib/strategy-session-counts";
import { HeroStatePanel } from "@/components/apex/dashboard/HeroStatePanel";
import { PositionsTable } from "@/components/apex/dashboard/PositionsTable";
import { RegimeCard } from "@/components/apex/dashboard/RegimeCard";
import { StrategyCards } from "@/components/apex/dashboard/StrategyCards";
import { ActivePositionsStrip } from "@/components/apex/orders/ActivePositionsStrip";
import { RiskHero } from "@/components/apex/risk/RiskHero";
import { StrategyConfigCard } from "@/components/apex/signals/StrategyConfigCard";
import type {
  BackendRuntimeStatus,
  BackendStrategy,
  BackendStrategyPolicy,
  BackendStrategySessionStats,
} from "@/services/apexDashboardApi";
import type { Position } from "@/types/positions";
import type { SessionStats } from "@/types/session";

vi.mock("@/components/apex/shell/useSessionUptime", () => ({ useSessionUptime: () => "00:10:00" }));

// ------------------------------------------------------------------
// Fixtures
// ------------------------------------------------------------------

const SCOPE_ACTIVE = {
  sessionId: "sess_1789137459103_bnd3mn",
  sessionStartedAt: Date.UTC(2026, 8, 21, 18, 0, 0),
  mode: "paper" as const,
};
const SCOPE_NONE = { sessionId: null, sessionStartedAt: null, mode: null };

const POLICY: BackendStrategyPolicy = {
  source: "atlas/config/guardrails.yaml",
  disabledStrategies: ["vwap_mr", "breakout"],
  perSymbolDisabledStrategies: {},
  strategies: [
    { id: "trend_follow", name: "Trend Follow", description: "EMA", category: "trend", disabledByGuardrails: false },
    { id: "momentum", name: "Momentum", description: "RSI/MACD", category: "momentum", disabledByGuardrails: false },
    { id: "breakout", name: "Breakout", description: "Donchian", category: "trend", disabledByGuardrails: true },
    { id: "vwap_mr", name: "VWAP MR", description: "MR", category: "mean-reversion", disabledByGuardrails: true },
  ],
};

const sessionStats = (o: Partial<BackendStrategySessionStats> = {}): BackendStrategySessionStats => ({
  strategyId: "trend_follow",
  name: "Trend Follow",
  enabled: true,
  closedTrades: 0,
  openTrades: 0,
  hydratedOpenCount: 0,
  wins: 0,
  losses: 0,
  breakeven: 0,
  winRate: null,
  realizedPnlUsd: 0,
  pnlToday: 0,
  closedTradesToday: 0,
  avgTradeUsd: null,
  feesUsd: 0,
  lastTradeAt: null,
  signalsGenerated: null,
  ...o,
});

/** Trend Follow: plugin lifetime counter says 41, this SESSION emitted 8 (#72). */
const TF: BackendStrategy = {
  id: "trend_follow",
  name: "Trend Follow",
  description: "EMA crossover",
  category: "trend",
  enabled: true,
  stats: { signalsGenerated: 41 },
  sessionStats: sessionStats({ signalsGenerated: 8, openTrades: 0, hydratedOpenCount: 3 }),
};

const enginePos = (o: Partial<EngineOpenPosition> = {}): EngineOpenPosition => ({
  id: "p1",
  symbol: "ETH-USD",
  strategy: "trend_follow",
  side: "long",
  size: 0.5,
  averagePrice: 3_000,
  marketPrice: 3_050,
  unrealizedPnL: 25,
  realizedPnL: 0,
  stopPrice: 2_900,
  takeProfit: 3_300,
  openTime: Date.UTC(2026, 8, 20, 12, 0, 0),
  hydratedFromPriorSession: true,
  ...o,
});

/** Three hydrated longs, no session-opened positions — the "looks flat" case. */
const THREE_HYDRATED: EngineOpenPosition[] = [
  enginePos({ id: "p1", symbol: "ETH-USD", unrealizedPnL: 25 }),
  enginePos({ id: "p2", symbol: "BTC-USD", averagePrice: 60_000, marketPrice: 60_500, size: 0.1, unrealizedPnL: 50 }),
  enginePos({ id: "p3", symbol: "SOL-USD", averagePrice: 150, marketPrice: 148, size: 10, unrealizedPnL: -20 }),
];

const status = (o: Partial<BackendRuntimeStatus> = {}): BackendRuntimeStatus => ({
  engineRunning: true,
  mode: "paper",
  sessionId: SCOPE_ACTIVE.sessionId,
  sessionStartedAt: SCOPE_ACTIVE.sessionStartedAt,
  activeSymbols: ["BTC-USD", "ETH-USD", "SOL-USD"],
  pnl: {
    sessionStartEquityUsd: 10_000,
    realizedPnlUsd: 0,
    unrealizedPnlUsd: 55,
    totalEquityUsd: 10_000,
    dailyPnlUsd: 0,
    dailyPnlR: 0,
    openPositionsCount: 3,
    exposureUsd: 4_700,
  },
  ...o,
});

const zeroCloseSession = (): SessionStats =>
  mapSessionStats(
    { totalPnl: 0, totalTrades: 0, winningTrades: 0, losingTrades: 0, winRate: 0, expectancy: 0, startTime: "x" } as never,
    status(),
  );

const REGIME_CHOP = {
  label: "Chop",
  subtitle: "ranging conditions",
  detectorRegime: "ranging",
  timeframe: "4h",
  meters: [],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

// ------------------------------------------------------------------
// A — zero-tolerance demo numbers
// ------------------------------------------------------------------

describe("A — no hard-coded demo numbers in the Risk / PnL paths", () => {
  it("source of the Risk and PnL paths contains no 86162 / 50000 literals", () => {
    for (const file of ["src/pages/Risk.tsx", "src/hooks/apex/useRiskData.ts", "src/hooks/usePnLSnapshot.ts"]) {
      const src = readFileSync(file, "utf8");
      expect(src, file).not.toMatch(/86[_,]?162/);
      expect(src, file).not.toMatch(/\b50[_,]?000\b/);
    }
  });

  it("exposure tree TOTAL is the runtime exposure only", () => {
    expect(buildExposureTree(4_700).value).toBe(4_700);
    expect(buildExposureTree(0)).toEqual({
      label: "Portfolio",
      value: 0,
      children: [{ label: "No open positions", value: 0 }],
    });
    expect(buildExposureTree(Number.NaN).value).toBe(0);
  });

  it("PnL snapshot is never fabricated: status without .pnl → null, payload without equity → null", () => {
    // The old fallback built { totalEquityUsd: 50_000 + dailyPnl } from status.risk.
    const fabricatedBefore = snapshotFromStatus({
      engineRunning: true,
      mode: "paper",
      risk: { exposureUsd: 4_700, dailyPnLUsd: 12, maxDrawdownPct: 0, killSwitchActive: false },
      pnl: null,
    });
    expect(fabricatedBefore).toBeNull();
    expect(normalizeSnapshot({ dailyPnlUsd: 12, exposureUsd: 4_700 })).toBeNull();
    expect(normalizeSnapshot(null)).toBeNull();

    const real = snapshotFromStatus({ pnl: status().pnl });
    expect(real?.totalEquityUsd).toBe(10_000);
    expect(real?.exposureUsd).toBe(4_700);
    expect(normalizeSnapshot({ total_equity_usd: "9950.5" })?.totalEquityUsd).toBe(9_950.5);
  });
});

// ------------------------------------------------------------------
// Heat — one SoT for hero and Risk
// ------------------------------------------------------------------

describe("heat — exposure / equity from the PnL snapshot, identical on hero and Risk", () => {
  it("is 47% for $4,700 on $10,000 and null (—) without equity — never a constant 0", () => {
    expect(computePortfolioHeatPct(4_700, 10_000)).toBe(47);
    expect(computePortfolioHeatPct(4_700, null)).toBeNull();
    expect(computePortfolioHeatPct(4_700, 0)).toBeNull();
    expect(formatHeatPct(null)).toBe("—");
    expect(formatHeatPct(47)).toBe("47.0%");
  });

  it("hero session stats and Risk portfolio derive the same heat from the same status snapshot", () => {
    const hero = mapSessionStats(null, status());
    const risk = buildPortfolio(status() as never, null, null);
    expect(hero.heat).toBe(47);
    expect(risk.heat).toBe(47);
    expect(hero.exposureUsd).toBe(4_700);
    expect(risk.exposure).toBe(4_700);

    const stopped = mapSessionStats(null, status({ engineRunning: false, pnl: null }));
    expect(stopped.heat).toBeNull();
    expect(buildPortfolio(status({ pnl: null }) as never, null, null).heat).toBeNull();
  });

  it("Risk hero renders — for heat without equity instead of 0.00%", () => {
    const portfolio = buildPortfolio(status({ pnl: null }) as never, null, null);
    const { getByTestId } = render(<RiskHero portfolio={portfolio} killLadder={[]} />);
    expect(getByTestId("risk-hero-heat").textContent).toBe("—");
  });
});

// ------------------------------------------------------------------
// B — positions are session-scoped
// ------------------------------------------------------------------

describe("B — open positions come from GET /api/positions for the active session", () => {
  it("requests session_id + execution_mode + status=open and scopes the Supabase fallback on opened_at", () => {
    vi.stubEnv("VITE_RUNTIME_API_URL", "http://runtime.test");
    const url = new URL(blotterApiUrl("positions", SCOPE_ACTIVE, 50, { status: "open" }));
    expect(url.pathname).toBe("/api/positions");
    expect(url.searchParams.get("session_id")).toBe(SCOPE_ACTIVE.sessionId);
    expect(url.searchParams.get("execution_mode")).toBe("paper");
    expect(url.searchParams.get("status")).toBe("open");
    expect(buildSessionBlotterOrFilter("positions", SCOPE_ACTIVE)).toBe(
      `session_id.eq.${SCOPE_ACTIVE.sessionId},and(session_id.is.null,opened_at.gte.2026-09-21T18:00:00.000Z)`,
    );
    vi.unstubAllEnvs();
  });

  it("returns nothing and never fetches without an active session", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const result = await fetchSessionOpenPositions(SCOPE_NONE);
    expect(result).toEqual({ engineOpenPositions: null, rows: [], source: "none" });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mapSessionOpenPositions(result)).toEqual([]);
  });

  it("reads engineOpenPositions from the API (engine truth) and flags hydrated ones", async () => {
    vi.stubEnv("VITE_RUNTIME_API_URL", "http://runtime.test");
    const fetchSpy = vi.fn(async (input: string) => {
      expect(input).toContain("/api/positions?");
      return new Response(
        JSON.stringify({
          positions: [{ id: "row-stale", symbol: "ETH-USD", side: "long", qty_open: 1, closed_at: null }],
          count: 1,
          engineOpenPositions: THREE_HYDRATED,
          scope: { filter: "session_id" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchSpy);

    const result = await fetchSessionOpenPositions(SCOPE_ACTIVE);
    expect(result.source).toBe("api");
    expect(result.engineOpenPositions).toHaveLength(3);

    // Engine truth wins over table rows: 3 open, all hydrated, none valued at entry.
    const positions = mapSessionOpenPositions(result);
    expect(positions.map((p) => p.sym)).toEqual(["ETH-USD", "BTC-USD", "SOL-USD"]);
    expect(positions.every((p) => p.hydratedFromPriorSession)).toBe(true);
    expect(positions[0]).toMatchObject({ side: "LONG", qty: 0.5, entry: 3_000, mark: 3_050, strat: "trend_follow", opened: "12:00:00" });
    vi.unstubAllEnvs();
  });

  it("maps engine positions defensively (short side, no mark, flat filtered out)", () => {
    const short = mapEnginePosition(enginePos({ side: "short", marketPrice: 0, hydratedFromPriorSession: false, openTime: null }));
    expect(short).toMatchObject({ side: "SHORT", mark: undefined, hydratedFromPriorSession: false, opened: "—" });
    const flat = mapSessionOpenPositions({
      engineOpenPositions: [enginePos({ side: "flat", size: 0 }), enginePos({ id: "p9" })],
      rows: [],
      source: "api",
    });
    expect(flat.map((p) => p.id)).toEqual(["p9"]);
  });

  it("dashboard table and Orders strip surface hydrated opens and fall back to the engine mark", () => {
    const positions = mapSessionOpenPositions({ engineOpenPositions: THREE_HYDRATED, rows: [], source: "api" });
    expect(openPositionsSubtitle(positions)).toBe("3 active · 3 hydrated from prior session");
    expect(resolvePositionMark(positions[0], {})).toEqual({ mark: 3_050, origin: "engine" });
    expect(resolvePositionMark(positions[0], { "ETH-USD": { price: 3_100, ts: 1, source: "ticker" } })).toEqual({ mark: 3_100, origin: "ws" });
    expect(markStatusLabel(positions, {})).toBe("marks 3/3 · 3 engine");

    const table = render(<PositionsTable positions={positions} />);
    expect(table.getByText("3 active · 3 hydrated from prior session")).toBeInTheDocument();
    expect(table.getAllByTestId(/position-hydrated-/)).toHaveLength(3);
    // Engine mark → real P&L for ETH-USD: (3050 - 3000) × 0.5 = +$25.00, not "—".
    expect(table.getByText("+$25.00")).toBeInTheDocument();
    table.unmount();

    const strip = render(<ActivePositionsStrip positions={positions} />);
    expect(strip.getByTestId("active-positions-hydrated").textContent).toBe("3 HYDRATED");
    expect(strip.getByText("3 OPEN")).toBeInTheDocument();
  });
});

// ------------------------------------------------------------------
// C — strategy cards: three distinct counts, desk copy
// ------------------------------------------------------------------

describe("C — signals emitted / closed (session) / open (live) are distinct counts", () => {
  it("prefers sessionStats.signalsGenerated (#72) over the plugin lifetime counter", () => {
    const withSession = resolveStrategySessionCounts("trend_follow", TF, undefined, null);
    expect(withSession.signals).toBe(8);
    const legacy = resolveStrategySessionCounts("trend_follow", { stats: { signalsGenerated: 41 } }, undefined, null);
    expect(legacy.signals).toBe(41);
    expect(resolveStrategySessionCounts("trend_follow", null, undefined, null).signals).toBeNull();
  });

  it("open (live) counts engine positions incl. hydrated; falls back to openTrades + hydratedOpenCount", () => {
    const fromPositions = resolveStrategySessionCounts("trend_follow", TF, undefined, THREE_HYDRATED);
    expect(fromPositions).toMatchObject({ closed: 0, open: 3, hydratedOpen: 3, pnlOpen: 55, winRate: null });

    const fromStats = resolveStrategySessionCounts("trend_follow", TF, undefined, null);
    expect(fromStats).toMatchObject({ open: 3, hydratedOpen: 3, pnlOpen: null });

    const otherStrategy = resolveStrategySessionCounts("momentum", { sessionStats: sessionStats({ strategyId: "momentum" }) }, undefined, THREE_HYDRATED);
    expect(otherStrategy).toMatchObject({ open: 0, hydratedOpen: 0 });
  });

  it("closed-only P&L and win rate come from sessionStats when present, ledger otherwise", () => {
    const stats = sessionStats({ closedTrades: 2, wins: 1, losses: 1, winRate: 0.5, realizedPnlUsd: 7.5 });
    expect(resolveStrategySessionCounts("trend_follow", { sessionStats: stats }, undefined, null)).toMatchObject({
      closed: 2,
      pnlClosed: 7.5,
      winRate: 0.5,
    });
    const ledger = { trades: 3, wins: 2, losses: 1, pnl: 9, winRate: 2 / 3 };
    expect(resolveStrategySessionCounts("trend_follow", { stats: {} }, ledger, null)).toMatchObject({ closed: 3, pnlClosed: 9, winRate: 2 / 3 });
  });

  it("desk copy: footer and hero sentence never say 'routed to trades' and never read flat with hydrated opens", () => {
    expect(strategyCardFooter({ signals: 8, closed: 0, open: 3, hydratedOpen: 3 })).toBe("8 signals emitted · 0 closed · 3 open (3 hydrated)");
    expect(strategyCardFooter({ signals: 1, closed: 2, open: 0, hydratedOpen: 0 })).toBe("1 signal emitted · 2 closed · 0 open");
    expect(strategyCardFooter({ signals: null, closed: 0, open: null, hydratedOpen: null })).toBe("— signals emitted · 0 closed · — open");

    expect(heroSessionSentence(0, 3)).toBe("0 closed this session · 3 open live");
    expect(heroSessionSentence(0, 3, 3)).toBe("0 closed this session · 3 open live (3 carried from prior session)");
    expect(heroSessionSentence(0, 0)).toBe("No closed trades this session · no open positions");
    expect(heroSessionSentence(2, 1)).toBe("2 closed this session · 1 open live");
    expect(heroSessionSentence(2, null)).toBe("2 closed this session · open positions unknown");
  });

  it("renders the card with labelled closed-only P&L, open P&L, and the three counts", () => {
    const cards = mapStrategyCards([TF], POLICY, [], THREE_HYDRATED);
    const tf = cards.find((c) => c.id === "trend_follow")!;
    expect(tf).toMatchObject({ signals: 8, closed: 0, open: 3, hydratedOpen: 3, pnlSession: 0, pnlOpen: 55, winRate: null });

    const { getByTestId, container } = render(
      <MemoryRouter>
        <StrategyCards strategies={cards} />
      </MemoryRouter>,
    );
    expect(container.textContent).toContain("P&L · closed (session)");
    expect(getByTestId("strategy-card-trend_follow-pnl").textContent).toBe("+$0.00");
    expect(getByTestId("strategy-card-trend_follow-pnl-open").textContent).toBe("open P&L +$55.00 · engine mark");
    expect(getByTestId("strategy-card-trend_follow-signals-emitted").textContent).toBe("8");
    expect(getByTestId("strategy-card-trend_follow-closed").textContent).toBe("0");
    expect(getByTestId("strategy-card-trend_follow-open").textContent).toBe("3(3 hydrated)");
    expect(getByTestId("strategy-card-trend_follow-win").textContent).toBe("—");
    expect(getByTestId("strategy-card-trend_follow-signals").textContent).toBe("8 signals emitted · 0 closed · 3 open (3 hydrated)");
    expect(container.textContent).not.toMatch(/routed to trades/i);
    // Killed by guardrails keeps the honest footer, no fake zeros.
    expect(getByTestId("strategy-card-breakout-signals").textContent).toBe("never registered — emits no signals");
    expect(getByTestId("strategy-card-breakout-open").textContent).toBe("—");
  });

  it("Signals page config card uses the same counts and labels", () => {
    const cfg = mapStrategyConfigs([TF], POLICY, [], THREE_HYDRATED).find((c) => c.id === "trend_follow")!;
    expect(cfg.stats).toMatchObject({ signals: 8, closed: 0, open: 3, hydratedOpen: 3, winRate: null });
    const { getByTestId, container } = render(<StrategyConfigCard strat={cfg} />);
    expect(container.textContent).toContain("SIGNALS EMITTED");
    expect(container.textContent).toContain("CLOSED (SESSION)");
    expect(container.textContent).toContain("OPEN (LIVE)");
    expect(getByTestId("strategy-config-trend_follow-signals").textContent).toBe("8");
    expect(getByTestId("strategy-config-trend_follow-closed").textContent).toBe("0");
    expect(getByTestId("strategy-config-trend_follow-open").textContent).toBe("3(3 hydrated)");
    expect(getByTestId("strategy-config-trend_follow-win").textContent).toBe("—");
  });
});

// ------------------------------------------------------------------
// D — rates are "—" at zero closes
// ------------------------------------------------------------------

describe("D — win rate / expectancy / W-L are — at zero closes, never 0%", () => {
  it("formatters", () => {
    expect(formatWinRate(null, 0)).toBe("—");
    expect(formatWinRate(0, 0)).toBe("—");
    expect(formatWinRate(0.5, 2)).toBe("50%");
    expect(formatWinRate(2 / 3, 3, 1)).toBe("66.7%");
    expect(formatExpectancyR(0, 0)).toBe("—");
    expect(formatExpectancyR(0.42, 3)).toBe("+0.42R");
    expect(formatExpectancyR(-0.1, 3)).toBe("-0.10R");
    expect(formatWinLoss(0, 0, 0)).toBe("—");
    expect(formatWinLoss(2, 1, 3)).toBe("2/1");
  });

  it("session stats carry null rates at zero closes and real ones after the first close", () => {
    const zero = zeroCloseSession();
    expect(zero.trades).toBe(0);
    expect(zero.winRate).toBeNull();
    expect(zero.pnlR).toBeNull();
    const two = mapSessionStats({ totalPnl: 5, totalTrades: 2, winningTrades: 1, losingTrades: 1, winRate: 0.5, expectancy: 0.2 } as never, status());
    expect(two.winRate).toBe(0.5);
    expect(two.pnlR).toBe(0.2);
  });

  it("hero renders — for win rate, W/L and In R, and the desk sentence with hydrated opens", () => {
    const positions = mapSessionOpenPositions({ engineOpenPositions: THREE_HYDRATED, rows: [], source: "api" });
    const { getByTestId, container } = render(
      <HeroStatePanel session={zeroCloseSession()} regime={REGIME_CHOP} intradayEquity={[]} openPositions={positions} signalsEmitted={8} />,
    );
    expect(getByTestId("hero-win-rate").textContent).toBe("—");
    expect(getByTestId("hero-win-loss").textContent).toBe("—");
    expect(getByTestId("hero-in-r").textContent).toBe("—");
    expect(getByTestId("hero-win-rate").parentElement?.getAttribute("title")).toBe("No closed trades this session — rate not defined.");
    expect(getByTestId("hero-session-sentence").textContent).toBe("0 closed this session · 3 open live (3 carried from prior session)");
    expect(getByTestId("hero-signals-emitted").textContent).toBe("8");
    expect(getByTestId("hero-closed").textContent).toBe("0");
    expect(getByTestId("hero-open").textContent).toBe("3(3 hydrated)");
    expect(getByTestId("hero-heat").textContent).toBe("47.0% / 3.0%");
    expect(container.textContent).not.toMatch(/0\.0%|0\.00R|\b0\/0\b/);
  });

  it("KPI tiles: win rate — at zero closes, exposure from the snapshot SoT, hydrated opens named", () => {
    const positions = mapSessionOpenPositions({ engineOpenPositions: THREE_HYDRATED, rows: [], source: "api" });
    const tiles = buildDashboardKpis(zeroCloseSession(), positions, {}, [0, 0]);
    const byKey = Object.fromEntries(tiles.map((t) => [t.key, t]));
    expect(byKey.win.value).toBe("—");
    expect(byKey.win.delta).toBe("no closed trades this session — rate not defined");
    expect(byKey.exposure.value).toBe("$4,700");
    expect(byKey.exposure.delta).toBe("3 open (3 hydrated)");
    expect(byKey.pnl.delta).toBe("0 closed this session · 3 open live (3 carried from prior session)");

    // No session at all → dashes, not zeros.
    const none = Object.fromEntries(buildDashboardKpis(undefined, [], {}, [0, 0]).map((t) => [t.key, t]));
    expect(none.win.value).toBe("—");
    expect(none.exposure.value).toBe("—");
  });
});

// ------------------------------------------------------------------
// Regime — one desk word
// ------------------------------------------------------------------

describe("regime — primary word is Chop / Trend, detector detail is the subtitle", () => {
  it("maps detector regimes to the status vocabulary", () => {
    expect(deskRegime("ranging")).toEqual({ label: "Chop", subtitle: "ranging conditions" });
    expect(deskRegime("chop")).toEqual({ label: "Chop", subtitle: "choppy conditions" });
    expect(deskRegime("choppy").label).toBe("Chop");
    expect(deskRegime("high_volatility")).toEqual({ label: "Chop", subtitle: "high volatility" });
    expect(deskRegime("strong_trend")).toEqual({ label: "Trend", subtitle: "strong trend" });
    expect(deskRegime("weak_trend")).toEqual({ label: "Trend", subtitle: "weak trend" });
    expect(deskRegime("trend")).toEqual({ label: "Trend", subtitle: null });
    expect(deskRegime(null)).toEqual({ label: "—", subtitle: null });
  });

  it("regime panel headlines Chop with the ranging subtitle — never RANGING as the primary", () => {
    const { getByTestId } = render(<RegimeCard regime={REGIME_CHOP} />);
    expect(getByTestId("regime-label").textContent).toBe("Chop");
    expect(getByTestId("regime-subtitle").textContent).toBe("Chop · ranging conditions");
  });
});

// ------------------------------------------------------------------
// Equity curve — mark-to-market last point
// ------------------------------------------------------------------

describe("equity curve — marks to market with the session snapshot", () => {
  it("derives start + realized + unrealized and never a constant", () => {
    expect(markToMarketEquity(status().pnl)).toBe(10_055);
    expect(markToMarketEquity({ ...status().pnl!, sessionStartEquityUsd: undefined })).toBeNull();
    expect(markToMarketEquity(null)).toBeNull();
  });

  it("appends the live equity so the header moves with unrealized P&L", () => {
    const curve = {
      equityCurve: [{ timestamp: 1, equity: 10_000, pnl: 0 }],
      highWaterMark: 10_000,
      currentEquity: 10_000,
      sessionStartEquity: 10_000,
      maxDrawdown: 0,
    };
    const points = buildEquityPoints(curve, status().pnl);
    expect(points.map((p) => p.v)).toEqual([10_000, 10_055]);
    // No trades yet: anchor at the session start, then the live mark.
    expect(buildEquityPoints({ ...curve, equityCurve: [] }, status().pnl).map((p) => p.v)).toEqual([10_000, 10_055]);
    // Engine stopped: nothing to draw.
    expect(buildEquityPoints(null, null)).toEqual([]);
  });
});

// Keep the fixture type honest with the hook's expectations.
const _positionsShape: Position[] = mapSessionOpenPositions({ engineOpenPositions: [], rows: [], source: "api" });
void _positionsShape;
