/**
 * TASK_016 U3/U5/U7 — status cache merge, honest engine pill and footer chips,
 * guardrails strategy policy overlay.
 */

import { describe, it, expect } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { applyEventToCache, mergeQueryData } from "@/runtime/event-bus/applyEventToCache";
import { normalizeRuntimeEvent } from "@/runtime/ws/normalizeEvent";
import type { PositionPayload, StatusPayload } from "@/runtime/ws/types";
import { deriveEnginePill } from "@/runtime/state/deriveEnginePill";
import { deriveFooterChips, deriveFooterSessionText } from "@/components/apex/shell/footer-chips";
import { mergeStrategyPolicy } from "@/lib/strategy-policy";
import { deriveBotMode, mapSessionStats, mapStrategyCards } from "@/hooks/apex/useDashboardData";
import type { RuntimeConnectivity } from "@/runtime/connectivity/types";
import type { RuntimeStatus } from "@/services/runtimeClient";
import type { BackendRuntimeStatus, BackendStrategyPolicy } from "@/services/apexDashboardApi";

const CONNECTED: RuntimeConnectivity = { state: "CONNECTED", since: 0 };

function restStatus(overrides: Partial<RuntimeStatus> = {}): RuntimeStatus {
  return {
    engineRunning: true,
    mode: "paper",
    sessionId: "sess_123_abc",
    sessionStartedAt: 1_000,
    paused: false,
    dailyStopHit: false,
    killSwitch: { active: false, reasons: [] },
    wsLatencyMs: 43,
    restLatencyMs: 112,
    spreadPctile: 10,
    regime: "trend",
    ws: { connected: true, isStalled: false },
    rest: { circuitOpen: false, rateLimited: false, degraded: false },
    exchangeHealth: { degraded: false },
    timestamp: 5_000,
    ...overrides,
  };
}

describe("U7 — status cache merge keeps sessionId across partial WS envelopes", () => {
  it("normalizes a legacy StatusUpdate without sessionId to a payload that lacks the key entirely", () => {
    const evt = normalizeRuntimeEvent({
      type: "StatusUpdate",
      timestamp: 1,
      payload: { engineRunning: true, mode: "paper", paused: false, killSwitch: { active: false, reasons: [] } },
    });
    expect(evt?.type).toBe("status");
    expect("sessionId" in (evt!.payload as object)).toBe(false);
  });

  it("passes sessionId/sessionStartedAt/pnl/ws through when the backend sends them", () => {
    const evt = normalizeRuntimeEvent({
      type: "StatusUpdate",
      timestamp: 1,
      payload: {
        engineRunning: true,
        mode: "paper",
        sessionId: "sess_9",
        sessionStartedAt: 42,
        pnl: { unrealizedPnlUsd: 12.5 },
        ws: { connected: true },
        lastMarketDataAt: 7,
      },
    });
    const p = evt!.payload as StatusPayload;
    expect(p.sessionId).toBe("sess_9");
    expect(p.sessionStartedAt).toBe(42);
    expect(p.pnl).toEqual({ unrealizedPnlUsd: 12.5 });
    expect(p.ws).toEqual({ connected: true });
    expect(p.lastMarketDataAt).toBe(7);
  });

  it("merges the WS status over the REST snapshot instead of replacing it", () => {
    const qc = new QueryClient();
    qc.setQueryData(["runtime-status"], restStatus());

    const evt = normalizeRuntimeEvent({
      type: "StatusUpdate",
      timestamp: 2,
      payload: { engineRunning: true, mode: "paper", paused: true, killSwitch: { active: false, reasons: [] }, wsLatencyMs: 50 },
    })!;
    applyEventToCache(qc, { type: evt.type, payload: evt.payload, ts: evt.ts, source: "ws" });

    const cached = qc.getQueryData<RuntimeStatus>(["runtime-status"])!;
    expect(cached.sessionId).toBe("sess_123_abc"); // preserved — the flap
    expect(cached.sessionStartedAt).toBe(1_000);
    expect(cached.ws).toEqual({ connected: true, isStalled: false }); // REST-only block preserved
    expect(cached.paused).toBe(true); // WS field applied
    expect(cached.wsLatencyMs).toBe(50);
  });

  it("applies a real session change carried by the WS envelope", () => {
    const qc = new QueryClient();
    qc.setQueryData(["runtime-status"], restStatus());
    mergeQueryData(qc, ["runtime-status"], { engineRunning: false, mode: null, sessionId: null, sessionStartedAt: null });
    const cached = qc.getQueryData<RuntimeStatus>(["runtime-status"])!;
    expect(cached.sessionId).toBeNull();
    expect(cached.engineRunning).toBe(false);
  });

  it("mergeQueryData skips undefined values and seeds an empty cache", () => {
    const qc = new QueryClient();
    mergeQueryData(qc, ["k"], { a: 1, b: undefined });
    expect(qc.getQueryData(["k"])).toEqual({ a: 1 });
    mergeQueryData(qc, ["k"], { a: undefined, c: 3 });
    expect(qc.getQueryData(["k"])).toEqual({ a: 1, c: 3 });
  });
});

