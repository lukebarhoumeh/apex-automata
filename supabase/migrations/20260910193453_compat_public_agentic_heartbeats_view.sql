-- Reconcile remote stamp 20260910193453 (compat_public_agentic_heartbeats_view).
-- HARD FENCE: Robinhood consumer — match live prod; do not broaden grants.

CREATE OR REPLACE VIEW public.agentic_heartbeats
WITH (security_invoker = true)
AS
SELECT
  id,
  ts,
  cycle,
  event,
  session,
  fire_ts,
  positions,
  stops_ok,
  fills_protected,
  orders,
  equity,
  note
FROM equity.agentic_heartbeats;

COMMENT ON VIEW public.agentic_heartbeats IS
  'Robinhood compat shim: public name → equity.agentic_heartbeats. HARD FENCE — do not drop/rename without Trading Master + Robinhood desk.';

REVOKE ALL ON TABLE public.agentic_heartbeats FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON TABLE public.agentic_heartbeats TO service_role;
GRANT ALL ON TABLE public.agentic_heartbeats TO postgres;

GRANT USAGE ON SCHEMA equity TO service_role, postgres;
