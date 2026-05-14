-- Reconciliation file pulled from supabase_migrations.schema_migrations
-- (version 20260427161412, name add_system_strategy) on 2026-05-14 via Supabase MCP.
-- Captures DDL applied directly to prod via dashboard/Lovable IDE.

ALTER TYPE public.strategy_name ADD VALUE IF NOT EXISTS 'system';