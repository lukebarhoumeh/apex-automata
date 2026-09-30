/**
 * Paper session hard stop — engine-side scheduled self-stop (handoff P5).
 *
 * The paper soak is ended by an EXTERNAL automation on LukePC (10:18pm CT:
 * `POST /api/engine/stop`, then the processes are killed). On 2026-09-22 that
 * external stop failed and the session ran on overnight. This module is the
 * engine-side BACKSTOP: while a PAPER session is running, a timer is armed for
 * the next `HH:MM` wall-clock time in an IANA zone (desk: 22:30
 * America/Chicago) and, when it fires, the server runs the SAME stop path the
 * `/api/engine/stop` route uses (engine.stop(reason) → flatten_on_shutdown →
 * closeTradingSession). The external automation stays primary; this only
 * catches the case where it did not run.
 *
 * PAPER ONLY. The scheduler is constructed by the server only for paper
 * sessions AND refuses to arm for any other mode (`arm()` returns false and
 * logs). The live stop path is untouched.
 *
 * The time math is pure and DST-safe: the wall clock for the target day is
 * resolved through `Intl.DateTimeFormat` (no fixed UTC offsets, no new deps),
 * so a fire on 2026-11-01 (fall back) or 2026-03-08 (spring forward) in
 * America/Chicago lands on the real 22:30 local. Consumers should not compute
 * "now + 24h": the scheduler re-derives the next occurrence every time it
 * (re-)arms.
 */

import type { Logger } from '../core/logger';
import type { ExecutionMode } from './session-context';

/** Guardrails `paper_session_hard_stop` block (see loadGuardrails.ts). */
export interface PaperSessionHardStopConfig {
  enabled: boolean;
  /** `HH:MM`, 24h, wall clock in `timezone`. */
  local_time: string;
  /** IANA zone, e.g. `America/Chicago`. */
  timezone: string;
  /** Stop reason handed to `engine.stop()` and stamped on the log line. */
  reason: string;
}

export interface HardStopTimeSpec {
  /** `HH:MM`, 24h. */
  localTime: string;
  /** IANA zone. */
  timezone: string;
}

export interface PaperHardStopSnapshot {
  /** True while a timer is armed (paper session running, block enabled). */
  enabled: boolean;
  /** ISO-8601 (UTC) instant of the next fire, or null when not armed. */
  nextFireAtIso: string | null;
  /** Epoch ms of the next fire, or null when not armed. */
  nextFireAtMs: number | null;
  timezone: string;
  localTime: string;
  reason: string;
}

export interface PaperHardStopFireContext {
  /** Epoch ms the timer actually fired. */
  firedAtMs: number;
  /** Epoch ms the fire was scheduled for (the resolved HH:MM instant). */
  scheduledForMs: number;
  reason: string;
  timezone: string;
  localTime: string;
}

/** `HH:MM`, 24h — shared with the guardrails zod schema. */
export const HARD_STOP_LOCAL_TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;
const HH_MM = HARD_STOP_LOCAL_TIME_PATTERN;
/** Node clamps timer delays above 2^31-1 ms to 1 ms; keep every hop well under that. */
const MAX_TIMER_DELAY_MS = 12 * 60 * 60 * 1000;

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function wallClockFormatter(timezone: string): Intl.DateTimeFormat {
  let formatter = formatterCache.get(timezone);
  if (!formatter) {
    // Throws RangeError for an unknown IANA zone — surfaced to the caller on purpose.
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
    formatterCache.set(timezone, formatter);
  }
  return formatter;
}

export interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/**
 * Wall clock of an instant in an IANA zone.
 *
 * @param ms Epoch ms.
 * @param timezone IANA zone.
 * @throws RangeError when `timezone` is not a valid IANA zone.
 */
export function wallClockAt(ms: number, timezone: string): WallClock {
  const parts = wallClockFormatter(timezone).formatToParts(new Date(ms));
  const get = (type: string): number => Number.parseInt(parts.find((p) => p.type === type)?.value ?? '0', 10);
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    // `hour12: false` renders midnight as "24" in some ICU versions.
    hour: get('hour') % 24,
    minute: get('minute'),
    second: get('second'),
  };
}

/** Parse `HH:MM` (24h). Returns null when malformed. */
export function parseLocalTime(localTime: string): { hour: number; minute: number } | null {
  const match = HH_MM.exec(localTime);
  if (!match) return null;
  return { hour: Number.parseInt(match[1], 10), minute: Number.parseInt(match[2], 10) };
}

function wallClockAsUtcMs(wc: WallClock): number {
  return Date.UTC(wc.year, wc.month - 1, wc.day, wc.hour, wc.minute, wc.second);
}

