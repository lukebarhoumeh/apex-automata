-- Tighten EXECUTE on the six public SECURITY DEFINER functions.
--
-- Verified on prod 2026-09-10: every one of these functions carried
-- EXECUTE for PUBLIC, anon, authenticated and service_role (Supabase default
-- privileges). End state after this migration:
--   anon           -> none
--   authenticated  -> has_role(uuid, app_role), upsert_account_metrics(uuid)
--   service_role   -> all six
--   postgres       -> owner (unchanged)
--
-- Trigger functions (handle_new_user, handle_updated_at, touch_updated_at,
-- update_updated_at_column) keep firing for every role: Postgres checks
-- EXECUTE on a trigger function at CREATE TRIGGER time, not when it fires.
--
-- Idempotent: REVOKE/GRANT are no-ops when the privilege state already matches.
-- Not IF EXISTS-guarded: all six functions exist in the repo chain and on prod.
-- Handoff: Database Engineer, 2026-09-10 (see docs/db/HANDOFF_2026-09-10.md).

REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.handle_updated_at() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.has_role(uuid, public.app_role) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.touch_updated_at() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.update_updated_at_column() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.upsert_account_metrics(uuid) FROM PUBLIC, anon;

REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.handle_updated_at() FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.touch_updated_at() FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.update_updated_at_column() FROM authenticated;

GRANT EXECUTE ON FUNCTION public.has_role(uuid, public.app_role) TO authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_account_metrics(uuid) TO authenticated;

GRANT EXECUTE ON FUNCTION public.handle_new_user() TO service_role;
GRANT EXECUTE ON FUNCTION public.handle_updated_at() TO service_role;
GRANT EXECUTE ON FUNCTION public.has_role(uuid, public.app_role) TO service_role;
GRANT EXECUTE ON FUNCTION public.touch_updated_at() TO service_role;
GRANT EXECUTE ON FUNCTION public.update_updated_at_column() TO service_role;
GRANT EXECUTE ON FUNCTION public.upsert_account_metrics(uuid) TO service_role;
