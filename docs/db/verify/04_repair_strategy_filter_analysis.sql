-- docs/db/verify/04_repair_strategy_filter_analysis.sql
-- Verify #4: 20260910180400_repair_strategy_filter_analysis_view
-- Read-only. Run as postgres (psql or Supabase SQL editor). Documentation only —
-- this file is NOT a migration and must never be applied as one.
--
-- Prod today (2026-09-10) has NO public.strategy_filter_analysis, so before #4
-- this script reports view_exists = f / pass = f — expected baseline. On a
-- Preview branch the patched 20260107000002 already creates the view but with
-- Supabase default privileges (anon_select = t), so pass = f until #4 runs in
-- the same chain and revokes anon; the full chain ends with pass = t.
--
-- Expected after #4:
--   view_exists = t | security_invoker = t | fixed_definition = t (uses the
--   hourly / hourly_json CTEs, i.e. no nested aggregates) | twelve_columns = t
--   anon_select = f | authenticated_select = t | pass = t

-- Detail: definition as stored (NULL when the view is absent)
SELECT pg_get_viewdef(to_regclass('public.strategy_filter_analysis'), true) AS definition;

-- Summary (last statement so the SQL editor shows it)
WITH v AS (
  SELECT to_regclass('public.strategy_filter_analysis') AS oid
), checks AS (
  SELECT
    v.oid IS NOT NULL                                                          AS view_exists,
    COALESCE((SELECT 'security_invoker=true' = ANY (c.reloptions)
              FROM pg_class c WHERE c.oid = v.oid), false)                     AS security_invoker,
    COALESCE(pg_get_viewdef(v.oid, true) ILIKE '%hourly_json%', false)         AS fixed_definition,
    (SELECT count(*) FROM pg_attribute a
      WHERE a.attrelid = v.oid AND a.attnum > 0 AND NOT a.attisdropped) = 12   AS twelve_columns,
    CASE WHEN v.oid IS NULL THEN false
         ELSE has_table_privilege('anon', v.oid, 'SELECT') END                 AS anon_select,
    CASE WHEN v.oid IS NULL THEN false
         ELSE has_table_privilege('authenticated', v.oid, 'SELECT') END        AS authenticated_select
  FROM v
)
SELECT *,
       (view_exists AND security_invoker AND fixed_definition AND twelve_columns
        AND NOT anon_select AND authenticated_select)                          AS pass
FROM checks;
