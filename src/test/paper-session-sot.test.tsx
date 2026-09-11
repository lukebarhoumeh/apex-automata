/**
 * Paper Execution Terminal — active-session single source of truth.
 *
 * - Strategy cards count the session's closed trades (TradeAnalytics), never
 *   the plugin's emitted-signal counter.
 * - Orders / fills / signals are scoped to the active session's time window
 *   (tables carry no session_id) and render honest empty states without one.
 * - Killed strategies (guardrails disabled_strategies) carry a killed flag.
 * - One session clock: hero, footer and sidebar all derive from
 *   /api/status → sessionStartedAt.
 * - Seeded pages are quarantined as DEMO; Settings never implies live venues
 *   or keys.
 */

import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import {
  summarizeTradesByStrategy,
  type BackendStrategyPolicy,
  type BackendTradeRecord,
} from "@/services/apexDashboardApi";
import {
  killedStrategyIds,
  mapSessionStats,
  mapSignalRecord,
  mapStrategyCards,
  recordToFeedEvent,
} from "@/hooks/apex/useDashboardData";
import { mapStrategyConfigs, mapSignalRecord as mapStreamSignal } from "@/hooks/apex/useSignalsData";
import {
  deriveSessionUptime,
  hasActiveSession,
  sessionKey,
  sessionOpenedLabel,
  sessionSinceIso,
  sessionWindow,
  shortSessionId,
  SESSION_WINDOW_SKEW_MS,
} from "@/lib/session-scope";
import { deriveFooterSessionText } from "@/components/apex/shell/footer-chips";
import { DEMO_PATHS, NAV } from "@/components/apex/shell/nav-config";
import { OrderBlotter, blotterEmptyMessage } from "@/components/apex/orders/OrderBlotter";
import { RecentFillsPanel } from "@/components/apex/orders/RecentFillsPanel";
import { OrdersKpiStrip } from "@/components/apex/orders/OrdersKpiStrip";
import { StrategyCards } from "@/components/apex/dashboard/StrategyCards";
import { SignalStreamPanel } from "@/components/apex/signals/SignalStreamPanel";
import { VenuesSection } from "@/components/apex/settings/sections/VenuesSection";
import { AccountSection } from "@/components/apex/settings/sections/AccountSection";
import { DemoBanner } from "@/components/apex/DemoBanner";
import { SETTINGS_SEED } from "@/hooks/apex/mock/seed-data";
import type { OrderRecord } from "@/types/orders";

const POLICY: BackendStrategyPolicy = {
  source: "atlas/config/guardrails.yaml",
  disabledStrategies: ["vwap_mr", "breakout", "momentum"],
  perSymbolDisabledStrategies: {},
  strategies: [
    { id: "trend_follow", name: "Trend Follow", description: "EMA", category: "trend", disabledByGuardrails: false },
    { id: "momentum", name: "Momentum", description: "RSI/MACD", category: "momentum", disabledByGuardrails: true },
    { id: "breakout", name: "Breakout", description: "Donchian", category: "trend", disabledByGuardrails: true },
    { id: "vwap_mr", name: "VWAP MR", description: "MR", category: "mean-reversion", disabledByGuardrails: true },
  ],
};

const TF_REGISTERED = {
  id: "trend_follow",
  name: "Trend Follow",
  description: "EMA crossover",
  category: "trend",
  enabled: true,
  // 8 emitted signals — the number the audit saw rendered as "Trades".
  stats: { signalsGenerated: 8 },
};

const trade = (o: Partial<BackendTradeRecord>): BackendTradeRecord => ({
  id: "t",
  symbol: "ETH-USD",
  side: "long",
  entryTime: "2026-09-11T15:00:00.000Z",
  entryPrice: 3_000,
  size: 1,
  fees: 0,
  ...o,
});

const SCOPE_ACTIVE = { sessionId: "sess_1789137459103_bnd3mn", sessionStartedAt: Date.UTC(2026, 8, 11, 15, 30, 0) };
const SCOPE_NONE = { sessionId: null, sessionStartedAt: null };

