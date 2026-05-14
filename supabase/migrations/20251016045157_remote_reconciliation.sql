-- Reconciliation file pulled from supabase_migrations.schema_migrations
-- (version 20251016045157, name (empty)) on 2026-05-14 via Supabase MCP.
-- Captures DDL applied directly to prod via dashboard/Lovable IDE.

-- Make user_id nullable in strategy_signals for global strategy configuration
-- AtlasBot v2 is single-trader, so strategies are global not per-user

ALTER TABLE public.strategy_signals ALTER COLUMN user_id DROP NOT NULL;

-- Seed default strategy configurations
INSERT INTO public.strategy_signals (name, enabled, params, win_rate, avg_r) VALUES
('meta', true, '{"threshold": 0.65}'::jsonb, 0.68, 1.2),
('breakout', true, '{"adxMin": 25, "donchianN": 20, "atrPctileMin": 70}'::jsonb, 0.58, 1.8),
('vwap_mr', true, '{"zAbsMin": 2.0, "adxMax": 25}'::jsonb, 0.62, 1.4)
ON CONFLICT DO NOTHING;