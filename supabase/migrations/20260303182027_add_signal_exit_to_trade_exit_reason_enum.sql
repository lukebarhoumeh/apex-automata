-- Reconciliation file pulled from supabase_migrations.schema_migrations
-- (version 20260303182027, name add_signal_exit_to_trade_exit_reason_enum) on 2026-05-14 via Supabase MCP.
-- Captures DDL applied directly to prod via dashboard/Lovable IDE.

ALTER TYPE trade_exit_reason ADD VALUE IF NOT EXISTS 'signal_exit';