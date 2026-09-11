/**
 * FE contract #1 — session scoping for GET /api/orders|fills|signals|positions
 * (api/session-scope.ts).
 *
 * Pins:
 *   - query validation (session_id shape, execution_mode enum, limit clamp, status);
 *   - the active session window comes from runtime state, past sessions from
 *     their trading_sessions row;
 *   - with the stamp columns present the read filters on session_id (plus
 *     unstamped rows inside the window); without them it uses the interim
 *     `<time col> >= started_at [<= ended_at]` window — and falls back from the
 *     first to the second exactly once when PostgREST reports the column missing;
 *   - the `scope` block tells the UI which filter was applied.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  SESSION_SCOPE_TIME_COLUMN,
  activeSessionWindow,
  applySessionScope,
  buildSessionScopeMeta,
  parseSessionScopeQuery,
  readWithSessionScope,
  sessionWindowFromRow,
  SessionScopeBuilder,
  SessionWindow,
} from '../api/session-scope';
import { SessionColumnSupport } from '../persistence/session-stamp';

const USER_ID = 'b7e8f9c2-4d6a-4c8b-9e2d-1a3b5c7d9e1f';
const STARTED_AT = Date.parse('2026-09-11T16:00:00.000Z');
const ENDED_AT = Date.parse('2026-09-11T18:30:00.000Z');

const ACTIVE: SessionWindow = {
  sessionId: 'sess_1757606400000_ab12cd',
  executionMode: 'paper',
  startedAt: STARTED_AT,
  endedAt: null,
  isActive: true,
};

/** Records every builder call in order so the exact PostgREST shape can be asserted. */
class FakeBuilder implements SessionScopeBuilder<FakeBuilder> {
  public readonly calls: Array<[string, ...unknown[]]> = [];
  eq(column: string, value: unknown) { this.calls.push(['eq', column, value]); return this; }
  gte(column: string, value: unknown) { this.calls.push(['gte', column, value]); return this; }
  lte(column: string, value: unknown) { this.calls.push(['lte', column, value]); return this; }
  is(column: string, value: null) { this.calls.push(['is', column, value]); return this; }
  not(column: string, operator: string, value: unknown) { this.calls.push(['not', column, operator, value]); return this; }
  or(filters: string) { this.calls.push(['or', filters]); return this; }
  order(column: string, options: { ascending: boolean }) { this.calls.push(['order', column, options]); return this; }
  limit(count: number) { this.calls.push(['limit', count]); return this; }
}

describe('parseSessionScopeQuery', () => {
  it('defaults to the active session, no mode assertion, default limit, status=all', () => {
    const parsed = parseSessionScopeQuery({});
    expect(parsed).toEqual({ ok: true, query: { sessionId: null, executionMode: null, limit: 100, status: 'all' } });
  });

  it('accepts a well-formed session_id, mode and limit; clamps limit to the max', () => {
    const parsed = parseSessionScopeQuery(
      { session_id: 'sess_1757606400000_ab12cd', execution_mode: 'paper', limit: '9999' },
      { maxLimit: 500 },
    );
    expect(parsed).toEqual({
      ok: true,
      query: { sessionId: 'sess_1757606400000_ab12cd', executionMode: 'paper', limit: 500, status: 'all' },
    });
  });

  it('rejects session ids that could break out of a PostgREST or() string', () => {
    const parsed = parseSessionScopeQuery({ session_id: 'sess_1,execution_mode.eq.live' });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.status).toBe(400);
  });

  it('rejects unknown execution_mode, non-positive limits and unknown status', () => {
    expect(parseSessionScopeQuery({ execution_mode: 'demo' }).ok).toBe(false);
    expect(parseSessionScopeQuery({ limit: '0' }).ok).toBe(false);
    expect(parseSessionScopeQuery({ limit: 'abc' }).ok).toBe(false);
    expect(parseSessionScopeQuery({ status: 'stale' }, { allowStatus: true }).ok).toBe(false);
  });

  it('only honours status when the endpoint allows it (positions)', () => {
    const ignored = parseSessionScopeQuery({ status: 'open' });
    expect(ignored.ok && ignored.query.status).toBe('all');
    const honoured = parseSessionScopeQuery({ status: 'closed' }, { allowStatus: true });
    expect(honoured.ok && honoured.query.status).toBe('closed');
  });

  it('positions default to open-only (FE PR1 #1) unless status is passed', () => {
    const defaulted = parseSessionScopeQuery({}, { allowStatus: true, defaultStatus: 'open' });
    expect(defaulted.ok && defaulted.query.status).toBe('open');
    const overridden = parseSessionScopeQuery({ status: 'all' }, { allowStatus: true, defaultStatus: 'open' });
    expect(overridden.ok && overridden.query.status).toBe('all');
  });

  it('takes the first value of repeated query params', () => {
    const parsed = parseSessionScopeQuery({ execution_mode: ['live', 'paper'] });
    expect(parsed.ok && parsed.query.executionMode).toBe('live');
  });
});

