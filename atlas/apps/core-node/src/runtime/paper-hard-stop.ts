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

// ── Fire handling (the server's timer callback) ─────────────────────────────
//
// `api/server.ts` cannot be imported in vitest, so the decision of what a fire
// does and the busy-retry timer live here; the server supplies its module
// state through `PaperHardStopFireRunner`'s deps (PR #82 round-2 findings 1/1b).

/** Retry cadence while another engine operation holds the engine lock. */
export const PAPER_HARD_STOP_BUSY_RETRY_MS = 10_000;
/**
 * Total attempts per fire, the first included: 1 fire + 5 retries, 10 s apart
 * (~50 s), then give up for the day.
 */
export const PAPER_HARD_STOP_BUSY_MAX_ATTEMPTS = 6;

export type HardStopFireDecision = 'run' | 'retry' | 'give_up' | 'stale_session' | 'no_engine' | 'not_paper';

export interface HardStopFireInputs {
  /** Session the scheduler (and any retry) was armed for. */
  armedSessionId: string;
  /** The server's current `runtimeState.sessionId` (null once the session closed). */
  currentSessionId: string | null;
  engineRunning: boolean;
  /** Mode of the running engine (`tradingEngine.getConfig().mode`), null when none. */
  engineMode: ExecutionMode | null;
  /** Another engine operation (start/stop/kill) holds the lock. */
  busy: boolean;
  /** 1 for the scheduled fire, 2..n for busy retries. */
  attempt: number;
  maxAttempts: number;
}

/**
 * What a hard-stop fire (or busy retry) should do. Pure.
 *
 * The session check comes FIRST: a retry armed for a session that has since
 * been stopped (and possibly replaced by a new start) must never act, and must
 * never disarm, because the scheduler may now belong to the new session.
 */
export function decideHardStopFire(inputs: HardStopFireInputs): HardStopFireDecision {
  if (inputs.currentSessionId !== inputs.armedSessionId) return 'stale_session';
  if (!inputs.engineRunning) return 'no_engine';
  if (inputs.engineMode !== 'paper') return 'not_paper';
  if (inputs.busy) return inputs.attempt >= inputs.maxAttempts ? 'give_up' : 'retry';
  return 'run';
}

export interface HardStopRetryTimerOptions {
  /** Injectable timers for tests; the default unrefs the handle so a pending retry never holds the process open. */
  setTimeoutFn?: (fn: () => void, ms: number) => TimerHandle;
  clearTimeoutFn?: (handle: TimerHandle) => void;
}

/**
 * Holds at most ONE pending busy-retry. `schedule()` replaces any previous
 * handle, `cancel()` clears it (the server calls it from every disarm), and
 * the handle is dropped when the callback runs.
 */
export class HardStopRetryTimer {
  private readonly setTimeoutFn: NonNullable<HardStopRetryTimerOptions['setTimeoutFn']>;
  private readonly clearTimeoutFn: NonNullable<HardStopRetryTimerOptions['clearTimeoutFn']>;
  private handle: TimerHandle | null = null;

  constructor(options: HardStopRetryTimerOptions = {}) {
    this.setTimeoutFn =
      options.setTimeoutFn ??
      ((fn, ms) => {
        const handle = setTimeout(fn, ms);
        handle.unref();
        return handle;
      });
    this.clearTimeoutFn = options.clearTimeoutFn ?? ((handle) => clearTimeout(handle));
  }

  schedule(fn: () => void, delayMs: number): void {
    this.cancel();
    const handle = this.setTimeoutFn(() => {
      if (this.handle === handle) this.handle = null;
      fn();
    }, delayMs);
    this.handle = handle;
  }

  /** Clear the pending retry. Returns true when one was pending. Idempotent. */
  cancel(): boolean {
    if (this.handle === null) return false;
    this.clearTimeoutFn(this.handle);
    this.handle = null;
    return true;
  }

  pending(): boolean {
    return this.handle !== null;
  }
}

