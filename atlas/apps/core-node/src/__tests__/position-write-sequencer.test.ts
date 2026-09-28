/**
 * P3-A (2026-09-28) — `positions` write ordering + close durability.
 *
 * Pins for persistence/position-write-sequencer.ts:
 *   - writes for one position id run strictly one after another; different
 *     ids do not wait on each other;
 *   - once a close has been issued for an id, a later non-close write for that
 *     id is dropped (debug), whether it arrives after the close or was queued
 *     before it and only reached the head afterwards;
 *   - a close write retries transient failures per the bounded schedule
 *     (250/1000/3000/8000 ms), logs every attempt and the final remediation;
 *   - a non-transient (schema / key / RLS) error is retried at most once;
 *   - a non-close write stays single-shot and keeps its historic log line;
 *   - `enqueue` never rejects.
 *
 * The end-to-end fill → tracker → row scenarios live in position-upsert.test.ts.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  CLOSE_WRITE_REMEDIATION,
  DEFAULT_CLOSE_RETRY_DELAYS_MS,
  NON_TRANSIENT_MAX_ATTEMPTS,
  PositionWriteSequencer,
  isTransientPositionWriteError,
  type PositionWriteAttempt,
  type PositionWriteKind,
} from '../persistence/position-write-sequencer';

const ID_A = '0f1e2d3c-4b5a-4697-8877-665544332211';
const ID_B = '8a7b6c5d-4e3f-4a1b-9c8d-7e6f5a4b3c2d';
const SESSION = 'sess_1790091200890_9q7egp';

const CONNECTION_FAILURE = { code: '08006', message: 'connection failure: server closed the connection unexpectedly' };
const RLS_DENIED = { code: '42501', message: 'new row violates row-level security policy for table "positions"' };
const OPEN_ROW_DUPLICATE = { code: '23505', message: 'duplicate key value violates unique constraint "positions_user_symbol_open_uidx"' };

const makeLogger = () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });

/** Deferred write: the test decides when (and how) each call resolves. */
function deferredWrite() {
  const resolvers: Array<(result: PositionWriteAttempt) => void> = [];
  const write = vi.fn(() => new Promise<PositionWriteAttempt>((resolve) => { resolvers.push(resolve); }));
  return { write, resolvers, resolve: (index: number, result: PositionWriteAttempt = { error: null }) => resolvers[index](result) };
}

const request = (positionId: string, kind: PositionWriteKind, write: () => Promise<PositionWriteAttempt>, symbol = 'ETH-USD') => ({
  positionId,
  symbol,
  sessionId: SESSION,
  kind,
  write,
});

const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

describe('isTransientPositionWriteError', () => {
  it('treats connection / pool / timeout failures and HTTP 5xx as transient', () => {
    expect(isTransientPositionWriteError(CONNECTION_FAILURE)).toBe(true);
    expect(isTransientPositionWriteError({ code: '57P03', message: 'the database system is starting up' })).toBe(true);
    expect(isTransientPositionWriteError({ code: 'PGRST003', message: 'Timed out acquiring connection from connection pool' })).toBe(true);
    expect(isTransientPositionWriteError({ code: '503', message: 'Service Unavailable' })).toBe(true);
    expect(isTransientPositionWriteError({ message: 'TypeError: fetch failed' })).toBe(true);
    expect(isTransientPositionWriteError({ message: 'Operation timed out after 10000ms' })).toBe(true);
  });

  it('never classifies schema / key / permission errors as transient', () => {
    expect(isTransientPositionWriteError(RLS_DENIED)).toBe(false);
    expect(isTransientPositionWriteError(OPEN_ROW_DUPLICATE)).toBe(false);
    expect(isTransientPositionWriteError({ code: '42P10', message: 'there is no unique or exclusion constraint matching the ON CONFLICT specification' })).toBe(false);
    expect(isTransientPositionWriteError({ code: 'PGRST204', message: "Could not find the 'session_id' column of 'positions' in the schema cache" })).toBe(false);
    expect(isTransientPositionWriteError({ code: '22P02', message: 'invalid input syntax for type uuid: "ord-1"' })).toBe(false);
    expect(isTransientPositionWriteError(null)).toBe(false);
    expect(isTransientPositionWriteError(undefined)).toBe(false);
  });
});

