-- docs/db/verify/03_quarantine_agentic_heartbeats.sql
-- Verify #3: 20260910180300_quarantine_agentic_heartbeats_to_equity_schema
-- Read-only. Run as postgres (psql or Supabase SQL editor). Documentation only —
-- this file is NOT a migration and must never be applied as one.
--
-- Precondition (handoff doc R1): equity writers were retargeted to
-- equity.agentic_heartbeats BEFORE #3 was applied. After the next heartbeat
-- cycle, last_heartbeat_ts must move forward — if it does not, the writer is
-- still pointed at public.agentic_heartbeats and is failing.
--
-- Expected after #3:
--   in_equity_only = t (table exists in equity, nothing left in public, exactly one copy)
--   sequence_in_equity = t | rls_enabled = t | policies_present = t (both named policies)
--   anon_no_access = t (no USAGE on schema equity, no table or sequence privilege)
--   service_role_can_write = t | authenticated_can_select = t
--   row_count ~ 43 on prod (43 as of 2026-09-10 15:40 UTC, plus any heartbeats
--   written since); 0 on a Preview branch (fresh chain). Informational only —
--   not part of pass, so the same script works on prod and Preview.
--   pass = t

-- Detail: location of table + sequence (expect both in equity)
SELECT n.nspname AS schema, c.relname, c.relkind, c.relrowsecurity AS rls
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relname IN ('agentic_heartbeats', 'agentic_heartbeats_id_seq')
ORDER BY 1, 2;

-- Detail: RLS policies (expect exactly these two)
SELECT schemaname, policyname, cmd, roles
FROM pg_policies
WHERE tablename = 'agentic_heartbeats'
ORDER BY 2;

-- Detail: privilege matrix (expect anon all f; service_role all t;
-- authenticated: schema_usage t, sel t — ins/upd/del may still read t until
-- handoff gap G1 is addressed; RLS blocks those writes regardless)
SELECT r AS role,
       has_schema_privilege(r, 'equity', 'USAGE')                              AS schema_usage,
       has_table_privilege(r, 'equity.agentic_heartbeats', 'SELECT')          AS sel,
       has_table_privilege(r, 'equity.agentic_heartbeats', 'INSERT')          AS ins,
       has_table_privilege(r, 'equity.agentic_heartbeats', 'UPDATE')          AS upd,
       has_table_privilege(r, 'equity.agentic_heartbeats', 'DELETE')          AS del,
       has_sequence_privilege(r, 'equity.agentic_heartbeats_id_seq', 'USAGE') AS seq_usage
FROM unnest(ARRAY['anon', 'authenticated', 'service_role']) AS r;

-- Summary (last statement so the SQL editor shows it)
WITH checks AS (
  SELECT
    (to_regclass('equity.agentic_heartbeats') IS NOT NULL
     AND to_regclass('public.agentic_heartbeats') IS NULL
     AND (SELECT count(*) = 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE c.relname = 'agentic_heartbeats' AND c.relkind = 'r'))         AS in_equity_only,
    to_regclass('equity.agentic_heartbeats_id_seq') IS NOT NULL                AS sequence_in_equity,
    COALESCE((SELECT relrowsecurity FROM pg_class
              WHERE oid = to_regclass('equity.agentic_heartbeats')), false)    AS rls_enabled,
    (SELECT count(*) = 2 FROM pg_policies
      WHERE schemaname = 'equity' AND tablename = 'agentic_heartbeats'
        AND policyname IN ('agentic_heartbeats_service_all',
                           'agentic_heartbeats_authenticated_select'))          AS policies_present,
    (NOT has_schema_privilege('anon', 'equity', 'USAGE')
     AND NOT has_table_privilege('anon', 'equity.agentic_heartbeats', 'SELECT')
     AND NOT has_table_privilege('anon', 'equity.agentic_heartbeats', 'INSERT')
     AND NOT has_table_privilege('anon', 'equity.agentic_heartbeats', 'UPDATE')
     AND NOT has_table_privilege('anon', 'equity.agentic_heartbeats', 'DELETE')
     AND NOT has_sequence_privilege('anon', 'equity.agentic_heartbeats_id_seq', 'USAGE'))
                                                                               AS anon_no_access,
    (has_schema_privilege('service_role', 'equity', 'USAGE')
     AND has_table_privilege('service_role', 'equity.agentic_heartbeats', 'INSERT')
     AND has_sequence_privilege('service_role', 'equity.agentic_heartbeats_id_seq', 'USAGE'))
                                                                               AS service_role_can_write,
    (has_schema_privilege('authenticated', 'equity', 'USAGE')
     AND has_table_privilege('authenticated', 'equity.agentic_heartbeats', 'SELECT'))
                                                                               AS authenticated_can_select,
    (SELECT count(*) FROM equity.agentic_heartbeats)                           AS row_count,
    (SELECT max(ts) FROM equity.agentic_heartbeats)                            AS last_heartbeat_ts
)
SELECT *,
       (in_equity_only AND sequence_in_equity AND rls_enabled AND policies_present
        AND anon_no_access AND service_role_can_write AND authenticated_can_select)
                                                                               AS pass
FROM checks;
