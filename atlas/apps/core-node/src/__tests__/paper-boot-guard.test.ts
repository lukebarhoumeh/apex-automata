/**
 * Paper boot guard — Risk desk pins for the 2026-09-22 stand-down.
 *
 * Pins:
 *   1. Refuse a PAPER start (423 `PAPER_BOOT_RISK_LATCHED`) while
 *      `risk_metrics.kill_switch_active=true` OR an open halt `risk_events`
 *      row (`consecutive_losses`, `daily_stop`, `manual_killswitch`, ...) is
 *      persisted — unless the desk set `RISK_CLEAR=YES` (exact value).
 *   2. `PAPER_RESET_RISK_STATE_ON_START` is only honoured together with
 *      `RISK_CLEAR=YES`; alone it is ignored with a reason.
 *   3. Soft ladder rows (L1–L5 codes) and already-cleared rows never block.
 *   4. Unverifiable risk state (read error) fails closed (503) unless
 *      `RISK_CLEAR=YES`; a missing table is "nothing persisted".
 *   5. Reads are paper-scoped with the legacy unscoped fallback and only touch
 *      `risk_metrics` / `risk_events` (never a write).
 */
import { describe, test, expect, beforeEach, vi } from 'vitest';
import type { Logger } from '../core/logger';
import {
  PAPER_BOOT_REMEDIATION,
  evaluatePaperBootGuard,
  isOpenHaltRiskEvent,
  isRiskClearAuthorized,
  readPaperBootRiskState,
  resolvePaperResetRiskStateOnStart,
  runPaperBootGuard,
  type PaperBootRiskStateReads,
} from '../trading/risk/paper-boot-guard';

interface RecordedCall {
  table: string;
  op: 'select' | 'insert' | 'upsert' | 'update' | 'delete';
  payload?: unknown;
  filters: Array<[string, ...unknown[]]>;
}
type MockResponse = { data?: unknown; error?: { code?: string; message?: string } | null };
type Responder = (call: RecordedCall) => MockResponse;

const harness = vi.hoisted(() => ({
  calls: [] as RecordedCall[],
  responders: new Map<string, Responder>(),
  reset() {
    this.calls.length = 0;
    this.responders.clear();
  },
  respond(key: string, responder: Responder) {
    this.responders.set(key, responder);
  },
  callsFor(table: string, op?: RecordedCall['op']) {
    return this.calls.filter((c) => c.table === table && (op ? c.op === op : true));
  },
}));

vi.mock('@supabase/supabase-js', () => {
  const FILTER_METHODS = ['eq', 'neq', 'is', 'in', 'gte', 'lte', 'gt', 'lt', 'order', 'limit'];
  const OP_METHODS: RecordedCall['op'][] = ['select', 'insert', 'upsert', 'update', 'delete'];
  function makeBuilder(table: string) {
    const call: RecordedCall = { table, op: 'select', filters: [] };
    const builder: Record<string, unknown> = {};
    const resolve = (): MockResponse => {
      harness.calls.push(call);
      const responder = harness.responders.get(`${table}.${call.op}`);
      const response = responder ? responder(call) : {};
      return { data: response.data ?? null, error: response.error ?? null };
    };
    for (const name of FILTER_METHODS) {
      builder[name] = (...args: unknown[]) => {
        call.filters.push([name, ...args]);
        return builder;
      };
    }
    for (const op of OP_METHODS) {
      builder[op] = (payload?: unknown) => {
        call.op = op;
        call.payload = payload;
        return builder;
      };
    }
    builder.maybeSingle = () => Promise.resolve(resolve());
    builder.single = () => Promise.resolve(resolve());
    builder.then = (onFulfilled?: (v: MockResponse) => unknown, onRejected?: (e: unknown) => unknown) =>
      Promise.resolve(resolve()).then(onFulfilled, onRejected);
    return builder;
  }
  return { createClient: () => ({ from: (table: string) => makeBuilder(table) }) };
});

import { createClient } from '@supabase/supabase-js';

const USER_ID = 'b7e8f9c2-4d6a-4c8b-9e2d-1a3b5c7d9e1f';
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;

