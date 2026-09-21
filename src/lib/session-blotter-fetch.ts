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
  type SessionWindow,
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
  positions: "opened_at",
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

/** Query-string additions per table (e.g. `status=open` on `/api/positions`). */
export type BlotterApiParams = Readonly<Record<string, string>>;

export function blotterApiUrl(
  table: SessionBlotterTable,
  scope: SessionScopeWithMode,
  limit: number,
  extra: BlotterApiParams = {},
): string {
  const params = new URLSearchParams({ limit: String(limit) });
  if (scope.sessionId) params.set("session_id", scope.sessionId);
  if (scope.mode === "paper" || scope.mode === "live") {
    params.set("execution_mode", scope.mode);
  }
  for (const [k, v] of Object.entries(extra)) params.set(k, v);
  return `${runtimeApiBase()}/api/${table}?${params.toString()}`;
}

/** Full JSON body of a blotter endpoint, or `null` when the API is unusable (fall back to Supabase). */
async function fetchBlotterBodyFromApi(
  table: SessionBlotterTable,
  scope: SessionScopeWithMode,
  limit: number,
  extra: BlotterApiParams = {},
): Promise<Record<string, unknown> | null> {
  let url: string;
  try {
    url = blotterApiUrl(table, scope, limit, extra);
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
  const body = (await res.json()) as unknown;
  return body && typeof body === "object" ? (body as Record<string, unknown>) : null;
}

async function fetchBlotterFromApi(
  table: SessionBlotterTable,
  scope: SessionScopeWithMode,
  limit: number,
): Promise<unknown[] | null> {
  const body = await fetchBlotterBodyFromApi(table, scope, limit);
  if (!body) return null;
  const rows = body[table];
  return Array.isArray(rows) ? rows : [];
}

type SupabaseBlotterQuery = {
  select: string;
  orderColumn: string;
  /** When session_id columns are absent, filter on this column instead of created_at for signals. */
  timeWindowColumn?: string;
};

type BlotterReadResult = {
  data: unknown[] | null;
  error: { code?: string; message?: string } | null;
};

/**
 * Run the stamped (`session_id`) read; when the deployed schema lacks the
 * session columns, re-run inside the session time window instead. Any other
 * error is thrown so React Query keeps the last-good rows.
 *
 * @param stamped Executes the `session_id`-scoped query.
 * @param legacy Executes the time-window query for the given window.
 */
async function readStampedOrLegacyWindow(
  table: SessionBlotterTable,
  scope: SessionScopeWithMode,
  stamped: () => Promise<BlotterReadResult>,
  legacy: (window: SessionWindow) => Promise<BlotterReadResult>,
): Promise<unknown[]> {
  const { data, error } = await stamped();
  if (!error) return data ?? [];

  if (!isSessionColumnMissingError(error)) {
    throw new Error(`${table} fetch: ${error.message}`);
  }

  const window = sessionWindow(scope);
  if (!window) return [];
  const { data: legacyData, error: legacyError } = await legacy(window);
  if (legacyError) throw new Error(`${table} fetch (legacy window): ${legacyError.message}`);
  return legacyData ?? [];
}

/** `execution_mode` clause for the stamped read (unstamped rows pass). */
function executionModeOrFilter(scope: SessionScopeWithMode): string | null {
  return scope.mode === "paper" || scope.mode === "live"
    ? `execution_mode.eq.${scope.mode},execution_mode.is.null`
    : null;
}

async function fetchBlotterFromSupabase(
  table: SessionBlotterTable,
  scope: SessionScopeWithMode,
  limit: number,
  query: SupabaseBlotterQuery,
): Promise<unknown[]> {
  const orFilter = buildSessionBlotterOrFilter(table, scope);
  if (!orFilter) return [];

  const orderCol = query.orderColumn;
  const modeFilter = executionModeOrFilter(scope);

  return readStampedOrLegacyWindow(
    table,
    scope,
    async () => {
      let builder = supabase
        .from(table)
        .select(query.select)
        .or(orFilter)
        .order(orderCol, { ascending: false })
        .limit(limit);
      if (modeFilter) builder = builder.or(modeFilter);
      const { data, error } = await builder;
      return { data, error };
    },
    async (window) => {
      const timeCol = query.timeWindowColumn ?? SESSION_BLOTTER_TIME_COLUMN[table];
      const { data, error } = await supabase
        .from(table)
        .select(query.select)
        .gte(timeCol, window.since)
        .lte(timeCol, window.until)
        .order(orderCol, { ascending: false })
        .limit(limit);
      return { data, error };
    },
  );
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

// ============================================================
// Positions — `GET /api/positions?status=open` (engine truth) with Supabase fallback
// ============================================================

/**
 * In-memory engine position as serialised by `/api/positions`
 * (`engineOpenPositions`, active session only). This is the PositionTracker's
 * own view — the same set the PnL snapshot's `openPositionsCount` /
 * `exposureUsd` are computed from — so the UI open count matches the engine
 * by construction. Includes positions hydrated from a prior session (flagged).
 */
export interface EngineOpenPosition {
  id: string;
  symbol: string;
  strategy: string | null;
  side: "long" | "short" | "flat" | string;
  size: number;
  averagePrice: number;
  /** Engine mark used for its unrealized P&L; may lag the WS ticker by a poll. */
  marketPrice: number;
  unrealizedPnL: number;
  realizedPnL: number;
  stopPrice: number | null;
  takeProfit: number | null;
  /** Epoch ms (or ISO) the position opened. */
  openTime: number | string | null;
  /** Opened in a prior session and hydrated at engine start — not one of this session's trades. */
  hydratedFromPriorSession: boolean;
}

export interface SessionOpenPositionsResult {
  /**
   * Engine opens for the ACTIVE session. `null` when the API did not provide
   * them (unreachable, or an older backend) — callers then use `rows`.
   */
  engineOpenPositions: readonly EngineOpenPosition[] | null;
  /** `positions` table rows scoped to the session (API rows or Supabase fallback). */
  rows: readonly unknown[];
  source: "api" | "supabase" | "none";
}

const NO_OPEN_POSITIONS: SessionOpenPositionsResult = { engineOpenPositions: null, rows: [], source: "none" };

/** Supabase `positions` column list the fallback read selects. */
export const POSITIONS_FALLBACK_SELECT =
  "id,symbol,strategy,side,qty_open,entry_price,stop_price_at_entry,take_profit_price,opened_at,closed_at";

/**
 * Open positions of the ACTIVE session. Prefers
 * `GET /api/positions?session_id=&execution_mode=&status=open` and reads the
 * engine's `engineOpenPositions` (hydrated ones flagged). Falls back to
 * Supabase `positions` filtered by `session_id` (plus unstamped rows inside
 * the session window) AND `closed_at IS NULL` — never an unscoped
 * `closed_at IS NULL` sweep, which bled every prior run's leftovers in.
 * Returns an empty result without an active session.
 */
export async function fetchSessionOpenPositions(
  scope: SessionScopeWithMode,
  limit = 50,
): Promise<SessionOpenPositionsResult> {
  if (!hasActiveSession(scope)) return NO_OPEN_POSITIONS;

  const body = await fetchBlotterBodyFromApi("positions", scope, limit, { status: "open" });
  if (body) {
    const rows = Array.isArray(body.positions) ? (body.positions as unknown[]) : [];
    const engine = Array.isArray(body.engineOpenPositions)
      ? (body.engineOpenPositions as EngineOpenPosition[])
      : null;
    return { engineOpenPositions: engine, rows, source: "api" };
  }

  const rows = await fetchOpenPositionsFromSupabase(scope, limit);
  return { engineOpenPositions: null, rows, source: "supabase" };
}

/**
 * Supabase fallback: `closed_at IS NULL` AND (`session_id = active` OR
 * unstamped inside the session window). A hydrated position keeps the
 * session_id of the run that OPENED it, so it is absent here — the API path
 * (`engineOpenPositions`) is the only source that surfaces hydrated opens.
 */
async function fetchOpenPositionsFromSupabase(scope: SessionScopeWithMode, limit: number): Promise<unknown[]> {
  const orFilter = buildSessionBlotterOrFilter("positions", scope);
  if (!orFilter) return [];
  const modeFilter = executionModeOrFilter(scope);
  const timeCol = SESSION_BLOTTER_TIME_COLUMN.positions;

  return readStampedOrLegacyWindow(
    "positions",
    scope,
    async () => {
      let builder = supabase
        .from("positions")
        .select(POSITIONS_FALLBACK_SELECT)
        .is("closed_at", null)
        .or(orFilter)
        .order(timeCol, { ascending: false })
        .limit(limit);
      if (modeFilter) builder = builder.or(modeFilter);
      const { data, error } = await builder;
      return { data, error };
    },
    async (window) => {
      const { data, error } = await supabase
        .from("positions")
        .select(POSITIONS_FALLBACK_SELECT)
        .is("closed_at", null)
        .gte(timeCol, window.since)
        .lte(timeCol, window.until)
        .order(timeCol, { ascending: false })
        .limit(limit);
      return { data, error };
    },
  );
}