describe("strategy cards — trades come from the session ledger, not signalsGenerated", () => {
  it("renders 0 trades for a zero-trade session even when the plugin emitted 8 signals", () => {
    const cards = mapStrategyCards([TF_REGISTERED], POLICY, []);
    const tf = cards.find((c) => c.id === "trend_follow")!;
    expect(tf.trades).toBe(0);
    expect(tf.signals).toBe(8);
    expect(tf.pnlSession).toBe(0);
    expect(tf.sessionScoped).toBe(true);
  });

  it("buckets the session's closed trades by plugin id with P&L and win rate", () => {
    const ledger = [
      trade({ id: "a", strategy: "trend_follow", realizedPnl: 12.5, outcome: "win" }),
      trade({ id: "b", strategy: "trend_follow", realizedPnl: -4, outcome: "loss" }),
      trade({ id: "c", strategy: "trend_follow", realizedPnl: 0.5 }), // outcome inferred from pnl
      trade({ id: "d", strategy: "momentum", realizedPnl: 3, outcome: "win" }), // other strategy
      trade({ id: "e", realizedPnl: 99 }), // engine-originated exit, no strategy → not attributed
    ];
    const summary = summarizeTradesByStrategy(ledger);
    expect(summary.trend_follow).toEqual({ trades: 3, wins: 2, losses: 1, pnl: 9, winRate: 2 / 3 });
    expect(summary.momentum).toMatchObject({ trades: 1, pnl: 3 });
    expect(Object.keys(summary)).not.toContain("undefined");

    const tf = mapStrategyCards([TF_REGISTERED], POLICY, ledger).find((c) => c.id === "trend_follow")!;
    expect(tf).toMatchObject({ trades: 3, pnlSession: 9, signals: 8 });
    expect(tf.winRate).toBeCloseTo(2 / 3);
  });

  it("marks cards as not session-scoped when the engine is stopped (no ledger)", () => {
    const cards = mapStrategyCards([], POLICY, null);
    expect(cards.every((c) => c.sessionScoped === false)).toBe(true);
    expect(cards.find((c) => c.id === "trend_follow")).toMatchObject({ status: "off", disabledBy: "engine-offline", trades: 0 });
  });

  it("Signals page config cards separate TRADES · SESSION from SIGNALS", () => {
    const cfg = mapStrategyConfigs([TF_REGISTERED], POLICY, [trade({ strategy: "trend_follow", realizedPnl: 1 })]);
    expect(cfg.find((c) => c.id === "trend_follow")!.stats).toMatchObject({ trades: 1, signals: 8 });
    expect(cfg.find((c) => c.id === "breakout")).toMatchObject({ enabled: false, disabledBy: "guardrails" });
  });

  it("renders — for killed strategies and the emitted/routed split for active ones", () => {
    const cards = mapStrategyCards([TF_REGISTERED], POLICY, [trade({ strategy: "trend_follow", realizedPnl: 1 })]);
    const { getByTestId } = render(
      <MemoryRouter>
        <StrategyCards strategies={cards} />
      </MemoryRouter>,
    );
    expect(getByTestId("strategy-card-trend_follow-trades").textContent).toBe("1");
    expect(getByTestId("strategy-card-trend_follow-signals").textContent).toBe("8 signals emitted · 1 routed to a trade");
    expect(getByTestId("strategy-card-momentum-trades").textContent).toBe("—");
    expect(getByTestId("strategy-card-momentum-pnl").textContent).toBe("—");
    expect(getByTestId("strategy-card-momentum-signals").textContent).toContain("never registered");
  });
});

