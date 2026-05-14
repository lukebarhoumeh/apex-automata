-- Reconciliation file pulled from supabase_migrations.schema_migrations
-- (version 20260204220632, name 20260204_perf_indexes_cleanup) on 2026-05-14 via Supabase MCP.
-- Captures DDL applied directly to prod via dashboard/Lovable IDE.

-- =====================================================
-- Performance: add missing FK indexes + remove duplicate indexes
-- =====================================================

CREATE INDEX IF NOT EXISTS idx_fills_order_leg_id ON public.fills (order_leg_id);
CREATE INDEX IF NOT EXISTS idx_journal_entries_order_id ON public.journal_entries (order_id);
CREATE INDEX IF NOT EXISTS idx_journal_entries_position_id ON public.journal_entries (position_id);
CREATE INDEX IF NOT EXISTS idx_journal_entries_signal_id ON public.journal_entries (signal_id);
CREATE INDEX IF NOT EXISTS idx_orders_signal_id ON public.orders (signal_id);
CREATE INDEX IF NOT EXISTS idx_metrics_intraday_symbol ON public.metrics_intraday (symbol);

DROP INDEX IF EXISTS public.idx_orders_user_time;
DROP INDEX IF EXISTS public.idx_signals_user_time;
