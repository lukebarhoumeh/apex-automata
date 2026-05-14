-- Reconciliation file pulled from supabase_migrations.schema_migrations
-- (version 20260422172333, name 20260422_add_session_end_exit_reason) on 2026-05-14 via Supabase MCP.
-- Captures DDL applied directly to prod via dashboard/Lovable IDE.

ALTER TYPE public.trade_exit_reason ADD VALUE IF NOT EXISTS 'session_end';