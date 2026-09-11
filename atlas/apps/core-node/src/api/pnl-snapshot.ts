/**
 * Canonical PnL / equity snapshot — Frontend Lead contract #5 (equity SoT).
 *
 * `GET /api/pnl`, `/api/status.pnl` and the WS `PnLSnapshot` / `StatusUpdate.pnl`
 * payloads are all built here so they cannot drift. `totalEquityUsd` is the
 * equity single source of truth:
 *   paper  = sessionStartEquityUsd + realizedPnlUsd + unrealizedPnlUsd
 *            (mark-to-market from the session anchor, every tick, no clamp)
 *   live   = the Coinbase account snapshot (exchange truth)
 * The risk engine's sizing equity (`getCurrentEquityForSizing`, refreshed on its
 * metrics tick and clamped to 50–200 % of paper capital) is exposed alongside as
 * `sizingEquityUsd` so the two can be compared, but it is not the display SoT.
 * Nothing in this module invents an equity number — there is no `50_000` /
 * `100_000` demo fallback, and the session anchor is the value
 * `openTradingSession` persisted to `trading_sessions.initial_equity`.
 *
 * `sessionId` on the snapshot is the runtime's `trading_sessions.session_id`
 * (the same id `/api/status` reports), not a synthetic `paper-<date>` label.
 *
 * Pure: every engine value is passed in, so the shape and the invariants are
 * unit-testable without a running engine.
 */

import { toIsoOrNull, type ExecutionMode } from '../runtime/session-context';

/** Field names the UI must read equity from (documented for FE; see PR body). */
export const EQUITY_SOT_FIELDS = {
  status: '/api/status.pnl.totalEquityUsd',
  pnl: '/api/pnl.totalEquityUsd',
  sessionStart: 'sessionStartEquityUsd',
} as const;

/** How `totalEquityUsd` was obtained: paper mark-to-market from the session anchor, or the live exchange snapshot. */
export type EquitySource = 'mark_to_market' | 'exchange_snapshot';

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
  /**
   * `RiskEngine.getCurrentEquityForSizing()`. Live: the Coinbase snapshot equity and
   * therefore the SoT; paper: the clamped sizing figure, exposed as `sizingEquityUsd`.
   */
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
  /** ISO-8601 UTC; same value as `/api/status.sessionStartedAt`. */
  sessionStartedAt: string | null;
  executionMode: ExecutionMode;
  /** UTC calendar day used for `dailyPnlUsd`. */
  riskDay: string;
  sessionStartEquityUsd: number;
  dayStartEquityUsd: number;
  realizedPnlUsd: number;
  unrealizedPnlUsd: number;
  /**
   * Equity single source of truth (see `EQUITY_SOT_FIELDS`). Always finite.
   * Paper: `sessionStartEquityUsd + realizedPnlUsd + unrealizedPnlUsd`; live: exchange snapshot.
   */
  totalEquityUsd: number;
  /** Where `totalEquityUsd` came from. */
  equitySource: EquitySource;
  /**
   * The risk engine's sizing equity (what order sizes are computed from). Paper: refreshed on
   * the risk metrics tick and clamped to 50–200 % of paper capital, so it can lag or differ
   * from `totalEquityUsd`; `null` when the engine reported a non-finite value.
   */
  sizingEquityUsd: number | null;
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

  const sizingEquityUsd = finite(inputs.equityForSizingUsd);
  const markToMarket = sessionStartEquityUsd + realizedPnlUsd + unrealizedPnlUsd;
  // Live: the exchange snapshot is the truth (falls back to mark-to-market only if the
  // engine handed us a non-finite value). Paper: always mark-to-market from the anchor.
  const useSnapshot = inputs.mode === 'live' && sizingEquityUsd !== null;
  const totalEquityUsd = useSnapshot ? sizingEquityUsd : markToMarket;
  const equitySource: EquitySource = useSnapshot ? 'exchange_snapshot' : 'mark_to_market';

  const dailyPnlUsd = finite(inputs.riskMetrics.dailyPnL) ?? 0;
  const riskUnitUsd = finite(inputs.riskStatus.riskUnitUsd) ?? sessionStartEquityUsd * 0.01;
  const dailyPnlR = riskUnitUsd > 0 ? dailyPnlUsd / riskUnitUsd : 0;

  return {
    ts: now,
    userId: inputs.userId,
    sessionId: inputs.session.sessionId,
    sessionStartedAt: toIsoOrNull(inputs.session.sessionStartedAt),
    executionMode: inputs.mode,
    riskDay: new Date(now).toISOString().slice(0, 10),
    sessionStartEquityUsd,
    dayStartEquityUsd: finite(inputs.riskStatus.dayStartEquityUsd) ?? sessionStartEquityUsd,
    realizedPnlUsd,
    unrealizedPnlUsd,
    totalEquityUsd,
    equitySource,
    sizingEquityUsd,
    dailyPnlUsd,
    dailyPnlR,
    riskUnitUsd,
    openPositionsCount: finite(inputs.portfolio.positionCount) ?? 0,
    exposureUsd: finite(inputs.riskMetrics.currentExposure) ?? 0,
    maxDrawdownPct: finite(inputs.riskMetrics.maxDrawdown) ?? 0,
    liveAccount: inputs.mode === 'live' ? inputs.liveAccount : null,
  };
}
