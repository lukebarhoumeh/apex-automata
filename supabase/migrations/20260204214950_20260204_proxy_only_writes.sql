-- Reconciliation file pulled from supabase_migrations.schema_migrations
-- (version 20260204214950, name 20260204_proxy_only_writes) on 2026-05-14 via Supabase MCP.
-- Captures DDL applied directly to prod via dashboard/Lovable IDE.

-- =====================================================
-- Enforce proxy-only writes
-- - Browser (anon/authenticated) is read-only
-- - Writes are permitted only to service_role (Edge Functions)
-- =====================================================

-- POSITIONS
DROP POLICY IF EXISTS "positions_user_read" ON public.positions;
DROP POLICY IF EXISTS "positions_read_public" ON public.positions;
DROP POLICY IF EXISTS "positions_service_write" ON public.positions;
DROP POLICY IF EXISTS "positions_service_update" ON public.positions;
DROP POLICY IF EXISTS "positions_service_delete" ON public.positions;
DROP POLICY IF EXISTS "positions_insert_service_role" ON public.positions;
DROP POLICY IF EXISTS "positions_update_service_role" ON public.positions;
DROP POLICY IF EXISTS "positions_delete_service_role" ON public.positions;
CREATE POLICY "positions_read_public" ON public.positions FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "positions_insert_service_role" ON public.positions FOR INSERT TO service_role WITH CHECK ((select auth.role()) = 'service_role');
CREATE POLICY "positions_update_service_role" ON public.positions FOR UPDATE TO service_role USING ((select auth.role()) = 'service_role') WITH CHECK ((select auth.role()) = 'service_role');
CREATE POLICY "positions_delete_service_role" ON public.positions FOR DELETE TO service_role USING ((select auth.role()) = 'service_role');

-- ORDERS
DROP POLICY IF EXISTS "orders_user_read" ON public.orders;
DROP POLICY IF EXISTS "orders_read_public" ON public.orders;
DROP POLICY IF EXISTS "orders_service_write" ON public.orders;
DROP POLICY IF EXISTS "orders_service_update" ON public.orders;
DROP POLICY IF EXISTS "orders_service_delete" ON public.orders;
DROP POLICY IF EXISTS "orders_insert_service_role" ON public.orders;
DROP POLICY IF EXISTS "orders_update_service_role" ON public.orders;
DROP POLICY IF EXISTS "orders_delete_service_role" ON public.orders;
CREATE POLICY "orders_read_public" ON public.orders FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "orders_insert_service_role" ON public.orders FOR INSERT TO service_role WITH CHECK ((select auth.role()) = 'service_role');
CREATE POLICY "orders_update_service_role" ON public.orders FOR UPDATE TO service_role USING ((select auth.role()) = 'service_role') WITH CHECK ((select auth.role()) = 'service_role');
CREATE POLICY "orders_delete_service_role" ON public.orders FOR DELETE TO service_role USING ((select auth.role()) = 'service_role');

-- ORDER_LEGS
DROP POLICY IF EXISTS "order_legs_user_read" ON public.order_legs;
DROP POLICY IF EXISTS "order_legs_read_public" ON public.order_legs;
DROP POLICY IF EXISTS "order_legs_service_write" ON public.order_legs;
DROP POLICY IF EXISTS "order_legs_service_update" ON public.order_legs;
DROP POLICY IF EXISTS "order_legs_service_delete" ON public.order_legs;
DROP POLICY IF EXISTS "order_legs_insert_service_role" ON public.order_legs;
DROP POLICY IF EXISTS "order_legs_update_service_role" ON public.order_legs;
DROP POLICY IF EXISTS "order_legs_delete_service_role" ON public.order_legs;
CREATE POLICY "order_legs_read_public" ON public.order_legs FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "order_legs_insert_service_role" ON public.order_legs FOR INSERT TO service_role WITH CHECK ((select auth.role()) = 'service_role');
CREATE POLICY "order_legs_update_service_role" ON public.order_legs FOR UPDATE TO service_role USING ((select auth.role()) = 'service_role') WITH CHECK ((select auth.role()) = 'service_role');
CREATE POLICY "order_legs_delete_service_role" ON public.order_legs FOR DELETE TO service_role USING ((select auth.role()) = 'service_role');

