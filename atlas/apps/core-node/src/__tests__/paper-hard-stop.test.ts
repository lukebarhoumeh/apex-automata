/**
 * Paper session hard stop (handoff P5) — engine-side 22:30 America/Chicago
 * self-stop backstop for PAPER sessions.
 *
 * Pins:
 *   1. `nextHardStopAt` resolves the NEXT `HH:MM` in an IANA zone: today when
 *      still ahead, tomorrow otherwise, and lands on the real local wall clock
 *      across both America/Chicago DST transitions (2026-03-08 spring forward,
 *      2026-11-01 fall back) — never "now + 24h". A wall time inside a
 *      spring-forward gap resolves AFTER the gap (review finding 3).
 *   2. The guardrails schema accepts the block, defaults an absent block to
 *      `enabled: false`, and rejects a malformed `local_time` / unknown zone.
 *   3. `PaperHardStopScheduler`: fires exactly once at the boundary, re-arms
 *      for the next day, `disarm()` cancels, a fire that disarms (the server's
 *      stop path) does NOT re-arm, and a non-paper mode never arms.
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Logger } from '../core/logger';
import {
  HARD_STOP_LOCAL_TIME_PATTERN,
  PaperHardStopScheduler,
  nextHardStopAt,
  parseLocalTime,
  wallClockAt,
  zonedTimeToUtcMs,
  type PaperHardStopFireContext,
} from '../runtime/paper-hard-stop';
import { GuardrailsSchema, loadGuardrails, resolvePaperSessionHardStopConfig } from '../config/loadGuardrails';

const CHICAGO = 'America/Chicago';
const SPEC = { localTime: '22:30', timezone: CHICAGO };

function makeLogger(): Logger & { lines: Array<{ level: string; msg: string; extra?: unknown }> } {
  const lines: Array<{ level: string; msg: string; extra?: unknown }> = [];
  const push = (level: string) => (msg: string, extra?: unknown) => {
    lines.push({ level, msg, extra });
  };
  return { lines, debug: push('debug'), info: push('info'), warn: push('warn'), error: push('error') };
}

describe('wall clock helpers', () => {
  test('wallClockAt renders America/Chicago local time across DST (CDT -5 / CST -6)', () => {
    // 2026-07-01T03:30Z = 2026-06-30 22:30 CDT
    expect(wallClockAt(Date.parse('2026-07-01T03:30:00Z'), CHICAGO)).toMatchObject({ year: 2026, month: 6, day: 30, hour: 22, minute: 30 });
    // 2026-12-02T04:30Z = 2026-12-01 22:30 CST
    expect(wallClockAt(Date.parse('2026-12-02T04:30:00Z'), CHICAGO)).toMatchObject({ year: 2026, month: 12, day: 1, hour: 22, minute: 30 });
  });

  test('parseLocalTime accepts HH:MM 24h and rejects everything else', () => {
    expect(parseLocalTime('22:30')).toEqual({ hour: 22, minute: 30 });
    expect(parseLocalTime('00:00')).toEqual({ hour: 0, minute: 0 });
    expect(parseLocalTime('23:59')).toEqual({ hour: 23, minute: 59 });
    for (const bad of ['24:00', '22:60', '9:30', '2230', '22:30:00', '', 'ten thirty', '10:30 PM']) {
      expect(parseLocalTime(bad), bad).toBeNull();
      expect(HARD_STOP_LOCAL_TIME_PATTERN.test(bad), bad).toBe(false);
    }
  });

  test('zonedTimeToUtcMs: 22:30 Chicago is 03:30Z next day in CDT and 04:30Z next day in CST', () => {
    expect(zonedTimeToUtcMs({ year: 2026, month: 9, day: 29 }, { hour: 22, minute: 30 }, CHICAGO)).toBe(Date.parse('2026-09-30T03:30:00Z'));
    expect(zonedTimeToUtcMs({ year: 2026, month: 12, day: 1 }, { hour: 22, minute: 30 }, CHICAGO)).toBe(Date.parse('2026-12-02T04:30:00Z'));
    // UTC zone is the identity.
    expect(zonedTimeToUtcMs({ year: 2026, month: 9, day: 29 }, { hour: 22, minute: 30 }, 'UTC')).toBe(Date.parse('2026-09-29T22:30:00Z'));
  });

  test('zonedTimeToUtcMs on the transition days themselves lands on the new offset', () => {
    // 2026-11-01: clocks fall back 02:00 CDT -> 01:00 CST; 22:30 that evening is CST (UTC-6).
    expect(zonedTimeToUtcMs({ year: 2026, month: 11, day: 1 }, { hour: 22, minute: 30 }, CHICAGO)).toBe(Date.parse('2026-11-02T04:30:00Z'));
    // 2026-03-08: clocks spring forward 02:00 CST -> 03:00 CDT; 22:30 that evening is CDT (UTC-5).
    expect(zonedTimeToUtcMs({ year: 2026, month: 3, day: 8 }, { hour: 22, minute: 30 }, CHICAGO)).toBe(Date.parse('2026-03-09T03:30:00Z'));
    // Ambiguous wall time on the fall-back night resolves to the FIRST (CDT) occurrence.
    expect(zonedTimeToUtcMs({ year: 2026, month: 11, day: 1 }, { hour: 1, minute: 30 }, CHICAGO)).toBe(Date.parse('2026-11-01T06:30:00Z'));
  });

  test('a wall time inside the spring-forward gap resolves AFTER the gap, shifted by the gap length (finding 3)', () => {
    // 2026-03-08: 02:00 CST -> 03:00 CDT; 02:30 does not exist. It resolves to 03:30 CDT
    // (08:30Z), never to 01:30 CST (07:30Z, one hour BEFORE the gap).
    const gap = zonedTimeToUtcMs({ year: 2026, month: 3, day: 8 }, { hour: 2, minute: 30 }, CHICAGO);
    expect(gap).toBe(Date.parse('2026-03-08T08:30:00Z'));
    expect(wallClockAt(gap, CHICAGO)).toMatchObject({ year: 2026, month: 3, day: 8, hour: 3, minute: 30 });
    // The first minute of the gap lands on the first real minute after it (03:00 CDT).
    const gapStart = zonedTimeToUtcMs({ year: 2026, month: 3, day: 8 }, { hour: 2, minute: 0 }, CHICAGO);
    expect(gapStart).toBe(Date.parse('2026-03-08T08:00:00Z'));
    expect(wallClockAt(gapStart, CHICAGO)).toMatchObject({ hour: 3, minute: 0 });
    // Wall times either side of the gap are untouched.
    expect(zonedTimeToUtcMs({ year: 2026, month: 3, day: 8 }, { hour: 1, minute: 59 }, CHICAGO)).toBe(Date.parse('2026-03-08T07:59:00Z'));
    expect(zonedTimeToUtcMs({ year: 2026, month: 3, day: 8 }, { hour: 3, minute: 0 }, CHICAGO)).toBe(Date.parse('2026-03-08T08:00:00Z'));
  });

  test('the shipped 22:30 America/Chicago instants are pinned on the DST days and a normal day', () => {
    // Byte-identical before/after the finding-3 gap fix (22:30 is never in a gap or overlap).
    expect(zonedTimeToUtcMs({ year: 2026, month: 3, day: 8 }, { hour: 22, minute: 30 }, CHICAGO)).toBe(Date.parse('2026-03-09T03:30:00Z'));
    expect(zonedTimeToUtcMs({ year: 2026, month: 11, day: 1 }, { hour: 22, minute: 30 }, CHICAGO)).toBe(Date.parse('2026-11-02T04:30:00Z'));
    expect(zonedTimeToUtcMs({ year: 2026, month: 9, day: 30 }, { hour: 22, minute: 30 }, CHICAGO)).toBe(Date.parse('2026-10-01T03:30:00Z'));
  });
});

describe('nextHardStopAt', () => {
  test('today when 22:30 CT is still ahead (soak morning, 09:00 CDT)', () => {
    const now = Date.parse('2026-09-29T14:00:00Z'); // 09:00 CDT
    expect(nextHardStopAt(now, SPEC)).toBe(Date.parse('2026-09-30T03:30:00Z')); // 22:30 CDT same day
  });

  test('tomorrow when 22:30 CT has already passed today (22:31 CDT)', () => {
    const now = Date.parse('2026-09-30T03:31:00Z'); // 2026-09-29 22:31 CDT
    expect(nextHardStopAt(now, SPEC)).toBe(Date.parse('2026-10-01T03:30:00Z')); // 2026-09-30 22:30 CDT
  });

  test('exactly at 22:30 CT schedules the NEXT day (strictly after now)', () => {
    const at = Date.parse('2026-09-30T03:30:00Z');
    expect(nextHardStopAt(at, SPEC)).toBe(Date.parse('2026-10-01T03:30:00Z'));
    expect(nextHardStopAt(at - 1, SPEC)).toBe(at);
  });

  test('the calendar day is the CHICAGO day, not the UTC day (just after UTC midnight)', () => {
    // 2026-09-30T01:00Z is still 2026-09-29 20:00 CDT -> today's 22:30 CDT is 03:30Z, 2.5h away.
    const now = Date.parse('2026-09-30T01:00:00Z');
    expect(nextHardStopAt(now, SPEC)).toBe(Date.parse('2026-09-30T03:30:00Z'));
  });

  test('DST fall back (2026-11-01, America/Chicago): fires at 22:30 CST = 04:30Z, 23.5h after 00:00 CDT', () => {
    const midnightCdt = Date.parse('2026-11-01T05:00:00Z'); // 2026-11-01 00:00 CDT
    const fire = nextHardStopAt(midnightCdt, SPEC);
    expect(fire).toBe(Date.parse('2026-11-02T04:30:00Z'));
    expect(fire - midnightCdt).toBe(23.5 * 60 * 60 * 1000);
    expect(wallClockAt(fire, CHICAGO)).toMatchObject({ month: 11, day: 1, hour: 22, minute: 30 });
    // From the previous evening just after 22:30 CDT the next fire is also 22:30 CST on 11-01.
    expect(nextHardStopAt(Date.parse('2026-11-01T03:31:00Z'), SPEC)).toBe(Date.parse('2026-11-02T04:30:00Z'));
  });

  test('DST spring forward (2026-03-08, America/Chicago): fires at 22:30 CDT = 03:30Z, 21.5h after 00:00 CST', () => {
    const midnightCst = Date.parse('2026-03-08T06:00:00Z'); // 2026-03-08 00:00 CST
    const fire = nextHardStopAt(midnightCst, SPEC);
    expect(fire).toBe(Date.parse('2026-03-09T03:30:00Z'));
    expect(fire - midnightCst).toBe(21.5 * 60 * 60 * 1000);
    expect(wallClockAt(fire, CHICAGO)).toMatchObject({ month: 3, day: 8, hour: 22, minute: 30 });
    // From the previous evening just after 22:30 CST the next fire is 22:30 CDT on 03-08.
    expect(nextHardStopAt(Date.parse('2026-03-08T04:31:00Z'), SPEC)).toBe(Date.parse('2026-03-09T03:30:00Z'));
  });

  test('every day of a DST-straddling fortnight fires at 22:30 local, exactly one calendar day apart', () => {
    let now = Date.parse('2026-10-26T12:00:00Z');
    let previousDay: string | null = null;
    for (let i = 0; i < 14; i++) {
      const fire = nextHardStopAt(now, SPEC);
      const wc = wallClockAt(fire, CHICAGO);
      expect([wc.hour, wc.minute]).toEqual([22, 30]);
      const day = `${wc.year}-${wc.month}-${wc.day}`;
      expect(day).not.toBe(previousDay);
      previousDay = day;
      now = fire;
    }
  });

  test('rejects a malformed local_time and an unknown zone', () => {
    expect(() => nextHardStopAt(Date.now(), { localTime: '25:00', timezone: CHICAGO })).toThrow(/HH:MM/);
    expect(() => nextHardStopAt(Date.now(), { localTime: '22:30', timezone: 'Mars/Olympus_Mons' })).toThrow(RangeError);
  });
});

describe('guardrails schema: paper_session_hard_stop', () => {
  const base = () => {
    const g = loadGuardrails() as Record<string, unknown>;
    return { ...g };
  };

  test('the canonical YAML carries the desk block (enabled, 22:30 America/Chicago)', () => {
    const g = loadGuardrails();
    expect(g.paper_session_hard_stop).toEqual({
      enabled: true,
      local_time: '22:30',
      timezone: 'America/Chicago',
      reason: 'paper_hard_stop_22_30_ct',
    });
    expect(resolvePaperSessionHardStopConfig(g)).toEqual(g.paper_session_hard_stop);
  });

  test('an absent block resolves to enabled=false with the desk defaults', () => {
    const doc = base();
    delete doc.paper_session_hard_stop;
    const parsed = GuardrailsSchema.parse(doc);
    expect(parsed.paper_session_hard_stop).toBeUndefined();
    expect(resolvePaperSessionHardStopConfig(parsed)).toEqual({
      enabled: false,
      local_time: '22:30',
      timezone: 'America/Chicago',
      reason: 'paper_hard_stop_22_30_ct',
    });
  });

  test('a partial block fills defaults', () => {
    const doc = base();
    doc.paper_session_hard_stop = { enabled: true };
    expect(GuardrailsSchema.parse(doc).paper_session_hard_stop).toEqual({
      enabled: true,
      local_time: '22:30',
      timezone: 'America/Chicago',
      reason: 'paper_hard_stop_22_30_ct',
    });
  });

  test('rejects a malformed local_time at schema level', () => {
    for (const bad of ['24:00', '22:60', '9:30', '2230', '10:30 PM']) {
      const doc = base();
      doc.paper_session_hard_stop = { enabled: true, local_time: bad };
      expect(() => GuardrailsSchema.parse(doc), bad).toThrow(/HH:MM/);
    }
  });

  test('rejects an unknown IANA zone at schema level', () => {
    const doc = base();
    doc.paper_session_hard_stop = { enabled: true, timezone: 'Mars/Olympus_Mons' };
    expect(() => GuardrailsSchema.parse(doc)).toThrow(/IANA/);
  });
});

describe('PaperHardStopScheduler', () => {
  const CONFIG = { enabled: true, local_time: '22:30', timezone: CHICAGO, reason: 'paper_hard_stop_22_30_ct' };
  // Soak morning: 2026-09-29 09:00 CDT. Fire boundary: 22:30 CDT = 2026-09-30T03:30Z.
  const START = Date.parse('2026-09-29T14:00:00Z');
  const FIRST_FIRE = Date.parse('2026-09-30T03:30:00Z');
  const SECOND_FIRE = Date.parse('2026-10-01T03:30:00Z');

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function make(opts: { mode?: 'paper' | 'live'; config?: typeof CONFIG; onFire?: (ctx: PaperHardStopFireContext) => Promise<void> | void } = {}) {
    const logger = makeLogger();
    const fires: PaperHardStopFireContext[] = [];
    const scheduler = new PaperHardStopScheduler({
      mode: opts.mode ?? 'paper',
      config: opts.config ?? CONFIG,
      logger,
      onFire: async (ctx) => {
        fires.push(ctx);
        await opts.onFire?.(ctx);
      },
    });
    return { scheduler, fires, logger };
  }

  test('arms for the next 22:30 CT and exposes it on the snapshot', () => {
    const { scheduler, logger } = make();
    expect(scheduler.arm()).toBe(true);
    expect(scheduler.snapshot()).toEqual({
      enabled: true,
      nextFireAtIso: new Date(FIRST_FIRE).toISOString(),
      nextFireAtMs: FIRST_FIRE,
      timezone: CHICAGO,
      localTime: '22:30',
      reason: 'paper_hard_stop_22_30_ct',
    });
    expect(logger.lines.some((l) => l.level === 'info' && /armed/.test(l.msg))).toBe(true);
  });

  test('fires exactly once at the boundary (not a millisecond early) and re-arms for +1 calendar day', async () => {
    const { scheduler, fires } = make();
    scheduler.arm();

    await vi.advanceTimersByTimeAsync(FIRST_FIRE - START - 1);
    expect(fires).toHaveLength(0);
    expect(scheduler.snapshot().nextFireAtMs).toBe(FIRST_FIRE);

    await vi.advanceTimersByTimeAsync(1);
    expect(fires).toHaveLength(1);
    expect(fires[0]).toMatchObject({
      scheduledForMs: FIRST_FIRE,
      firedAtMs: FIRST_FIRE,
      reason: 'paper_hard_stop_22_30_ct',
      timezone: CHICAGO,
      localTime: '22:30',
    });

    // Re-armed for the following day; nothing else fires in between.
    expect(scheduler.isArmed()).toBe(true);
    expect(scheduler.snapshot().nextFireAtMs).toBe(SECOND_FIRE);
    await vi.advanceTimersByTimeAsync(SECOND_FIRE - FIRST_FIRE - 1);
    expect(fires).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fires).toHaveLength(2);
    expect(fires[1].scheduledForMs).toBe(SECOND_FIRE);
    expect(scheduler.getFireCount()).toBe(2);
  });

  test('disarm() cancels the pending fire and clears the snapshot', async () => {
    const { scheduler, fires } = make();
    scheduler.arm();
    scheduler.disarm();
    expect(scheduler.isArmed()).toBe(false);
    expect(scheduler.snapshot()).toMatchObject({ enabled: false, nextFireAtIso: null, nextFireAtMs: null });
    await vi.advanceTimersByTimeAsync(3 * 24 * 60 * 60 * 1000);
    expect(fires).toHaveLength(0);
    // Idempotent.
    expect(() => scheduler.disarm()).not.toThrow();
  });

  test('a fire whose handler disarms (the server stop path) does NOT re-arm', async () => {
    let ref: PaperHardStopScheduler | null = null;
    const { scheduler, fires } = make({ onFire: () => ref?.disarm() });
    ref = scheduler;
    scheduler.arm();
    await vi.advanceTimersByTimeAsync(FIRST_FIRE - START);
    expect(fires).toHaveLength(1);
    expect(scheduler.isArmed()).toBe(false);
    expect(scheduler.snapshot().nextFireAtIso).toBeNull();
    await vi.advanceTimersByTimeAsync(2 * 24 * 60 * 60 * 1000);
    expect(fires).toHaveLength(1);
  });

  test('re-arm replaces the previous timer (no double fire)', async () => {
    const { scheduler, fires } = make();
    scheduler.arm();
    scheduler.arm();
    await vi.advanceTimersByTimeAsync(FIRST_FIRE - START);
    expect(fires).toHaveLength(1);
  });

  test('a handler that throws is logged, never escapes the timer, and the scheduler still re-arms', async () => {
    const { scheduler, fires, logger } = make({
      onFire: () => {
        throw new Error('stop path exploded');
      },
    });
    scheduler.arm();
    await vi.advanceTimersByTimeAsync(FIRST_FIRE - START);
    expect(fires).toHaveLength(1);
    expect(logger.lines.some((l) => l.level === 'error' && /onFire threw/.test(l.msg))).toBe(true);
    expect(scheduler.snapshot().nextFireAtMs).toBe(SECOND_FIRE);
  });

  test('live mode NEVER arms (and says so), even with the block enabled', async () => {
    const { scheduler, fires, logger } = make({ mode: 'live' });
    expect(scheduler.arm()).toBe(false);
    expect(scheduler.isArmed()).toBe(false);
    expect(scheduler.snapshot()).toMatchObject({ enabled: false, nextFireAtIso: null });
    expect(logger.lines.some((l) => l.level === 'warn' && /not paper/.test(l.msg))).toBe(true);
    await vi.advanceTimersByTimeAsync(3 * 24 * 60 * 60 * 1000);
    expect(fires).toHaveLength(0);
  });

  test('a disabled block never arms', async () => {
    const { scheduler, fires } = make({ config: { ...CONFIG, enabled: false } });
    expect(scheduler.arm()).toBe(false);
    expect(scheduler.snapshot()).toMatchObject({ enabled: false, nextFireAtIso: null, localTime: '22:30', timezone: CHICAGO });
    await vi.advanceTimersByTimeAsync(3 * 24 * 60 * 60 * 1000);
    expect(fires).toHaveLength(0);
  });

  test('arming across the fall-back night fires at 22:30 CST on 2026-11-01 (23.5h later, not 22.5h)', async () => {
    const midnightCdt = Date.parse('2026-11-01T05:00:00Z');
    vi.setSystemTime(midnightCdt);
    const { scheduler, fires } = make();
    scheduler.arm();
    expect(scheduler.snapshot().nextFireAtIso).toBe('2026-11-02T04:30:00.000Z');
    await vi.advanceTimersByTimeAsync(22.5 * 60 * 60 * 1000);
    expect(fires).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(fires).toHaveLength(1);
    expect(wallClockAt(fires[0].firedAtMs, CHICAGO)).toMatchObject({ month: 11, day: 1, hour: 22, minute: 30 });
  });
});