describe('activeSessionWindow / sessionWindowFromRow', () => {
  it('builds the active window from runtime state and refuses a half-set pair', () => {
    expect(activeSessionWindow({ sessionId: ACTIVE.sessionId, sessionStartedAt: STARTED_AT, sessionMode: 'paper' })).toEqual(ACTIVE);
    expect(activeSessionWindow({ sessionId: null, sessionStartedAt: null, sessionMode: null })).toBeNull();
    expect(activeSessionWindow({ sessionId: 'sess_x', sessionStartedAt: null, sessionMode: 'paper' })).toBeNull();
  });

  it('builds a past window from a trading_sessions row (ended_at bounds it)', () => {
    const window = sessionWindowFromRow({
      session_id: 'sess_old',
      started_at: '2026-09-11T16:00:00.000Z',
      ended_at: '2026-09-11T18:30:00.000Z',
      mode: 'paper',
    });
    expect(window).toEqual({ sessionId: 'sess_old', executionMode: 'paper', startedAt: STARTED_AT, endedAt: ENDED_AT, isActive: false });
  });

  it('prefers execution_mode over mode, ignores unknown modes, and rejects rows without started_at', () => {
    expect(sessionWindowFromRow({ session_id: 's', started_at: '2026-09-11T16:00:00.000Z', mode: 'paper', execution_mode: 'live' })?.executionMode).toBe('live');
    expect(sessionWindowFromRow({ session_id: 's', started_at: '2026-09-11T16:00:00.000Z', mode: 'demo' })?.executionMode).toBeNull();
    expect(sessionWindowFromRow({ session_id: 's', started_at: null })).toBeNull();
  });
});

describe('applySessionScope', () => {
  it('session_id filter: user_id, stamped-or-unstamped-in-window, mode, order by time col desc, limit', () => {
    const b = applySessionScope(new FakeBuilder(), { table: 'orders', userId: USER_ID, window: ACTIVE, filter: 'session_id', limit: 100 });
    expect(b.calls).toEqual([
      ['eq', 'user_id', USER_ID],
      ['or', `session_id.eq.${ACTIVE.sessionId},and(session_id.is.null,created_at.gte.2026-09-11T16:00:00.000Z)`],
      ['or', 'execution_mode.eq.paper,execution_mode.is.null'],
      ['order', 'created_at', { ascending: false }],
      ['limit', 100],
    ]);
  });

  it('time_window filter: user_id + gte started_at (+ lte ended_at for past sessions)', () => {
    const past: SessionWindow = { ...ACTIVE, sessionId: 'sess_old', endedAt: ENDED_AT, isActive: false };
    const b = applySessionScope(new FakeBuilder(), { table: 'fills', userId: USER_ID, window: past, filter: 'time_window', limit: 50 });
    expect(b.calls).toEqual([
      ['eq', 'user_id', USER_ID],
      ['gte', 'filled_at', '2026-09-11T16:00:00.000Z'],
      ['lte', 'filled_at', '2026-09-11T18:30:00.000Z'],
      ['order', 'filled_at', { ascending: false }],
      ['limit', 50],
    ]);
  });

  it('bounds the unstamped clause by ended_at for past sessions on the session_id path', () => {
    const past: SessionWindow = { ...ACTIVE, sessionId: 'sess_old', executionMode: null, endedAt: ENDED_AT, isActive: false };
    const b = applySessionScope(new FakeBuilder(), { table: 'signals', userId: USER_ID, window: past, filter: 'session_id', limit: 60 });
    expect(b.calls[1]).toEqual([
      'or',
      'session_id.eq.sess_old,and(session_id.is.null,created_at.gte.2026-09-11T16:00:00.000Z,created_at.lte.2026-09-11T18:30:00.000Z)',
    ]);
    // No mode clause when the session's mode is unknown.
    expect(b.calls.filter((c) => c[0] === 'or')).toHaveLength(1);
  });

  it('positions: status=open / closed add the closed_at predicate; all adds nothing', () => {
    const open = applySessionScope(new FakeBuilder(), { table: 'positions', userId: USER_ID, window: ACTIVE, filter: 'time_window', limit: 50, status: 'open' });
    expect(open.calls).toContainEqual(['is', 'closed_at', null]);
    const closed = applySessionScope(new FakeBuilder(), { table: 'positions', userId: USER_ID, window: ACTIVE, filter: 'time_window', limit: 50, status: 'closed' });
    expect(closed.calls).toContainEqual(['not', 'closed_at', 'is', null]);
    const all = applySessionScope(new FakeBuilder(), { table: 'positions', userId: USER_ID, window: ACTIVE, filter: 'time_window', limit: 50, status: 'all' });
    expect(all.calls.some((c) => c[1] === 'closed_at')).toBe(false);
    expect(all.calls).toContainEqual(['order', 'opened_at', { ascending: false }]);
  });

  it('status is ignored for non-position tables', () => {
    const b = applySessionScope(new FakeBuilder(), { table: 'orders', userId: USER_ID, window: ACTIVE, filter: 'time_window', limit: 10, status: 'open' });
    expect(b.calls.some((c) => c[1] === 'closed_at')).toBe(false);
  });

  it('uses the documented time column per table', () => {
    expect(SESSION_SCOPE_TIME_COLUMN).toEqual({ orders: 'created_at', fills: 'filled_at', signals: 'created_at', positions: 'opened_at' });
  });
});

