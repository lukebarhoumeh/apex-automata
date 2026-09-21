/**
 * Coinbase Derivatives Exchange (CDE) crypto trading hours — the weekly break.
 *
 * Venue fact (CDE nano Bitcoin Perp-Style spec PDF; CDE API memo 2026-09-11):
 * crypto futures trade Friday 18:00 ET → Friday 17:00 ET with a ONE-HOUR
 * weekly break Friday 17:00–18:00 America/New_York. No resting logic may
 * span the gap — the desk rule for card SH-QMAKER-CFM-PAPER-v0 is "flatten
 * into the Fri break; inv breach without flatten → VOID".
 *
 * This module is pure: given a `Date` and the harness leads
 * (`guardrails.cfm.hours_gap`) it answers which phase we are in.
 *
 *   open ──(break − entry_block_lead)──▶ entry_blocked ──(break − flatten_lead)──▶ flatten ──17:00──▶ break ──18:00──▶ open
 *
 *   - `open`          normal trading.
 *   - `entry_blocked` no NEW `*-CDE` positions; resting orders may stay, exits allowed.
 *   - `flatten`       cancel resting `*-CDE` orders, flatten `*-CDE` inventory, no entries.
 *   - `break`         venue closed: no `*-CDE` orders at all (exits still permitted by
 *                     the risk layer in case anything is left, but nothing should be).
 *
 * DST is handled by formatting in the venue time zone (`Intl.DateTimeFormat`),
 * never by fixed UTC offsets. Consumers should TICK (≤ 60 s) rather than sleep
 * until `msToNextTransition`: the minute arithmetic is exact within a day but a
 * DST switch (Sunday 02:00 ET) between now and a transition days away shifts it
 * by an hour.
 */

export const CDE_TIME_ZONE = 'America/New_York';

/** Friday 17:00–18:00 America/New_York. `weekday` uses JS convention (0 = Sunday). */
export const CDE_WEEKLY_BREAK = Object.freeze({
  timeZone: CDE_TIME_ZONE,
  weekday: 5,
  startHour: 17,
  endHour: 18,
});

export type CdeBreakPhase = 'open' | 'entry_blocked' | 'flatten' | 'break';

export interface CdeBreakLeads {
  /** Minutes before the break when new `*-CDE` entries stop. */
  entryBlockLeadMin: number;
  /** Minutes before the break when `*-CDE` orders are cancelled and inventory flattened. */
  flattenLeadMin: number;
}

export interface EtWallClock {
  /** 0 = Sunday … 6 = Saturday, in America/New_York. */
  weekday: number;
  hour: number;
  minute: number;
  second: number;
  /** `YYYY-MM-DD` in America/New_York (for episode keys / logs). */
  date: string;
}

export interface CdeBreakStatus {
  phase: CdeBreakPhase;
  /** Milliseconds until the current phase ends (see DST caveat in the module doc). */
  msToNextTransition: number;
  /** Milliseconds until the next break starts; 0 while the break is on. */
  msToBreakStart: number;
  /** Venue wall clock the decision was made on. */
  et: EtWallClock;
  /** Stable key for "this week's break episode" (`YYYY-MM-DD` of the Friday), or null when open. */
  episodeKey: string | null;
}

const WEEKDAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const MINUTES_PER_DAY = 24 * 60;
const MINUTES_PER_WEEK = 7 * MINUTES_PER_DAY;

const formatter = new Intl.DateTimeFormat('en-US', {
  timeZone: CDE_TIME_ZONE,
  weekday: 'short',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

/**
 * Wall clock in America/New_York for an instant.
 *
 * @param now Instant to convert.
 */
export function etWallClock(now: Date): EtWallClock {
  const parts = formatter.formatToParts(now);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  // `hour12: false` can render midnight as "24" in some ICU versions.
  const hour = Number.parseInt(get('hour'), 10) % 24;
  return {
    weekday: WEEKDAY_INDEX[get('weekday')] ?? 0,
    hour,
    minute: Number.parseInt(get('minute'), 10),
    second: Number.parseInt(get('second'), 10),
    date: `${get('year')}-${get('month')}-${get('day')}`,
  };
}

/** Minutes since Sunday 00:00 ET (fractional seconds included). */
function minutesIntoWeek(et: EtWallClock): number {
  return et.weekday * MINUTES_PER_DAY + et.hour * 60 + et.minute + et.second / 60;
}

/** Minutes from `from` forward to `to` on the weekly circle. */
function forwardMinutes(from: number, to: number): number {
  const diff = to - from;
  return diff >= 0 ? diff : diff + MINUTES_PER_WEEK;
}

/**
 * Where `now` sits relative to the CDE weekly break, given the harness leads.
 *
 * @param now Instant to classify.
 * @param leads Entry-block / flatten leads in minutes (`guardrails.cfm.hours_gap`).
 * @throws When `flattenLeadMin > entryBlockLeadMin` (you stop entering before you flatten).
 */
export function cdeBreakStatus(now: Date, leads: CdeBreakLeads): CdeBreakStatus {
  if (leads.flattenLeadMin > leads.entryBlockLeadMin) {
    throw new Error(
      `cdeBreakStatus: flattenLeadMin (${leads.flattenLeadMin}) must be <= entryBlockLeadMin (${leads.entryBlockLeadMin})`,
    );
  }
  const et = etWallClock(now);
  const t = minutesIntoWeek(et);
  const breakStart = CDE_WEEKLY_BREAK.weekday * MINUTES_PER_DAY + CDE_WEEKLY_BREAK.startHour * 60;
  const breakEnd = CDE_WEEKLY_BREAK.weekday * MINUTES_PER_DAY + CDE_WEEKLY_BREAK.endHour * 60;
  const flattenStart = breakStart - Math.max(0, leads.flattenLeadMin);
  const entryBlockStart = breakStart - Math.max(0, leads.entryBlockLeadMin);

  let phase: CdeBreakPhase;
  let nextTransition: number;
  if (t >= breakStart && t < breakEnd) {
    phase = 'break';
    nextTransition = breakEnd;
  } else if (t >= flattenStart && t < breakStart) {
    phase = 'flatten';
    nextTransition = breakStart;
  } else if (t >= entryBlockStart && t < flattenStart) {
    phase = 'entry_blocked';
    nextTransition = flattenStart;
  } else {
    phase = 'open';
    nextTransition = entryBlockStart;
  }

  const msToNextTransition = Math.round(forwardMinutes(t, nextTransition) * 60_000);
  const msToBreakStart = phase === 'break' ? 0 : Math.round(forwardMinutes(t, breakStart) * 60_000);

  return {
    phase,
    msToNextTransition,
    msToBreakStart,
    et,
    // Every non-open phase belongs to the Friday it leads into (same ET date, since
    // the widest lead is well under 17 hours).
    episodeKey: phase === 'open' ? null : et.date,
  };
}

/** True while the venue is closed (Fri 17:00–18:00 ET). */
export function isCdeBreak(now: Date): boolean {
  return cdeBreakStatus(now, { entryBlockLeadMin: 0, flattenLeadMin: 0 }).phase === 'break';
}