describe("U2 — PositionUpdate carries the engine mark", () => {
  it("maps the PositionTracker shape (size/averagePrice/marketPrice/unrealizedPnL)", () => {
    const evt = normalizeRuntimeEvent({
      type: "PositionUpdate",
      timestamp: 3,
      payload: {
        id: "pos-1",
        symbol: "ETH-PERP-INTX",
        side: "short",
        size: 2,
        averagePrice: 3_000,
        marketPrice: 2_950,
        unrealizedPnL: 100,
        stopPrice: 3_100,
        takeProfit: 2_800,
        openTime: "2026-09-11T14:00:00.000Z",
      },
    })!;
    const p = evt.payload as PositionPayload;
    expect(evt.type).toBe("position:updated");
    expect(p.qty).toBe(2);
    expect(p.entryPrice).toBe(3_000);
    expect(p.marketPrice).toBe(2_950);
    expect(p.unrealizedPnlUsd).toBe(100);
    expect(p.stopPriceAtEntry).toBe(3_100);
    expect(p.takeProfitPrice).toBe(2_800);
    expect(p.openedAt).toBe("2026-09-11T14:00:00.000Z");
  });

  it("leaves marketPrice undefined when the payload has none (Supabase row shape)", () => {
    const evt = normalizeRuntimeEvent({
      type: "PositionUpdate",
      timestamp: 3,
      payload: { id: "pos-2", symbol: "BTC-USD", side: "long", qty_open: 1, entry_price: 60_000 },
    })!;
    const p = evt.payload as PositionPayload;
    expect(p.qty).toBe(1);
    expect(p.entryPrice).toBe(60_000);
    expect(p.marketPrice).toBeUndefined();
  });
});

describe("U3 — engine pill never defaults to paper and outranks running with halt/transport", () => {
  it("shows stopped when the engine is not running", () => {
    const pill = deriveEnginePill(restStatus({ engineRunning: false, mode: null, sessionId: null }), { state: "ENGINE_STOPPED", since: 0, engineRunning: false });
    expect(pill.label).toBe("stopped");
    expect(pill.tone).toBe("muted");
  });

  it("shows paper · running for a paper session", () => {
    const pill = deriveEnginePill(restStatus(), CONNECTED);
    expect(pill.label).toBe("paper · running");
    expect(pill.tone).toBe("up");
  });

  it("shows unknown · running when the runtime does not report a mode", () => {
    const pill = deriveEnginePill(restStatus({ mode: null }), CONNECTED);
    expect(pill.label).toBe("unknown · running");
    expect(pill.tone).toBe("warn");
  });

  it("shows halted after a kill even though engineRunning is still true", () => {
    const pill = deriveEnginePill(restStatus({ killSwitch: { active: true, reasons: ["User activated kill switch"] } }), CONNECTED);
    expect(pill.label).toBe("halted");
    expect(pill.tone).toBe("down");
    expect(pill.title).toContain("NOT auto-closed");
  });

  it("shows halted when only engineState reports it", () => {
    expect(deriveEnginePill(restStatus({ engineState: "halted" }), CONNECTED).label).toBe("halted");
  });

  it("marks live sessions distinctly", () => {
    const pill = deriveEnginePill(restStatus({ mode: "live" }), CONNECTED);
    expect(pill.label).toBe("live · running");
    expect(pill.tone).toBe("live");
  });

  it("reports stale / offline transport over any engine state", () => {
    expect(deriveEnginePill(restStatus(), { state: "STALE", since: 0, lastHeartbeatAt: 0, ageMs: 12_000 }).label).toBe("stale 12s");
    expect(deriveEnginePill(restStatus(), { state: "BACKEND_DOWN", since: 0 }).label).toBe("backend down");
    expect(deriveEnginePill(restStatus(), { state: "DISCONNECTED", since: 0 }).label).toBe("offline");
    expect(deriveEnginePill(undefined, CONNECTED).label).toBe("connecting…");
  });
});

