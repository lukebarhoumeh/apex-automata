-- docs/db/verify/06_strategy_name_enum.sql
-- Read-only verification for
--   20260929120000_add_donchian_daily_s3_to_strategy_name_enum.sql
--   (placeholder version — renamed to the apply-time version after the MCP apply)
-- Run as postgres or any role that can read pg_enum (SQL editor shows only the
-- final summary row; psql shows all).
-- Documentation only — never copy into supabase/migrations/.

-- 1. Every label of public.strategy_name in declaration order.
--    Expected (7 rows): breakout, vwap_mr, obi_scalper, momentum, trend_follow,
--    system, donchian_daily_s3 — the new label LAST, existing order unchanged.
SELECT enumlabel, enumsortorder
FROM pg_enum
WHERE enumtypid = 'public.strategy_name'::regtype
ORDER BY enumsortorder;

-- 2. The three columns typed with the enum (the writers this label reaches).
--    Expected: orders.strategy, positions.strategy, signals.strategy (plus any
--    other column on the same type, e.g. strategy_params.name).
SELECT table_name, column_name, udt_name
FROM information_schema.columns
WHERE table_schema = 'public' AND udt_name = 'strategy_name'
ORDER BY table_name, column_name;

-- 3. Rows already carrying the label (informational; 0 while the plugin is
--    disabled — it stays on every kill list, this migration enables nothing).
SELECT 'orders'    AS tbl, count(*) FILTER (WHERE strategy::text = 'donchian_daily_s3') AS donchian_rows FROM public.orders
UNION ALL
SELECT 'positions',       count(*) FILTER (WHERE strategy::text = 'donchian_daily_s3')                   FROM public.positions
UNION ALL
SELECT 'signals',         count(*) FILTER (WHERE strategy::text = 'donchian_daily_s3')                   FROM public.signals;

-- 4. Summary
SELECT
  (SELECT count(*) FROM pg_enum WHERE enumtypid = 'public.strategy_name'::regtype)                                        AS label_count,
  (SELECT count(*) FROM pg_enum WHERE enumtypid = 'public.strategy_name'::regtype AND enumlabel = 'donchian_daily_s3')    AS donchian_present,
  (SELECT count(*) FROM pg_enum WHERE enumtypid = 'public.strategy_name'::regtype
     AND enumlabel IN ('breakout','vwap_mr','obi_scalper','momentum','trend_follow','system'))                            AS legacy_labels,
  (SELECT enumlabel FROM pg_enum WHERE enumtypid = 'public.strategy_name'::regtype ORDER BY enumsortorder DESC LIMIT 1)   AS last_label,
  (
    (SELECT count(*) FROM pg_enum WHERE enumtypid = 'public.strategy_name'::regtype AND enumlabel = 'donchian_daily_s3') = 1
    AND (SELECT count(*) FROM pg_enum WHERE enumtypid = 'public.strategy_name'::regtype
           AND enumlabel IN ('breakout','vwap_mr','obi_scalper','momentum','trend_follow','system')) = 6
    AND (SELECT enumlabel FROM pg_enum WHERE enumtypid = 'public.strategy_name'::regtype ORDER BY enumsortorder DESC LIMIT 1) = 'donchian_daily_s3'
  ) AS pass;
