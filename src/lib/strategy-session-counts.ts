/**
 * Per-strategy session counts for the strategy cards (Dashboard) and the
 * strategy config cards (Signals page). ONE resolver so both surfaces agree
 * and neither invents a parallel counter.
 *
 * Sources, in precedence order:
 *
 *   signals   `sessionStats.signalsGenerated` (session-scoped emits, API #72)
 *             → plugin `stats.signalsGenerated` (lifetime counter; pre-#72
 *               backend only) → null ("—")
 *   closed    `sessionStats.closedTrades` → client bucketing of the session
 *             ledger (`/api/analytics/trades`) → 0
 *   open      engine open positions (`/api/positions` → engineOpenPositions,
 *             hydrated INCLUDED) → `sessionStats.openTrades + hydratedOpenCount`
 *             → null
 *   hydrated  engine positions flagged `hydratedFromPriorSession` →
 *             `sessionStats.hydratedOpenCount` → null
 *   winRate   null whenever `closed === 0` — a rate over zero trades is not
 *             defined, so it is never rendered as 0%.
 */

import type { BackendStrategy, StrategyTradeSummary } from "@/services/apexDashboardApi";

/** The slice of an engine open position this module reads. */
export interface StrategyOpenPositionLike {
  strategy: string | null;
  hydratedFromPriorSession?: boolean;
  /** Engine unrealized P&L (USD) at its own mark. */
  unrealizedPnL?: number;
}

export interface StrategySessionCounts {
  /** Signals emitted this session; null when no counter is available. */
  signals: number | null;
  /** Closed trades attributed to the strategy in the active session. */
  closed: number;
  /** Open positions (live), hydrated included; null when no open source is available. */
  open: number | null;
  /** Subset of `open` carried from a prior session; null when unknown. */
  hydratedOpen: number | null;
  /** Realized USD over the session's CLOSED trades only. */
  pnlClosed: number;
  /** Engine unrealized USD over the strategy's open positions; null when positions are unavailable. */
  pnlOpen: number | null;
  wins: number;
  losses: number;
  /** wins / closed; null when closed === 0. */
  winRate: number | null;
}

function finite(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export const EMPTY_STRATEGY_COUNTS: StrategySessionCounts = {
  signals: null,
  closed: 0,
  open: null,
  hydratedOpen: null,
  pnlClosed: 0,
  pnlOpen: null,
  wins: 0,
  losses: 0,
  winRate: null,
};

/**
 * Resolve one strategy's session counts.
 *
 * @param strategyId Plugin id the positions/ledger are matched on.
 * @param registered The `/api/strategies` entry (null when not registered).
 * @param ledger Client-side bucket of `/api/analytics/trades` for this id (pre-#64 fallback).
 * @param openPositions Engine open positions for the active session; `null` when unavailable.
 */
export function resolveStrategySessionCounts(
  strategyId: string,
  registered: Pick<BackendStrategy, "stats" | "sessionStats"> | null | undefined,
  ledger: StrategyTradeSummary | undefined,
  openPositions: readonly StrategyOpenPositionLike[] | null,
): StrategySessionCounts {
  const ss = registered?.sessionStats ?? null;

  const signals = finite(ss?.signalsGenerated) ?? finite(registered?.stats?.signalsGenerated);

  const closed = finite(ss?.closedTrades) ?? ledger?.trades ?? 0;
  const wins = finite(ss?.wins) ?? ledger?.wins ?? 0;
  const losses = finite(ss?.losses) ?? ledger?.losses ?? 0;
  const pnlClosed = finite(ss?.realizedPnlUsd) ?? ledger?.pnl ?? 0;

  let winRate: number | null = null;
  if (closed > 0) {
    winRate = finite(ss?.winRate) ?? (ledger && ledger.trades > 0 ? ledger.winRate : null) ?? wins / closed;
  }

  let open: number | null = null;
  let hydratedOpen: number | null = null;
  let pnlOpen: number | null = null;
  if (openPositions !== null) {
    const mine = openPositions.filter((p) => p.strategy === strategyId);
    open = mine.length;
    hydratedOpen = mine.filter((p) => p.hydratedFromPriorSession).length;
    pnlOpen = mine.reduce((acc, p) => acc + (finite(p.unrealizedPnL) ?? 0), 0);
  } else if (ss) {
    const sessionOpen = finite(ss.openTrades) ?? 0;
    hydratedOpen = finite(ss.hydratedOpenCount);
    open = sessionOpen + (hydratedOpen ?? 0);
  }

  return { signals, closed, open, hydratedOpen, pnlClosed, pnlOpen, wins, losses, winRate };
}

// ============================================================
// Desk copy — the exact sentences the UX desk signed off on
// ============================================================

const WIN_RATE_UNDEFINED = "No closed trades this session — rate not defined.";

/** Tooltip for any rate rendered as "—" because there are no closed trades. */
export const RATE_UNDEFINED_TITLE = WIN_RATE_UNDEFINED;

/** `62%` or "—" (rate not defined at zero closes). */
export function formatWinRate(winRate: number | null, closed: number, digits = 0): string {
  if (closed <= 0 || winRate === null || !Number.isFinite(winRate)) return "—";
  return `${(winRate * 100).toFixed(digits)}%`;
}

/** `+0.42R` or "—" when there are no closed trades to measure expectancy on. */
export function formatExpectancyR(pnlR: number | null, closed: number): string {
  if (closed <= 0 || pnlR === null || !Number.isFinite(pnlR)) return "—";
  return `${pnlR >= 0 ? "+" : "-"}${Math.abs(pnlR).toFixed(2)}R`;
}

/** `3/1` or "—" when there are no closed trades (never `0/0`). */
export function formatWinLoss(wins: number, losses: number, closed: number): string {
  return closed <= 0 ? "—" : `${wins}/${losses}`;
}

/** `3 open` / `3 open (2 hydrated)`. */
export function formatOpenLive(open: number | null, hydratedOpen: number | null): string {
  if (open === null) return "—";
  return hydratedOpen !== null && hydratedOpen > 0 ? `${open} open (${hydratedOpen} hydrated)` : `${open} open`;
}

/**
 * Hero sentence:
 *   closed=0, open>0 → `0 closed this session · N open live`
 *   both 0          → `No closed trades this session · no open positions`
 *   closed>0        → `N closed this session · M open live`
 * A hydrated count > 0 is appended as `(K carried from prior session)` so
 * three hydrated longs never read as "flat".
 */
export function heroSessionSentence(closed: number, open: number | null, hydratedOpen: number | null = null): string {
  const openN = open ?? 0;
  const carried = hydratedOpen !== null && hydratedOpen > 0 ? ` (${hydratedOpen} carried from prior session)` : "";
  if (closed <= 0 && openN <= 0) return "No closed trades this session · no open positions";
  const openPart = open === null ? "open positions unknown" : `${openN} open live${carried}`;
  return `${closed} closed this session · ${openPart}`;
}

/**
 * Active strategy card footer: `N signals emitted · M closed · K open`
 * (`K open (J hydrated)` when hydrated opens exist; "—" for an unknown part).
 */
export function strategyCardFooter(c: Pick<StrategySessionCounts, "signals" | "closed" | "open" | "hydratedOpen">): string {
  const signals = c.signals === null ? "— signals emitted" : `${c.signals} ${c.signals === 1 ? "signal" : "signals"} emitted`;
  const openPart = c.open === null ? "— open" : formatOpenLive(c.open, c.hydratedOpen);
  return `${signals} · ${c.closed} closed · ${openPart}`;
}