-- FILLS
DROP POLICY IF EXISTS "fills_user_read" ON public.fills;
DROP POLICY IF EXISTS "fills_read_public" ON public.fills;
DROP POLICY IF EXISTS "fills_service_write" ON public.fills;
DROP POLICY IF EXISTS "fills_service_update" ON public.fills;
DROP POLICY IF EXISTS "fills_service_delete" ON public.fills;
DROP POLICY IF EXISTS "fills_insert_service_role" ON public.fills;
DROP POLICY IF EXISTS "fills_update_service_role" ON public.fills;
DROP POLICY IF EXISTS "fills_delete_service_role" ON public.fills;
CREATE POLICY "fills_read_public" ON public.fills FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "fills_insert_service_role" ON public.fills FOR INSERT TO service_role WITH CHECK ((select auth.role()) = 'service_role');
CREATE POLICY "fills_update_service_role" ON public.fills FOR UPDATE TO service_role USING ((select auth.role()) = 'service_role') WITH CHECK ((select auth.role()) = 'service_role');
CREATE POLICY "fills_delete_service_role" ON public.fills FOR DELETE TO service_role USING ((select auth.role()) = 'service_role');

-- SIGNALS
DROP POLICY IF EXISTS "signals_user_read" ON public.signals;
DROP POLICY IF EXISTS "signals_read_public" ON public.signals;
DROP POLICY IF EXISTS "signals_service_write" ON public.signals;
DROP POLICY IF EXISTS "signals_service_update" ON public.signals;
DROP POLICY IF EXISTS "signals_service_delete" ON public.signals;
DROP POLICY IF EXISTS "signals_insert_service_role" ON public.signals;
DROP POLICY IF EXISTS "signals_update_service_role" ON public.signals;
DROP POLICY IF EXISTS "signals_delete_service_role" ON public.signals;
CREATE POLICY "signals_read_public" ON public.signals FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "signals_insert_service_role" ON public.signals FOR INSERT TO service_role WITH CHECK ((select auth.role()) = 'service_role');
CREATE POLICY "signals_update_service_role" ON public.signals FOR UPDATE TO service_role USING ((select auth.role()) = 'service_role') WITH CHECK ((select auth.role()) = 'service_role');
CREATE POLICY "signals_delete_service_role" ON public.signals FOR DELETE TO service_role USING ((select auth.role()) = 'service_role');

-- STRATEGIES
DROP POLICY IF EXISTS "strategies_user_read" ON public.strategies;
DROP POLICY IF EXISTS "strategies_read_public" ON public.strategies;
DROP POLICY IF EXISTS "strategies_service_write" ON public.strategies;
DROP POLICY IF EXISTS "strategies_service_update" ON public.strategies;
DROP POLICY IF EXISTS "strategies_service_delete" ON public.strategies;
DROP POLICY IF EXISTS "strategies_insert_service_role" ON public.strategies;
DROP POLICY IF EXISTS "strategies_update_service_role" ON public.strategies;
DROP POLICY IF EXISTS "strategies_delete_service_role" ON public.strategies;
CREATE POLICY "strategies_read_public" ON public.strategies FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "strategies_insert_service_role" ON public.strategies FOR INSERT TO service_role WITH CHECK ((select auth.role()) = 'service_role');
CREATE POLICY "strategies_update_service_role" ON public.strategies FOR UPDATE TO service_role USING ((select auth.role()) = 'service_role') WITH CHECK ((select auth.role()) = 'service_role');
CREATE POLICY "strategies_delete_service_role" ON public.strategies FOR DELETE TO service_role USING ((select auth.role()) = 'service_role');

-- ALERTS
DROP POLICY IF EXISTS "alerts_user_read" ON public.alerts;
DROP POLICY IF EXISTS "alerts_read_public" ON public.alerts;
DROP POLICY IF EXISTS "alerts_service_write" ON public.alerts;
DROP POLICY IF EXISTS "alerts_service_update" ON public.alerts;
DROP POLICY IF EXISTS "alerts_service_delete" ON public.alerts;
DROP POLICY IF EXISTS "alerts_insert_service_role" ON public.alerts;
DROP POLICY IF EXISTS "alerts_update_service_role" ON public.alerts;
DROP POLICY IF EXISTS "alerts_delete_service_role" ON public.alerts;
CREATE POLICY "alerts_read_public" ON public.alerts FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "alerts_insert_service_role" ON public.alerts FOR INSERT TO service_role WITH CHECK ((select auth.role()) = 'service_role');
CREATE POLICY "alerts_update_service_role" ON public.alerts FOR UPDATE TO service_role USING ((select auth.role()) = 'service_role') WITH CHECK ((select auth.role()) = 'service_role');
CREATE POLICY "alerts_delete_service_role" ON public.alerts FOR DELETE TO service_role USING ((select auth.role()) = 'service_role');