const NO_ENV: NodeJS.ProcessEnv = {};
const CLEAR_ENV: NodeJS.ProcessEnv = { RISK_CLEAR: 'YES' };

const emptyReads = (): PaperBootRiskStateReads => ({
  latestRiskMetrics: null,
  openRiskEvents: [],
  readErrors: [],
  missingTables: [],
});

const latchedMetrics = (over: Record<string, unknown> = {}) => ({
  user_id: USER_ID,
  kill_switch_active: true,
  consecutive_losses: 12,
  daily_pnl: -410.5,
  updated_at: '2026-09-22T19:04:11.000Z',
  execution_mode: 'paper',
  ...over,
});

const openEvent = (event_type: string, over: Record<string, unknown> = {}) => ({
  id: `evt-${event_type}`,
  user_id: USER_ID,
  event_type,
  details: { eventType: 'halt', reasonCode: event_type },
  active: true,
  triggered_at: '2026-09-22T19:04:10.000Z',
  cleared_at: null,
  execution_mode: 'paper',
  ...over,
});

describe('RISK_CLEAR authorisation', () => {
  test('only the exact value YES authorises', () => {
    expect(isRiskClearAuthorized({ RISK_CLEAR: 'YES' })).toBe(true);
    for (const value of ['yes', 'Yes', 'true', '1', 'Y', ' YES', 'YES ', '', undefined]) {
      expect(isRiskClearAuthorized({ RISK_CLEAR: value })).toBe(false);
    }
    expect(isRiskClearAuthorized({})).toBe(false);
  });

  test('CONFIRM_LIVE=YES is not a substitute for RISK_CLEAR', () => {
    expect(isRiskClearAuthorized({ CONFIRM_LIVE: 'YES' })).toBe(false);
  });
});

describe('PAPER_RESET_RISK_STATE_ON_START gate', () => {
  test('requested without RISK_CLEAR is NOT honoured and says why', () => {
    const gate = resolvePaperResetRiskStateOnStart({ PAPER_RESET_RISK_STATE_ON_START: 'true' });
    expect(gate).toMatchObject({ requested: true, authorized: false, honored: false });
    expect(gate.ignoredReason).toMatch(/PAPER_RESET_RISK_STATE_ON_START=true ignored: RISK_CLEAR=YES is not set/);
  });

  test('requested with RISK_CLEAR=YES is honoured', () => {
    expect(resolvePaperResetRiskStateOnStart({ PAPER_RESET_RISK_STATE_ON_START: 'true', RISK_CLEAR: 'YES' })).toEqual({
      requested: true,
      authorized: true,
      honored: true,
      ignoredReason: null,
    });
  });

  test('RISK_CLEAR alone never resets anything', () => {
    expect(resolvePaperResetRiskStateOnStart({ RISK_CLEAR: 'YES' })).toMatchObject({ requested: false, honored: false, ignoredReason: null });
    expect(resolvePaperResetRiskStateOnStart({ RISK_CLEAR: 'YES', PAPER_RESET_RISK_STATE_ON_START: 'false' })).toMatchObject({ honored: false });
  });

  test('the default (nothing set) is safe', () => {
    expect(resolvePaperResetRiskStateOnStart({})).toEqual({ requested: false, authorized: false, honored: false, ignoredReason: null });
  });
});

describe('isOpenHaltRiskEvent()', () => {
  test('open halt codes count', () => {
    for (const code of ['consecutive_losses', 'daily_stop', 'manual_killswitch', 'max_drawdown', 'leverage_breach', 'data_gap', 'unknown']) {
      expect(isOpenHaltRiskEvent(openEvent(code))).toBe(true);
    }
  });

  test('soft ladder rungs never count', () => {
    for (const code of ['size_down_consec', 'size_down_daily_r', 'strategy_freeze', 'regime_pause', 'sleeve_halt']) {
      expect(isOpenHaltRiskEvent(openEvent(code, { details: { eventType: 'ladder', ladderLevel: 2 } }))).toBe(false);
    }
  });

  test('cleared, retired, resume-audit and malformed rows never count', () => {
    expect(isOpenHaltRiskEvent(openEvent('consecutive_losses', { cleared_at: '2026-09-22T20:00:00.000Z' }))).toBe(false);
    expect(isOpenHaltRiskEvent(openEvent('consecutive_losses', { active: false }))).toBe(false);
    expect(isOpenHaltRiskEvent(openEvent('consecutive_losses', { details: { eventType: 'resume' } }))).toBe(false);
    expect(isOpenHaltRiskEvent(openEvent('', {}))).toBe(false);
    expect(isOpenHaltRiskEvent({ event_type: null })).toBe(false);
  });
});

