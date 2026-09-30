/**
 * Paper hard stop — busy-retry chain (PR #82 round-2 review findings 1 / 1b).
 *
 * When the 22:30 CT fire finds another engine operation holding the lock it
 * retries every 10 s. Before the fix the retry was a bare, unowned
 * `setTimeout` in `api/server.ts`: `disarmPaperHardStop()` could not cancel it
 * and it never checked the session, so a manual stop at 22:30 followed by a
 * new paper start within ~60 s got the NEW session stopped.
 *
 * `api/server.ts` cannot be imported in vitest (it listens on a port at
 * import), so the fire handling lives in `runtime/paper-hard-stop.ts`
 * (`decideHardStopFire`, `HardStopRetryTimer`, `PaperHardStopFireRunner`) and
 * the server only supplies its state through the runner's deps. These tests
 * drive that production runner with fake timers.
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Logger } from '../core/logger';
import {
  HardStopRetryTimer,
  PAPER_HARD_STOP_BUSY_MAX_ATTEMPTS,
  PAPER_HARD_STOP_BUSY_RETRY_MS,
  PaperHardStopFireRunner,
  decideHardStopFire,
  type HardStopFireInputs,
  type PaperHardStopFireContext,
} from '../runtime/paper-hard-stop';
import type { ExecutionMode } from '../runtime/session-context';

type Line = { level: string; msg: string; extra?: unknown };

function makeLogger(): Logger & { lines: Line[] } {
  const lines: Line[] = [];
  const push = (level: string) => (msg: string, extra?: unknown) => {
    lines.push({ level, msg, extra });
  };
  return { lines, debug: push('debug'), info: push('info'), warn: push('warn'), error: push('error') };
}

// 2026-09-29 22:30 CDT.
const FIRE_AT = Date.parse('2026-09-30T03:30:00Z');
const CTX: PaperHardStopFireContext = {
  firedAtMs: FIRE_AT,
  scheduledForMs: FIRE_AT,
  reason: 'paper_hard_stop_22_30_ct',
  timezone: 'America/Chicago',
  localTime: '22:30',
};

describe('decideHardStopFire', () => {
  const base: HardStopFireInputs = {
    armedSessionId: 'S1',
    currentSessionId: 'S1',
    engineRunning: true,
    engineMode: 'paper',
    busy: false,
    attempt: 1,
    maxAttempts: 6,
  };

  test('run: the armed paper session is still running and the lock is free', () => {
    expect(decideHardStopFire(base)).toBe('run');
  });

  test('stale_session: the session changed (new start) or was closed since arming — checked first', () => {
    expect(decideHardStopFire({ ...base, currentSessionId: 'S2' })).toBe('stale_session');
    expect(decideHardStopFire({ ...base, currentSessionId: null })).toBe('stale_session');
    // Even while busy on a new session, a stale retry never retries again.
    expect(decideHardStopFire({ ...base, currentSessionId: 'S2', busy: true, attempt: 3 })).toBe('stale_session');
  });

  test('no_engine / not_paper', () => {
    expect(decideHardStopFire({ ...base, engineRunning: false, engineMode: null })).toBe('no_engine');
    expect(decideHardStopFire({ ...base, engineMode: 'live' })).toBe('not_paper');
    expect(decideHardStopFire({ ...base, engineMode: null })).toBe('not_paper');
  });

  test('retry below maxAttempts, give_up on the last attempt', () => {
    for (let attempt = 1; attempt < 6; attempt++) {
      expect(decideHardStopFire({ ...base, busy: true, attempt }), `attempt ${attempt}`).toBe('retry');
    }
    expect(decideHardStopFire({ ...base, busy: true, attempt: 6 })).toBe('give_up');
    expect(decideHardStopFire({ ...base, busy: true, attempt: 7 })).toBe('give_up');
  });

  test('the shipped cadence is 6 attempts (1 fire + 5 retries) 10 s apart', () => {
    expect(PAPER_HARD_STOP_BUSY_MAX_ATTEMPTS).toBe(6);
    expect(PAPER_HARD_STOP_BUSY_RETRY_MS).toBe(10_000);
  });
});

describe('HardStopRetryTimer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test('schedule → pending → fires once → not pending', async () => {
    const timer = new HardStopRetryTimer();
    const fn = vi.fn();
    timer.schedule(fn, 10_000);
    expect(timer.pending()).toBe(true);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(fn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(timer.pending()).toBe(false);
  });

  test('cancel() clears the pending handle and returns whether one was pending', async () => {
    const timer = new HardStopRetryTimer();
    const fn = vi.fn();
    expect(timer.cancel()).toBe(false);
    timer.schedule(fn, 10_000);
    expect(timer.cancel()).toBe(true);
    expect(timer.pending()).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fn).not.toHaveBeenCalled();
  });

  test('schedule() replaces a previous pending handle (only ONE retry at a time)', async () => {
    const timer = new HardStopRetryTimer();
    const first = vi.fn();
    const second = vi.fn();
    timer.schedule(first, 10_000);
    timer.schedule(second, 10_000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  test('uses the injected setTimeout / clearTimeout', () => {
    const handle = setTimeout(() => undefined, 0);
    clearTimeout(handle);
    const setTimeoutFn = vi.fn(() => handle);
    const clearTimeoutFn = vi.fn();
    const timer = new HardStopRetryTimer({ setTimeoutFn, clearTimeoutFn });
    timer.schedule(() => undefined, 10_000);
    expect(setTimeoutFn).toHaveBeenCalledWith(expect.any(Function), 10_000);
    timer.cancel();
    expect(clearTimeoutFn).toHaveBeenCalledWith(handle);
  });
});

/**
 * A stand-in for the server's module state. `disarm` mirrors
 * `disarmPaperHardStop` in api/server.ts: it cancels the runner's pending retry
 * BEFORE anything else (the server does so ahead of its `if (!paperHardStop) return;`).
 */
