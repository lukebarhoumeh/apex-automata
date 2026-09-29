-- =============================================================================
-- Desk status views — stable, documented read surface for "is a paper session
-- open / what is the risk state" questions (2026-09-29, PR #82 follow-up).
-- =============================================================================
-- Why: the Postgres error log for 2026-09-28 (142 errors / 170 requests in the
-- dashboard, 21% success) is a single external reader — the desk monitor
-- polling through the Supabase MCP endpoint (`POST /mcp`, OAuth user
-- 3d0e1e1e-25ff-424c-81f8-142a80fb3df0) every 10–15 min — guessing column
-- names that do not exist on `trading_sessions` / `risk_metrics`
-- (sqlstate 42703: `id`, `status`, `equity`, `trade_count`, `trades_count`,
-- `pnl`, `starting_equity`, `ending_equity`, `kill_switch`, `exposure`,
-- `session_id` on risk_metrics). None of the errors come from the Apex
-- runtime or the frontend. See docs/db/DESK_QUERIES_2026-09-29.md.
--
-- What this adds (READ-ONLY, ADDITIVE, no table / RLS / grant changes):
--   public.desk_session_status  one row per trading_sessions row, with the
--                               vocabulary the desk asks for (id, status
--                               OPEN|ENDED, equity, trade_count, pnl, …) plus
--                               the latest account_metrics equity for the
--                               session (current_equity).
--   public.desk_risk_status     one row per risk_metrics row (one per
--                               user_id × execution_mode) with kill_switch /
--                               halt / exposure aliases, the open-halt count
--                               computed EXACTLY like the paper boot guard
--                               (src/trading/risk/paper-boot-guard.ts
--                               isOpenHaltRiskEvent: real halt code, not a
--                               soft ladder rung, not cleared, not retired,
--                               not a resume audit row), and the latest
--                               account_metrics session_id / equity.
--
-- Both views are `security_invoker = true` (the 2026-09-10 hardening
-- posture): row access is decided by the RLS of the underlying tables for
-- the caller, never by the view owner. anon is revoked (same as every other
-- Apex view); authenticated + service_role get SELECT. The MCP endpoint runs
-- as `postgres` and is unaffected by grants.
--
-- Scope fence (docs/db/EXTERNAL_CONSUMERS.md): reads ONLY public.trading_sessions,
-- public.risk_metrics, public.account_metrics, public.risk_events. Nothing
-- here touches agentic_* / cb_* / equity.* objects or their policies.
--
-- Idempotent: DROP VIEW IF EXISTS + CREATE, so re-running (or re-defining
-- the column list later) is safe; no dependents exist.
--
-- Rollback (as postgres):
--   DROP VIEW IF EXISTS public.desk_risk_status;
--   DROP VIEW IF EXISTS public.desk_session_status;
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. desk_session_status
-- ---------------------------------------------------------------------------
DROP VIEW IF EXISTS public.desk_session_status;

CREATE VIEW public.desk_session_status
WITH (security_invoker = true) AS
SELECT
  s.session_id                                                AS id,
  s.session_id,
  s.user_id,
  s.mode,
  s.execution_mode,
  CASE WHEN s.ended_at IS NULL THEN 'OPEN' ELSE 'ENDED' END   AS status,
  s.started_at,
  s.ended_at,
  s.initial_equity,
  s.initial_equity                                            AS starting_equity,
  s.final_equity,
  s.final_equity                                              AS ending_equity,
  am.total_equity                                             AS current_equity,
  am.updated_at                                               AS current_equity_as_of,
  COALESCE(s.final_equity, am.total_equity, s.initial_equity) AS equity,
  s.total_trades,
  s.total_trades                                              AS trade_count,
  s.total_trades                                              AS trades_count,
  s.total_pnl,
  s.total_pnl                                                 AS pnl,
  s.realized_pnl,
  am.unrealized_pnl,
  s.created_at,
  s.updated_at
FROM public.trading_sessions s
LEFT JOIN LATERAL (
  SELECT m.total_equity, m.unrealized_pnl, m.updated_at
  FROM public.account_metrics m
  WHERE m.session_id = s.session_id
  ORDER BY m.updated_at DESC NULLS LAST
  LIMIT 1
) am ON TRUE;

COMMENT ON VIEW public.desk_session_status IS
  'Desk read surface over trading_sessions. status = OPEN while ended_at IS NULL, else ENDED. equity = final_equity (ended) else latest account_metrics.total_equity for the session else initial_equity. Read-only, security_invoker.';
COMMENT ON COLUMN public.desk_session_status.id IS 'Alias of session_id (text primary key, sess_<epoch>_<rand>).';
COMMENT ON COLUMN public.desk_session_status.status IS 'OPEN when ended_at IS NULL, otherwise ENDED. Derived; not stored on the table.';
COMMENT ON COLUMN public.desk_session_status.equity IS 'COALESCE(final_equity, latest account_metrics.total_equity for this session, initial_equity).';
COMMENT ON COLUMN public.desk_session_status.current_equity IS 'Latest account_metrics.total_equity stamped with this session_id (NULL when the session never wrote one).';
COMMENT ON COLUMN public.desk_session_status.trade_count IS 'Alias of total_trades (closed trades at session end; NULL while open).';
COMMENT ON COLUMN public.desk_session_status.pnl IS 'Alias of total_pnl (final_equity - initial_equity at session end; NULL while open).';

