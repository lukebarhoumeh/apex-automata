-- docs/db/verify/02_execution_mode_backfill.sql
-- Verify #2: 20260910180200_backfill_account_metrics_execution_mode
-- Read-only. Run as postgres (psql or Supabase SQL editor). Documentation only —
-- this file is NOT a migration and must never be applied as one.
--
-- Run immediately after #2 is applied: the backfill is one-shot and
-- handle_new_user() can still insert account_metrics rows with a NULL
-- execution_mode later (handoff doc R5).
--
-- Expected after #2:
--   null_execution_mode_account_metrics = 0 | null_execution_mode_trading_sessions = 0
--   values_valid = t (only 'paper' / 'live') | fn_stamps_execution_mode = t | pass = t
--   Row counts unchanged by the migration (54 / 38 as of 2026-09-10).
--   null_session_id_account_metrics may be > 0: days with no trading_session keep
--   session_id NULL and fall back to execution_mode = 'paper' (by design).

-- Detail: value distribution
SELECT 'account_metrics'  AS tbl, execution_mode, count(*) FROM public.account_metrics  GROUP BY 1, 2
UNION ALL
SELECT 'trading_sessions' AS tbl, execution_mode, count(*) FROM public.trading_sessions GROUP BY 1, 2
ORDER BY 1, 2;

-- Detail: sessions whose execution_mode disagrees with mode (expect 0 rows;
-- only possible if execution_mode was already set to something else pre-backfill)
SELECT session_id, mode, execution_mode
FROM public.trading_sessions
WHERE execution_mode IS DISTINCT FROM mode;

-- Summary (last statement so the SQL editor shows it)
WITH checks AS (
  SELECT
    (SELECT count(*) FROM public.account_metrics  WHERE execution_mode IS NULL) AS null_execution_mode_account_metrics,
    (SELECT count(*) FROM public.trading_sessions WHERE execution_mode IS NULL) AS null_execution_mode_trading_sessions,
    (SELECT count(*) FROM public.account_metrics  WHERE session_id IS NULL)     AS null_session_id_account_metrics,
    (SELECT count(*) FROM public.account_metrics)                               AS account_metrics_rows,
    (SELECT count(*) FROM public.trading_sessions)                              AS trading_sessions_rows,
    (SELECT COALESCE(bool_and(execution_mode IN ('paper', 'live')), true) FROM public.account_metrics)
      AND
    (SELECT COALESCE(bool_and(execution_mode IN ('paper', 'live')), true) FROM public.trading_sessions)
                                                                                AS values_valid,
    pg_get_functiondef('public.upsert_account_metrics(uuid)'::regprocedure) ILIKE '%execution_mode%'
                                                                                AS fn_stamps_execution_mode
)
SELECT *,
       (null_execution_mode_account_metrics = 0
        AND null_execution_mode_trading_sessions = 0
        AND values_valid
        AND fn_stamps_execution_mode)                                           AS pass
FROM checks;
