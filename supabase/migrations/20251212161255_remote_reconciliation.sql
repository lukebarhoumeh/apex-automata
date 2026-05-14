-- Reconciliation file pulled from supabase_migrations.schema_migrations
-- (version 20251212161255, name (empty)) on 2026-05-14 via Supabase MCP.
-- Captures DDL applied directly to prod via dashboard/Lovable IDE.

-- Drop FK on profiles
ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_user_id_fkey;