-- ---------------------------------------------------------------------------
-- 2. desk_risk_status
-- ---------------------------------------------------------------------------
DROP VIEW IF EXISTS public.desk_risk_status;

CREATE VIEW public.desk_risk_status
WITH (security_invoker = true) AS
SELECT
  r.id,
  r.user_id,
  r.execution_mode,
  CASE
    WHEN r.kill_switch_active OR COALESCE(he.active_halts, 0) > 0 THEN 'HALTED'
    ELSE 'OK'
  END                                                         AS status,
  r.kill_switch_active,
  r.kill_switch_active                                        AS kill_switch,
  r.kill_switch_active                                        AS halt,
  COALESCE(he.active_halts, 0)                                AS active_halts,
  he.latest_halt_type,
  he.latest_halt_at,
  r.consecutive_losses,
  r.daily_pnl,
  r.daily_pnl_r,
  r.realized_pnl_usd,
  r.unrealized_pnl_usd,
  r.max_drawdown,
  r.error_rate,
  r.exposure_usd,
  r.exposure_usd                                              AS exposure,
  r.average_latency_ms,
  r.market_data_stale_ms,
  am.session_id,
  am.total_equity                                             AS current_equity,
  am.total_equity                                             AS equity,
  am.updated_at                                               AS equity_as_of,
  r.created_at,
  r.updated_at
FROM public.risk_metrics r
LEFT JOIN LATERAL (
  SELECT m.session_id, m.total_equity, m.updated_at
  FROM public.account_metrics m
  WHERE m.user_id = r.user_id
    AND (r.execution_mode IS NULL OR m.execution_mode IS NULL OR m.execution_mode = r.execution_mode)
  ORDER BY m.updated_at DESC NULLS LAST
  LIMIT 1
) am ON TRUE
LEFT JOIN LATERAL (
  -- Mirrors paper-boot-guard.ts isOpenHaltRiskEvent(): a row still blocks a
  -- paper boot when it is a real halt code (never an L1–L5 soft rung), not
  -- cleared, not retired (active=false) and not a resume audit row.
  SELECT
    count(*)::int                                              AS active_halts,
    (array_agg(e.event_type ORDER BY e.triggered_at DESC))[1]  AS latest_halt_type,
    max(e.triggered_at)                                        AS latest_halt_at
  FROM public.risk_events e
  WHERE e.user_id = r.user_id
    AND (r.execution_mode IS NULL OR e.execution_mode IS NULL OR e.execution_mode = r.execution_mode)
    AND e.cleared_at IS NULL
    AND e.active IS DISTINCT FROM false
    AND e.event_type NOT IN ('size_down_consec', 'size_down_daily_r', 'strategy_freeze', 'regime_pause', 'sleeve_halt')
    AND COALESCE(e.details ->> 'eventType', '') <> 'resume'
) he ON TRUE;

COMMENT ON VIEW public.desk_risk_status IS
  'Desk read surface over risk_metrics (one row per user_id x execution_mode). status = HALTED when kill_switch_active or an open halt risk_events row exists (same rule as the paper boot guard), else OK. Read-only, security_invoker.';
COMMENT ON COLUMN public.desk_risk_status.kill_switch IS 'Alias of kill_switch_active.';
COMMENT ON COLUMN public.desk_risk_status.halt IS 'Alias of kill_switch_active.';
COMMENT ON COLUMN public.desk_risk_status.exposure IS 'Alias of exposure_usd.';
COMMENT ON COLUMN public.desk_risk_status.active_halts IS 'Open halt risk_events rows for this user/mode per paper-boot-guard.ts isOpenHaltRiskEvent (excludes L1-L5 soft rungs, cleared/retired rows, resume audit rows). >0 means a paper start is refused without RISK_CLEAR=YES.';
COMMENT ON COLUMN public.desk_risk_status.session_id IS 'session_id of the latest account_metrics row for this user/mode (risk_metrics itself carries no session stamp).';
COMMENT ON COLUMN public.desk_risk_status.current_equity IS 'Latest account_metrics.total_equity for this user/mode.';

-- ---------------------------------------------------------------------------
-- 3. Grants — same posture as the 2026-09-10 hardening: anon revoked,
--    authenticated + service_role may SELECT (RLS of the base tables still
--    applies through security_invoker).
-- ---------------------------------------------------------------------------
REVOKE ALL ON public.desk_session_status FROM PUBLIC, anon;
REVOKE ALL ON public.desk_risk_status    FROM PUBLIC, anon;
GRANT SELECT ON public.desk_session_status TO authenticated, service_role;
GRANT SELECT ON public.desk_risk_status    TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Post-conditions (read-only; run after apply) — docs/db/verify/05_desk_status_views.sql
-- ---------------------------------------------------------------------------
-- SELECT c.relname, c.reloptions FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
--  WHERE n.nspname = 'public' AND c.relname IN ('desk_session_status', 'desk_risk_status');
--   -- expect 2 rows, reloptions = {security_invoker=true}
-- SELECT id, status, started_at, ended_at, equity, trade_count, pnl, execution_mode
--   FROM public.desk_session_status ORDER BY COALESCE(ended_at, started_at) DESC NULLS LAST LIMIT 3;
-- SELECT status, kill_switch, active_halts, consecutive_losses, daily_pnl, exposure, execution_mode, session_id, updated_at
--   FROM public.desk_risk_status ORDER BY updated_at DESC NULLS LAST LIMIT 1;