/**
 * Epoch ms of a wall-clock time in an IANA zone (`zonedTimeToUtc`).
 *
 * Starts from the naive UTC reading of the wall clock and corrects by the
 * zone offset observed at that guess, iterating so a DST boundary between the
 * guess and the answer is absorbed. A wall time that does not exist (inside a
 * spring-forward gap) is shifted forward by the gap length, e.g. 02:30 in a
 * 1h gap resolves to 03:30 after it; an ambiguous wall time (fall-back
 * overlap) resolves to the first (DST) occurrence. Neither can happen for
 * 22:30 in America/Chicago.
 *
 * @param date Calendar day in the zone.
 * @param time Wall-clock hour/minute in the zone.
 * @param timezone IANA zone.
 */
export function zonedTimeToUtcMs(
  date: { year: number; month: number; day: number },
  time: { hour: number; minute: number },
  timezone: string,
): number {
  const target = Date.UTC(date.year, date.month - 1, date.day, time.hour, time.minute, 0);
  let utc = target;
  for (let i = 0; i < 4; i++) {
    const observed = wallClockAsUtcMs(wallClockAt(utc, timezone));
    const diff = observed - utc; // the zone offset at `utc`
    const candidate = target - diff;
    if (candidate === utc) break;
    utc = candidate;
  }
  // Fall-back overlap: `target - offset` may have converged on the second
  // occurrence; prefer the earlier instant if it also reads as the target.
  const earlier = utc - 60 * 60 * 1000;
  if (wallClockAsUtcMs(wallClockAt(earlier, timezone)) === target) return earlier;
  // Spring-forward gap: the target wall time never exists, so the iteration
  // settles on an instant that reads BEFORE it (the pre-gap offset). Shift
  // forward by the shortfall (= the gap length), offset-agnostic.
  const reads = wallClockAsUtcMs(wallClockAt(utc, timezone));
  if (reads < target) utc += target - reads;
  return utc;
}

/**
 * Next occurrence (strictly after `nowMs`) of `localTime` in `timezone`.
 *
 * @param nowMs Epoch ms "now".
 * @param spec `HH:MM` + IANA zone.
 * @returns Epoch ms of the next fire.
 * @throws Error when `localTime` is not `HH:MM`; RangeError for an unknown zone.
 */
export function nextHardStopAt(nowMs: number, spec: HardStopTimeSpec): number {
  const time = parseLocalTime(spec.localTime);
  if (!time) {
    throw new Error(`paper_session_hard_stop.local_time must be HH:MM (24h), got '${spec.localTime}'`);
  }
  const today = wallClockAt(nowMs, spec.timezone);
  let candidate = zonedTimeToUtcMs(today, time, spec.timezone);
  // Walk forward by calendar day (never by 24h of ms) until strictly in the future.
  let dayOffset = 1;
  while (candidate <= nowMs) {
    const next = new Date(Date.UTC(today.year, today.month - 1, today.day + dayOffset));
    candidate = zonedTimeToUtcMs(
      { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() },
      time,
      spec.timezone,
    );
    dayOffset++;
    if (dayOffset > 3) {
      throw new Error(`nextHardStopAt: could not resolve a future ${spec.localTime} ${spec.timezone} from ${new Date(nowMs).toISOString()}`);
    }
  }
  return candidate;
}

type TimerHandle = ReturnType<typeof setTimeout>;

export interface PaperHardStopSchedulerOptions {
  /** Session execution mode. Anything but `paper` never arms. */
  mode: ExecutionMode;
  config: PaperSessionHardStopConfig;
  /** Runs the shared stop path. Errors are logged, never rethrown into the timer. */
  onFire: (ctx: PaperHardStopFireContext) => Promise<void> | void;
  logger: Logger;
  /** Injectable clock / timers for tests. */
  now?: () => number;
  setTimeoutFn?: (fn: () => void, ms: number) => TimerHandle;
  clearTimeoutFn?: (handle: TimerHandle) => void;
}

/**
 * Arms a timer for the next `local_time` in `timezone` and runs `onFire` when
 * it is reached. After a fire the scheduler re-arms for the next occurrence
 * unless `disarm()` was called (the server's stop path disarms, so a fired
 * hard stop leaves the scheduler idle until the next paper start).
 */
export class PaperHardStopScheduler {
  private readonly mode: ExecutionMode;
  private readonly config: PaperSessionHardStopConfig;
  private readonly onFire: PaperHardStopSchedulerOptions['onFire'];
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly setTimeoutFn: NonNullable<PaperHardStopSchedulerOptions['setTimeoutFn']>;
  private readonly clearTimeoutFn: NonNullable<PaperHardStopSchedulerOptions['clearTimeoutFn']>;

