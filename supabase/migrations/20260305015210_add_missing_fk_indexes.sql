-- Reconciliation file pulled from supabase_migrations.schema_migrations
-- (version 20260305015210, name add_missing_fk_indexes) on 2026-05-14 via Supabase MCP.
-- Captures DDL applied directly to prod via dashboard/Lovable IDE.

CREATE INDEX IF NOT EXISTS idx_fills_order_leg_id ON fills(order_leg_id);
CREATE INDEX IF NOT EXISTS idx_order_legs_user_id ON order_legs(user_id);
CREATE INDEX IF NOT EXISTS idx_journal_entries_position_id ON journal_entries(position_id);
CREATE INDEX IF NOT EXISTS idx_journal_entries_order_id ON journal_entries(order_id);
CREATE INDEX IF NOT EXISTS idx_journal_entries_signal_id ON journal_entries(signal_id);
CREATE INDEX IF NOT EXISTS idx_trade_outcomes_strategy_regime ON trade_outcomes(strategy, regime);