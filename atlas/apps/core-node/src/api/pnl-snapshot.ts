/**
 * Canonical PnL / equity snapshot — Frontend Lead contract #5 (equity SoT).
 *
 * `GET /api/pnl`, `/api/status.pnl` and the WS `PnLSnapshot` / `StatusUpdate.pnl`
 * payloads are all built here so they cannot drift. The single source of truth
 * for equity is the risk engine's sizing equity (`RiskEngine.getCurrentEquityForSizing`):
 * paper = `guardrails.account.equity_usd` + realized + unrealized, live = the
 * Coinbase account snapshot + unrealized. Nothing in this module invents an
 * equity number — there is no `50_000` / `100_000` demo fallback, and the
 * session anchor is the value `openTradingSession` persisted to
 * `trading_sessions.initial_equity`.
 *
 * `sessionId` on the snapshot is the runtime's `trading_sessions.session_id`
 * (the same id `/api/status` reports), not a synthetic `paper-<date>` label.
 *
 * Pure: every engine value is passed in, so the shape and the invariants are
 * unit-testable without a running engine.
 */

import type { ExecutionMode } from '../runtime/session-context';

/** Field names the UI must read equity from (documented for FE; see PR body). */
export const EQUITY_SOT_FIELDS = {
  status: '/api/status.pnl.totalEquityUsd',
  pnl: '/api/pnl.totalEquityUsd',
  sessionStart: 'sessionStartEquityUsd',
} as const;

export type EquitySource = 'risk_engine' | 'derived';

export interface PnlSnapshotSessionInputs {
  sessionId: string | null;
  /** Epoch ms. */
  sessionStartedAt: number | null;
  /** `trading_sessions.initial_equity` for this session (paper: guardrails equity; live: Coinbase snapshot). */
  sessionInitialEquityUsd: number | null;
}

export interface PnlSnapshotInputs {
  mode: ExecutionMode;
  userId: string;
  session: PnlSnapshotSessionInputs;
  /**
   * Equity anchor the risk engine sizes the session from. Paper: the same value as
   * `session.sessionInitialEquityUsd`; live: `RiskEngine.getAccountEquity()`.
   */
  accountEquityUsd: number;
  /** `RiskEngine.getCurrentEquityForSizing()` — the equity SoT. */
  equityForSizingUsd: number;
  riskMetrics: { dailyPnL: number; currentExposure: number; maxDrawdown: number };
  riskStatus: { riskUnitUsd?: number | null; dayStartEquityUsd?: number | null };
  portfolio: { totalRealizedPnL: number; totalUnrealizedPnL: number; positionCount: number };
  /** Live only (TASK_011); `null` in paper. Passed through untouched. */
  liveAccount: Record<string, unknown> | null;
  now?: number;
}

export interface PnlSnapshot {
  ts: number;
  userId: string;
  /** Runtime `trading_sessions.session_id`; `null` only in the start/stop window where no row is open. */
  sessionId: string | null;
  /** Epoch ms; same value as `/api/status.sessionStartedAt`. */
  sessionStartedAt: number | null;
  executionMode: ExecutionMode;
  /** UTC calendar day used for `dailyPnlUsd`. */
  riskDay: string;
  sessionStartEquityUsd: number;
  dayStartEquityUsd: number;
  realizedPnlUsd: number;
  unrealizedPnlUsd: number;
  /** Equity single source of truth (see `EQUITY_SOT_FIELDS`). Always finite. */
  totalEquityUsd: number;
  /** Where `totalEquityUsd` came from: the risk engine, or session anchor + P&L when the engine value was non-finite. */
  equitySource: EquitySource;
  dailyPnlUsd: number;
  dailyPnlR: number;
  riskUnitUsd: number;
  openPositionsCount: number;
  exposureUsd: number;
  maxDrawdownPct: number;
  liveAccount: Record<string, unknown> | null;
}

/** Numeric field names on the snapshot — every one is guaranteed finite. */
export const PNL_SNAPSHOT_NUMERIC_FIELDS = [
  'ts',
  'sessionStartEquityUsd',
  'dayStartEquityUsd',
  'realizedPnlUsd',
  'unrealizedPnlUsd',
  'totalEquityUsd',
  'dailyPnlUsd',
  'dailyPnlR',
  'riskUnitUsd',
  'openPositionsCount',
  'exposureUsd',
  'maxDrawdownPct',
] as const satisfies readonly (keyof PnlSnapshot)[];

function finite(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Build the canonical PnL snapshot from engine state.
 *
 * @throws {Error} when neither the risk engine equity nor the session anchor is a finite
 *   number — the caller must not serve a snapshot with invented equity.
 */
export function buildPnlSnapshotPayload(inputs: PnlSnapshotInputs): PnlSnapshot {
  const now = inputs.now ?? Date.now();
  const realizedPnlUsd = finite(inputs.portfolio.totalRealizedPnL) ?? 0;
  const unrealizedPnlUsd = finite(inputs.portfolio.totalUnrealizedPnL) ?? 0;

  // Session anchor: what the session actually opened with. Paper falls through to
  // the risk engine's account equity (== guardrails.account.equity_usd) only when the
  // session row has not been opened yet (start/stop window) — never to a constant.
  const sessionStartEquityUsd =
    finite(inputs.session.sessionInitialEquityUsd) ?? finite(inputs.accountEquityUsd);
  if (sessionStartEquityUsd === null) {
    throw new Error('PNL_SNAPSHOT_NO_EQUITY_ANCHOR: session initial equity and account equity are both non-finite');
  }

  const engineEquity = finite(inputs.equityForSizingUsd);
  const totalEquityUsd = engineEquity ?? sessionStartEquityUsd + realizedPnlUsd + unrealizedPnlUsd;
  const equitySource: EquitySource = engineEquity !== null ? 'risk_engine' : 'derived';

  const dailyPnlUsd = finite(inputs.riskMetrics.dailyPnL) ?? 0;
  const riskUnitUsd = finite(inputs.riskStatus.riskUnitUsd) ?? sessionStartEquityUsd * 0.01;
  const dailyPnlR = riskUnitUsd > 0 ? dailyPnlUsd / riskUnitUsd : 0;

  return {
    ts: now,
    userId: inputs.userId,
    sessionId: inputs.session.sessionId,
    sessionStartedAt: inputs.session.sessionStartedAt,
    executionMode: inputs.mode,
    riskDay: new Date(now).toISOString().slice(0, 10),
    sessionStartEquityUsd,
    dayStartEquityUsd: finite(inputs.riskStatus.dayStartEquityUsd) ?? sessionStartEquityUsd,
    realizedPnlUsd,
    unrealizedPnlUsd,
    totalEquityUsd,
    equitySource,
    dailyPnlUsd,
    dailyPnlR,
    riskUnitUsd,
    openPositionsCount: finite(inputs.portfolio.positionCount) ?? 0,
    exposureUsd: finite(inputs.riskMetrics.currentExposure) ?? 0,
    maxDrawdownPct: finite(inputs.riskMetrics.maxDrawdown) ?? 0,
    liveAccount: inputs.mode === 'live' ? inputs.liveAccount : null,
  };
}
