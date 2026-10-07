-- Hardening pass 2 (advisor S1 + S3, 2026-10-07 audit). Zero behavior change.
-- Applied to prod (gdrdaajvutmewgxbjurk) via MCP on 2026-10-07 as version 20261007205037.
--
-- S1 (lint 0011): pin search_path on the 6 SECURITY DEFINER desk/agentic RPCs.
-- All reference only public-schema objects unqualified, so pinning to
-- 'public, pg_temp' blocks role-level search_path hijack without breaking
-- any internal reference.
alter function public.acquire_lease(text, text, integer) set search_path = public, pg_temp;
alter function public.release_lease(text, uuid) set search_path = public, pg_temp;
alter function public.cb_state_put(text, integer, jsonb, text) set search_path = public, pg_temp;
alter function public.submit_intent(text, text, uuid) set search_path = public, pg_temp;
alter function public.expire_intents(text) set search_path = public, pg_temp;
alter function public.cb_snapshot_put(text, jsonb) set search_path = public, pg_temp;

-- S3 (lint 0006 multiple_permissive_policies): drop purely-redundant policies.
-- service_role bypasses RLS, so service-role-qualified policies on {public}
-- grant nothing and only add per-row evaluation cost; the trading_sessions
-- "Allow individual *" quartet is fully subsumed by trading_sessions_user_policy
-- (ALL, same (select auth.uid()) = user_id check; with_check defaults to USING).
drop policy "Users can view own metrics" on public.account_metrics;           -- subsumed by account_metrics_read_public (SELECT true)
drop policy "Service role can manage equity curve" on public.equity_curve;    -- always-false for anon/authenticated; service_role bypasses
drop policy "Service role full access" on public.exchange_credentials;        -- same pattern; per-user policies remain intact
drop policy "Allow individual read access" on public.trading_sessions;
drop policy "Allow individual insert access" on public.trading_sessions;
drop policy "Allow individual update access" on public.trading_sessions;
drop policy "Allow individual delete access" on public.trading_sessions;
