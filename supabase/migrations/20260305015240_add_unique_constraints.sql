-- Reconciliation file pulled from supabase_migrations.schema_migrations
-- (version 20260305015240, name add_unique_constraints) on 2026-05-14 via Supabase MCP.
-- Captures DDL applied directly to prod via dashboard/Lovable IDE.

-- Prevent duplicate signals (same user, symbol, strategy, timestamp)
CREATE UNIQUE INDEX IF NOT EXISTS idx_signals_dedup
  ON signals(user_id, symbol, strategy, decided_at)
  WHERE decided_at IS NOT NULL;

-- Prevent duplicate fills (same order, trade_id, fill time)
CREATE UNIQUE INDEX IF NOT EXISTS idx_fills_dedup
  ON fills(order_id, trade_id, filled_at)
  WHERE trade_id IS NOT NULL;