describe('PositionWriteSequencer — per-id ordering', () => {
  it('a write for X waits for the previous write for X; another id is not held up', async () => {
    const sequencer = new PositionWriteSequencer({ logger: makeLogger() });
    const a = deferredWrite();
    const b = deferredWrite();

    const a1 = sequencer.enqueue(request(ID_A, 'update', a.write));
    const a2 = sequencer.enqueue(request(ID_A, 'update', a.write));
    const b1 = sequencer.enqueue(request(ID_B, 'update', b.write, 'SOL-USD'));
    await flush();

    // A's second write has not been issued; B's first write has (independent chain).
    expect(a.write).toHaveBeenCalledTimes(1);
    expect(b.write).toHaveBeenCalledTimes(1);
    expect(sequencer.snapshot()).toEqual({ pendingIds: 2, rememberedCloses: 0 });

    a.resolve(0);
    await expect(a1).resolves.toEqual({ status: 'written', kind: 'update', attempts: 1, error: null });
    await flush();
    expect(a.write).toHaveBeenCalledTimes(2);

    a.resolve(1);
    b.resolve(0);
    await expect(a2).resolves.toMatchObject({ status: 'written' });
    await expect(b1).resolves.toMatchObject({ status: 'written' });
    await sequencer.idle(ID_A);
    await sequencer.idle(ID_B);
    expect(sequencer.snapshot()).toEqual({ pendingIds: 0, rememberedCloses: 0 });
  });

  it('the close waits for an in-flight update and is the last write that lands', async () => {
    const logger = makeLogger();
    const sequencer = new PositionWriteSequencer({ logger });
    const landed: Array<'update' | 'close'> = [];
    const update = deferredWrite();
    const close = vi.fn(async (): Promise<PositionWriteAttempt> => { landed.push('close'); return { error: null }; });

    const u = sequencer.enqueue(request(ID_A, 'update', update.write));
    await flush();
    const c = sequencer.enqueue(request(ID_A, 'close', close));
    await flush();
    expect(close).not.toHaveBeenCalled();
    expect(sequencer.hasCloseIssued(ID_A)).toBe(true);

    landed.push('update');
    update.resolve(0);
    await Promise.all([u, c]);
    expect(landed).toEqual(['update', 'close']);
    expect(close).toHaveBeenCalledTimes(1);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('a non-close write enqueued after the close is dropped without touching the table (debug)', async () => {
    const logger = makeLogger();
    const sequencer = new PositionWriteSequencer({ logger });
    const write = vi.fn(async (): Promise<PositionWriteAttempt> => ({ error: null }));

    await sequencer.enqueue(request(ID_A, 'close', write));
    const stale = await sequencer.enqueue(request(ID_A, 'update', write));

    expect(stale).toEqual({ status: 'dropped', kind: 'update', attempts: 0, error: null });
    expect(write).toHaveBeenCalledTimes(1);
    expect(logger.debug).toHaveBeenCalledTimes(1);
    expect(logger.debug.mock.calls[0][0]).toMatch(/dropping stale update write/);
    expect(logger.debug.mock.calls[0][1]).toMatchObject({ positionId: ID_A, symbol: 'ETH-USD', sessionId: SESSION });
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();

    // A second close for the same id (idempotent re-assert) is still written.
    await expect(sequencer.enqueue(request(ID_A, 'close', write))).resolves.toMatchObject({ status: 'written' });
    expect(write).toHaveBeenCalledTimes(2);
  });

  it('a non-close write queued BEFORE the close but reaching the head after it is dropped too', async () => {
    const logger = makeLogger();
    const sequencer = new PositionWriteSequencer({ logger });
    const inflight = deferredWrite();
    const queuedUpdate = vi.fn(async (): Promise<PositionWriteAttempt> => ({ error: null }));
    const close = vi.fn(async (): Promise<PositionWriteAttempt> => ({ error: null }));

    const u0 = sequencer.enqueue(request(ID_A, 'update', inflight.write));
    await flush(); // u0 is on the wire
    const u1 = sequencer.enqueue(request(ID_A, 'update', queuedUpdate));
    const c = sequencer.enqueue(request(ID_A, 'close', close));
    await flush();
    expect(inflight.write).toHaveBeenCalledTimes(1);
    expect(queuedUpdate).not.toHaveBeenCalled();
    inflight.resolve(0);

    expect(await u0).toMatchObject({ status: 'written' });
    expect(await u1).toEqual({ status: 'dropped', kind: 'update', attempts: 0, error: null });
    expect(await c).toMatchObject({ status: 'written', attempts: 1 });
    expect(queuedUpdate).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('bounds the closed-id memory (oldest evicted first)', async () => {
    const sequencer = new PositionWriteSequencer({ maxRememberedCloses: 2 });
    const ok = async (): Promise<PositionWriteAttempt> => ({ error: null });
    for (const id of ['a', 'b', 'c']) await sequencer.enqueue(request(id, 'close', ok));
    expect(sequencer.snapshot().rememberedCloses).toBe(2);
    expect(sequencer.hasCloseIssued('a')).toBe(false);
    expect(sequencer.hasCloseIssued('b')).toBe(true);
    expect(sequencer.hasCloseIssued('c')).toBe(true);
  });
});

describe('PositionWriteSequencer — close durability', () => {
  it('retries a transient close failure on the schedule and logs each attempt', async () => {
    const logger = makeLogger();
    const sleeps: number[] = [];
    const sequencer = new PositionWriteSequencer({ logger, sleep: async (ms) => { sleeps.push(ms); } });
    const write = vi
      .fn<[], Promise<PositionWriteAttempt>>()
      .mockResolvedValueOnce({ error: CONNECTION_FAILURE, detail: { onConflictTarget: 'id' } })
      .mockResolvedValueOnce({ error: CONNECTION_FAILURE, detail: { onConflictTarget: 'id' } })
      .mockResolvedValueOnce({ error: null, detail: { onConflictTarget: 'id' } });

    const outcome = await sequencer.enqueue(request(ID_A, 'close', write));

    expect(outcome).toEqual({ status: 'written', kind: 'close', attempts: 3, error: null });
    expect(write).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([250, 1000]);
    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(logger.warn.mock.calls[0][1]).toMatchObject({ positionId: ID_A, symbol: 'ETH-USD', sessionId: SESSION, attempt: 1, maxAttempts: 5, nextDelayMs: 250, transient: true, code: '08006', onConflictTarget: 'id' });
    expect(logger.warn.mock.calls[1][1]).toMatchObject({ attempt: 2, nextDelayMs: 1000 });
    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.info.mock.calls[0][0]).toMatch(/succeeded after retry/);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('a write that THROWS (fetch failure) is treated as transient and retried', async () => {
    const logger = makeLogger();
    const sequencer = new PositionWriteSequencer({ logger, sleep: async () => {} });
    const write = vi
      .fn<[], Promise<PositionWriteAttempt>>()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce({ error: null });

    await expect(sequencer.enqueue(request(ID_A, 'close', write))).resolves.toEqual({ status: 'written', kind: 'close', attempts: 2, error: null });
    expect(logger.warn.mock.calls[0][1]).toMatchObject({ transient: true, message: 'fetch failed' });
  });

  it('gives up after the full schedule, names id / symbol / session and the remediation, never spins', async () => {
    const logger = makeLogger();
    const sleeps: number[] = [];
    const sequencer = new PositionWriteSequencer({ logger, sleep: async (ms) => { sleeps.push(ms); } });
    const write = vi.fn(async (): Promise<PositionWriteAttempt> => ({ error: CONNECTION_FAILURE, detail: { hint: null } }));

    const outcome = await sequencer.enqueue(request(ID_A, 'close', write));

    expect(outcome).toEqual({ status: 'failed', kind: 'close', attempts: DEFAULT_CLOSE_RETRY_DELAYS_MS.length + 1, error: CONNECTION_FAILURE });
    expect(write).toHaveBeenCalledTimes(5);
    expect(sleeps).toEqual([250, 1000, 3000, 8000]);
    expect(logger.warn).toHaveBeenCalledTimes(4);
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error.mock.calls[0][0]).toMatch(/close write failed after 5 attempt/);
    expect(logger.error.mock.calls[0][0]).toContain(CLOSE_WRITE_REMEDIATION);
    expect(logger.error.mock.calls[0][1]).toMatchObject({
      positionId: ID_A,
      symbol: 'ETH-USD',
      sessionId: SESSION,
      attempts: 5,
      code: '08006',
      remediation: 'row left open; reconcile manually or on next start',
    });
  });

  it('a non-transient error on a close is retried exactly once, then surfaced', async () => {
    const logger = makeLogger();
    const sleeps: number[] = [];
    const sequencer = new PositionWriteSequencer({ logger, sleep: async (ms) => { sleeps.push(ms); } });
    const write = vi.fn(async (): Promise<PositionWriteAttempt> => ({ error: RLS_DENIED }));

    const outcome = await sequencer.enqueue(request(ID_A, 'close', write));

    expect(NON_TRANSIENT_MAX_ATTEMPTS).toBe(2);
    expect(outcome).toEqual({ status: 'failed', kind: 'close', attempts: 2, error: RLS_DENIED });
    expect(write).toHaveBeenCalledTimes(2);
    expect(sleeps).toEqual([250]);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][1]).toMatchObject({ transient: false, maxAttempts: 2, code: '42501' });
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error.mock.calls[0][1]).toMatchObject({ positionId: ID_A, attempts: 2, code: '42501', remediation: CLOSE_WRITE_REMEDIATION });
  });

  it('a non-close write stays single-shot and keeps the historic log line', async () => {
    const logger = makeLogger();
    const sleep = vi.fn(async () => {});
    const sequencer = new PositionWriteSequencer({ logger, sleep });
    const write = vi.fn(async (): Promise<PositionWriteAttempt> => ({ error: CONNECTION_FAILURE, detail: { onConflictTarget: 'id', hint: null } }));

    const outcome = await sequencer.enqueue(request(ID_A, 'update', write));

    expect(outcome).toEqual({ status: 'failed', kind: 'update', attempts: 1, error: CONNECTION_FAILURE });
    expect(write).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error.mock.calls[0][0]).toBe('Failed to sync position to Supabase:');
    expect(logger.error.mock.calls[0][1]).toMatchObject({ error: CONNECTION_FAILURE.message, code: '08006', positionId: ID_A, symbol: 'ETH-USD', onConflictTarget: 'id' });
  });

  it('a failed write does not block later writes for the same id', async () => {
    const sequencer = new PositionWriteSequencer({ logger: makeLogger(), sleep: async () => {} });
    const failing = vi.fn(async (): Promise<PositionWriteAttempt> => { throw new Error('ECONNRESET'); });
    const ok = vi.fn(async (): Promise<PositionWriteAttempt> => ({ error: null }));

    const first = sequencer.enqueue(request(ID_A, 'update', failing));
    const second = sequencer.enqueue(request(ID_A, 'update', ok));

    await expect(first).resolves.toMatchObject({ status: 'failed', attempts: 1 });
    await expect(second).resolves.toMatchObject({ status: 'written', attempts: 1 });
    expect(ok).toHaveBeenCalledTimes(1);
  });
});