describe('evaluatePaperBootGuard() — refuse-boot pin', () => {
  test('kill_switch_active=true refuses with 423 PAPER_BOOT_RISK_LATCHED and a clear error', () => {
    const verdict = evaluatePaperBootGuard({ mode: 'paper', env: NO_ENV, reads: { ...emptyReads(), latestRiskMetrics: latchedMetrics() } });
    expect(verdict.allowed).toBe(false);
    expect(verdict.code).toBe('PAPER_BOOT_RISK_LATCHED');
    expect(verdict.httpStatus).toBe(423);
    expect(verdict.riskClearAuthorized).toBe(false);
    expect(verdict.blockers).toEqual([
      { kind: 'kill_switch_active', source: 'risk_metrics', updatedAt: '2026-09-22T19:04:11.000Z', consecutiveLosses: 12, dailyPnl: -410.5 },
    ]);
    expect(verdict.error).toMatch(/PAPER start refused: persisted paper risk state is latched \(risk_metrics\.kill_switch_active=true\)/);
    expect(verdict.error).toMatch(/set RISK_CLEAR=YES/);
    expect(verdict.remediation).toBe(PAPER_BOOT_REMEDIATION);
  });

  test('an open consecutive_losses halt row refuses even when risk_metrics is clean', () => {
    const verdict = evaluatePaperBootGuard({
      mode: 'paper',
      env: NO_ENV,
      reads: {
        ...emptyReads(),
        latestRiskMetrics: latchedMetrics({ kill_switch_active: false, consecutive_losses: 0 }),
        openRiskEvents: [openEvent('consecutive_losses', { details: { eventType: 'halt', reasonCode: 'consecutive_losses', ladderLevel: 6 } })],
      },
    });
    expect(verdict.allowed).toBe(false);
    expect(verdict.code).toBe('PAPER_BOOT_RISK_LATCHED');
    expect(verdict.blockers).toEqual([
      { kind: 'active_halt_event', source: 'risk_events', id: 'evt-consecutive_losses', eventType: 'consecutive_losses', triggeredAt: '2026-09-22T19:04:10.000Z', ladderLevel: 6 },
    ]);
    expect(verdict.error).toMatch(/active halt risk_events: consecutive_losses/);
  });

  test('an open manual_killswitch row written while the engine was down (no latch in risk_metrics) refuses', () => {
    const verdict = evaluatePaperBootGuard({
      mode: 'paper',
      env: NO_ENV,
      reads: { ...emptyReads(), openRiskEvents: [openEvent('manual_killswitch', { details: { reason: 'User activated kill switch' } })] },
    });
    expect(verdict).toMatchObject({ allowed: false, code: 'PAPER_BOOT_RISK_LATCHED', httpStatus: 423 });
    expect(verdict.blockers.map((b) => b.kind)).toEqual(['active_halt_event']);
  });

  test('latch AND halt rows are all reported (dedup by code in the message)', () => {
    const verdict = evaluatePaperBootGuard({
      mode: 'paper',
      env: NO_ENV,
      reads: {
        ...emptyReads(),
        latestRiskMetrics: latchedMetrics(),
        openRiskEvents: [openEvent('consecutive_losses'), openEvent('daily_stop'), openEvent('consecutive_losses', { id: 'evt-older' })],
      },
    });
    expect(verdict.allowed).toBe(false);
    expect(verdict.blockers).toHaveLength(4);
    expect(verdict.error).toMatch(/risk_metrics\.kill_switch_active=true; active halt risk_events: consecutive_losses, daily_stop/);
  });

  test('only soft ladder rows open -> allowed (the in-memory ladder re-derives them)', () => {
    const verdict = evaluatePaperBootGuard({
      mode: 'paper',
      env: NO_ENV,
      reads: {
        ...emptyReads(),
        latestRiskMetrics: latchedMetrics({ kill_switch_active: false, consecutive_losses: 4 }),
        openRiskEvents: [
          openEvent('size_down_consec', { details: { eventType: 'ladder', ladderLevel: 1 } }),
          openEvent('strategy_freeze', { details: { eventType: 'ladder', strategy: 'trend_follow' } }),
          openEvent('regime_pause', { details: { eventType: 'ladder', strategy: 'trend_follow', regime: 'choppy' } }),
        ],
      },
    });
    expect(verdict).toMatchObject({ allowed: true, code: 'PAPER_BOOT_ALLOWED', httpStatus: 200, error: null, blockers: [] });
  });

  test('cleared halt rows (cleared_at set or active=false) do not block', () => {
    const verdict = evaluatePaperBootGuard({
      mode: 'paper',
      env: NO_ENV,
      reads: {
        ...emptyReads(),
        latestRiskMetrics: latchedMetrics({ kill_switch_active: false }),
        openRiskEvents: [openEvent('daily_stop', { cleared_at: '2026-09-22T00:00:01.000Z' }), openEvent('consecutive_losses', { active: false })],
      },
    });
    expect(verdict).toMatchObject({ allowed: true, code: 'PAPER_BOOT_ALLOWED', blockers: [] });
  });

  test('clean state -> allowed', () => {
    expect(evaluatePaperBootGuard({ mode: 'paper', env: NO_ENV, reads: emptyReads() })).toMatchObject({
      allowed: true,
      code: 'PAPER_BOOT_ALLOWED',
      httpStatus: 200,
      riskClearAuthorized: false,
    });
    expect(
      evaluatePaperBootGuard({ mode: 'paper', env: NO_ENV, reads: { ...emptyReads(), latestRiskMetrics: latchedMetrics({ kill_switch_active: false }) } }),
    ).toMatchObject({ allowed: true, code: 'PAPER_BOOT_ALLOWED' });
  });

  test('a previous-day latch still refuses (a latch is a latch until CLEAR)', () => {
    const verdict = evaluatePaperBootGuard({
      mode: 'paper',
      env: NO_ENV,
      reads: { ...emptyReads(), latestRiskMetrics: latchedMetrics({ updated_at: '2026-09-20T03:00:00.000Z' }) },
    });
    expect(verdict).toMatchObject({ allowed: false, code: 'PAPER_BOOT_RISK_LATCHED' });
  });

  test('RISK_CLEAR=YES overrides a latch (allowed, code names the override, blockers still reported)', () => {
    const verdict = evaluatePaperBootGuard({
      mode: 'paper',
      env: CLEAR_ENV,
      reads: { ...emptyReads(), latestRiskMetrics: latchedMetrics(), openRiskEvents: [openEvent('consecutive_losses')] },
    });
    expect(verdict.allowed).toBe(true);
    expect(verdict.code).toBe('PAPER_BOOT_RISK_CLEAR_OVERRIDE');
    expect(verdict.httpStatus).toBe(200);
    expect(verdict.riskClearAuthorized).toBe(true);
    expect(verdict.blockers).toHaveLength(2);
    expect(verdict.error).toMatch(/proceeding under RISK_CLEAR=YES/);
  });

  test('a wrong RISK_CLEAR value is not an override', () => {
    for (const value of ['yes', 'true', '1']) {
      const verdict = evaluatePaperBootGuard({ mode: 'paper', env: { RISK_CLEAR: value }, reads: { ...emptyReads(), latestRiskMetrics: latchedMetrics() } });
      expect(verdict).toMatchObject({ allowed: false, code: 'PAPER_BOOT_RISK_LATCHED', riskClearAuthorized: false });
    }
  });

  test('live mode is not the guard\'s business (CONFIRM_LIVE path is untouched)', () => {
    const verdict = evaluatePaperBootGuard({ mode: 'live', env: NO_ENV, reads: { ...emptyReads(), latestRiskMetrics: latchedMetrics() } });
    expect(verdict).toMatchObject({ allowed: true, code: 'PAPER_BOOT_NOT_APPLICABLE', blockers: [] });
  });

  test('unreadable risk state fails closed (503 PAPER_BOOT_RISK_STATE_UNVERIFIED) without RISK_CLEAR', () => {
    const verdict = evaluatePaperBootGuard({
      mode: 'paper',
      env: NO_ENV,
      reads: { ...emptyReads(), readErrors: [{ table: 'risk_metrics', code: null, message: 'TypeError: fetch failed' }] },
    });
    expect(verdict.allowed).toBe(false);
    expect(verdict.code).toBe('PAPER_BOOT_RISK_STATE_UNVERIFIED');
    expect(verdict.httpStatus).toBe(503);
    expect(verdict.error).toMatch(/could not be verified \(risk_metrics: TypeError: fetch failed\)/);
  });

  test('unreadable risk state with RISK_CLEAR=YES proceeds with a warning', () => {
    const verdict = evaluatePaperBootGuard({
      mode: 'paper',
      env: CLEAR_ENV,
      reads: { ...emptyReads(), readErrors: [{ table: 'risk_events', code: '500', message: 'boom' }] },
    });
    expect(verdict.allowed).toBe(true);
    expect(verdict.code).toBe('PAPER_BOOT_ALLOWED');
    expect(verdict.warnings[0]).toMatch(/could not be fully read \(risk_events \[500\]: boom\); proceeding under RISK_CLEAR=YES/);
  });

  test('a missing table is "nothing persisted" (allowed, warned)', () => {
    const verdict = evaluatePaperBootGuard({ mode: 'paper', env: NO_ENV, reads: { ...emptyReads(), missingTables: ['risk_events'] } });
    expect(verdict).toMatchObject({ allowed: true, code: 'PAPER_BOOT_ALLOWED' });
    expect(verdict.warnings).toEqual(['risk_events table not present on this snapshot; nothing persisted there to latch']);
  });
});

