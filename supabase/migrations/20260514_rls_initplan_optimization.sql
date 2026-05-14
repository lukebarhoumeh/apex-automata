-- ============================================================================
-- Wave 1 D5: RLS initplan + function search_path.
-- Corrective; will be folded into D1 baseline (Wave 2).
-- ============================================================================
--
-- WHY:
-- Supabase Performance Advisor flags `auth.uid() = user_id` as a per-row
-- evaluation. Wrapping it as `(select auth.uid()) = user_id` lets Postgres
-- cache the value as an initplan once per query — ~100x speed-up on tables
-- with > 10k rows. See:
--   https://supabase.com/docs/guides/database/postgres/row-level-security
--
-- HOW:
-- ALTER POLICY can rewrite USING / WITH CHECK expressions in place, but it
-- silently no-ops if the policy already references the subselect pattern
-- (no-op is fine). DROP + CREATE is the simpler idempotent path and matches
-- the prior `20260204233000_rls_policy_perf_cleanup.sql` style. We use that.
--
-- SCOPE (verified against live pg_policies, gdrdaajvutmewgxbjurk, 2026-05-14):
-- Only the policies below still use raw `auth.uid()` / `auth.role()`. All
-- other public-schema policies already use the `(select ...)` initplan
-- pattern (see `20260204233000_rls_policy_perf_cleanup.sql`).
--
-- 1. account_metrics."Users can view own metrics"        -- raw auth.uid()
-- 2. equity_curve."Users can view own equity curve"      -- raw auth.uid()
-- 3. equity_curve."Service role can manage equity curve" -- raw auth.role()
--
-- Same migration ALTERs handle_updated_at + handle_new_user to add
-- `pg_catalog` to their search_path (Supabase linter warning
-- `function_search_path_mutable` — defense against function shadowing).
--
-- DEPLOYMENT:
-- DO NOT apply to live DB in this PR. Branching is OFF (gated on D1 baseline
-- consolidation, Wave 2). Deployment happens after D1 lands.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 1) account_metrics."Users can view own metrics"
-- ----------------------------------------------------------------------------
do $$
begin
  if exists (
    select 1 from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'account_metrics'
  ) then
    drop policy if exists "Users can view own metrics" on public.account_metrics;

    create policy "Users can view own metrics"
      on public.account_metrics
      for select
      to public
      using ((select auth.uid()) = user_id);
  end if;
end
$$;

-- ----------------------------------------------------------------------------
-- 2) equity_curve."Users can view own equity curve"
-- ----------------------------------------------------------------------------
do $$
begin
  if exists (
    select 1 from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'equity_curve'
  ) then
    drop policy if exists "Users can view own equity curve" on public.equity_curve;

    create policy "Users can view own equity curve"
      on public.equity_curve
      for select
      to public
      using ((select auth.uid()) = user_id);
  end if;
end
$$;

-- ----------------------------------------------------------------------------
-- 3) equity_curve."Service role can manage equity curve"
-- ----------------------------------------------------------------------------
do $$
begin
  if exists (
    select 1 from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'equity_curve'
  ) then
    drop policy if exists "Service role can manage equity curve" on public.equity_curve;

    create policy "Service role can manage equity curve"
      on public.equity_curve
      for all
      to public
      using ((select auth.role()) = 'service_role');
  end if;
end
$$;

-- ----------------------------------------------------------------------------
-- 4) Function search_path hardening (Supabase linter: function_search_path_mutable)
-- ----------------------------------------------------------------------------
-- ALTER FUNCTION ... SET search_path is idempotent — re-running just rewrites
-- the same setting. Guard with regprocedure existence check for safety.
do $$
begin
  if exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'handle_updated_at'
  ) then
    alter function public.handle_updated_at() set search_path = public, pg_catalog;
  end if;

  if exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'handle_new_user'
  ) then
    alter function public.handle_new_user() set search_path = public, pg_catalog;
  end if;
end
$$;

commit;
