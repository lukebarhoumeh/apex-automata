/**
 * Active-session scoping for the paper Execution Terminal.
 *
 * The runtime owns exactly one session at a time (`/api/status` →
 * `sessionId` / `sessionStartedAt`). Everything a paper view shows must be
 * attributable to that session — never seeded demo data and never rows an
 * earlier run wrote to the same Supabase project.
 *
 * API gap (documented for Apex Engineering): `public.orders`, `fills`,
 * `positions` and `signals` carry no `session_id` column, so the only honest
 * scope the UI can apply to those tables is the session's own time window:
 * `created_at >= sessionStartedAt`. Rows written by the active engine are
 * always inside that window; rows from prior sessions never are. With no
 * active session there is nothing to attribute, so callers must render an
 * empty state instead of querying at all.
 */

import { fmtDuration } from "@/components/apex/format";

export interface SessionScope {
  sessionId: string | null | undefined;
  /** Epoch ms from `/api/status`. */
  sessionStartedAt: number | null | undefined;
}

/** True only when the runtime reports a session id we can attribute rows to. */
export function hasActiveSession(scope: SessionScope): boolean {
  return typeof scope.sessionId === "string" && scope.sessionId.length > 0;
}

/**
 * ISO-8601 lower bound for `created_at` / `filled_at` / `decided_at` filters.
 * `null` when there is no active session or the runtime did not report a
 * start time (older backend) — in which case callers must not query.
 */
export function sessionSinceIso(scope: SessionScope): string | null {
  if (!hasActiveSession(scope)) return null;
  const startedAt = scope.sessionStartedAt;
  if (typeof startedAt !== "number" || !Number.isFinite(startedAt) || startedAt <= 0) return null;
  return new Date(startedAt).toISOString();
}

/** React Query key fragment so each session gets its own cache entry. */
export function sessionKey(scope: SessionScope): string {
  return hasActiveSession(scope) ? (scope.sessionId as string) : "no-session";
}

/** `…bnd3mn` — the tail operators recognise from the runtime logs. */
export function shortSessionId(sessionId: string | null | undefined): string {
  if (!sessionId) return "—";
  return sessionId.length > 6 ? `…${sessionId.slice(-6)}` : sessionId;
}

/** `HH:MM UTC` of the session start, or "—". */
export function sessionOpenedLabel(sessionStartedAt: number | null | undefined): string {
  if (typeof sessionStartedAt !== "number" || !Number.isFinite(sessionStartedAt) || sessionStartedAt <= 0) return "—";
  return `${new Date(sessionStartedAt).toISOString().slice(11, 16)} UTC`;
}

/**
 * The one session clock. Elapsed `HH:MM:SS` since `sessionStartedAt` at
 * local time `now`, or "—" without a session. Hero, footer and any other
 * uptime label must derive from this so they can never disagree.
 */
export function deriveSessionUptime(
  sessionStartedAt: number | null | undefined,
  now: number,
): string {
  if (typeof sessionStartedAt !== "number" || !Number.isFinite(sessionStartedAt) || sessionStartedAt <= 0) return "—";
  return fmtDuration(Math.max(0, now - sessionStartedAt));
}
