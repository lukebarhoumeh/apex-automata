/**
 * FE contract #4 — stable session window on /api/status and every WS
 * StatusUpdate (api/status-payload.ts).
 *
 * One builder feeds REST, the periodic broadcast, the on-connect send and the
 * pause/resume broadcasts. These tests pin what the UI merge relies on:
 * `sessionId` / `sessionStartedAt` / `pnl` keys are always present, `pnl` is
 * the full canonical snapshot or null, and `pnl.sessionId` equals `sessionId`.
 */

import { describe, it, expect } from 'vitest';
import { STATUS_PAYLOAD_REQUIRED_KEYS, buildStatusPayload, StatusPayloadInputs } from '../api/status-payload';
import { buildPnlSnapshotPayload } from '../api/pnl-snapshot';

const NOW = Date.parse('2026-09-11T17:30:00.000Z');
const SESSION_ID = 'sess_1757606400000_ab12cd';
const STARTED_AT = Date.parse('2026-09-11T16:00:00.000Z');
/** FE PR1 #4: `sessionStartedAt` is an ISO-8601 UTC string on the wire, never epoch ms. */
const STARTED_AT_ISO = '2026-09-11T16:00:00.000Z';

const KILL_SWITCH_OFF = { active: false, reasons: [], since: null };

function runtime(overrides: Partial<StatusPayloadInputs['runtime']> = {}): StatusPayloadInputs['runtime'] {
  return {
    paused: false,
    dailyStopHit: false,
    killSwitch: KILL_SWITCH_OFF,
    wsLatencyMs: 12,
    restLatencyMs: 40,
    spreadPctile: 0.3,
    regime: 'chop',
    risk: { exposureUsd: 0, dailyPnLUsd: 0, maxDrawdownPct: 0, killSwitchActive: false },
    warmupComplete: true,
    candlesBuffered: { 'ETH-USD': 300 },
    sessionId: null,
    sessionStartedAt: null,
    sessionMode: null,
    sessionInitialEquity: null,
    ...overrides,
  };
}

function supervisor(overrides: Partial<StatusPayloadInputs['supervisor']> = {}): StatusPayloadInputs['supervisor'] {
  return {
    runtimeAlive: true,
    engineDesiredState: 'running',
    lastMarketDataAt: NOW - 500,
    lastEngineHeartbeatAt: NOW - 200,
    restartCount: 0,
    lastRestartReason: null,
    lastRestartAt: null,
    killSwitch: KILL_SWITCH_OFF,
    ...overrides,
  };
}

function pnl(sessionId: string | null, sessionStartedAt: number | null) {
  return buildPnlSnapshotPayload({
    mode: 'paper',
    userId: 'user-1',
    session: { sessionId, sessionStartedAt, sessionInitialEquityUsd: 10_000 },
    accountEquityUsd: 10_000,
    equityForSizingUsd: 10_042.5,
    riskMetrics: { dailyPnL: 42.5, currentExposure: 0, maxDrawdown: 0 },
    riskStatus: { riskUnitUsd: 50 },
    portfolio: { totalRealizedPnL: 42.5, totalUnrealizedPnL: 0, positionCount: 0 },
    liveAccount: null,
    now: NOW,
  });
}