describe("U5 — footer chips reflect runtime health, never hard-coded green", () => {
  const now = 100_000;

  it("renders idle OFF chips when the engine is stopped", () => {
    const chips = deriveFooterChips({
      status: restStatus({ engineRunning: false, mode: null, sessionId: null, ws: null, rest: null }),
      connectivity: { state: "ENGINE_STOPPED", since: 0, engineRunning: false },
      metaFilterEnabled: null,
      now,
    });
    expect(chips.map((c) => [c.label, c.suffix, c.status])).toEqual([
      ["MD_STREAM", "OFF", "idle"],
      ["BROKER", "OFF", "idle"],
      ["META_FILTER", "OFF", "idle"],
    ]);
  });

  it("renders measured latencies and RULES when the paper session is healthy", () => {
    const chips = deriveFooterChips({ status: restStatus({ lastMarketDataAt: now - 1_000 }), connectivity: CONNECTED, metaFilterEnabled: true, now });
    expect(chips.map((c) => [c.suffix, c.status])).toEqual([
      ["43ms", "ok"],
      ["112ms", "ok"],
      ["RULES", "ok"],
    ]);
  });

  it("flags stale market data, degraded broker and bypassed meta-filter", () => {
    const chips = deriveFooterChips({
      status: restStatus({
        lastMarketDataAt: now - 45_000,
        rest: { circuitOpen: false, rateLimited: false, degraded: true, degradedReasons: ["consecutive failures"] },
      }),
      connectivity: CONNECTED,
      metaFilterEnabled: false,
      now,
    });
    expect(chips[0]).toMatchObject({ suffix: "45s AGO", status: "warn" });
    expect(chips[1]).toMatchObject({ suffix: "DEGRADED", status: "warn", title: "consecutive failures" });
    expect(chips[2]).toMatchObject({ suffix: "BYPASSED", status: "warn" });
  });

  it("goes down on circuit-open / exchange WS down / no frontend link", () => {
    const down = deriveFooterChips({
      status: restStatus({ ws: { connected: false }, rest: { circuitOpen: true } }),
      connectivity: CONNECTED,
      metaFilterEnabled: true,
      now,
    });
    expect(down[0]).toMatchObject({ suffix: "EXCH WS DOWN", status: "down" });
    expect(down[1]).toMatchObject({ suffix: "CIRCUIT OPEN", status: "down" });

    const noLink = deriveFooterChips({ status: restStatus(), connectivity: { state: "BACKEND_DOWN", since: 0 }, metaFilterEnabled: true, now });
    expect(noLink.map((c) => c.status)).toEqual(["down", "down", "down"]);
    expect(noLink[0].suffix).toBe("NO LINK");
  });

  it("describes the session honestly on the right", () => {
    // sessionStartedAt=1_000, now=7_000 → the one session clock reads 00:00:06.
    expect(deriveFooterSessionText(restStatus(), CONNECTED, 7_000)).toBe("PAPER · session …23_abc · up 00:00:06 · status 2s ago");
    expect(deriveFooterSessionText(restStatus({ engineRunning: false, sessionId: null }), CONNECTED, 7_000)).toBe("no active session · status 2s ago");
    expect(deriveFooterSessionText(undefined, { state: "BACKEND_DOWN", since: 0 }, 0)).toBe("runtime unreachable");
  });
});

