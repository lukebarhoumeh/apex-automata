-- docs/db/verify/00_stub_agentic_heartbeats.sql
-- Verify: orphan stub 20260902202325_agentic_heartbeats is reconciled.
-- Read-only. Run as postgres (psql or Supabase SQL editor). Documentation only —
-- this file is NOT a migration and must never be applied as one.
--
-- When to run: any time after the PR merges, ideally BEFORE #3 (quarantine) is
-- applied. After #3 the table lives in schema equity, so public_table_exists
-- flips to false by design; quarantined_to_equity then reads true and pass
-- stays true — use 03_quarantine_agentic_heartbeats.sql for the full check.
--
-- Expected (pre-#3):
--   version_recorded = t | version_name = agentic_heartbeats | public_table_exists = t
--   public_sequence_exists = t | indexes_present = t | rls_enabled = t
--   quarantined_to_equity = f | pass = t
-- Expected (post-#3): public_* = f, indexes_present = f, rls_enabled = f,
--   quarantined_to_equity = t, pass = t

-- Detail: the remote history row the stub file mirrors
SELECT version, name
FROM supabase_migrations.schema_migrations
WHERE version = '20260902202325';

-- Detail: where the table currently lives (expect public before #3, equity after)
SELECT n.nspname AS schema, c.relname, c.relkind, c.relrowsecurity AS rls
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relname IN ('agentic_heartbeats', 'agentic_heartbeats_id_seq')
ORDER BY 2;

-- Summary (last statement so the SQL editor shows it)
WITH checks AS (
  SELECT
    (SELECT count(*) = 1 FROM supabase_migrations.schema_migrations
      WHERE version = '20260902202325')                                     AS version_recorded,
    (SELECT name FROM supabase_migrations.schema_migrations
      WHERE version = '20260902202325')                                     AS version_name,
    to_regclass('public.agentic_heartbeats') IS NOT NULL                    AS public_table_exists,
    to_regclass('public.agentic_heartbeats_id_seq') IS NOT NULL             AS public_sequence_exists,
    (SELECT count(*) = 2 FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'agentic_heartbeats'
        AND indexname IN ('agentic_heartbeats_ts_idx', 'agentic_heartbeats_cycle_ts_idx')) AS indexes_present,
    COALESCE((SELECT relrowsecurity FROM pg_class
      WHERE oid = to_regclass('public.agentic_heartbeats')), false)         AS rls_enabled,
    to_regclass('equity.agentic_heartbeats') IS NOT NULL                    AS quarantined_to_equity,
    -- second orphan stub reconciled on this branch (informational; SELECT 1 file,
    -- real hardening lives in 20260910180000 / 20260910180100)
    (SELECT count(*) = 1 FROM supabase_migrations.schema_migrations
      WHERE version = '20260910175414')                                     AS security_hardening_stamp_recorded
)
SELECT *,
       (version_recorded AND
        ((public_table_exists AND public_sequence_exists AND indexes_present AND rls_enabled)
         OR quarantined_to_equity))                                         AS pass
FROM checks;