describe('buildStatusPayload', () => {
  it('stopped: every required key is present, session fields are null, pnl is null (not a partial object)', () => {
    const payload = buildStatusPayload({
      runtime: runtime(),
      supervisor: supervisor({ engineDesiredState: 'stopped' }),
      engine: { running: false, mode: null, engineState: 'stopped', activeSymbols: [] },
      pnl: null,
      liveAccount: null,
      now: NOW,
    });

    for (const key of STATUS_PAYLOAD_REQUIRED_KEYS) expect(payload, key).toHaveProperty(key);
    expect(payload).toMatchObject({
      engineRunning: false,
      mode: null,
      sessionId: null,
      sessionStartedAt: null,
      session: { id: null, startedAt: null, mode: null, initialEquityUsd: null },
      pnl: null,
      liveAccount: null,
      engineState: 'stopped',
      engineDesiredState: 'stopped',
      timestamp: NOW,
    });
  });

  it('running: session window rides along and pnl.sessionId equals sessionId', () => {
    const payload = buildStatusPayload({
      runtime: runtime({ sessionId: SESSION_ID, sessionStartedAt: STARTED_AT, sessionMode: 'paper', sessionInitialEquity: 10_000 }),
      supervisor: supervisor(),
      engine: { running: true, mode: 'paper', engineState: 'running', activeSymbols: ['ETH-USD'] },
      pnl: pnl(SESSION_ID, STARTED_AT),
      liveAccount: null,
      now: NOW,
    });

    expect(payload.sessionId).toBe(SESSION_ID);
    expect(payload.sessionStartedAt).toBe(STARTED_AT_ISO);
    expect(typeof payload.sessionStartedAt).toBe('string');
    expect(payload.session).toEqual({ id: SESSION_ID, startedAt: STARTED_AT_ISO, mode: 'paper', initialEquityUsd: 10_000 });
    expect(payload.pnl?.sessionId).toBe(payload.sessionId);
    expect(payload.pnl?.sessionStartedAt).toBe(payload.sessionStartedAt);
    expect(payload.pnl?.totalEquityUsd).toBe(10_042.5);
    expect(payload.mode).toBe('paper');
    expect(payload.activeSymbols).toEqual(['ETH-USD']);
  });

  it('never leaks a snapshot when the engine is not running, and never a live block in paper', () => {
    const payload = buildStatusPayload({
      runtime: runtime(),
      supervisor: supervisor(),
      engine: { running: false, mode: null, engineState: 'stopped', activeSymbols: [] },
      pnl: pnl(null, null),
      liveAccount: { equityUsd: 1 },
      now: NOW,
    });
    expect(payload.pnl).toBeNull();
    expect(payload.liveAccount).toBeNull();

    const paper = buildStatusPayload({
      runtime: runtime({ sessionId: SESSION_ID, sessionStartedAt: STARTED_AT, sessionMode: 'paper' }),
      supervisor: supervisor(),
      engine: { running: true, mode: 'paper', engineState: 'running', activeSymbols: [] },
      pnl: pnl(SESSION_ID, STARTED_AT),
      liveAccount: { equityUsd: 1 },
      now: NOW,
    });
    expect(paper.liveAccount).toBeNull();
  });

  it('a supervisor-tripped kill switch takes precedence over stale runtime state', () => {
    const tripped = { active: true, reasons: ['heartbeat lost'], since: NOW - 1_000 };
    const payload = buildStatusPayload({
      runtime: runtime({ killSwitch: KILL_SWITCH_OFF }),
      supervisor: supervisor({ killSwitch: tripped }),
      engine: { running: true, mode: 'paper', engineState: 'halted', activeSymbols: [] },
      pnl: null,
      liveAccount: null,
      now: NOW,
    });
    expect(payload.killSwitch).toBe(tripped);
  });

  it('pause/resume-style emits (same builder, paused toggled) keep the session window identical', () => {
    const base = { sessionId: SESSION_ID, sessionStartedAt: STARTED_AT, sessionMode: 'paper' as const, sessionInitialEquity: 10_000 };
    const engine = { running: true, mode: 'paper' as const, engineState: 'running' as const, activeSymbols: ['ETH-USD'] };
    const snapshot = pnl(SESSION_ID, STARTED_AT);

    const paused = buildStatusPayload({ runtime: runtime({ ...base, paused: true }), supervisor: supervisor(), engine, pnl: snapshot, liveAccount: null, now: NOW });
    const resumed = buildStatusPayload({ runtime: runtime({ ...base, paused: false }), supervisor: supervisor(), engine, pnl: snapshot, liveAccount: null, now: NOW + 1 });

    expect(paused.paused).toBe(true);
    expect(resumed.paused).toBe(false);
    expect([paused.sessionId, resumed.sessionId]).toEqual([SESSION_ID, SESSION_ID]);
    expect([paused.sessionStartedAt, resumed.sessionStartedAt]).toEqual([STARTED_AT_ISO, STARTED_AT_ISO]);
    expect(Object.keys(paused).sort()).toEqual(Object.keys(resumed).sort());
  });

  it('exposes the pnl block fields the FE types (realizedPnlUsd, unrealizedPnlUsd, totalEquityUsd, dailyPnlUsd, dailyPnlR, openPositionsCount, exposureUsd)', () => {
    const payload = buildStatusPayload({
      runtime: runtime({ sessionId: SESSION_ID, sessionStartedAt: STARTED_AT, sessionMode: 'paper', sessionInitialEquity: 10_000 }),
      supervisor: supervisor(),
      engine: { running: true, mode: 'paper', engineState: 'running', activeSymbols: [] },
      pnl: pnl(SESSION_ID, STARTED_AT),
      liveAccount: null,
      now: NOW,
    });
    for (const key of ['realizedPnlUsd', 'unrealizedPnlUsd', 'totalEquityUsd', 'dailyPnlUsd', 'dailyPnlR', 'openPositionsCount', 'exposureUsd'] as const) {
      expect(typeof payload.pnl?.[key], key).toBe('number');
    }
    expect(payload.pnl?.totalEquityUsd).toBe(10_042.5);
  });
});
