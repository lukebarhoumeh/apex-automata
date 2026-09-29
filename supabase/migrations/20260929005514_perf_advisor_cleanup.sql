-- =============================================================================
-- Performance-advisor cleanup on Apex-owned objects (2026-09-29).
-- =============================================================================
-- Source: Supabase performance advisor run on 2026-09-29 against project
-- gdrdaajvutmewgxbjurk. Only the findings on Apex crypto tables are handled;
-- everything on agentic_* / cb_* (the co-hosted equity workflow) is left
-- untouched per docs/db/EXTERNAL_CONSUMERS.md. The 47 "multiple permissive
-- policies" and 57 "unused index" findings are informational and NOT acted
-- on here (dropping policies or indexes on a soak system needs a desk call).
--
-- What this does:
--   1. duplicate_index — drop the newer of each identical pair (same
--      table, same key, same order); the surviving index is named:
--        idx_account_metrics_user_date   -> keep account_metrics_user_date_idx  (user_id, date DESC)
--        idx_mf_decisions_timestamp      -> keep idx_meta_filter_decisions_timestamp ("timestamp" DESC)
--        idx_mf_decisions_signal_id      -> keep idx_meta_filter_decisions_signal (signal_id)
--      Plain btree indexes, none backs a constraint (checked in pg_constraint).
--      Query plans are unchanged: the planner picks the identical survivor.
--   2. auth_rls_initplan — recreate the two remaining policies that call
--      auth.*() per row so Postgres evaluates them once per statement
--      (the D5 / 20260514000000 pattern, applied to the two policies that
--      migration missed):
--        trading_sessions.trading_sessions_user_policy     ALL, TO public
--          USING (auth.uid() = user_id)              -> ((select auth.uid()) = user_id)
--        exchange_credentials."Service role full access"   ALL, TO public
--          USING ((auth.jwt() ->> 'role') = 'service_role') -> (((select auth.jwt()) ->> 'role') = 'service_role')
--      Same roles, same command, same predicate, no WITH CHECK (Postgres
--      reuses USING for writes exactly as before). Semantics are identical.
--
-- Scope fence: touches ONLY public.account_metrics, public.meta_filter_decisions
-- (indexes), public.trading_sessions, public.exchange_credentials (policies).
--
-- Idempotent: DROP INDEX IF EXISTS; policies are DROP IF EXISTS + CREATE
-- inside one transaction-safe DO block, guarded on the table existing.
-- Safe under load: the indexes are small; DROP/CREATE POLICY is a catalog
-- change (a brief ACCESS EXCLUSIVE lock on two tiny tables).
--
-- Rollback (as postgres):
--   CREATE INDEX IF NOT EXISTS idx_account_metrics_user_date ON public.account_metrics (user_id, date DESC);
--   CREATE INDEX IF NOT EXISTS idx_mf_decisions_timestamp ON public.meta_filter_decisions ("timestamp" DESC);
--   CREATE INDEX IF NOT EXISTS idx_mf_decisions_signal_id ON public.meta_filter_decisions (signal_id);
--   DROP POLICY IF EXISTS trading_sessions_user_policy ON public.trading_sessions;
--   CREATE POLICY trading_sessions_user_policy ON public.trading_sessions FOR ALL TO public USING (auth.uid() = user_id);
--   DROP POLICY IF EXISTS "Service role full access" ON public.exchange_credentials;
--   CREATE POLICY "Service role full access" ON public.exchange_credentials FOR ALL TO public USING ((auth.jwt() ->> 'role') = 'service_role');
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Duplicate indexes
-- ---------------------------------------------------------------------------
DROP INDEX IF EXISTS public.idx_account_metrics_user_date;
DROP INDEX IF EXISTS public.idx_mf_decisions_timestamp;
DROP INDEX IF EXISTS public.idx_mf_decisions_signal_id;

-- ---------------------------------------------------------------------------
-- 2. RLS init-plan rewrite (semantics unchanged)
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF to_regclass('public.trading_sessions') IS NOT NULL THEN
    DROP POLICY IF EXISTS trading_sessions_user_policy ON public.trading_sessions;
    CREATE POLICY trading_sessions_user_policy
      ON public.trading_sessions
      FOR ALL
      TO public
      USING ((SELECT auth.uid()) = user_id);
  ELSE
    RAISE NOTICE 'public.trading_sessions absent; skipping policy rewrite';
  END IF;

  IF to_regclass('public.exchange_credentials') IS NOT NULL THEN
    DROP POLICY IF EXISTS "Service role full access" ON public.exchange_credentials;
    CREATE POLICY "Service role full access"
      ON public.exchange_credentials
      FOR ALL
      TO public
      USING (((SELECT auth.jwt()) ->> 'role') = 'service_role');
  ELSE
    RAISE NOTICE 'public.exchange_credentials absent; skipping policy rewrite';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Post-conditions (read-only; run after apply) — docs/db/verify/05_desk_status_views.sql
-- ---------------------------------------------------------------------------
-- SELECT indexname FROM pg_indexes WHERE schemaname = 'public'
--    AND indexname IN ('idx_account_metrics_user_date','idx_mf_decisions_timestamp','idx_mf_decisions_signal_id');
--   -- expect 0 rows
-- SELECT indexname FROM pg_indexes WHERE schemaname = 'public'
--    AND indexname IN ('account_metrics_user_date_idx','idx_meta_filter_decisions_timestamp','idx_meta_filter_decisions_signal');
--   -- expect 3 rows (survivors)
-- SELECT tablename, policyname, qual FROM pg_policies WHERE schemaname = 'public'
--    AND policyname IN ('trading_sessions_user_policy', 'Service role full access');
--   -- expect both quals to start with "(( SELECT auth."
