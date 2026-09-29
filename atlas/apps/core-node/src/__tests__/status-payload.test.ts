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
import {
  STATUS_PAYLOAD_REQUIRED_KEYS,
  buildPersistenceBlock,
  buildStatusPayload,
  StatusPayloadInputs,
  type StatusPersistenceBlock,
} from '../api/status-payload';
import { buildPnlSnapshotPayload } from '../api/pnl-snapshot';

const NOW = Date.parse('2026-09-11T17:30:00.000Z');
const SESSION_ID = 'sess_1757606400000_ab12cd';
const STARTED_AT = Date.parse('2026-09-11T16:00:00.000Z');

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
    expect(payload.sessionStartedAt).toBe(STARTED_AT);
    expect(payload.session).toEqual({ id: SESSION_ID, startedAt: STARTED_AT, mode: 'paper', initialEquityUsd: 10_000 });
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

  it('paperHardStop (handoff P5) rides along for a running PAPER session, is null when stopped, and NEVER for live', () => {
    const snapshot = {
      enabled: true,
      nextFireAtIso: '2026-09-30T03:30:00.000Z',
      nextFireAtMs: Date.parse('2026-09-30T03:30:00.000Z'),
      timezone: 'America/Chicago',
      localTime: '22:30',
      reason: 'paper_hard_stop_22_30_ct',
    };
    const paper = buildStatusPayload({
      runtime: runtime({ sessionId: SESSION_ID, sessionStartedAt: STARTED_AT, sessionMode: 'paper' }),
      supervisor: supervisor(),
      engine: { running: true, mode: 'paper', engineState: 'running', activeSymbols: [] },
      pnl: pnl(SESSION_ID, STARTED_AT),
      liveAccount: null,
      paperHardStop: snapshot,
      now: NOW,
    });
    expect(paper.paperHardStop).toEqual(snapshot);
    expect(STATUS_PAYLOAD_REQUIRED_KEYS).toContain('paperHardStop');

    const stopped = buildStatusPayload({
      runtime: runtime(),
      supervisor: supervisor({ engineDesiredState: 'stopped' }),
      engine: { running: false, mode: null, engineState: 'stopped', activeSymbols: [] },
      pnl: null,
      liveAccount: null,
      paperHardStop: snapshot,
      now: NOW,
    });
    expect(stopped).toHaveProperty('paperHardStop', null);

    // Callers that predate the field still get the key (null).
    const legacy = buildStatusPayload({
      runtime: runtime({ sessionId: SESSION_ID, sessionStartedAt: STARTED_AT, sessionMode: 'paper' }),
      supervisor: supervisor(),
      engine: { running: true, mode: 'paper', engineState: 'running', activeSymbols: [] },
      pnl: pnl(SESSION_ID, STARTED_AT),
      liveAccount: null,
      now: NOW,
    });
    expect(legacy).toHaveProperty('paperHardStop', null);

    const live = buildStatusPayload({
      runtime: runtime({ sessionId: SESSION_ID, sessionStartedAt: STARTED_AT, sessionMode: 'live' }),
      supervisor: supervisor(),
      engine: { running: true, mode: 'live', engineState: 'running', activeSymbols: [] },
      pnl: null,
      liveAccount: { equityUsd: 1 },
      paperHardStop: snapshot,
      now: NOW,
    });
    expect(live.paperHardStop).toBeNull();
  });

  describe('persistence health block (round 3, task G)', () => {
    const POSITION_ID = '0f1e2d3c-4b5a-4697-8877-665544332211';
    const restamp = {
      outcome: 'restamped' as const,
      sessionId: SESSION_ID,
      hydrated: 2,
      restamped: 1,
      alreadyCurrent: 0,
      foreign: 1,
      rows: [{ id: POSITION_ID, symbol: 'ETH-USD', fromSessionId: 'sess_prev_1', fromExecutionMode: 'paper' }],
      foreignRows: [{ id: 'other', symbol: 'BTC-USD', fromSessionId: 'sess_live', fromExecutionMode: 'live' }],
      error: null,
    };
    const reconcile = {
      at: NOW - 2_000,
      dbOpenCount: 2,
      engineOpenCount: 1,
      inDbNotEngine: ['SOL-USD'],
      inEngineNotDb: [],
      foreignModeOpen: 1,
      foreignModeSymbols: ['BTC-USD'],
      foreignModes: ['live'],
      modeScoped: true,
      note: 'mismatch — exchange reconciler + next ticker/fill will repair drift',
    };
    const closeWriteFailures = {
      count: 1,
      last: { positionId: POSITION_ID, symbol: 'ETH-USD', sessionId: SESSION_ID, at: NOW - 1_000, attempts: 5, code: '08006', error: 'connection failure' },
    };
    const orderLinks = { linked: 3, pending: 1, failed: 0, disabled: false };

    function block(): StatusPersistenceBlock {
      return buildPersistenceBlock({
        sessionId: SESSION_ID,
        executionMode: 'paper',
        hydrateRestamp: restamp,
        reconcile,
        closeWriteFailures,
        orderLinks,
      });
    }

    it('buildPersistenceBlock projects the restamp / reconcile / sequencer / linker facts onto the wire shape', () => {
      expect(block()).toEqual({
        sessionId: SESSION_ID,
        executionMode: 'paper',
        hydrateRestamp: {
          outcome: 'restamped',
          hydrated: 2,
          restamped: 1,
          alreadyCurrent: 0,
          foreign: 1,
          symbols: ['ETH-USD'],
          fromSessionIds: ['sess_prev_1'],
          error: null,
        },
        reconcile: {
          at: NOW - 2_000,
          modeScoped: true,
          dbOpenCount: 2,
          engineOpenCount: 1,
          inDbNotEngine: ['SOL-USD'],
          inEngineNotDb: [],
          foreignModeOpen: 1,
          foreignModeSymbols: ['BTC-USD'],
          note: 'mismatch — exchange reconciler + next ticker/fill will repair drift',
        },
        closeWriteFailures,
        orderLinks,
      });
    });

    it('a start with nothing hydrated / no reconcile yet reports nulls, and a restamp error is a message not an object', () => {
      const built = buildPersistenceBlock({
        sessionId: SESSION_ID,
        executionMode: 'paper',
        hydrateRestamp: { ...restamp, outcome: 'error', rows: [], restamped: 0, error: { code: '42501', message: 'permission denied for table positions' } },
        reconcile: null,
        closeWriteFailures: { count: 0, last: null },
        orderLinks: { linked: 0, pending: 0, failed: 0, disabled: false },
      });
      expect(built.hydrateRestamp).toMatchObject({ outcome: 'error', restamped: 0, symbols: [], fromSessionIds: [], error: '42501: permission denied for table positions' });
      expect(built.reconcile).toBeNull();
      expect(built.closeWriteFailures).toEqual({ count: 0, last: null });

      const none = buildPersistenceBlock({
        sessionId: SESSION_ID,
        executionMode: 'paper',
        hydrateRestamp: null,
        reconcile: null,
        closeWriteFailures: { count: 0, last: null },
        orderLinks: { linked: 0, pending: 0, failed: 0, disabled: true },
      });
      expect(none.hydrateRestamp).toBeNull();
      expect(none.orderLinks.disabled).toBe(true);
    });

    it('`persistence` is a required key: null when stopped (even if supplied), the block while running, null for legacy callers', () => {
      expect(STATUS_PAYLOAD_REQUIRED_KEYS).toContain('persistence');

      const stopped = buildStatusPayload({
        runtime: runtime(),
        supervisor: supervisor({ engineDesiredState: 'stopped' }),
        engine: { running: false, mode: null, engineState: 'stopped', activeSymbols: [] },
        pnl: null,
        liveAccount: null,
        persistence: block(),
        now: NOW,
      });
      expect(stopped).toHaveProperty('persistence', null);

      const running = buildStatusPayload({
        runtime: runtime({ sessionId: SESSION_ID, sessionStartedAt: STARTED_AT, sessionMode: 'paper', sessionInitialEquity: 10_000 }),
        supervisor: supervisor(),
        engine: { running: true, mode: 'paper', engineState: 'running', activeSymbols: ['ETH-USD'] },
        pnl: pnl(SESSION_ID, STARTED_AT),
        liveAccount: null,
        persistence: block(),
        now: NOW,
      });
      expect(running.persistence).toEqual(block());
      expect(running.persistence?.sessionId).toBe(running.sessionId);
      expect(running.persistence?.closeWriteFailures.count).toBe(1);
      expect(running.persistence?.orderLinks).toEqual(orderLinks);

      const legacy = buildStatusPayload({
        runtime: runtime({ sessionId: SESSION_ID, sessionStartedAt: STARTED_AT, sessionMode: 'paper' }),
        supervisor: supervisor(),
        engine: { running: true, mode: 'paper', engineState: 'running', activeSymbols: [] },
        pnl: pnl(SESSION_ID, STARTED_AT),
        liveAccount: null,
        now: NOW,
      });
      expect(legacy).toHaveProperty('persistence', null);
    });

    it('carries the same block for a running LIVE session (read-only diagnostics, same semantics)', () => {
      const live = buildStatusPayload({
        runtime: runtime({ sessionId: SESSION_ID, sessionStartedAt: STARTED_AT, sessionMode: 'live' }),
        supervisor: supervisor(),
        engine: { running: true, mode: 'live', engineState: 'running', activeSymbols: [] },
        pnl: null,
        liveAccount: { equityUsd: 1 },
        persistence: { ...block(), executionMode: 'live' },
        now: NOW,
      });
      expect(live.persistence?.executionMode).toBe('live');
      expect(live.persistence?.orderLinks).toEqual(orderLinks);
    });
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
    expect([paused.sessionStartedAt, resumed.sessionStartedAt]).toEqual([STARTED_AT, STARTED_AT]);
    expect(Object.keys(paused).sort()).toEqual(Object.keys(resumed).sort());
  });
});
