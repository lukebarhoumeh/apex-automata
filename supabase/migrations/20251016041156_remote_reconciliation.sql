-- Reconciliation file pulled from supabase_migrations.schema_migrations
-- (version 20251016041156, name (empty)) on 2026-05-14 via Supabase MCP.
-- Captures DDL applied directly to prod via dashboard/Lovable IDE.

-- Fix RLS policies for single-user operation
-- Since authentication is removed and it's a single-user system,
-- we'll make all operations permissive

-- account_metrics
DROP POLICY IF EXISTS "Users can view their own metrics" ON account_metrics;
DROP POLICY IF EXISTS "Users can manage their own metrics" ON account_metrics;

CREATE POLICY "Allow all access to account_metrics"
ON account_metrics FOR ALL
TO public
USING (true)
WITH CHECK (true);

-- positions
DROP POLICY IF EXISTS "positions_rw_own" ON positions;

CREATE POLICY "Allow all access to positions"
ON positions FOR ALL
TO public
USING (true)
WITH CHECK (true);

-- orders
DROP POLICY IF EXISTS "orders_rw_own" ON orders;

CREATE POLICY "Allow all access to orders"
ON orders FOR ALL
TO public
USING (true)
WITH CHECK (true);

-- order_legs
DROP POLICY IF EXISTS "order_legs_rw_own" ON order_legs;

CREATE POLICY "Allow all access to order_legs"
ON order_legs FOR ALL
TO public
USING (true)
WITH CHECK (true);

-- fills
DROP POLICY IF EXISTS "fills_rw_own" ON fills;

CREATE POLICY "Allow all access to fills"
ON fills FOR ALL
TO public
USING (true)
WITH CHECK (true);

-- strategies
DROP POLICY IF EXISTS "strategies_rw_own" ON strategies;

CREATE POLICY "Allow all access to strategies"
ON strategies FOR ALL
TO public
USING (true)
WITH CHECK (true);

-- signals
DROP POLICY IF EXISTS "signals_rw_own" ON signals;

CREATE POLICY "Allow all access to signals"
ON signals FOR ALL
TO public
USING (true)
WITH CHECK (true);

-- alerts
DROP POLICY IF EXISTS "alerts_rw_own" ON alerts;

CREATE POLICY "Allow all access to alerts"
ON alerts FOR ALL
TO public
USING (true)
WITH CHECK (true);

-- risk_events
DROP POLICY IF EXISTS "risk_events_rw_own" ON risk_events;

CREATE POLICY "Allow all access to risk_events"
ON risk_events FOR ALL
TO public
USING (true)
WITH CHECK (true);

-- risk_settings
DROP POLICY IF EXISTS "Users can view their own risk settings" ON risk_settings;
DROP POLICY IF EXISTS "Users can insert their own risk settings" ON risk_settings;
DROP POLICY IF EXISTS "Users can update their own risk settings" ON risk_settings;

CREATE POLICY "Allow all access to risk_settings"
ON risk_settings FOR ALL
TO public
USING (true)
WITH CHECK (true);

-- journal_entries
DROP POLICY IF EXISTS "journal_entries_rw_own" ON journal_entries;

CREATE POLICY "Allow all access to journal_entries"
ON journal_entries FOR ALL
TO public
USING (true)
WITH CHECK (true);

-- models
DROP POLICY IF EXISTS "models_rw_own" ON models;

CREATE POLICY "Allow all access to models"
ON models FOR ALL
TO public
USING (true)
WITH CHECK (true);

-- metrics_intraday
DROP POLICY IF EXISTS "metrics_intraday_rw_own" ON metrics_intraday;

CREATE POLICY "Allow all access to metrics_intraday"
ON metrics_intraday FOR ALL
TO public
USING (true)
WITH CHECK (true);

-- strategy_signals
DROP POLICY IF EXISTS "Users can view their own strategy signals" ON strategy_signals;
DROP POLICY IF EXISTS "Users can manage their own strategy signals" ON strategy_signals;

CREATE POLICY "Allow all access to strategy_signals"
ON strategy_signals FOR ALL
TO public
USING (true)
WITH CHECK (true);

-- bot_states
DROP POLICY IF EXISTS "Users can view their own bot state" ON bot_states;
DROP POLICY IF EXISTS "Users can insert their own bot state" ON bot_states;
DROP POLICY IF EXISTS "Users can update their own bot state" ON bot_states;

CREATE POLICY "Allow all access to bot_states"
ON bot_states FOR ALL
TO public
USING (true)
WITH CHECK (true);