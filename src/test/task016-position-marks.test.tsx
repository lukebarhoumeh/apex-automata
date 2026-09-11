/**
 * TASK_016 U2 — positions are valued at real marks only.
 *
 * - P&L math is pure and returns null (→ "—") when the mark is unknown.
 * - PositionsTable / ActivePositionsStrip render identically for identical
 *   props (no Math.random, no ticking local state).
 */

import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { computePositionPnl, computeStopTargetProgress } from "@/lib/position-pnl";
import { PositionsTable } from "@/components/apex/dashboard/PositionsTable";
import { ActivePositionsStrip } from "@/components/apex/orders/ActivePositionsStrip";
import type { LiveMarks } from "@/hooks/apex/useLiveMarks";
import type { Position } from "@/types/positions";

const POSITIONS: readonly Position[] = [
  { id: "p1", sym: "BTC-USD", side: "LONG", qty: 0.5, entry: 60_000, stop: 59_000, target: 63_000, opened: "09:00:00", strat: "trend_follow", conf: 0 },
  { id: "p2", sym: "ETH-PERP-INTX", side: "SHORT", qty: 2, entry: 3_000, stop: 3_100, target: 2_800, opened: "09:05:00", strat: "trend_follow", conf: 0 },
];

const MARKS: LiveMarks = {
  "BTC-USD": { price: 61_000, ts: 1, source: "ticker" },
};

describe("computePositionPnl", () => {
  it("returns null when the mark is unknown or unusable", () => {
    expect(computePositionPnl("LONG", 100, 1, undefined)).toBeNull();
    expect(computePositionPnl("LONG", 100, 1, null)).toBeNull();
    expect(computePositionPnl("LONG", 100, 1, 0)).toBeNull();
    expect(computePositionPnl("LONG", 100, 1, Number.NaN)).toBeNull();
  });

  it("values longs and shorts against the mark", () => {
    expect(computePositionPnl("LONG", 60_000, 0.5, 61_000)).toEqual({ mark: 61_000, pnl: 500, pnlPct: (1_000 / 60_000) * 100 });
    expect(computePositionPnl("SHORT", 3_000, 2, 2_900)).toEqual({ mark: 2_900, pnl: 200, pnlPct: (100 / 3_000) * 100 });
    expect(computePositionPnl("SHORT", 3_000, 2, 3_100)?.pnl).toBe(-200);
  });

  it("is deterministic", () => {
    const a = computePositionPnl("LONG", 60_000, 0.5, 61_000);
    const b = computePositionPnl("LONG", 60_000, 0.5, 61_000);
    expect(a).toEqual(b);
  });
});

describe("computeStopTargetProgress", () => {
  it("is 0 without a mark and clamps to ±100", () => {
    expect(computeStopTargetProgress("LONG", 100, 90, 120, undefined)).toBe(0);
    expect(computeStopTargetProgress("LONG", 100, 90, 120, 110)).toBe(50);
    expect(computeStopTargetProgress("LONG", 100, 90, 120, 95)).toBe(-50);
    expect(computeStopTargetProgress("LONG", 100, 90, 120, 500)).toBe(100);
    expect(computeStopTargetProgress("SHORT", 100, 110, 80, 90)).toBe(50);
  });
});

describe("PositionsTable", () => {
  it("renders identical markup for identical props (no randomness)", () => {
    const a = render(<PositionsTable positions={POSITIONS} marks={MARKS} />);
    const htmlA = a.container.innerHTML;
    a.unmount();
    const b = render(<PositionsTable positions={POSITIONS} marks={MARKS} />);
    expect(b.container.innerHTML).toBe(htmlA);
  });

  it("shows the real mark and P&L for marked symbols and — for unmarked ones", () => {
    const { getByText, getAllByText } = render(<PositionsTable positions={POSITIONS} marks={MARKS} />);
    expect(getByText("61,000.00")).toBeInTheDocument();
    expect(getByText("+$500.00")).toBeInTheDocument();
    // ETH-PERP-INTX has no mark → Mark, P&L and P&L% all render "—".
    expect(getAllByText("—")).toHaveLength(3);
    expect(getByText("marks 1/2")).toBeInTheDocument();
  });

  it("never fabricates a mark from entry when no marks are supplied", () => {
    const { queryByText, getAllByText, getByText } = render(<PositionsTable positions={POSITIONS} />);
    expect(queryByText("+$0.00")).toBeNull();
    expect(getAllByText("—")).toHaveLength(6);
    expect(getByText("no live marks")).toBeInTheDocument();
  });
});

describe("ActivePositionsStrip", () => {
  it("renders identical markup for identical props and — without marks", () => {
    const a = render(<ActivePositionsStrip positions={POSITIONS} marks={MARKS} />);
    const htmlA = a.container.innerHTML;
    a.unmount();
    const b = render(<ActivePositionsStrip positions={POSITIONS} marks={MARKS} />);
    expect(b.container.innerHTML).toBe(htmlA);
    expect(b.getByText("+$500.00")).toBeInTheDocument();
    expect(b.getByText("no live mark")).toBeInTheDocument();
    expect(b.getByText("marks 1/2")).toBeInTheDocument();
  });
});
