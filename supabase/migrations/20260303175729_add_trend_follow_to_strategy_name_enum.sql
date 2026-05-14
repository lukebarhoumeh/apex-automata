-- Reconciliation file pulled from supabase_migrations.schema_migrations
-- (version 20260303175729, name add_trend_follow_to_strategy_name_enum) on 2026-05-14 via Supabase MCP.
-- Captures DDL applied directly to prod via dashboard/Lovable IDE.

ALTER TYPE strategy_name ADD VALUE IF NOT EXISTS 'trend_follow';