-- RISK_EVENTS
DROP POLICY IF EXISTS "risk_events_user_read" ON public.risk_events;
DROP POLICY IF EXISTS "risk_events_read_public" ON public.risk_events;
DROP POLICY IF EXISTS "risk_events_service_write" ON public.risk_events;
DROP POLICY IF EXISTS "risk_events_service_update" ON public.risk_events;
DROP POLICY IF EXISTS "risk_events_service_delete" ON public.risk_events;
DROP POLICY IF EXISTS "risk_events_insert_service_role" ON public.risk_events;
DROP POLICY IF EXISTS "risk_events_update_service_role" ON public.risk_events;
DROP POLICY IF EXISTS "risk_events_delete_service_role" ON public.risk_events;
CREATE POLICY "risk_events_read_public" ON public.risk_events FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "risk_events_insert_service_role" ON public.risk_events FOR INSERT TO service_role WITH CHECK ((select auth.role()) = 'service_role');
CREATE POLICY "risk_events_update_service_role" ON public.risk_events FOR UPDATE TO service_role USING ((select auth.role()) = 'service_role') WITH CHECK ((select auth.role()) = 'service_role');
CREATE POLICY "risk_events_delete_service_role" ON public.risk_events FOR DELETE TO service_role USING ((select auth.role()) = 'service_role');

-- RISK_METRICS
DROP POLICY IF EXISTS "risk_metrics_user_read" ON public.risk_metrics;
DROP POLICY IF EXISTS "risk_metrics_read_public" ON public.risk_metrics;
DROP POLICY IF EXISTS "risk_metrics_service_write" ON public.risk_metrics;
DROP POLICY IF EXISTS "risk_metrics_service_update" ON public.risk_metrics;
DROP POLICY IF EXISTS "risk_metrics_service_delete" ON public.risk_metrics;
DROP POLICY IF EXISTS "risk_metrics_insert_service_role" ON public.risk_metrics;
DROP POLICY IF EXISTS "risk_metrics_update_service_role" ON public.risk_metrics;
DROP POLICY IF EXISTS "risk_metrics_delete_service_role" ON public.risk_metrics;
CREATE POLICY "risk_metrics_read_public" ON public.risk_metrics FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "risk_metrics_insert_service_role" ON public.risk_metrics FOR INSERT TO service_role WITH CHECK ((select auth.role()) = 'service_role');
CREATE POLICY "risk_metrics_update_service_role" ON public.risk_metrics FOR UPDATE TO service_role USING ((select auth.role()) = 'service_role') WITH CHECK ((select auth.role()) = 'service_role');
CREATE POLICY "risk_metrics_delete_service_role" ON public.risk_metrics FOR DELETE TO service_role USING ((select auth.role()) = 'service_role');

-- MODELS
DROP POLICY IF EXISTS "models_user_read" ON public.models;
DROP POLICY IF EXISTS "models_read_public" ON public.models;
DROP POLICY IF EXISTS "models_service_write" ON public.models;
DROP POLICY IF EXISTS "models_service_update" ON public.models;
DROP POLICY IF EXISTS "models_service_delete" ON public.models;
DROP POLICY IF EXISTS "models_insert_service_role" ON public.models;
DROP POLICY IF EXISTS "models_update_service_role" ON public.models;
DROP POLICY IF EXISTS "models_delete_service_role" ON public.models;
CREATE POLICY "models_read_public" ON public.models FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "models_insert_service_role" ON public.models FOR INSERT TO service_role WITH CHECK ((select auth.role()) = 'service_role');
CREATE POLICY "models_update_service_role" ON public.models FOR UPDATE TO service_role USING ((select auth.role()) = 'service_role') WITH CHECK ((select auth.role()) = 'service_role');
CREATE POLICY "models_delete_service_role" ON public.models FOR DELETE TO service_role USING ((select auth.role()) = 'service_role');

