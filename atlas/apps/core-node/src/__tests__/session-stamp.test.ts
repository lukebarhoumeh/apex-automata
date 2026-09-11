/**
 * TASK_014 P5 (blotter side) — session_id / execution_mode stamping with
 * schema-tolerant fallback (persistence/session-stamp.ts).
 *
 * Pins:
 *   - rows are stamped with the active session and mode;
 *   - a "column does not exist" answer for one of the two stamp columns strips
 *     them and retries ONCE with the legacy shape, then remembers the table as
 *     unstamped so later writes skip the failing round-trip;
 *   - the memory expires (re-probe) so applying the migration under a running
 *     process is picked up;
 *   - unrelated errors are surfaced, never masked as "migration pending".
 */

import { describe, it, expect, vi } from 'vitest';
import {
  SESSION_STAMP_COLUMNS,
  SessionColumnSupport,
  isSessionColumnMissingError,
  stampSessionColumns,
  stripSessionColumns,
  writeWithSessionStamp,
} from '../persistence/session-stamp';

const STAMP = { sessionId: 'sess_1757600000000_ab12cd', executionMode: 'paper' as const };
const MISSING_SESSION_ID = { code: 'PGRST204', message: "Could not find the 'session_id' column of 'orders' in the schema cache" };
const MISSING_EXECUTION_MODE = { code: '42703', message: 'column "execution_mode" of relation "fills" does not exist' };
const UNRELATED_MISSING = { code: 'PGRST204', message: "Could not find the 'active' column of 'risk_events' in the schema cache" };
const RLS_DENIED = { code: '42501', message: 'new row violates row-level security policy' };

describe('stampSessionColumns / stripSessionColumns', () => {
  it('adds session_id + execution_mode and leaves the input untouched', () => {
    const row = { id: 'o1', symbol: 'ETH-USD' };
    const stamped = stampSessionColumns(row, STAMP);
    expect(stamped).toEqual({ id: 'o1', symbol: 'ETH-USD', session_id: STAMP.sessionId, execution_mode: 'paper' });
    expect(row).toEqual({ id: 'o1', symbol: 'ETH-USD' });
  });

  it('returns the same row reference when there is no stamp', () => {
    const row = { id: 'o1' };
    expect(stampSessionColumns(row, null)).toBe(row);
    expect(stampSessionColumns(row, undefined)).toBe(row);
  });

  it('strip removes exactly the two stamp columns', () => {
    const stripped = stripSessionColumns({ id: 'o1', session_id: 'x', execution_mode: 'paper', price: 1 });
    expect(stripped).toEqual({ id: 'o1', price: 1 });
    expect(SESSION_STAMP_COLUMNS).toEqual(['session_id', 'execution_mode']);
  });
});

describe('isSessionColumnMissingError', () => {
  it('matches PGRST204 / 42703 that name one of the stamp columns', () => {
    expect(isSessionColumnMissingError(MISSING_SESSION_ID)).toBe(true);
    expect(isSessionColumnMissingError(MISSING_EXECUTION_MODE)).toBe(true);
  });

  it('does not match unrelated missing columns or other errors', () => {
    expect(isSessionColumnMissingError(UNRELATED_MISSING)).toBe(false);
    expect(isSessionColumnMissingError(RLS_DENIED)).toBe(false);
    expect(isSessionColumnMissingError(null)).toBe(false);
  });
});

describe('SessionColumnSupport', () => {
  it('stamps by default, stops after a miss, re-probes after the TTL', () => {
    let now = 1_000_000;
    const support = new SessionColumnSupport({ reprobeMs: 60_000, now: () => now });

    expect(support.getState('orders')).toBe('unknown');
    expect(support.shouldStamp('orders')).toBe(true);

    support.markMissing('orders');
    expect(support.getState('orders')).toBe('missing');
    expect(support.shouldStamp('orders')).toBe(false);

    now += 59_999;
    expect(support.shouldStamp('orders')).toBe(false);
    now += 1;
    expect(support.shouldStamp('orders')).toBe(true);

    support.markPresent('orders');
    expect(support.getState('orders')).toBe('present');
    expect(support.shouldStamp('orders')).toBe(true);
    expect(support.snapshot()).toEqual({ orders: 'present' });
  });

  it('tracks tables independently', () => {
    const support = new SessionColumnSupport();
    support.markMissing('fills');
    expect(support.shouldStamp('fills')).toBe(false);
    expect(support.shouldStamp('orders')).toBe(true);
  });
});

