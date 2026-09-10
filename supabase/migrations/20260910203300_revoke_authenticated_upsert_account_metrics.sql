-- Restrict EXECUTE on public.upsert_account_metrics(uuid) to service_role.
--
-- TM greenlight 2026-09-10 (supersedes the 18:48 UTC desk lock recorded in
-- docs/db/HANDOFF_2026-09-10.md, R9 / addendum): the only runtime caller is
-- Apex core-node (atlas/apps/core-node/src/api/server.ts), which invokes the
-- RPC through the client built with SUPABASE_SERVICE_KEY. The authenticated
-- grant re-issued by 20260910180100 and 20260910180200 is therefore not
-- needed. End state: anon f, authenticated f, service_role t (owner postgres
-- unchanged).
--
-- Idempotent: REVOKE/GRANT are no-ops when the privilege state already
-- matches. Not IF EXISTS-guarded: the function exists in the repo chain
-- (20251016000000) and on prod. Sorts after 180100/180200, so a fresh chain
-- (Supabase Preview) ends in the same service_role-only state as prod.
--
-- Touches nothing else. In particular no heartbeats objects
-- (equity.agentic_heartbeats / public.agentic_heartbeats) — see
-- docs/db/EXTERNAL_CONSUMERS.md (hard fence).
--
-- STAGED ONLY: no MCP apply, no `supabase db push` from this PR. Applying is
-- a separate, TM-authorised step.

-- TM-greenlit 2026-09-10: Apex core-node uses SUPABASE_SERVICE_KEY only.
REVOKE EXECUTE ON FUNCTION public.upsert_account_metrics(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_account_metrics(uuid) TO service_role;