-- JOURNAL_ENTRIES
DROP POLICY IF EXISTS "journal_entries_user_read" ON public.journal_entries;
DROP POLICY IF EXISTS "journal_entries_read_public" ON public.journal_entries;
DROP POLICY IF EXISTS "journal_entries_service_write" ON public.journal_entries;
DROP POLICY IF EXISTS "journal_entries_service_update" ON public.journal_entries;
DROP POLICY IF EXISTS "journal_entries_service_delete" ON public.journal_entries;
DROP POLICY IF EXISTS "journal_entries_insert_service_role" ON public.journal_entries;
DROP POLICY IF EXISTS "journal_entries_update_service_role" ON public.journal_entries;
DROP POLICY IF EXISTS "journal_entries_delete_service_role" ON public.journal_entries;
CREATE POLICY "journal_entries_read_public" ON public.journal_entries FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "journal_entries_insert_service_role" ON public.journal_entries FOR INSERT TO service_role WITH CHECK ((select auth.role()) = 'service_role');
CREATE POLICY "journal_entries_update_service_role" ON public.journal_entries FOR UPDATE TO service_role USING ((select auth.role()) = 'service_role') WITH CHECK ((select auth.role()) = 'service_role');
CREATE POLICY "journal_entries_delete_service_role" ON public.journal_entries FOR DELETE TO service_role USING ((select auth.role()) = 'service_role');

-- ACCOUNT_METRICS
DROP POLICY IF EXISTS "account_metrics_user_read" ON public.account_metrics;
DROP POLICY IF EXISTS "account_metrics_read_public" ON public.account_metrics;
DROP POLICY IF EXISTS "account_metrics_service_write" ON public.account_metrics;
DROP POLICY IF EXISTS "account_metrics_service_update" ON public.account_metrics;
DROP POLICY IF EXISTS "account_metrics_service_delete" ON public.account_metrics;
DROP POLICY IF EXISTS "account_metrics_insert_service_role" ON public.account_metrics;
DROP POLICY IF EXISTS "account_metrics_update_service_role" ON public.account_metrics;
DROP POLICY IF EXISTS "account_metrics_delete_service_role" ON public.account_metrics;
CREATE POLICY "account_metrics_read_public" ON public.account_metrics FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "account_metrics_insert_service_role" ON public.account_metrics FOR INSERT TO service_role WITH CHECK ((select auth.role()) = 'service_role');
CREATE POLICY "account_metrics_update_service_role" ON public.account_metrics FOR UPDATE TO service_role USING ((select auth.role()) = 'service_role') WITH CHECK ((select auth.role()) = 'service_role');
CREATE POLICY "account_metrics_delete_service_role" ON public.account_metrics FOR DELETE TO service_role USING ((select auth.role()) = 'service_role');

-- DAILY_EQUITY
DROP POLICY IF EXISTS "daily_equity_user_read" ON public.daily_equity;
DROP POLICY IF EXISTS "daily_equity_read_public" ON public.daily_equity;
DROP POLICY IF EXISTS "daily_equity_service_write" ON public.daily_equity;
DROP POLICY IF EXISTS "daily_equity_service_update" ON public.daily_equity;
DROP POLICY IF EXISTS "daily_equity_service_delete" ON public.daily_equity;
DROP POLICY IF EXISTS "daily_equity_insert_service_role" ON public.daily_equity;
DROP POLICY IF EXISTS "daily_equity_update_service_role" ON public.daily_equity;
DROP POLICY IF EXISTS "daily_equity_delete_service_role" ON public.daily_equity;
CREATE POLICY "daily_equity_read_public" ON public.daily_equity FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "daily_equity_insert_service_role" ON public.daily_equity FOR INSERT TO service_role WITH CHECK ((select auth.role()) = 'service_role');
CREATE POLICY "daily_equity_update_service_role" ON public.daily_equity FOR UPDATE TO service_role USING ((select auth.role()) = 'service_role') WITH CHECK ((select auth.role()) = 'service_role');
CREATE POLICY "daily_equity_delete_service_role" ON public.daily_equity FOR DELETE TO service_role USING ((select auth.role()) = 'service_role');

-- BOT_STATES
DROP POLICY IF EXISTS "bot_states_user_read" ON public.bot_states;
DROP POLICY IF EXISTS "bot_states_read_public" ON public.bot_states;
DROP POLICY IF EXISTS "bot_states_service_write" ON public.bot_states;
DROP POLICY IF EXISTS "bot_states_service_update" ON public.bot_states;
DROP POLICY IF EXISTS "bot_states_service_delete" ON public.bot_states;
DROP POLICY IF EXISTS "bot_states_insert_service_role" ON public.bot_states;
DROP POLICY IF EXISTS "bot_states_update_service_role" ON public.bot_states;
DROP POLICY IF EXISTS "bot_states_delete_service_role" ON public.bot_states;
CREATE POLICY "bot_states_read_public" ON public.bot_states FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "bot_states_insert_service_role" ON public.bot_states FOR INSERT TO service_role WITH CHECK ((select auth.role()) = 'service_role');
CREATE POLICY "bot_states_update_service_role" ON public.bot_states FOR UPDATE TO service_role USING ((select auth.role()) = 'service_role') WITH CHECK ((select auth.role()) = 'service_role');
CREATE POLICY "bot_states_delete_service_role" ON public.bot_states FOR DELETE TO service_role USING ((select auth.role()) = 'service_role');

