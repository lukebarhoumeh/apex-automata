-- Fix Supabase advisor ERROR: security_definer_view on public.agentic_monthly_spend.
-- The view was created without security_invoker in PR #92's migration
-- (20261019190000_agentic_calls.sql), which defaults to SECURITY DEFINER.
-- Supabase advisor flags this as a risk: a view owned by the migration role
-- (postgres/supabase_admin) running as DEFINER lets any role with SELECT
-- see all rows regardless of RLS on the underlying agentic_calls table.
--
-- Fix: set security_invoker = true so the view executes with the caller's
-- privileges (RLS on agentic_calls applies). Revoke anon access since
-- agentic data is not public.
--
-- The runtime cost-cap code (agentic/cost-tracker.ts) reads agentic_calls
-- directly via service_role, not this view, so behavior is unchanged.

ALTER VIEW public.agentic_monthly_spend SET (security_invoker = true);
REVOKE ALL ON public.agentic_monthly_spend FROM anon;