describe("Hero — mode and unrealized come from /api/status", () => {
  const backendStatus = (o: Partial<BackendRuntimeStatus> = {}): BackendRuntimeStatus => ({
    engineRunning: true,
    mode: "paper",
    sessionId: "s",
    activeSymbols: ["BTC-USD", "ETH-USD"],
    pnl: { realizedPnlUsd: 10, unrealizedPnlUsd: -4.25, totalEquityUsd: 10_005.75, dailyPnlUsd: 5.75, dailyPnlR: 0.1, openPositionsCount: 1, exposureUsd: 500 },
    ...o,
  });

  it("derives stopped / halted / paused / paper / live — never a paper default", () => {
    expect(deriveBotMode(null)).toBe("stopped");
    expect(deriveBotMode(backendStatus({ engineRunning: false }))).toBe("stopped");
    expect(deriveBotMode(backendStatus({ killSwitch: { active: true } }))).toBe("halted");
    expect(deriveBotMode(backendStatus({ engineState: "halted" }))).toBe("halted");
    expect(deriveBotMode(backendStatus({ paused: true }))).toBe("paused");
    expect(deriveBotMode(backendStatus())).toBe("paper");
    expect(deriveBotMode(backendStatus({ mode: "live" }))).toBe("live");
  });

  it("reads unrealized from the PositionTracker snapshot and null when there is none", () => {
    const withSnapshot = mapSessionStats(null, backendStatus());
    expect(withSnapshot.unrealized).toBe(-4.25);
    expect(withSnapshot.markets).toBe(2);

    const stopped = mapSessionStats(null, backendStatus({ engineRunning: false, pnl: null }));
    expect(stopped.unrealized).toBeNull();
    expect(stopped.mode).toBe("stopped");
  });

  it("session P&L = realized (closed trades) + unrealized (open)", () => {
    const stats = mapSessionStats(
      { totalPnl: 20, startTime: new Date().toISOString(), mode: "paper" } as never,
      backendStatus(),
    );
    expect(stats.realized).toBe(20);
    expect(stats.unrealized).toBe(-4.25);
    expect(stats.pnl).toBe(15.75);
  });
});

describe("P4 — guardrails disabled_strategies overlay", () => {
  const policy: BackendStrategyPolicy = {
    source: "atlas/config/guardrails.yaml",
    disabledStrategies: ["vwap_mr", "breakout", "momentum"],
    perSymbolDisabledStrategies: { "ETH-PERP-INTX": ["momentum"] },
    strategies: [
      { id: "breakout", name: "Breakout", description: "d", category: "trend", disabledByGuardrails: true },
      { id: "vwap_mr", name: "VWAP MR", description: "d", category: "mean-reversion", disabledByGuardrails: true },
      { id: "momentum", name: "Momentum", description: "d", category: "momentum", disabledByGuardrails: true },
      { id: "trend_follow", name: "Trend Follow", description: "d", category: "trend", disabledByGuardrails: false },
    ],
  };

  it("shows killed strategies as disabled-by-guardrails even though the runtime never registers them", () => {
    const merged = mergeStrategyPolicy(
      [{ id: "trend_follow", name: "Trend Follow", description: "d", category: "trend", enabled: true }],
      policy,
    );
    expect(merged.map((m) => [m.id, m.enabled, m.disabledBy])).toEqual([
      ["trend_follow", true, undefined],
      ["breakout", false, "guardrails"],
      ["vwap_mr", false, "guardrails"],
      ["momentum", false, "guardrails"],
    ]);
  });

  it("SoT wins if a stale runtime still lists a killed strategy as enabled", () => {
    const merged = mergeStrategyPolicy([{ id: "momentum", name: "Momentum", enabled: true }], policy);
    expect(merged[0]).toMatchObject({ id: "momentum", enabled: false, disabledBy: "guardrails" });
  });

  it("marks non-killed builtins as engine-offline when nothing is registered", () => {
    const merged = mergeStrategyPolicy([], policy);
    expect(merged.find((m) => m.id === "trend_follow")).toMatchObject({ enabled: false, disabledBy: "engine-offline" });
  });

  it("passes the registered list through unchanged without a policy", () => {
    const merged = mergeStrategyPolicy([{ id: "trend_follow", name: "TF", enabled: false }], null);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ enabled: false, disabledBy: "runtime" });
  });

  it("maps to dashboard cards with a killed status — emitted signals are never counted as trades", () => {
    const cards = mapStrategyCards(
      [{ id: "trend_follow", name: "Trend Follow", description: "d", category: "trend", enabled: true, stats: { signalsGenerated: 3 } }],
      policy,
      [],
    );
    expect(cards.find((c) => c.id === "trend_follow")).toMatchObject({ status: "on", trades: 0, signals: 3, sessionScoped: true });
    expect(cards.find((c) => c.id === "momentum")).toMatchObject({ status: "killed", disabledBy: "guardrails", trades: 0 });
  });
});