describe("session scope — time window from /api/status, empty without a session", () => {
  it("builds the ISO lower bound only for an active session with a start time", () => {
    expect(hasActiveSession(SCOPE_ACTIVE)).toBe(true);
    expect(sessionSinceIso(SCOPE_ACTIVE)).toBe("2026-09-11T15:30:00.000Z");
    expect(hasActiveSession(SCOPE_NONE)).toBe(false);
    expect(sessionSinceIso(SCOPE_NONE)).toBeNull();
    // Older backend: id but no start time → must not query (would be unscoped).
    expect(sessionSinceIso({ sessionId: "sess_x", sessionStartedAt: null })).toBeNull();
    expect(sessionSinceIso({ sessionId: "sess_x", sessionStartedAt: 0 })).toBeNull();
  });

  it("bounds the window above by now + skew so future-dated fixture rows cannot leak in", () => {
    const now = SCOPE_ACTIVE.sessionStartedAt + 60_000;
    const w = sessionWindow(SCOPE_ACTIVE, now)!;
    expect(w.since).toBe("2026-09-11T15:30:00.000Z");
    expect(w.until).toBe(new Date(now + SESSION_WINDOW_SKEW_MS).toISOString());
    // The real DB holds a breakout signal decided_at 2099-01-01 — it must fall outside.
    expect("2099-01-01T00:00:00.000Z" > w.until).toBe(true);
    expect(sessionWindow(SCOPE_NONE, now)).toBeNull();
  });

  it("keys caches per session and labels the session tail", () => {
    expect(sessionKey(SCOPE_ACTIVE)).toBe("sess_1789137459103_bnd3mn");
    expect(sessionKey(SCOPE_NONE)).toBe("no-session");
    expect(shortSessionId("sess_1789137459103_bnd3mn")).toBe("…bnd3mn");
    expect(shortSessionId(null)).toBe("—");
    expect(sessionOpenedLabel(SCOPE_ACTIVE.sessionStartedAt)).toBe("15:30 UTC");
  });

  it("blotter copy distinguishes no session / no orders / filtered out", () => {
    expect(blotterEmptyMessage(SCOPE_NONE, 0, 0)).toMatch(/No active session/);
    expect(blotterEmptyMessage(SCOPE_ACTIVE, 0, 0)).toBe("No orders this session yet.");
    expect(blotterEmptyMessage(SCOPE_ACTIVE, 3, 0)).toBe("No orders match the current filters.");
  });

  it("Orders page renders honest empty states and session-scoped header", () => {
    const noSession = render(
      <>
        <OrderBlotter orders={[]} session={SCOPE_NONE} onSelect={() => {}} />
        <RecentFillsPanel fills={[]} session={SCOPE_NONE} />
        <OrdersKpiStrip stats={{ total: 0, filled: 0, pending: 0, cancelled: 0, rejected: 0, fillRate: 0 }} session={SCOPE_NONE} />
      </>,
    );
    expect(noSession.getByTestId("blotter-session-scope").textContent).toContain("no active session");
    expect(noSession.getByTestId("blotter-empty").textContent).toMatch(/No active session/);
    expect(noSession.getByTestId("fills-empty").textContent).toMatch(/No active session/);
    expect(noSession.getByTestId("orders-kpi-strip").textContent).not.toMatch(/Orders today/);
    noSession.unmount();

    const active = render(
      <>
        <OrderBlotter orders={[]} session={SCOPE_ACTIVE} onSelect={() => {}} />
        <RecentFillsPanel fills={[]} session={SCOPE_ACTIVE} />
      </>,
    );
    expect(active.getByTestId("blotter-session-scope").textContent).toBe("session …bnd3mn · since 15:30 UTC");
    expect(active.getByTestId("blotter-empty").textContent).toBe("No orders this session yet.");
    expect(active.getByTestId("fills-empty").textContent).toBe("No fills this session yet.");
  });

  it("blotter still lists this session's orders", () => {
    const order: OrderRecord = {
      id: "o1", ts: "15:31:00", sym: "ETH-USD", side: "BUY", type: "MKT", qty: 0.1, px: null, fillAvg: null,
      status: "FILLED", strat: "trend_follow", venue: "Coinbase",
    };
    const { queryByTestId, container } = render(<OrderBlotter orders={[order]} session={SCOPE_ACTIVE} onSelect={() => {}} />);
    expect(queryByTestId("blotter-empty")).toBeNull();
    expect(container.querySelectorAll("tbody tr")).toHaveLength(1);
    expect(container.querySelector("tbody tr")?.textContent).toContain("ETH-USD");
  });
});

