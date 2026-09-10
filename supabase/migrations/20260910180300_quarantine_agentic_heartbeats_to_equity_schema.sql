-- Quarantine agentic_heartbeats (equity/agentic ops table, created outside this
-- repo — see stub 20260902202325) out of `public` into a dedicated `equity`
-- schema and lock down its privileges.
--
-- Verified on prod 2026-09-10 (read-only): table lives in public with RLS
-- enabled but ZERO policies, and anon/authenticated/service_role hold ALL
-- table privileges plus USAGE/UPDATE on the sequence; schema `equity` does not
-- exist. End state: table + owned sequence in `equity`; service_role ALL,
-- authenticated SELECT (RLS-gated), anon nothing; `equity` is not exposed via
-- PostgREST and gets no `public` synonym (desk default).
--
-- ALTER TABLE ... SET SCHEMA carries the OWNED BY sequence along, so the guarded
-- DO blocks below are no-ops on the normal path and only fire if ownership was
-- ever detached. Idempotent on re-run (IF EXISTS / DROP POLICY IF EXISTS).
-- Handoff: Database Engineer, 2026-09-10 (see docs/db/HANDOFF_2026-09-10.md).

CREATE SCHEMA IF NOT EXISTS equity;

COMMENT ON SCHEMA equity IS
  'Quarantine schema for equity/agentic ops tables; not part of crypto trading surface.';

ALTER TABLE IF EXISTS public.agentic_heartbeats SET SCHEMA equity;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'agentic_heartbeats_id_seq' AND n.nspname = 'public'
  ) AND EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'agentic_heartbeats' AND n.nspname = 'equity'
  ) THEN
    ALTER SEQUENCE public.agentic_heartbeats_id_seq SET SCHEMA equity;
  END IF;
END $$;

ALTER TABLE equity.agentic_heartbeats ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS agentic_heartbeats_service_all ON equity.agentic_heartbeats;
DROP POLICY IF EXISTS agentic_heartbeats_authenticated_select ON equity.agentic_heartbeats;

CREATE POLICY agentic_heartbeats_service_all
  ON equity.agentic_heartbeats FOR ALL TO service_role
  USING (true) WITH CHECK (true);

CREATE POLICY agentic_heartbeats_authenticated_select
  ON equity.agentic_heartbeats FOR SELECT TO authenticated
  USING (true);

REVOKE ALL ON TABLE equity.agentic_heartbeats FROM anon;
REVOKE ALL ON TABLE equity.agentic_heartbeats FROM PUBLIC;
GRANT SELECT ON TABLE equity.agentic_heartbeats TO authenticated;
GRANT ALL ON TABLE equity.agentic_heartbeats TO service_role;
GRANT ALL ON TABLE equity.agentic_heartbeats TO postgres;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'agentic_heartbeats_id_seq' AND n.nspname = 'equity'
  ) THEN
    EXECUTE 'REVOKE ALL ON SEQUENCE equity.agentic_heartbeats_id_seq FROM anon, PUBLIC';
    EXECUTE 'GRANT USAGE, SELECT ON SEQUENCE equity.agentic_heartbeats_id_seq TO service_role, postgres';
  END IF;
END $$;

GRANT USAGE ON SCHEMA equity TO service_role, postgres, authenticated;
REVOKE USAGE ON SCHEMA equity FROM anon;
REVOKE CREATE ON SCHEMA equity FROM PUBLIC, anon, authenticated;

-- No public synonym (desk default).
