-- docs/db/verify/01_security_invoker_and_revoke.sql
-- Verify #1: 20260910180000_fix_security_invoker_views +
--            20260910180100_revoke_anon_execute_security_definer
-- Read-only. Run as postgres (psql or Supabase SQL editor). Documentation only —
-- this file is NOT a migration and must never be applied as one.
--
-- Expected after #1:
--   views:     security_invoker = t on ml_training_data, strategy_regime_performance,
--              daily_trade_summary (3 rows)
--   functions: anon_exec = f on all 6 DEFINER fns; public_exec = f on all 6;
--              auth_exec = t ONLY for has_role(uuid, app_role) and
--              upsert_account_metrics(uuid); service_exec = t on all 6
--   summary:   every column = t

-- Detail: views
SELECT c.relname                                                     AS view_name,
       COALESCE('security_invoker=true' = ANY (c.reloptions), false) AS security_invoker
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind = 'v'
  AND c.relname IN ('ml_training_data', 'strategy_regime_performance', 'daily_trade_summary')
ORDER BY 1;

-- Detail: EXECUTE matrix on the six SECURITY DEFINER functions
SELECT fn,
       has_function_privilege('anon',          fn, 'EXECUTE') AS anon_exec,
       has_function_privilege('public',        fn, 'EXECUTE') AS public_exec,
       has_function_privilege('authenticated', fn, 'EXECUTE') AS auth_exec,
       has_function_privilege('service_role',  fn, 'EXECUTE') AS service_exec
FROM unnest(ARRAY[
  'public.handle_new_user()',
  'public.handle_updated_at()',
  'public.has_role(uuid, public.app_role)',
  'public.touch_updated_at()',
  'public.update_updated_at_column()',
  'public.upsert_account_metrics(uuid)'
]) AS fn;

-- Summary (last statement so the SQL editor shows it)
WITH v AS (
  SELECT c.relname,
         COALESCE('security_invoker=true' = ANY (c.reloptions), false) AS si
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind = 'v'
    AND c.relname IN ('ml_training_data', 'strategy_regime_performance', 'daily_trade_summary')
), f AS (
  SELECT fn,
         has_function_privilege('anon',          fn, 'EXECUTE') AS anon_exec,
         has_function_privilege('public',        fn, 'EXECUTE') AS public_exec,
         has_function_privilege('authenticated', fn, 'EXECUTE') AS auth_exec,
         has_function_privilege('service_role',  fn, 'EXECUTE') AS service_exec
  FROM unnest(ARRAY[
    'public.handle_new_user()', 'public.handle_updated_at()',
    'public.has_role(uuid, public.app_role)', 'public.touch_updated_at()',
    'public.update_updated_at_column()', 'public.upsert_account_metrics(uuid)'
  ]) AS fn
), checks AS (
  SELECT
    (SELECT count(*) = 3 AND bool_and(si) FROM v)                          AS views_security_invoker,
    (SELECT bool_and(NOT anon_exec) FROM f)                                AS anon_exec_false_all,
    (SELECT bool_and(NOT public_exec) FROM f)                              AS public_exec_false_all,
    (SELECT bool_and(auth_exec = (fn IN ('public.has_role(uuid, public.app_role)',
                                         'public.upsert_account_metrics(uuid)'))) FROM f)
                                                                           AS auth_exec_only_has_role_and_upsert,
    (SELECT bool_and(service_exec) FROM f)                                 AS service_exec_true_all
)
SELECT *,
       (views_security_invoker AND anon_exec_false_all AND public_exec_false_all
        AND auth_exec_only_has_role_and_upsert AND service_exec_true_all)  AS pass
FROM checks;