describe('readWithSessionScope', () => {
  const MISSING = { code: '42703', message: 'column orders.session_id does not exist' };

  function harness(responses: Array<{ data: unknown[] | null; error: { code?: string; message?: string } | null }>) {
    const builders: FakeBuilder[] = [];
    const execute = vi.fn(async () => responses.shift()!);
    return {
      builders,
      execute,
      createQuery: () => { const b = new FakeBuilder(); builders.push(b); return b; },
    };
  }

  it('prefers the session_id filter and marks the table present on success', async () => {
    const support = new SessionColumnSupport();
    const h = harness([{ data: [{ id: 'o1' }], error: null }]);

    const result = await readWithSessionScope({ table: 'orders', userId: USER_ID, window: ACTIVE, limit: 100, support, ...h });

    expect(result).toEqual({ rows: [{ id: 'o1' }], error: null, filter: 'session_id', fellBack: false });
    expect(h.builders).toHaveLength(1);
    expect(h.builders[0].calls[1][0]).toBe('or');
    expect(support.getState('orders')).toBe('present');
  });

  it('falls back to the time window once when the column is missing, and remembers', async () => {
    const support = new SessionColumnSupport();
    const logger = { warn: vi.fn() };
    const h = harness([{ data: null, error: MISSING }, { data: [{ id: 'o1' }, { id: 'o2' }], error: null }]);

    const result = await readWithSessionScope({ table: 'orders', userId: USER_ID, window: ACTIVE, limit: 100, support, logger, ...h });

    expect(result).toEqual({ rows: [{ id: 'o1' }, { id: 'o2' }], error: null, filter: 'time_window', fellBack: true });
    expect(h.builders).toHaveLength(2);
    expect(h.builders[1].calls).toContainEqual(['gte', 'created_at', '2026-09-11T16:00:00.000Z']);
    expect(support.getState('orders')).toBe('missing');
    expect(logger.warn).toHaveBeenCalledTimes(1);

    // Known-missing: straight to the time window, single query.
    const h2 = harness([{ data: [], error: null }]);
    const again = await readWithSessionScope({ table: 'orders', userId: USER_ID, window: ACTIVE, limit: 100, support, logger, ...h2 });
    expect(again.filter).toBe('time_window');
    expect(again.fellBack).toBe(false);
    expect(h2.builders).toHaveLength(1);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('surfaces unrelated errors from the session_id read without falling back', async () => {
    const support = new SessionColumnSupport();
    const boom = { code: '42501', message: 'permission denied' };
    const h = harness([{ data: null, error: boom }]);

    const result = await readWithSessionScope({ table: 'signals', userId: USER_ID, window: ACTIVE, limit: 60, support, ...h });

    expect(result).toEqual({ rows: [], error: boom, filter: 'session_id', fellBack: false });
    expect(h.builders).toHaveLength(1);
    expect(support.getState('signals')).toBe('unknown');
  });
});

describe('buildSessionScopeMeta', () => {
  it('describes the active session and the applied filter', () => {
    const meta = buildSessionScopeMeta(ACTIVE, 'session_id', 'orders', { limit: 100, status: 'all' });
    expect(meta).toMatchObject({
      sessionId: ACTIVE.sessionId,
      executionMode: 'paper',
      sessionStartedAt: '2026-09-11T16:00:00.000Z', // ISO string (FE PR1 #4), usable directly in created_at >= filters
      sessionEndedAt: null,
      isActive: true,
      filter: 'session_id',
      timeColumn: 'created_at',
      limit: 100,
    });
    expect(meta).not.toHaveProperty('status');
    expect(meta.note).toMatch(/session_id/);
  });

  it('past sessions carry an ISO sessionEndedAt', () => {
    const past: SessionWindow = { ...ACTIVE, sessionId: 'sess_old', endedAt: ENDED_AT, isActive: false };
    const meta = buildSessionScopeMeta(past, 'time_window', 'orders', { limit: 100, status: 'all' });
    expect(meta.sessionStartedAt).toBe('2026-09-11T16:00:00.000Z');
    expect(meta.sessionEndedAt).toBe('2026-09-11T18:30:00.000Z');
    expect(meta.isActive).toBe(false);
  });

  it('is explicit when nothing is scoped', () => {
    const meta = buildSessionScopeMeta(null, 'none', 'positions', { limit: 50, status: 'open' });
    expect(meta).toMatchObject({ sessionId: null, sessionStartedAt: null, isActive: false, filter: 'none', timeColumn: 'opened_at', status: 'open' });
    expect(meta.note).toMatch(/intentionally empty/);
  });

  it('flags the interim window filter so the UI can show it is pre-migration', () => {
    const meta = buildSessionScopeMeta(ACTIVE, 'time_window', 'fills', { limit: 50, status: 'all' });
    expect(meta.filter).toBe('time_window');
    expect(meta.note).toMatch(/20260911170000/);
  });
});