function makeHarness(opts: { disarmCancelsRetry?: boolean; stop?: (sessionId: string) => Promise<void> } = {}) {
  const logger = makeLogger();
  const state = {
    sessionId: 'S1' as string | null,
    engineMode: 'paper' as ExecutionMode | null,
    busy: false,
  };
  const stops: Array<{ armedSessionId: string; currentSessionId: string | null }> = [];
  const disarms: string[] = [];
  const runner = new PaperHardStopFireRunner({
    logger,
    getCurrentSessionId: () => state.sessionId,
    getEngineMode: () => state.engineMode,
    isEngineBusy: () => state.busy,
    disarm: (cause) => {
      disarms.push(cause);
      if (opts.disarmCancelsRetry !== false) runner.cancelRetry();
    },
    stop: async (_ctx, sessionId) => {
      stops.push({ armedSessionId: sessionId, currentSessionId: state.sessionId });
      if (opts.stop) {
        await opts.stop(sessionId);
        return;
      }
      state.sessionId = null;
      state.engineMode = null;
    },
  });
  /** A manual POST /api/engine/stop finishing: disarm, then the session closes. */
  const manualStopCompletes = () => {
    disarms.push('api_request');
    if (opts.disarmCancelsRetry !== false) runner.cancelRetry();
    state.sessionId = null;
    state.engineMode = null;
    state.busy = false;
  };
  /** A new paper start: openTradingSession sets the id, then armPaperHardStop disarms ('rearm') and arms. */
  const newPaperStart = (sessionId: string) => {
    state.busy = true;
    state.engineMode = 'paper';
    state.sessionId = sessionId;
    disarms.push('rearm');
    if (opts.disarmCancelsRetry !== false) runner.cancelRetry();
    state.busy = false;
  };
  return { logger, state, stops, disarms, runner, manualStopCompletes, newPaperStart };
}