  private timer: TimerHandle | null = null;
  private nextFireAtMs: number | null = null;
  private armed = false;
  private firing = false;
  private fireCount = 0;

  constructor(options: PaperHardStopSchedulerOptions) {
    this.mode = options.mode;
    this.config = options.config;
    this.onFire = options.onFire;
    this.logger = options.logger;
    this.now = options.now ?? (() => Date.now());
    this.setTimeoutFn = options.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimeoutFn = options.clearTimeoutFn ?? ((handle) => clearTimeout(handle));
  }

  /**
   * Arm for the next occurrence. Returns false (and arms nothing) when the
   * block is disabled or the session is not paper.
   *
   * @param nowMs Epoch ms to schedule from (defaults to the injected clock).
   */
  arm(nowMs: number = this.now()): boolean {
    if (this.mode !== 'paper') {
      this.logger.warn('PAPER hard stop scheduler refused to arm: session is not paper (live path untouched)', {
        mode: this.mode,
      });
      return false;
    }
    if (!this.config.enabled) {
      this.logger.info('PAPER hard stop backstop disabled by guardrails (paper_session_hard_stop.enabled=false)');
      return false;
    }
    this.disarm();
    this.nextFireAtMs = nextHardStopAt(nowMs, { localTime: this.config.local_time, timezone: this.config.timezone });
    this.armed = true;
    this.scheduleHop(nowMs);
    this.logger.info('PAPER hard stop backstop armed (engine-side; external 10:18pm CT stop stays primary)', {
      nextFireAt: new Date(this.nextFireAtMs).toISOString(),
      localTime: this.config.local_time,
      timezone: this.config.timezone,
      reason: this.config.reason,
    });
    return true;
  }

  /** Cancel the pending timer. Idempotent. */
  disarm(): void {
    if (this.timer !== null) {
      this.clearTimeoutFn(this.timer);
      this.timer = null;
    }
    this.armed = false;
    this.nextFireAtMs = null;
  }

  /** True while a timer is pending. */
  isArmed(): boolean {
    return this.armed;
  }

  /** Number of times `onFire` has been invoked. */
  getFireCount(): number {
    return this.fireCount;
  }

  snapshot(): PaperHardStopSnapshot {
    return {
      enabled: this.armed,
      nextFireAtIso: this.nextFireAtMs !== null ? new Date(this.nextFireAtMs).toISOString() : null,
      nextFireAtMs: this.nextFireAtMs,
      timezone: this.config.timezone,
      localTime: this.config.local_time,
      reason: this.config.reason,
    };
  }

  /** Schedule the next timer hop toward `nextFireAtMs` (bounded so long waits survive Node's timer cap). */
  private scheduleHop(nowMs: number): void {
    if (!this.armed || this.nextFireAtMs === null) return;
    const remaining = this.nextFireAtMs - nowMs;
    const delay = Math.max(0, Math.min(remaining, MAX_TIMER_DELAY_MS));
    this.timer = this.setTimeoutFn(() => {
      this.timer = null;
      void this.onTimer();
    }, delay);
  }

  private async onTimer(): Promise<void> {
    if (!this.armed || this.nextFireAtMs === null) return;
    const nowMs = this.now();
    if (nowMs < this.nextFireAtMs) {
      // Intermediate hop (or an early wake) — keep waiting for the real boundary.
      this.scheduleHop(nowMs);
      return;
    }
    if (this.firing) return;
    this.firing = true;
    const scheduledForMs = this.nextFireAtMs;
    this.fireCount++;
    try {
      await this.onFire({
        firedAtMs: nowMs,
        scheduledForMs,
        reason: this.config.reason,
        timezone: this.config.timezone,
        localTime: this.config.local_time,
      });
    } catch (err) {
      // The timer callback has no caller to rethrow to; log loudly and keep the scheduler consistent.
      this.logger.error('PAPER hard stop onFire threw', {
        error: err instanceof Error ? err.message : String(err),
        scheduledFor: new Date(scheduledForMs).toISOString(),
      });
    } finally {
      this.firing = false;
    }
    // Re-arm for the next occurrence unless the stop path disarmed us meanwhile.
    if (this.armed && this.nextFireAtMs === scheduledForMs) {
      const rearmFrom = Math.max(this.now(), scheduledForMs);
      this.nextFireAtMs = nextHardStopAt(rearmFrom, { localTime: this.config.local_time, timezone: this.config.timezone });
      this.scheduleHop(this.now());
      this.logger.info('PAPER hard stop backstop re-armed for the next occurrence', {
        nextFireAt: new Date(this.nextFireAtMs).toISOString(),
      });
    }
  }
}
