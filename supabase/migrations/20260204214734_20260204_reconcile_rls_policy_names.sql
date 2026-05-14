-- Reconciliation file pulled from supabase_migrations.schema_migrations
-- (version 20260204214734, name 20260204_reconcile_rls_policy_names) on 2026-05-14 via Supabase MCP.
-- Captures DDL applied directly to prod via dashboard/Lovable IDE.

-- =====================================================
-- Reconcile RLS policy state (idempotent)
-- Ensures expected policy names exist regardless of prior state
-- =====================================================

CREATE OR REPLACE FUNCTION public.update_trade_outcomes_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$function$;

-- Helper: drop known policies if they exist

-- POSITIONS
DROP POLICY IF EXISTS "Allow all access to positions" ON public.positions;
DROP POLICY IF EXISTS "positions_user_read" ON public.positions;
DROP POLICY IF EXISTS "positions_service_write" ON public.positions;
DROP POLICY IF EXISTS "positions_service_update" ON public.positions;
DROP POLICY IF EXISTS "positions_service_delete" ON public.positions;
CREATE POLICY "positions_user_read" ON public.positions FOR SELECT USING (true);
CREATE POLICY "positions_service_write" ON public.positions FOR INSERT WITH CHECK (true);
CREATE POLICY "positions_service_update" ON public.positions FOR UPDATE USING (true);
CREATE POLICY "positions_service_delete" ON public.positions FOR DELETE USING (true);

-- ORDERS
DROP POLICY IF EXISTS "Allow all access to orders" ON public.orders;
DROP POLICY IF EXISTS "orders_user_read" ON public.orders;
DROP POLICY IF EXISTS "orders_service_write" ON public.orders;
DROP POLICY IF EXISTS "orders_service_update" ON public.orders;
DROP POLICY IF EXISTS "orders_service_delete" ON public.orders;
CREATE POLICY "orders_user_read" ON public.orders FOR SELECT USING (true);
CREATE POLICY "orders_service_write" ON public.orders FOR INSERT WITH CHECK (true);
CREATE POLICY "orders_service_update" ON public.orders FOR UPDATE USING (true);
CREATE POLICY "orders_service_delete" ON public.orders FOR DELETE USING (true);

-- ORDER_LEGS
DROP POLICY IF EXISTS "Allow all access to order_legs" ON public.order_legs;
DROP POLICY IF EXISTS "order_legs_user_read" ON public.order_legs;
DROP POLICY IF EXISTS "order_legs_service_write" ON public.order_legs;
DROP POLICY IF EXISTS "order_legs_service_update" ON public.order_legs;
DROP POLICY IF EXISTS "order_legs_service_delete" ON public.order_legs;
CREATE POLICY "order_legs_user_read" ON public.order_legs FOR SELECT USING (true);
CREATE POLICY "order_legs_service_write" ON public.order_legs FOR INSERT WITH CHECK (true);
CREATE POLICY "order_legs_service_update" ON public.order_legs FOR UPDATE USING (true);
CREATE POLICY "order_legs_service_delete" ON public.order_legs FOR DELETE USING (true);

-- FILLS
DROP POLICY IF EXISTS "Allow all access to fills" ON public.fills;
DROP POLICY IF EXISTS "fills_user_read" ON public.fills;
DROP POLICY IF EXISTS "fills_service_write" ON public.fills;
DROP POLICY IF EXISTS "fills_service_update" ON public.fills;
DROP POLICY IF EXISTS "fills_service_delete" ON public.fills;
CREATE POLICY "fills_user_read" ON public.fills FOR SELECT USING (true);
CREATE POLICY "fills_service_write" ON public.fills FOR INSERT WITH CHECK (true);
CREATE POLICY "fills_service_update" ON public.fills FOR UPDATE USING (true);
CREATE POLICY "fills_service_delete" ON public.fills FOR DELETE USING (true);

-- SIGNALS
DROP POLICY IF EXISTS "Allow all access to signals" ON public.signals;
DROP POLICY IF EXISTS "signals_user_read" ON public.signals;
DROP POLICY IF EXISTS "signals_service_write" ON public.signals;
DROP POLICY IF EXISTS "signals_service_update" ON public.signals;
DROP POLICY IF EXISTS "signals_service_delete" ON public.signals;
CREATE POLICY "signals_user_read" ON public.signals FOR SELECT USING (true);
CREATE POLICY "signals_service_write" ON public.signals FOR INSERT WITH CHECK (true);
CREATE POLICY "signals_service_update" ON public.signals FOR UPDATE USING (true);
CREATE POLICY "signals_service_delete" ON public.signals FOR DELETE USING (true);

-- STRATEGIES
DROP POLICY IF EXISTS "Allow all access to strategies" ON public.strategies;
DROP POLICY IF EXISTS "strategies_user_read" ON public.strategies;
DROP POLICY IF EXISTS "strategies_service_write" ON public.strategies;
DROP POLICY IF EXISTS "strategies_service_update" ON public.strategies;
DROP POLICY IF EXISTS "strategies_service_delete" ON public.strategies;
CREATE POLICY "strategies_user_read" ON public.strategies FOR SELECT USING (true);
CREATE POLICY "strategies_service_write" ON public.strategies FOR INSERT WITH CHECK (true);
CREATE POLICY "strategies_service_update" ON public.strategies FOR UPDATE USING (true);
CREATE POLICY "strategies_service_delete" ON public.strategies FOR DELETE USING (true);

