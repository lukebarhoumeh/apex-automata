/**
 * TASK_016 P5/P6 — widgets that must describe the paper session (or say they don't).
 */

import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { LiveSignalFeed } from "@/components/apex/dashboard/LiveSignalFeed";
import { StrategyCards } from "@/components/apex/dashboard/StrategyCards";
import { SignalStreamPanel } from "@/components/apex/signals/SignalStreamPanel";
import { MetaModelHero } from "@/components/apex/signals/MetaModelHero";
import type { FeedEvent, SignalRecord } from "@/types/signals";
import type { MetaFilterInfo, StrategyCardData } from "@/types/strategy";

const FEED: FeedEvent[] = [{ id: "f1", ts: "15:22:00", kind: "SIGNAL", msg: "SOL-USD BUY p=0.60", tag: "trend_follow", score: 0.6 }];

const CARDS: StrategyCardData[] = [
  { id: "trend_follow", name: "EMA Trend Follow", status: "on", pnlSession: 12.5, trades: 2, winRate: 0.5, signals: 7, sparkline: [] },
  { id: "momentum", name: "RSI/MACD Momentum", status: "killed", disabledBy: "guardrails", pnlSession: 0, trades: 0, winRate: 0, signals: 0, sparkline: [] },
];

const SIGNALS: SignalRecord[] = [
  { id: "s1", ts: "15:22:00", sym: "SOL-USD", strat: "trend_follow", side: "BUY", conf: 0.6, state: "ACCEPTED", z: null, adx: null, note: "" },
  { id: "s2", ts: "15:01:00", sym: "SOL-USD", strat: "trend_follow", side: "BUY", conf: 0.6, state: "REJECTED", z: null, adx: null, note: "cold streak" },
  { id: "s3", ts: "00:00:00", sym: "BTC-USD", strat: "breakout", side: "BUY", conf: 0.7, state: "KILLED", z: null, adx: null, note: "" },
];

const META: MetaFilterInfo = {
  name: "Rule-based meta-filter",
  enabled: true,
  threshold: 0.5,
  rules: [
    { key: "coldStreakEnabled", label: "Cold-streak cooldown", enabled: true },
    { key: "timeFilterEnabled", label: "Time-of-day filter", enabled: false },
  ],
};

describe("LiveSignalFeed", () => {
  it("is LIVE only while a session runs, IDLE otherwise", () => {
    const live = render(<LiveSignalFeed initialEvents={FEED} live />);
    expect(live.getByTestId("signal-feed-state")).toHaveTextContent("LIVE");
    expect(live.getByText("this session")).toBeInTheDocument();
    live.unmount();

    const idle = render(<LiveSignalFeed initialEvents={[]} live={false} />);
    expect(idle.getByTestId("signal-feed-state")).toHaveTextContent("IDLE");
    expect(idle.getByText("recent · engine stopped")).toBeInTheDocument();
    expect(idle.getByText("No signals to show.")).toBeInTheDocument();
  });
});

describe("StrategyCards", () => {
  it("shows session trades/P&L/signals only while a session runs; killed strategies stay killed", () => {
    const running = render(
      <MemoryRouter>
        <StrategyCards strategies={CARDS} sessionActive />
      </MemoryRouter>,
    );
    const tf = running.getByTestId("strategy-card-trend_follow");
    expect(tf).toHaveTextContent("Session P&L");
    expect(tf).toHaveTextContent("+$12.50");
    expect(tf).toHaveTextContent("Signals7");
    expect(tf).toHaveTextContent("Trades2");
    expect(running.getByTestId("strategy-card-momentum")).toHaveTextContent("Disabled · guardrails");
    running.unmount();

    const stopped = render(
      <MemoryRouter>
        <StrategyCards strategies={CARDS} sessionActive={false} />
      </MemoryRouter>,
    );
    const tfStopped = stopped.getByTestId("strategy-card-trend_follow");
    expect(tfStopped).not.toHaveTextContent("+$12.50");
    expect(tfStopped).toHaveTextContent("Trades—");
  });
});

describe("SignalStreamPanel / MetaModelHero", () => {
  it("badges killed-strategy rows and excludes them from acceptance math", () => {
    const stream = render(<SignalStreamPanel signals={SIGNALS} threshold={0.5} live />);
    expect(stream.getByTestId("signal-stream-header")).toHaveTextContent("LIVE · THIS SESSION");
    expect(stream.getByText("1 killed-strategy rows")).toBeInTheDocument();
    expect(stream.getAllByText("KILLED").length).toBeGreaterThan(0);
    stream.unmount();

    const hero = render(<MetaModelHero meta={META} signals={SIGNALS} sessionActive />);
    expect(hero.getByTestId("meta-gate-state")).toHaveTextContent("RULE-BASED · GATE · ACTIVE");
    expect(hero.getByText("of 2 gated signals")).toBeInTheDocument(); // breakout row excluded
    expect(hero.getByText("1 from killed strategies excluded")).toBeInTheDocument();
    expect(hero.getByText("50.0%")).toBeInTheDocument();
  });

  it("says so when the engine is stopped", () => {
    const hero = render(<MetaModelHero meta={{ ...META, enabled: null }} signals={[]} sessionActive={false} />);
    expect(hero.getByTestId("meta-gate-state")).toHaveTextContent("GATE · UNKNOWN (ENGINE STOPPED)");
    expect(hero.getByText("RECENT (0) · ENGINE STOPPED")).toBeInTheDocument();
    const stream = render(<SignalStreamPanel signals={[]} threshold={0.5} live={false} />);
    expect(stream.getByTestId("signal-stream-header")).toHaveTextContent("RECENT · ENGINE STOPPED");
  });
});