describe('PaperHardStopFireRunner (the server fire handler)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIRE_AT);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test('REPRODUCTION: fire busy → manual stop + disarm → new session armed → the old retry must NOT stop it', async () => {
    const h = makeHarness();
    // 22:30:00 — the external automation's POST /api/engine/stop holds the lock.
    h.state.busy = true;
    await h.runner.run(CTX, 'S1');
    expect(h.runner.retryPending()).toBe(true);
    expect(h.stops).toHaveLength(0);

    // 22:30:05 — the manual stop finishes (disarms, closes S1).
    await vi.advanceTimersByTimeAsync(5_000);
    h.manualStopCompletes();
    expect(h.runner.retryPending()).toBe(false);

    // 22:30:08 — a new paper session S2 starts and arms its own backstop.
    await vi.advanceTimersByTimeAsync(3_000);
    h.newPaperStart('S2');

    // The whole old retry window passes: S2 is never stopped.
    await vi.advanceTimersByTimeAsync(PAPER_HARD_STOP_BUSY_MAX_ATTEMPTS * PAPER_HARD_STOP_BUSY_RETRY_MS + 10_000);
    expect(h.stops).toHaveLength(0);
    expect(h.state.sessionId).toBe('S2');
    expect(h.state.engineMode).toBe('paper');
  });

  test('defence in depth: even if a retry is NOT cancelled, it bails on the session check ("stale hard-stop retry")', async () => {
    const h = makeHarness({ disarmCancelsRetry: false });
    h.state.busy = true;
    await h.runner.run(CTX, 'S1');
    expect(h.runner.retryPending()).toBe(true);
    h.manualStopCompletes();
    h.newPaperStart('S2');

    await vi.advanceTimersByTimeAsync(PAPER_HARD_STOP_BUSY_RETRY_MS);
    expect(h.stops).toHaveLength(0);
    expect(h.state.sessionId).toBe('S2');
    expect(h.runner.retryPending()).toBe(false);
    const stale = h.logger.lines.find((l) => /stale hard-stop retry/.test(l.msg));
    expect(stale?.level).toBe('info');
    expect(stale?.extra).toMatchObject({ sessionId: 'S1', currentSessionId: 'S2', attempt: 2 });
    // A stale retry never disarms: the scheduler now belongs to S2.
    expect(h.disarms).not.toContain('stale_session');
    await vi.advanceTimersByTimeAsync(10 * PAPER_HARD_STOP_BUSY_RETRY_MS);
    expect(h.stops).toHaveLength(0);
  });

  test('busy on the fire, free on the second attempt → stops the ARMED session exactly once', async () => {
    const h = makeHarness();
    h.state.busy = true;
    await h.runner.run(CTX, 'S1');
    h.state.busy = false;
    await vi.advanceTimersByTimeAsync(PAPER_HARD_STOP_BUSY_RETRY_MS);
    expect(h.stops).toEqual([{ armedSessionId: 'S1', currentSessionId: 'S1' }]);
    expect(h.runner.retryPending()).toBe(false);
    await vi.advanceTimersByTimeAsync(10 * PAPER_HARD_STOP_BUSY_RETRY_MS);
    expect(h.stops).toHaveLength(1);
  });

  test('busy throughout → 6 attempts (1 fire + 5 retries, 50 s) then gives up for the day', async () => {
    const h = makeHarness();
    h.state.busy = true;
    await h.runner.run(CTX, 'S1');
    await vi.advanceTimersByTimeAsync(10 * PAPER_HARD_STOP_BUSY_RETRY_MS);
    const retries = h.logger.lines.filter((l) => l.level === 'warn' && /retrying/.test(l.msg));
    expect(retries.map((l) => (l.extra as { attempt: number }).attempt)).toEqual([1, 2, 3, 4, 5]);
    const giveUp = h.logger.lines.filter((l) => l.level === 'error' && /giving up for today/.test(l.msg));
    expect(giveUp).toHaveLength(1);
    expect(giveUp[0].extra).toMatchObject({ sessionId: 'S1', attempts: 6 });
    expect(h.stops).toHaveLength(0);
    expect(h.runner.retryPending()).toBe(false);
  });

  test('the armed session running and the lock free → stops immediately, no retry', async () => {
    const h = makeHarness();
    await h.runner.run(CTX, 'S1');
    expect(h.stops).toEqual([{ armedSessionId: 'S1', currentSessionId: 'S1' }]);
    expect(h.runner.retryPending()).toBe(false);
  });

  test('no engine → disarms with cause no_engine; non-paper engine → REFUSES and disarms with mode_mismatch', async () => {
    const noEngine = makeHarness();
    // No engine: `getEngineMode()` returns null (the server maps `tradingEngine === null` to null).
    noEngine.state.engineMode = null;
    await noEngine.runner.run(CTX, 'S1');
    expect(noEngine.stops).toHaveLength(0);
    expect(noEngine.disarms).toEqual(['no_engine']);
    expect(noEngine.logger.lines.some((l) => l.level === 'info' && /no engine is running/.test(l.msg))).toBe(true);

    const live = makeHarness();
    live.state.engineMode = 'live';
    await live.runner.run(CTX, 'S1');
    expect(live.stops).toHaveLength(0);
    expect(live.disarms).toEqual(['mode_mismatch']);
    expect(live.logger.lines.some((l) => l.level === 'error' && /REFUSING/.test(l.msg))).toBe(true);
  });

  test('a stop that throws on a RETRY is logged and never escapes the timer (no unhandled rejection)', async () => {
    const h = makeHarness({
      stop: async () => {
        throw new Error('stop path exploded');
      },
    });
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      h.state.busy = true;
      await h.runner.run(CTX, 'S1');
      h.state.busy = false;
      await vi.advanceTimersByTimeAsync(PAPER_HARD_STOP_BUSY_RETRY_MS);
      await vi.runAllTicks();
      expect(h.stops).toHaveLength(1);
      expect(h.logger.lines.some((l) => l.level === 'error' && /retry threw/.test(l.msg))).toBe(true);
    } finally {
      process.off('unhandledRejection', unhandled);
    }
    expect(unhandled).not.toHaveBeenCalled();
  });

  test('a stop that throws on the FIRST fire is rethrown to the scheduler (which logs it), as before', async () => {
    const h = makeHarness({
      stop: async () => {
        throw new Error('stop path exploded');
      },
    });
    await expect(h.runner.run(CTX, 'S1')).rejects.toThrow('stop path exploded');
  });
});