export interface PaperHardStopFireRunnerOptions {
  logger: Logger;
  /** `runtimeState.sessionId`. */
  getCurrentSessionId: () => string | null;
  /** `tradingEngine?.getConfig().mode ?? null` — null means no engine is running. */
  getEngineMode: () => ExecutionMode | null;
  /** `engineOperationInProgress`. */
  isEngineBusy: () => boolean;
  /** The server's `disarmPaperHardStop(cause)` (used for no_engine / mode_mismatch). */
  disarm: (cause: string) => void;
  /**
   * Take the engine lock and run the shared stop path. Called synchronously
   * right after a `run` decision (no await in between), so the lock the
   * decision saw free cannot be taken by anything else first.
   */
  stop: (ctx: PaperHardStopFireContext, sessionId: string) => Promise<void>;
  retryMs?: number;
  maxAttempts?: number;
  retryTimer?: HardStopRetryTimer;
}

/**
 * The server's hard-stop timer callback. Owns the single busy-retry handle so
 * every disarm can cancel it (`cancelRetry()`), and re-checks the session on
 * every attempt so a retry can never stop a session it was not armed for.
 */
export class PaperHardStopFireRunner {
  private readonly deps: PaperHardStopFireRunnerOptions;
  private readonly retryMs: number;
  private readonly maxAttempts: number;
  private readonly retryTimer: HardStopRetryTimer;

  constructor(deps: PaperHardStopFireRunnerOptions) {
    this.deps = deps;
    this.retryMs = deps.retryMs ?? PAPER_HARD_STOP_BUSY_RETRY_MS;
    this.maxAttempts = deps.maxAttempts ?? PAPER_HARD_STOP_BUSY_MAX_ATTEMPTS;
    this.retryTimer = deps.retryTimer ?? new HardStopRetryTimer();
  }

  /** Cancel a pending busy-retry. Returns true when one was pending. */
  cancelRetry(): boolean {
    return this.retryTimer.cancel();
  }

  retryPending(): boolean {
    return this.retryTimer.pending();
  }

  /**
   * Handle one attempt. The scheduled fire (attempt 1) rethrows a stop failure
   * to the scheduler, which logs it; a retry has no caller, so its failure is
   * logged here instead of becoming an unhandled rejection.
   *
   * @param ctx The scheduler's fire context.
   * @param sessionId Session the scheduler was armed for.
   * @param attempt 1 for the fire, 2..maxAttempts for busy retries.
   */
  async run(ctx: PaperHardStopFireContext, sessionId: string, attempt = 1): Promise<void> {
    const { logger } = this.deps;
    const firedAtIso = new Date(ctx.firedAtMs).toISOString();
    const currentSessionId = this.deps.getCurrentSessionId();
    const engineMode = this.deps.getEngineMode();
    const decision = decideHardStopFire({
      armedSessionId: sessionId,
      currentSessionId,
      engineRunning: engineMode !== null,
      engineMode,
      busy: this.deps.isEngineBusy(),
      attempt,
      maxAttempts: this.maxAttempts,
    });

    switch (decision) {
      case 'stale_session':
        // Never disarm here: the scheduler may already belong to a new session.
        logger.info('PAPER stale hard-stop retry — session changed; not stopping', {
          sessionId,
          currentSessionId,
          attempt,
          firedAt: firedAtIso,
        });
        return;
      case 'no_engine':
        logger.info('PAPER hard stop fired but no engine is running — nothing to stop', { sessionId, firedAt: firedAtIso });
        this.deps.disarm('no_engine');
        return;
      case 'not_paper':
        // Belt-and-braces: the scheduler is only ever built for paper; never stop a live engine from here.
        logger.error('PAPER hard stop fired while the running engine is not paper — REFUSING to act', { sessionId, mode: engineMode });
        this.deps.disarm('mode_mismatch');
        return;
      case 'give_up':
        logger.error('PAPER hard stop could not acquire the engine lock — giving up for today', {
          sessionId,
          attempts: attempt,
          firedAt: firedAtIso,
        });
        return;
      case 'retry':
        logger.warn('PAPER hard stop fired while an engine operation is in progress — retrying', {
          sessionId,
          attempt,
          retryInMs: this.retryMs,
        });
        this.retryTimer.schedule(() => {
          this.run(ctx, sessionId, attempt + 1).catch((error: unknown) => {
            logger.error('PAPER hard stop retry threw', {
              sessionId,
              attempt: attempt + 1,
              error: error instanceof Error ? error.message : String(error),
            });
          });
        }, this.retryMs);
        return;
      case 'run':
        await this.deps.stop(ctx, sessionId);
        return;
    }
  }
}