describe('readPaperBootRiskState() / runPaperBootGuard() — Supabase reads', () => {
  beforeEach(() => {
    harness.reset();
    vi.clearAllMocks();
  });

  const client = () => createClient('http://localhost:54321', 'test-key');

  test('reads the newest paper risk_metrics row and the open paper risk_events rows; read-only', async () => {
    harness.respond('risk_metrics.select', () => ({ data: latchedMetrics() }));
    harness.respond('risk_events.select', () => ({ data: [openEvent('consecutive_losses')] }));

    const reads = await readPaperBootRiskState(client(), { userId: USER_ID, logger });

    expect(reads.latestRiskMetrics).toMatchObject({ kill_switch_active: true });
    expect(reads.openRiskEvents).toHaveLength(1);
    expect(reads.readErrors).toEqual([]);
    expect(reads.missingTables).toEqual([]);

    const metricsRead = harness.callsFor('risk_metrics', 'select')[0];
    expect(metricsRead.filters).toEqual(
      expect.arrayContaining([
        ['eq', 'user_id', USER_ID],
        ['eq', 'execution_mode', 'paper'],
        ['order', 'updated_at', { ascending: false }],
        ['limit', 1],
      ]),
    );
    const eventsRead = harness.callsFor('risk_events', 'select')[0];
    expect(eventsRead.filters).toEqual(
      expect.arrayContaining([
        ['eq', 'user_id', USER_ID],
        ['is', 'cleared_at', null],
        ['eq', 'execution_mode', 'paper'],
      ]),
    );
    for (const call of harness.calls) {
      expect(call.op).toBe('select');
      expect(['risk_metrics', 'risk_events']).toContain(call.table);
    }
  });

  test('falls back to the unscoped legacy shape when execution_mode is missing (pre-migration snapshot)', async () => {
    harness.respond('risk_metrics.select', (call) =>
      call.filters.some(([m, col]) => m === 'eq' && col === 'execution_mode')
        ? { error: { code: '42703', message: 'column risk_metrics.execution_mode does not exist' } }
        : { data: latchedMetrics({ execution_mode: undefined }) },
    );
    harness.respond('risk_events.select', (call) =>
      call.filters.some(([m, col]) => m === 'eq' && col === 'execution_mode')
        ? { error: { code: '42703', message: 'column risk_events.execution_mode does not exist' } }
        : { data: [] },
    );

    const reads = await readPaperBootRiskState(client(), { userId: USER_ID, logger });

    expect(reads.readErrors).toEqual([]);
    expect(reads.latestRiskMetrics).toMatchObject({ kill_switch_active: true });
    expect(harness.callsFor('risk_metrics', 'select')).toHaveLength(2);
    expect(harness.callsFor('risk_events', 'select')).toHaveLength(2);
    expect(logger.warn).toHaveBeenCalledWith(
      'risk_metrics.execution_mode unavailable; falling back to unscoped legacy persistence',
      expect.objectContaining({ table: 'risk_metrics' }),
    );
  });

  test('PGRST116 (no row) is nothing persisted; a missing table is recorded, not an error', async () => {
    harness.respond('risk_metrics.select', () => ({ error: { code: 'PGRST116', message: 'no rows' } }));
    harness.respond('risk_events.select', () => ({ error: { code: 'PGRST205', message: 'relation "risk_events" does not exist' } }));

    const reads = await readPaperBootRiskState(client(), { userId: USER_ID, logger });

    expect(reads.latestRiskMetrics).toBeNull();
    expect(reads.openRiskEvents).toEqual([]);
    expect(reads.readErrors).toEqual([]);
    expect(reads.missingTables).toEqual(['risk_events']);
  });

  test('a real read failure is captured (never thrown) and makes the verdict fail closed', async () => {
    harness.respond('risk_metrics.select', () => ({ error: { code: '500', message: 'TypeError: fetch failed' } }));
    harness.respond('risk_events.select', () => ({ data: [] }));

    const verdict = await runPaperBootGuard(client(), { userId: USER_ID, mode: 'paper', logger, env: NO_ENV });

    expect(verdict).toMatchObject({ allowed: false, code: 'PAPER_BOOT_RISK_STATE_UNVERIFIED', httpStatus: 503 });
    expect(verdict.error).toMatch(/risk_metrics \[500\]: TypeError: fetch failed/);
  });

  test('runPaperBootGuard(): latched prod-like state refuses; RISK_CLEAR=YES lets it through', async () => {
    harness.respond('risk_metrics.select', () => ({ data: latchedMetrics() }));
    harness.respond('risk_events.select', () => ({
      data: [
        openEvent('size_down_consec', { details: { eventType: 'ladder', ladderLevel: 2 } }),
        openEvent('consecutive_losses', { details: { eventType: 'halt', reasonCode: 'consecutive_losses', ladderLevel: 6 } }),
      ],
    }));

    const refused = await runPaperBootGuard(client(), { userId: USER_ID, mode: 'paper', logger, env: NO_ENV });
    expect(refused.allowed).toBe(false);
    expect(refused.code).toBe('PAPER_BOOT_RISK_LATCHED');
    expect(refused.blockers.map((b) => b.kind)).toEqual(['kill_switch_active', 'active_halt_event']);

    const overridden = await runPaperBootGuard(client(), { userId: USER_ID, mode: 'paper', logger, env: CLEAR_ENV });
    expect(overridden.allowed).toBe(true);
    expect(overridden.code).toBe('PAPER_BOOT_RISK_CLEAR_OVERRIDE');
  });

  test('runPaperBootGuard(): live mode never touches Supabase', async () => {
    const verdict = await runPaperBootGuard(client(), { userId: USER_ID, mode: 'live', logger, env: NO_ENV });
    expect(verdict.code).toBe('PAPER_BOOT_NOT_APPLICABLE');
    expect(harness.calls).toHaveLength(0);
  });
});
