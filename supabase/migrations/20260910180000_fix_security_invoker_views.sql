-- Restore security_invoker on the three analytics views.
--
-- 20260204215045_20260204_security_invoker_views.sql set security_invoker on
-- these views; 20260305015408_fix_numeric_precision.sql then DROP/CREATEd them
-- without the option, silently reverting them to owner (postgres) privileges
-- and bypassing the underlying tables' RLS. Verified on prod 2026-09-10:
-- pg_class.reloptions IS NULL for all three.
--
-- Idempotent: ALTER VIEW IF EXISTS + SET is a no-op when already set.
-- Handoff: Database Engineer, 2026-09-10 (see docs/db/HANDOFF_2026-09-10.md).

ALTER VIEW IF EXISTS public.ml_training_data SET (security_invoker = true);
ALTER VIEW IF EXISTS public.strategy_regime_performance SET (security_invoker = true);
ALTER VIEW IF EXISTS public.daily_trade_summary SET (security_invoker = true);