describe("signals — killed strategies carry a disabled affordance", () => {
  const row = {
    id: "s1", symbol: "BTC-USD", strategy: "breakout", decided_at: "2026-09-11T15:40:00.000Z",
    side: "long", score: 0.7, confidence: 0.7, meta_prob: null, allowed: false, reason: "killed",
  };

  it("flags rows whose strategy is in disabled_strategies (dashboard + signals hooks)", () => {
    const killed = killedStrategyIds(POLICY);
    expect(mapSignalRecord(row, killed).killed).toBe(true);
    expect(mapStreamSignal(row, killed).killed).toBe(true);
    expect(mapSignalRecord({ ...row, strategy: "trend_follow" }, killed).killed).toBe(false);
    expect(recordToFeedEvent(mapSignalRecord(row, killed)).killed).toBe(true);
    // No policy → nothing is flagged (never invent a kill).
    expect(mapSignalRecord(row, killedStrategyIds(null)).killed).toBe(false);
  });

  it("renders the killed chip in the stream and an honest empty state", () => {
    const killed = killedStrategyIds(POLICY);
    const withRows = render(<SignalStreamPanel signals={[mapStreamSignal(row, killed)]} threshold={0.5} />);
    expect(withRows.getByTestId("signal-killed-s1").textContent).toBe("killed");
    withRows.unmount();
    const empty = render(<SignalStreamPanel signals={[]} threshold={0.5} />);
    expect(empty.getByTestId("signal-stream-empty").textContent).toMatch(/No signals this session/);
  });
});

describe("one session clock — /api/status sessionStartedAt everywhere", () => {
  it("hero session identity comes from /api/status, not TradeAnalytics' own startTime", () => {
    const analytics = { sessionId: "paper-20260911-090000-ab12", startTime: "2026-09-11T09:00:00.000Z", totalTrades: 0 } as never;
    const stats = mapSessionStats(analytics, {
      engineRunning: true, mode: "paper", sessionId: "sess_1789137459103_bnd3mn", sessionStartedAt: SCOPE_ACTIVE.sessionStartedAt,
    });
    expect(stats.sessionId).toBe("sess_1789137459103_bnd3mn");
    expect(stats.sessionStartedAt).toBe(SCOPE_ACTIVE.sessionStartedAt);
    expect(stats.openedAt).toBe("15:30:00");
    const stopped = mapSessionStats(null, { engineRunning: false, mode: null, sessionId: null });
    expect(stopped.sessionId).toBeNull();
    expect(stopped.sessionStartedAt).toBeNull();
    expect(stopped.openedAt).toBe("—");
  });

  it("footer uptime equals the shared derivation for the same start time", () => {
    const now = SCOPE_ACTIVE.sessionStartedAt + 3_723_000; // 1h 2m 3s
    expect(deriveSessionUptime(SCOPE_ACTIVE.sessionStartedAt, now)).toBe("01:02:03");
    expect(deriveSessionUptime(null, now)).toBe("—");
    const text = deriveFooterSessionText(
      { engineRunning: true, mode: "paper", sessionId: SCOPE_ACTIVE.sessionId, sessionStartedAt: SCOPE_ACTIVE.sessionStartedAt, timestamp: now - 1_000 } as never,
      { state: "CONNECTED", since: 0 },
      now,
    );
    expect(text).toBe("PAPER · session …bnd3mn · up 01:02:03 · status 1s ago");
  });
});

describe("DEMO quarantine — seeded pages are labelled, paper SoT pages are not", () => {
  it("flags exactly the seed-data pages in the nav", () => {
    const demo = NAV.filter((n) => n.demo).map((n) => n.id).sort();
    expect(demo).toEqual(["alerts", "backtest", "journal", "model", "settings"]);
    for (const p of ["/", "/orders", "/signals", "/risk"]) expect(DEMO_PATHS.has(p)).toBe(false);
    for (const p of ["/model", "/backtest", "/journal", "/alerts", "/settings"]) expect(DEMO_PATHS.has(p)).toBe(true);
  });

  it("DemoBanner names the fixture source", () => {
    const { getByTestId } = render(<DemoBanner detail="x" />);
    expect(getByTestId("demo-banner").textContent).toMatch(/Demo data — seeded fixtures, not the paper session/);
  });

  it("Settings never implies live venues or issued keys", () => {
    const { container } = render(
      <>
        <VenuesSection venues={SETTINGS_SEED.venues} />
        <AccountSection account={SETTINGS_SEED.account} />
      </>,
    );
    const text = container.textContent ?? "";
    expect(text).not.toMatch(/LIVE · \d+ms/);
    expect(text).not.toMatch(/cb_live_|kr_live_|apex_live_sk/);
    expect(text).toContain("DEMO · NOT CONNECTED");
    expect(text).toContain("no key issued (demo)");
  });
});