describe('writeWithSessionStamp', () => {
  const row = { id: 'o1', symbol: 'ETH-USD', quantity: 0.5 };

  it('writes the stamped row and marks the table present on success', async () => {
    const support = new SessionColumnSupport();
    const write = vi.fn().mockResolvedValue({ error: null });

    const result = await writeWithSessionStamp({ table: 'orders', row, stamp: STAMP, support, write });

    expect(result).toEqual({ error: null, stamped: true, fellBack: false });
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith({ ...row, session_id: STAMP.sessionId, execution_mode: 'paper' });
    expect(support.getState('orders')).toBe('present');
  });

  it('strips the stamp and retries once when the schema lacks the columns, then remembers', async () => {
    const support = new SessionColumnSupport();
    const logger = { warn: vi.fn() };
    const write = vi
      .fn()
      .mockResolvedValueOnce({ error: MISSING_SESSION_ID })
      .mockResolvedValueOnce({ error: null });

    const first = await writeWithSessionStamp({ table: 'orders', row, stamp: STAMP, support, write, logger });

    expect(first).toEqual({ error: null, stamped: false, fellBack: true });
    expect(write).toHaveBeenCalledTimes(2);
    expect(write.mock.calls[1][0]).toEqual(row);
    expect(support.getState('orders')).toBe('missing');
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][0]).toMatch(/migration 20260911170000/);

    // Next write skips the stamped attempt entirely and does not warn again.
    write.mockClear();
    write.mockResolvedValueOnce({ error: null });
    const second = await writeWithSessionStamp({ table: 'orders', row, stamp: STAMP, support, write, logger });
    expect(second).toEqual({ error: null, stamped: false, fellBack: false });
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0][0]).toEqual(row);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('accepts the 42703 shape for execution_mode too', async () => {
    const support = new SessionColumnSupport();
    const write = vi
      .fn()
      .mockResolvedValueOnce({ error: MISSING_EXECUTION_MODE })
      .mockResolvedValueOnce({ error: null });

    const result = await writeWithSessionStamp({ table: 'fills', row, stamp: STAMP, support, write });
    expect(result.fellBack).toBe(true);
    expect(support.getState('fills')).toBe('missing');
  });

  it('surfaces unrelated errors without retrying or changing the table state', async () => {
    const support = new SessionColumnSupport();
    const write = vi.fn().mockResolvedValueOnce({ error: RLS_DENIED });

    const result = await writeWithSessionStamp({ table: 'signals', row, stamp: STAMP, support, write });

    expect(result).toEqual({ error: RLS_DENIED, stamped: true, fellBack: false });
    expect(write).toHaveBeenCalledTimes(1);
    expect(support.getState('signals')).toBe('unknown');
  });

  it('does not mask an unrelated missing column (e.g. risk_events.active) as a pending migration', async () => {
    const support = new SessionColumnSupport();
    const write = vi.fn().mockResolvedValueOnce({ error: UNRELATED_MISSING });

    const result = await writeWithSessionStamp({ table: 'orders', row, stamp: STAMP, support, write });

    expect(result.error).toBe(UNRELATED_MISSING);
    expect(result.fellBack).toBe(false);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('writes the legacy shape directly when there is no active session', async () => {
    const support = new SessionColumnSupport();
    const write = vi.fn().mockResolvedValue({ error: null });

    const result = await writeWithSessionStamp({ table: 'positions', row, stamp: null, support, write });

    expect(result).toEqual({ error: null, stamped: false, fellBack: false });
    expect(write).toHaveBeenCalledWith(row);
    expect(support.getState('positions')).toBe('unknown');
  });

  it('re-probes with the stamped shape after the TTL and flips back to present when the migration landed', async () => {
    let now = 0;
    const support = new SessionColumnSupport({ reprobeMs: 1_000, now: () => now });
    support.markMissing('orders');
    const write = vi.fn().mockResolvedValue({ error: null });

    now = 1_000;
    const result = await writeWithSessionStamp({ table: 'orders', row, stamp: STAMP, support, write });

    expect(result.stamped).toBe(true);
    expect(support.getState('orders')).toBe('present');
  });
});
