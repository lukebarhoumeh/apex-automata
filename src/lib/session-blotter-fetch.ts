/**
 * Session-scoped blotter reads for the paper Execution Terminal.
 *
 * Prefer runtime API (`GET /api/orders|fills|signals`) which applies the same
 * `session_id` + legacy time-window filter as the backend contract. Fall back
 * to Supabase with an equivalent `.or()` when the API is unreachable.
 */

import { supabase } from "@/integrations/supabase/client";
import {
  hasActiveSession,
  sessionSinceIso,
  sessionWindow,
  type SessionScope,
} from "@/lib/session-scope";

/** Env-only base URL (see README); throws when unset so we never embed a literal host. */
function runtimeApiBase(): string {
  const url = import.meta.env.VITE_RUNTIME_API_URL;
  if (typeof url !== "string" || url.length === 0) {
    throw new Error("VITE_RUNTIME_API_URL is not configured");
  }
  return url.replace(/\/$/, "");
}

/** Time column used for legacy unstamped rows (matches api/session-scope.ts). */
export const SESSION_BLOTTER_TIME_COLUMN = {
  orders: "created_at",
  fills: "filled_at",
  signals: "created_at",
} as const;

export type SessionBlotterTable = keyof typeof SESSION_BLOTTER_TIME_COLUMN;

/** Signals also expose `decided_at` for display; use it for pure time-window fallback. */
export const SIGNALS_DISPLAY_TIME_COLUMN = "decided_at";

export type SessionScopeWithMode = SessionScope & {
  mode?: "paper" | "live" | null;
};

function isSessionColumnMissingError(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  const code = error.code ?? "";
  const msg = (error.message ?? "").toLowerCase();
  return (
    code === "42703" ||
    code === "PGRST204" ||
    msg.includes("session_id") ||
    msg.includes("execution_mode")
  );
}

/**
 * PostgREST `or()` filter: stamped rows for the active session, plus unstamped
 * rows inside the session start window (migration applied mid-session).
 */
export function buildSessionBlotterOrFilter(table: SessionBlotterTable, scope: SessionScope): string | null {
  if (!hasActiveSession(scope)) return null;
  const since = sessionSinceIso(scope);
  if (!since) return null;
  const timeCol = SESSION_BLOTTER_TIME_COLUMN[table];
  const sessionId = scope.sessionId as string;
  return `session_id.eq.${sessionId},and(session_id.is.null,${timeCol}.gte.${since})`;
}

function blotterApiUrl(table: SessionBlotterTable, scope: SessionScopeWithMode, limit: number): string {
  const params = new URLSearchParams({ limit: String(limit) });
  if (scope.sessionId) params.set("session_id", scope.sessionId);
  if (scope.mode === "paper" || scope.mode === "live") {
    params.set("execution_mode", scope.mode);
  }
  return `${runtimeApiBase()}/api/${table}?${params.toString()}`;
}

async function fetchBlotterFromApi(
  table: SessionBlotterTable,
  scope: SessionScopeWithMode,
  limit: number,
): Promise<unknown[] | null> {
  let url: string;
  try {
    url = blotterApiUrl(table, scope, limit);
  } catch {
    return null;
  }
  let res: Response;
  try {
    res = await fetch(url);
  } catch {
    return null;
  }
  if (res.status === 429 || res.status >= 500) return null;
  if (!res.ok) return null;
  const body = (await res.json()) as Record<string, unknown>;
  const rows = body[table];
  return Array.isArray(rows) ? rows : [];
}

type SupabaseBlotterQuery = {
  select: string;
  orderColumn: string;
  /** When session_id columns are absent, filter on this column instead of created_at for signals. */
  timeWindowColumn?: string;
};

async function fetchBlotterFromSupabase(
  table: SessionBlotterTable,
  scope: SessionScopeWithMode,
  limit: number,
  query: SupabaseBlotterQuery,
): Promise<unknown[]> {
  const orFilter = buildSessionBlotterOrFilter(table, scope);
  if (!orFilter) return [];

  const orderCol = query.orderColumn;
  let builder = supabase
    .from(table)
    .select(query.select)
    .or(orFilter)
    .order(orderCol, { ascending: false })
    .limit(limit);

  if (scope.mode === "paper" || scope.mode === "live") {
    builder = builder.or(`execution_mode.eq.${scope.mode},execution_mode.is.null`);
  }

  const { data, error } = await builder;
  if (!error) return (data as unknown[]) ?? [];

  if (!isSessionColumnMissingError(error)) {
    throw new Error(`${table} fetch: ${error.message}`);
  }

  const window = sessionWindow(scope);
  if (!window) return [];
  const timeCol = query.timeWindowColumn ?? SESSION_BLOTTER_TIME_COLUMN[table];
  let legacy = supabase
    .from(table)
    .select(query.select)
    .gte(timeCol, window.since)
    .lte(timeCol, window.until)
    .order(orderCol, { ascending: false })
    .limit(limit);

  const { data: legacyData, error: legacyError } = await legacy;
  if (legacyError) throw new Error(`${table} fetch (legacy window): ${legacyError.message}`);
  return (legacyData as unknown[]) ?? [];
}

/**
 * Rows for one blotter table in the active session. Returns `[]` without a session.
 */
export async function fetchSessionBlotterRows(
  table: SessionBlotterTable,
  scope: SessionScopeWithMode,
  limit: number,
  query: SupabaseBlotterQuery,
): Promise<unknown[]> {
  if (!hasActiveSession(scope)) return [];

  const apiRows = await fetchBlotterFromApi(table, scope, limit);
  if (apiRows !== null) return apiRows;

  return fetchBlotterFromSupabase(table, scope, limit, query);
}