-- ALERTS
DROP POLICY IF EXISTS "Allow all access to alerts" ON public.alerts;
DROP POLICY IF EXISTS "alerts_user_read" ON public.alerts;
DROP POLICY IF EXISTS "alerts_service_write" ON public.alerts;
DROP POLICY IF EXISTS "alerts_service_update" ON public.alerts;
DROP POLICY IF EXISTS "alerts_service_delete" ON public.alerts;
CREATE POLICY "alerts_user_read" ON public.alerts FOR SELECT USING (true);
CREATE POLICY "alerts_service_write" ON public.alerts FOR INSERT WITH CHECK (true);
CREATE POLICY "alerts_service_update" ON public.alerts FOR UPDATE USING (true);
CREATE POLICY "alerts_service_delete" ON public.alerts FOR DELETE USING (true);

-- RISK_EVENTS
DROP POLICY IF EXISTS "Allow all access to risk_events" ON public.risk_events;
DROP POLICY IF EXISTS "risk_events_user_read" ON public.risk_events;
DROP POLICY IF EXISTS "risk_events_service_write" ON public.risk_events;
DROP POLICY IF EXISTS "risk_events_service_update" ON public.risk_events;
DROP POLICY IF EXISTS "risk_events_service_delete" ON public.risk_events;
CREATE POLICY "risk_events_user_read" ON public.risk_events FOR SELECT USING (true);
CREATE POLICY "risk_events_service_write" ON public.risk_events FOR INSERT WITH CHECK (true);
CREATE POLICY "risk_events_service_update" ON public.risk_events FOR UPDATE USING (true);
CREATE POLICY "risk_events_service_delete" ON public.risk_events FOR DELETE USING (true);

-- RISK_METRICS
DROP POLICY IF EXISTS "Allow all access to risk_metrics" ON public.risk_metrics;
DROP POLICY IF EXISTS "risk_metrics_user_read" ON public.risk_metrics;
DROP POLICY IF EXISTS "risk_metrics_service_write" ON public.risk_metrics;
DROP POLICY IF EXISTS "risk_metrics_service_update" ON public.risk_metrics;
DROP POLICY IF EXISTS "risk_metrics_service_delete" ON public.risk_metrics;
CREATE POLICY "risk_metrics_user_read" ON public.risk_metrics FOR SELECT USING (true);
CREATE POLICY "risk_metrics_service_write" ON public.risk_metrics FOR INSERT WITH CHECK (true);
CREATE POLICY "risk_metrics_service_update" ON public.risk_metrics FOR UPDATE USING (true);
CREATE POLICY "risk_metrics_service_delete" ON public.risk_metrics FOR DELETE USING (true);

-- MODELS
DROP POLICY IF EXISTS "Allow all access to models" ON public.models;
DROP POLICY IF EXISTS "models_user_read" ON public.models;
DROP POLICY IF EXISTS "models_service_write" ON public.models;
DROP POLICY IF EXISTS "models_service_update" ON public.models;
DROP POLICY IF EXISTS "models_service_delete" ON public.models;
CREATE POLICY "models_user_read" ON public.models FOR SELECT USING (true);
CREATE POLICY "models_service_write" ON public.models FOR INSERT WITH CHECK (true);
CREATE POLICY "models_service_update" ON public.models FOR UPDATE USING (true);
CREATE POLICY "models_service_delete" ON public.models FOR DELETE USING (true);

-- JOURNAL_ENTRIES
DROP POLICY IF EXISTS "Allow all access to journal_entries" ON public.journal_entries;
DROP POLICY IF EXISTS "journal_entries_user_read" ON public.journal_entries;
DROP POLICY IF EXISTS "journal_entries_service_write" ON public.journal_entries;
DROP POLICY IF EXISTS "journal_entries_service_update" ON public.journal_entries;
DROP POLICY IF EXISTS "journal_entries_service_delete" ON public.journal_entries;
CREATE POLICY "journal_entries_user_read" ON public.journal_entries FOR SELECT USING (true);
CREATE POLICY "journal_entries_service_write" ON public.journal_entries FOR INSERT WITH CHECK (true);
CREATE POLICY "journal_entries_service_update" ON public.journal_entries FOR UPDATE USING (true);
CREATE POLICY "journal_entries_service_delete" ON public.journal_entries FOR DELETE USING (true);

-- ACCOUNT_METRICS
DROP POLICY IF EXISTS "Allow all access to account_metrics" ON public.account_metrics;
DROP POLICY IF EXISTS "account_metrics_user_read" ON public.account_metrics;
DROP POLICY IF EXISTS "account_metrics_service_write" ON public.account_metrics;
DROP POLICY IF EXISTS "account_metrics_service_update" ON public.account_metrics;
DROP POLICY IF EXISTS "account_metrics_service_delete" ON public.account_metrics;
CREATE POLICY "account_metrics_user_read" ON public.account_metrics FOR SELECT USING (true);
CREATE POLICY "account_metrics_service_write" ON public.account_metrics FOR INSERT WITH CHECK (true);
CREATE POLICY "account_metrics_service_update" ON public.account_metrics FOR UPDATE USING (true);
CREATE POLICY "account_metrics_service_delete" ON public.account_metrics FOR DELETE USING (true);

