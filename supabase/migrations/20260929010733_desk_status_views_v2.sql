-- =============================================================================
-- Desk status views v2 — honest equity columns + SELECT-only grants
-- (2026-09-29, supersedes 20260929005509_desk_status_views).
-- =============================================================================
-- Why (found while verifying v1 against live rows):
--   1. `account_metrics.total_equity` is NOT account equity. The writer is the
--      SECURITY DEFINER RPC public.upsert_account_metrics(p_user_id), which
--      stores SUM(qty_open * latest filled price) over OPEN positions — i.e.
--      open-position market value, 0.00 when flat (see also
--      atlas/apps/core-node/src/persistence/position-upsert.ts header). v1
--      exposed it as `current_equity` / `equity`, which would read 0.00 for a
--      flat OPEN session. The only equity anchor the runtime persists is
--      daily_equity.start_equity (risk-engine.ts saveDailyStartEquity);
--      end_equity / high / low are never written today.
--   2. Supabase default privileges granted ALL on the new views to
--      authenticated + service_role at CREATE time; v1 only revoked anon.
--      The views are not auto-updatable (LATERAL joins) so writes would fail
--      anyway, but the grants should say what we mean: SELECT only.
--
-- What changes (both views are DROPped and re-CREATEd; no table changes):
--   desk_session_status
--     - current_equity, current_equity_as_of, unrealized_pnl   (removed)
--     + open_position_value, open_position_value_as_of         (account_metrics.total_equity, labelled honestly)
--     ~ equity = COALESCE(final_equity, initial_equity)        (same as the generated table column)
--   desk_risk_status
--     - current_equity, equity, equity_as_of                    (removed)
--     + open_position_value, open_position_value_as_of         (account_metrics.total_equity)
--     + day_start_equity, day_start_equity_date                (latest daily_equity row for user/mode)
--     = session_id still = latest account_metrics.session_id   (the RPC stamps the newest trading_sessions row)
--   grants: REVOKE ALL FROM PUBLIC, anon, authenticated, service_role;
--           GRANT SELECT TO authenticated, service_role.
--   trading_sessions.equity COMMENT corrected (it pointed at the removed alias).
--
-- Everything else (security_invoker, the open-halt rule mirrored from
-- paper-boot-guard.ts, the alias columns) is unchanged from v1.
--
-- Scope fence (docs/db/EXTERNAL_CONSUMERS.md): reads ONLY public.trading_sessions,
-- public.risk_metrics, public.account_metrics, public.risk_events,
-- public.daily_equity. No agentic_* / cb_* / equity.* objects.
--
-- Idempotent: DROP VIEW IF EXISTS + CREATE; grants are absolute. Re-running
-- is a no-op.
--
-- Rollback (as postgres): re-run 20260929005509_desk_status_views.sql (v1),
-- or DROP both views.
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
  COALESCE(s.final_equity, s.initial_equity)                  AS equity,
  s.total_trades,
  s.total_trades                                              AS trade_count,
  s.total_trades                                              AS trades_count,
  s.total_pnl,
  s.total_pnl                                                 AS pnl,
  s.realized_pnl,
  am.total_equity                                             AS open_position_value,
  am.updated_at                                               AS open_position_value_as_of,
  s.created_at,
  s.updated_at
FROM public.trading_sessions s
LEFT JOIN LATERAL (
  SELECT m.total_equity, m.updated_at
  FROM public.account_metrics m
  WHERE m.session_id = s.session_id
  ORDER BY m.updated_at DESC NULLS LAST
  LIMIT 1
) am ON TRUE;

COMMENT ON VIEW public.desk_session_status IS
  'Desk read surface over trading_sessions. status = OPEN while ended_at IS NULL, else ENDED. equity = final_equity once ended, else initial_equity (session-start equity; the runtime persists no intraday equity). Read-only, security_invoker.';
COMMENT ON COLUMN public.desk_session_status.id IS 'Alias of session_id (text primary key, sess_<epoch>_<rand>).';
COMMENT ON COLUMN public.desk_session_status.status IS 'OPEN when ended_at IS NULL, otherwise ENDED. Derived; not stored on the table.';
COMMENT ON COLUMN public.desk_session_status.equity IS 'COALESCE(final_equity, initial_equity). For an OPEN session this is the session-start equity, not a live mark.';
COMMENT ON COLUMN public.desk_session_status.open_position_value IS 'Latest account_metrics.total_equity stamped with this session_id. Written by upsert_account_metrics() as SUM(qty_open * latest fill price) over OPEN positions: open-position market value, 0.00 when flat. NOT account equity.';
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
  am.total_equity                                             AS open_position_value,
  am.updated_at                                               AS open_position_value_as_of,
  de.start_equity                                             AS day_start_equity,
  de.date                                                     AS day_start_equity_date,
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
  SELECT d.start_equity, d.date
  FROM public.daily_equity d
  WHERE d.user_id = r.user_id
    AND (r.execution_mode IS NULL OR d.execution_mode IS NULL OR d.execution_mode = r.execution_mode)
  ORDER BY d.date DESC
  LIMIT 1
) de ON TRUE
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
COMMENT ON COLUMN public.desk_risk_status.session_id IS 'session_id of the latest account_metrics row for this user/mode (upsert_account_metrics stamps the newest trading_sessions row; risk_metrics itself carries no session stamp).';
COMMENT ON COLUMN public.desk_risk_status.open_position_value IS 'Latest account_metrics.total_equity for this user/mode: SUM(qty_open * latest fill price) over OPEN positions, 0.00 when flat. NOT account equity.';
COMMENT ON COLUMN public.desk_risk_status.day_start_equity IS 'daily_equity.start_equity of the latest daily_equity row for this user/mode (the risk engine''s day-start anchor; see day_start_equity_date). The runtime persists no intraday equity mark.';

-- ---------------------------------------------------------------------------
-- 3. Grants — SELECT only for authenticated + service_role. RLS of the base
--    tables still applies through security_invoker. The MCP endpoint runs
--    as postgres (owner) and is unaffected.
-- ---------------------------------------------------------------------------
REVOKE ALL ON public.desk_session_status FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON public.desk_risk_status    FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.desk_session_status TO authenticated, service_role;
GRANT SELECT ON public.desk_risk_status    TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. Correct the v1 comment on the generated alias column
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF to_regclass('public.trading_sessions') IS NOT NULL
     AND EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'trading_sessions' AND column_name = 'equity') THEN
    COMMENT ON COLUMN public.trading_sessions.equity IS
      'GENERATED: COALESCE(final_equity, initial_equity). For an OPEN session this is the session-start equity; the runtime persists no intraday equity mark (account_metrics.total_equity is open-position value, not equity). Do not write.';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Post-conditions (read-only; run after apply) — docs/db/verify/05_desk_status_views.sql
-- ---------------------------------------------------------------------------
-- SELECT grantee, privilege_type FROM information_schema.role_table_grants
--  WHERE table_schema = 'public' AND table_name IN ('desk_session_status', 'desk_risk_status')
--    AND grantee IN ('anon', 'authenticated', 'service_role');
--   -- expect exactly: authenticated SELECT, service_role SELECT (x2 views); no anon rows
-- SELECT status, kill_switch, active_halts, open_position_value, day_start_equity, session_id
--   FROM public.desk_risk_status ORDER BY updated_at DESC NULLS LAST LIMIT 1;
