/**
 * FE contract #5 — canonical PnL / equity snapshot (api/pnl-snapshot.ts).
 *
 * Pins:
 *   - `sessionId` is the runtime trading_sessions id (not `paper-<date>`);
 *   - every numeric field is a finite number; `totalEquityUsd` comes from the
 *     risk engine and, if that is ever non-finite, is derived from the session
 *     anchor + P&L — never from a 50_000 / 100_000 constant;
 *   - no equity anchor at all is an error, not a demo number.
 */

import { describe, it, expect } from 'vitest';
import { EQUITY_SOT_FIELDS, PNL_SNAPSHOT_NUMERIC_FIELDS, buildPnlSnapshotPayload, PnlSnapshotInputs } from '../api/pnl-snapshot';

const NOW = Date.parse('2026-09-11T17:30:00.000Z');
const SESSION = { sessionId: 'sess_1757606400000_ab12cd', sessionStartedAt: Date.parse('2026-09-11T16:00:00.000Z'), sessionInitialEquityUsd: 10_000 };

function inputs(overrides: Partial<PnlSnapshotInputs> = {}): PnlSnapshotInputs {
  return {
    mode: 'paper',
    userId: 'user-1',
    session: SESSION,
    accountEquityUsd: 10_000,
    equityForSizingUsd: 10_042.5,
    riskMetrics: { dailyPnL: 42.5, currentExposure: 1_250, maxDrawdown: 0.8 },
    riskStatus: { riskUnitUsd: 50, dayStartEquityUsd: 10_000 },
    portfolio: { totalRealizedPnL: 30, totalUnrealizedPnL: 12.5, positionCount: 1 },
    liveAccount: null,
    now: NOW,
    ...overrides,
  };
}

describe('buildPnlSnapshotPayload', () => {
  it('carries the runtime session identity and the paper capital as the session anchor', () => {
    const snap = buildPnlSnapshotPayload(inputs());

    expect(snap.sessionId).toBe(SESSION.sessionId);
    expect(snap.sessionStartedAt).toBe('2026-09-11T16:00:00.000Z'); // ISO string, not ms (FE PR1 #4)
    expect(snap.sessionId).not.toMatch(/^paper-\d{4}-\d{2}-\d{2}$/);
    expect(snap.executionMode).toBe('paper');
    expect(snap.riskDay).toBe('2026-09-11');
    expect(snap.sessionStartEquityUsd).toBe(10_000);
    expect(snap.dayStartEquityUsd).toBe(10_000);
    expect(snap.totalEquityUsd).toBe(10_042.5);
    expect(snap.equitySource).toBe('risk_engine');
    expect(snap.realizedPnlUsd).toBe(30);
    expect(snap.unrealizedPnlUsd).toBe(12.5);
    expect(snap.dailyPnlUsd).toBe(42.5);
    expect(snap.dailyPnlR).toBe(0.85);
    expect(snap.openPositionsCount).toBe(1);
    expect(snap.exposureUsd).toBe(1_250);
    expect(snap.liveAccount).toBeNull();
  });

  it('every documented numeric field is a finite number', () => {
    const snap = buildPnlSnapshotPayload(inputs());
    for (const field of PNL_SNAPSHOT_NUMERIC_FIELDS) {
      expect(typeof snap[field], field).toBe('number');
      expect(Number.isFinite(snap[field] as number), field).toBe(true);
    }
    expect(EQUITY_SOT_FIELDS.status).toBe('/api/status.pnl.totalEquityUsd');
    expect(EQUITY_SOT_FIELDS.pnl).toBe('/api/pnl.totalEquityUsd');
  });

  it('derives equity from the session anchor + P&L when the engine value is non-finite (never a constant)', () => {
    const snap = buildPnlSnapshotPayload(inputs({ equityForSizingUsd: Number.NaN }));

    expect(snap.totalEquityUsd).toBe(10_000 + 30 + 12.5);
    expect(snap.equitySource).toBe('derived');
    expect(snap.totalEquityUsd).not.toBe(50_000);
  });

  it('falls through to the risk-engine account equity for the anchor only while no session row is open', () => {
    const snap = buildPnlSnapshotPayload(
      inputs({ session: { sessionId: null, sessionStartedAt: null, sessionInitialEquityUsd: null }, accountEquityUsd: 10_000 }),
    );
    expect(snap.sessionId).toBeNull();
    expect(snap.sessionStartEquityUsd).toBe(10_000);
  });

  it('refuses to invent an anchor when both the session equity and the account equity are non-finite', () => {
    expect(() =>
      buildPnlSnapshotPayload(
        inputs({ session: { ...SESSION, sessionInitialEquityUsd: null }, accountEquityUsd: Number.NaN }),
      ),
    ).toThrow(/PNL_SNAPSHOT_NO_EQUITY_ANCHOR/);
  });

  it('coerces non-finite metrics to 0 and derives the risk unit from the anchor when missing', () => {
    const snap = buildPnlSnapshotPayload(
      inputs({
        riskMetrics: { dailyPnL: Number.NaN, currentExposure: Number.POSITIVE_INFINITY, maxDrawdown: Number.NaN },
        riskStatus: {},
        portfolio: { totalRealizedPnL: Number.NaN, totalUnrealizedPnL: 5, positionCount: 0 },
      }),
    );
    expect(snap.dailyPnlUsd).toBe(0);
    expect(snap.exposureUsd).toBe(0);
    expect(snap.maxDrawdownPct).toBe(0);
    expect(snap.realizedPnlUsd).toBe(0);
    expect(snap.riskUnitUsd).toBe(100); // 1% of the 10_000 anchor
    expect(snap.dailyPnlR).toBe(0);
    expect(snap.dayStartEquityUsd).toBe(10_000);
  });

  it('passes the live account block through in live mode only', () => {
    const liveAccount = { equityUsd: 2_500, quoteAvailableUsd: 2_000, feeTier: { name: 'Intro' }, fetchedAt: NOW, stale: false };
    const live = buildPnlSnapshotPayload(inputs({ mode: 'live', accountEquityUsd: 2_500, equityForSizingUsd: 2_512, session: { ...SESSION, sessionInitialEquityUsd: 2_500 }, liveAccount }));
    expect(live.liveAccount).toBe(liveAccount);
    expect(live.sessionStartEquityUsd).toBe(2_500);

    const paper = buildPnlSnapshotPayload(inputs({ liveAccount }));
    expect(paper.liveAccount).toBeNull();
  });
});