-- DAILY_EQUITY
DROP POLICY IF EXISTS "Allow all access to daily_equity" ON public.daily_equity;
DROP POLICY IF EXISTS "daily_equity_user_read" ON public.daily_equity;
DROP POLICY IF EXISTS "daily_equity_service_write" ON public.daily_equity;
DROP POLICY IF EXISTS "daily_equity_service_update" ON public.daily_equity;
DROP POLICY IF EXISTS "daily_equity_service_delete" ON public.daily_equity;
CREATE POLICY "daily_equity_user_read" ON public.daily_equity FOR SELECT USING (true);
CREATE POLICY "daily_equity_service_write" ON public.daily_equity FOR INSERT WITH CHECK (true);
CREATE POLICY "daily_equity_service_update" ON public.daily_equity FOR UPDATE USING (true);
CREATE POLICY "daily_equity_service_delete" ON public.daily_equity FOR DELETE USING (true);

-- BOT_STATES
DROP POLICY IF EXISTS "Allow all access to bot_states" ON public.bot_states;
DROP POLICY IF EXISTS "bot_states_user_read" ON public.bot_states;
DROP POLICY IF EXISTS "bot_states_service_write" ON public.bot_states;
DROP POLICY IF EXISTS "bot_states_service_update" ON public.bot_states;
DROP POLICY IF EXISTS "bot_states_service_delete" ON public.bot_states;
CREATE POLICY "bot_states_user_read" ON public.bot_states FOR SELECT USING (true);
CREATE POLICY "bot_states_service_write" ON public.bot_states FOR INSERT WITH CHECK (true);
CREATE POLICY "bot_states_service_update" ON public.bot_states FOR UPDATE USING (true);
CREATE POLICY "bot_states_service_delete" ON public.bot_states FOR DELETE USING (true);

-- RISK_SETTINGS
DROP POLICY IF EXISTS "Allow all access to risk_settings" ON public.risk_settings;
DROP POLICY IF EXISTS "risk_settings_user_read" ON public.risk_settings;
DROP POLICY IF EXISTS "risk_settings_service_write" ON public.risk_settings;
DROP POLICY IF EXISTS "risk_settings_service_update" ON public.risk_settings;
DROP POLICY IF EXISTS "risk_settings_service_delete" ON public.risk_settings;
CREATE POLICY "risk_settings_user_read" ON public.risk_settings FOR SELECT USING (true);
CREATE POLICY "risk_settings_service_write" ON public.risk_settings FOR INSERT WITH CHECK (true);
CREATE POLICY "risk_settings_service_update" ON public.risk_settings FOR UPDATE USING (true);
CREATE POLICY "risk_settings_service_delete" ON public.risk_settings FOR DELETE USING (true);

-- METRICS_INTRADAY
DROP POLICY IF EXISTS "Allow all access to metrics_intraday" ON public.metrics_intraday;
DROP POLICY IF EXISTS "metrics_intraday_user_read" ON public.metrics_intraday;
DROP POLICY IF EXISTS "metrics_intraday_service_write" ON public.metrics_intraday;
DROP POLICY IF EXISTS "metrics_intraday_service_update" ON public.metrics_intraday;
DROP POLICY IF EXISTS "metrics_intraday_service_delete" ON public.metrics_intraday;
CREATE POLICY "metrics_intraday_user_read" ON public.metrics_intraday FOR SELECT USING (true);
CREATE POLICY "metrics_intraday_service_write" ON public.metrics_intraday FOR INSERT WITH CHECK (true);
CREATE POLICY "metrics_intraday_service_update" ON public.metrics_intraday FOR UPDATE USING (true);
CREATE POLICY "metrics_intraday_service_delete" ON public.metrics_intraday FOR DELETE USING (true);

-- STRATEGY_SIGNALS
DROP POLICY IF EXISTS "Allow all access to strategy_signals" ON public.strategy_signals;
DROP POLICY IF EXISTS "strategy_signals_user_read" ON public.strategy_signals;
DROP POLICY IF EXISTS "strategy_signals_service_write" ON public.strategy_signals;
DROP POLICY IF EXISTS "strategy_signals_service_update" ON public.strategy_signals;
DROP POLICY IF EXISTS "strategy_signals_service_delete" ON public.strategy_signals;
CREATE POLICY "strategy_signals_user_read" ON public.strategy_signals FOR SELECT USING (true);
CREATE POLICY "strategy_signals_service_write" ON public.strategy_signals FOR INSERT WITH CHECK (true);
CREATE POLICY "strategy_signals_service_update" ON public.strategy_signals FOR UPDATE USING (true);
CREATE POLICY "strategy_signals_service_delete" ON public.strategy_signals FOR DELETE USING (true);