-- RISK_SETTINGS
DROP POLICY IF EXISTS "risk_settings_user_read" ON public.risk_settings;
DROP POLICY IF EXISTS "risk_settings_read_public" ON public.risk_settings;
DROP POLICY IF EXISTS "risk_settings_service_write" ON public.risk_settings;
DROP POLICY IF EXISTS "risk_settings_service_update" ON public.risk_settings;
DROP POLICY IF EXISTS "risk_settings_service_delete" ON public.risk_settings;
DROP POLICY IF EXISTS "risk_settings_insert_service_role" ON public.risk_settings;
DROP POLICY IF EXISTS "risk_settings_update_service_role" ON public.risk_settings;
DROP POLICY IF EXISTS "risk_settings_delete_service_role" ON public.risk_settings;
CREATE POLICY "risk_settings_read_public" ON public.risk_settings FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "risk_settings_insert_service_role" ON public.risk_settings FOR INSERT TO service_role WITH CHECK ((select auth.role()) = 'service_role');
CREATE POLICY "risk_settings_update_service_role" ON public.risk_settings FOR UPDATE TO service_role USING ((select auth.role()) = 'service_role') WITH CHECK ((select auth.role()) = 'service_role');
CREATE POLICY "risk_settings_delete_service_role" ON public.risk_settings FOR DELETE TO service_role USING ((select auth.role()) = 'service_role');

-- METRICS_INTRADAY
DROP POLICY IF EXISTS "metrics_intraday_user_read" ON public.metrics_intraday;
DROP POLICY IF EXISTS "metrics_intraday_read_public" ON public.metrics_intraday;
DROP POLICY IF EXISTS "metrics_intraday_service_write" ON public.metrics_intraday;
DROP POLICY IF EXISTS "metrics_intraday_service_update" ON public.metrics_intraday;
DROP POLICY IF EXISTS "metrics_intraday_service_delete" ON public.metrics_intraday;
DROP POLICY IF EXISTS "metrics_intraday_insert_service_role" ON public.metrics_intraday;
DROP POLICY IF EXISTS "metrics_intraday_update_service_role" ON public.metrics_intraday;
DROP POLICY IF EXISTS "metrics_intraday_delete_service_role" ON public.metrics_intraday;
CREATE POLICY "metrics_intraday_read_public" ON public.metrics_intraday FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "metrics_intraday_insert_service_role" ON public.metrics_intraday FOR INSERT TO service_role WITH CHECK ((select auth.role()) = 'service_role');
CREATE POLICY "metrics_intraday_update_service_role" ON public.metrics_intraday FOR UPDATE TO service_role USING ((select auth.role()) = 'service_role') WITH CHECK ((select auth.role()) = 'service_role');
CREATE POLICY "metrics_intraday_delete_service_role" ON public.metrics_intraday FOR DELETE TO service_role USING ((select auth.role()) = 'service_role');

-- STRATEGY_SIGNALS
DROP POLICY IF EXISTS "strategy_signals_user_read" ON public.strategy_signals;
DROP POLICY IF EXISTS "strategy_signals_read_public" ON public.strategy_signals;
DROP POLICY IF EXISTS "strategy_signals_service_write" ON public.strategy_signals;
DROP POLICY IF EXISTS "strategy_signals_service_update" ON public.strategy_signals;
DROP POLICY IF EXISTS "strategy_signals_service_delete" ON public.strategy_signals;
DROP POLICY IF EXISTS "strategy_signals_insert_service_role" ON public.strategy_signals;
DROP POLICY IF EXISTS "strategy_signals_update_service_role" ON public.strategy_signals;
DROP POLICY IF EXISTS "strategy_signals_delete_service_role" ON public.strategy_signals;
CREATE POLICY "strategy_signals_read_public" ON public.strategy_signals FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "strategy_signals_insert_service_role" ON public.strategy_signals FOR INSERT TO service_role WITH CHECK ((select auth.role()) = 'service_role');
CREATE POLICY "strategy_signals_update_service_role" ON public.strategy_signals FOR UPDATE TO service_role USING ((select auth.role()) = 'service_role') WITH CHECK ((select auth.role()) = 'service_role');
CREATE POLICY "strategy_signals_delete_service_role" ON public.strategy_signals FOR DELETE TO service_role USING ((select auth.role()) = 'service_role');
