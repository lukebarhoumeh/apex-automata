-- docs/db/verify/05_desk_status_views.sql
-- Read-only verification for the 2026-09-29 desk-status migrations:
--   20260929005509_desk_status_views        (v1 views — superseded, kept as history)
--   20260929005512_desk_compat_alias_columns
--   20260929005514_perf_advisor_cleanup
--   20260929010733_desk_status_views_v2     (current view definitions + SELECT-only grants)
-- Run as postgres (SQL editor shows only the final summary row; psql shows all).
-- Documentation only — never copy into supabase/migrations/.

-- 1. Views exist with security_invoker
SELECT c.relname, c.reloptions
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relname IN ('desk_session_status', 'desk_risk_status')
ORDER BY c.relname;

-- 2. Grants: SELECT only, authenticated + service_role, no anon
SELECT table_name, grantee, privilege_type
FROM information_schema.role_table_grants
WHERE table_schema = 'public'
  AND table_name IN ('desk_session_status', 'desk_risk_status')
  AND grantee IN ('anon', 'authenticated', 'service_role')
ORDER BY table_name, grantee, privilege_type;

-- 3. Generated alias columns (11)
SELECT table_name, column_name, is_generated, generation_expression
FROM information_schema.columns
WHERE table_schema = 'public'
  AND ((table_name = 'trading_sessions' AND column_name IN
        ('id','status','starting_equity','ending_equity','equity','trade_count','trades_count','pnl'))
    OR (table_name = 'risk_metrics' AND column_name IN ('kill_switch','halt','exposure')))
ORDER BY table_name, column_name;

-- 4. The desk monitor's own statements (must return rows / 0 rows, never 42703)
SELECT id, status, started_at, ended_at, equity, trade_count, pnl, execution_mode
FROM public.trading_sessions
ORDER BY COALESCE(ended_at, started_at) DESC NULLS LAST LIMIT 3;

SELECT kill_switch, consecutive_losses, daily_pnl, max_drawdown, exposure, execution_mode, updated_at
FROM public.risk_metrics
ORDER BY updated_at DESC NULLS LAST LIMIT 1;

-- 5. Canonical desk reads
SELECT id, status, equity, open_position_value, trade_count, pnl, execution_mode
FROM public.desk_session_status
ORDER BY COALESCE(ended_at, started_at) DESC NULLS LAST LIMIT 3;

SELECT status, kill_switch, active_halts, latest_halt_type, consecutive_losses, daily_pnl,
       exposure, day_start_equity, day_start_equity_date, session_id, execution_mode, updated_at
FROM public.desk_risk_status
ORDER BY updated_at DESC NULLS LAST LIMIT 1;

-- 6. Advisor cleanups
SELECT indexname FROM pg_indexes
WHERE schemaname = 'public'
  AND indexname IN ('idx_account_metrics_user_date','idx_mf_decisions_timestamp','idx_mf_decisions_signal_id',
                    'account_metrics_user_date_idx','idx_meta_filter_decisions_timestamp','idx_meta_filter_decisions_signal')
ORDER BY indexname;                                   -- expect only the 3 survivors

SELECT tablename, policyname, qual FROM pg_policies
WHERE schemaname = 'public'
  AND ((tablename = 'trading_sessions' AND policyname = 'trading_sessions_user_policy')
    OR (tablename = 'exchange_credentials' AND policyname = 'Service role full access'));

-- 7. External-consumer fence unchanged
SELECT n.nspname, c.relkind::text
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relname = 'agentic_heartbeats';               -- expect equity r + public v

-- 8. Summary
SELECT
  (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'v'
      AND c.relname IN ('desk_session_status', 'desk_risk_status')
      AND 'security_invoker=true' = ANY (c.reloptions))                       AS views_invoker,
  (SELECT count(*) FROM information_schema.role_table_grants
    WHERE table_schema = 'public'
      AND table_name IN ('desk_session_status', 'desk_risk_status')
      AND grantee IN ('anon', 'authenticated', 'service_role'))              AS view_grant_rows,
  (SELECT count(*) FROM information_schema.role_table_grants
    WHERE table_schema = 'public'
      AND table_name IN ('desk_session_status', 'desk_risk_status')
      AND grantee = 'anon')                                                    AS anon_grants,
  (SELECT count(*) FROM information_schema.columns
    WHERE table_schema = 'public' AND is_generated = 'ALWAYS'
      AND ((table_name = 'trading_sessions' AND column_name IN
            ('id','status','starting_equity','ending_equity','equity','trade_count','trades_count','pnl'))
        OR (table_name = 'risk_metrics' AND column_name IN ('kill_switch','halt','exposure')))) AS generated_cols,
  (SELECT count(*) FROM pg_indexes WHERE schemaname = 'public'
    AND indexname IN ('idx_account_metrics_user_date','idx_mf_decisions_timestamp','idx_mf_decisions_signal_id')) AS dup_indexes_left,
  (SELECT count(*) FROM pg_policies WHERE schemaname = 'public'
    AND ((tablename = 'trading_sessions' AND policyname = 'trading_sessions_user_policy')
      OR (tablename = 'exchange_credentials' AND policyname = 'Service role full access'))
    AND qual LIKE '%( SELECT auth.%')                                          AS initplan_policies,
  (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'agentic_heartbeats' AND n.nspname = 'public' AND c.relkind = 'v') AS heartbeats_view_ok,
  (
    (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'v'
        AND c.relname IN ('desk_session_status', 'desk_risk_status')
        AND 'security_invoker=true' = ANY (c.reloptions)) = 2
    AND (SELECT count(*) FROM information_schema.role_table_grants
          WHERE table_schema = 'public'
            AND table_name IN ('desk_session_status', 'desk_risk_status')
            AND grantee IN ('anon', 'authenticated', 'service_role')) = 4     -- 2 views x (authenticated, service_role) SELECT
    AND (SELECT count(*) FROM information_schema.role_table_grants
          WHERE table_schema = 'public'
            AND table_name IN ('desk_session_status', 'desk_risk_status')
            AND grantee = 'anon') = 0
    AND (SELECT count(*) FROM information_schema.columns
          WHERE table_schema = 'public' AND is_generated = 'ALWAYS'
            AND ((table_name = 'trading_sessions' AND column_name IN
                  ('id','status','starting_equity','ending_equity','equity','trade_count','trades_count','pnl'))
              OR (table_name = 'risk_metrics' AND column_name IN ('kill_switch','halt','exposure')))) = 11
    AND (SELECT count(*) FROM pg_indexes WHERE schemaname = 'public'
          AND indexname IN ('idx_account_metrics_user_date','idx_mf_decisions_timestamp','idx_mf_decisions_signal_id')) = 0
    AND (SELECT count(*) FROM pg_policies WHERE schemaname = 'public'
          AND ((tablename = 'trading_sessions' AND policyname = 'trading_sessions_user_policy')
            OR (tablename = 'exchange_credentials' AND policyname = 'Service role full access'))
          AND qual LIKE '%( SELECT auth.%') = 2
    AND (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE c.relname = 'agentic_heartbeats' AND n.nspname = 'public' AND c.relkind = 'v') = 1
  ) AS pass;
