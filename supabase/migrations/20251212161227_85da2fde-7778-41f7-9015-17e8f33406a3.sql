-- Drop ALL foreign key constraints referencing auth.users for single-user MVP
-- This allows us to use a fixed user_id without creating a real auth user

-- Drop FK on strategies
ALTER TABLE public.strategies DROP CONSTRAINT IF EXISTS strategies_user_id_fkey;

-- Drop FK on signals  
ALTER TABLE public.signals DROP CONSTRAINT IF EXISTS signals_user_id_fkey;

-- Drop FK on orders
ALTER TABLE public.orders DROP CONSTRAINT IF EXISTS orders_user_id_fkey;

-- Drop FK on order_legs
ALTER TABLE public.order_legs DROP CONSTRAINT IF EXISTS order_legs_user_id_fkey;

-- Drop FK on fills
ALTER TABLE public.fills DROP CONSTRAINT IF EXISTS fills_user_id_fkey;

-- Drop FK on positions
ALTER TABLE public.positions DROP CONSTRAINT IF EXISTS positions_user_id_fkey;

-- Drop FK on risk_events
ALTER TABLE public.risk_events DROP CONSTRAINT IF EXISTS risk_events_user_id_fkey;

-- Drop FK on risk_settings
ALTER TABLE public.risk_settings DROP CONSTRAINT IF EXISTS risk_settings_user_id_fkey;

-- Drop FK on risk_metrics
ALTER TABLE public.risk_metrics DROP CONSTRAINT IF EXISTS risk_metrics_user_id_fkey;

-- Drop FK on account_metrics
ALTER TABLE public.account_metrics DROP CONSTRAINT IF EXISTS account_metrics_user_id_fkey;

-- Drop FK on alerts
ALTER TABLE public.alerts DROP CONSTRAINT IF EXISTS alerts_user_id_fkey;

-- Drop FK on bot_states
ALTER TABLE public.bot_states DROP CONSTRAINT IF EXISTS bot_states_user_id_fkey;

-- Drop FK on models
ALTER TABLE public.models DROP CONSTRAINT IF EXISTS models_user_id_fkey;

-- Drop FK on journal_entries
ALTER TABLE public.journal_entries DROP CONSTRAINT IF EXISTS journal_entries_user_id_fkey;

-- Drop FK on metrics_intraday
ALTER TABLE public.metrics_intraday DROP CONSTRAINT IF EXISTS metrics_intraday_user_id_fkey;

-- Drop FK on daily_equity
ALTER TABLE public.daily_equity DROP CONSTRAINT IF EXISTS daily_equity_user_id_fkey;

-- Drop FK on strategy_signals
ALTER TABLE public.strategy_signals DROP CONSTRAINT IF EXISTS strategy_signals_user_id_fkey;

-- Drop FK on user_roles (keep for future auth)
-- ALTER TABLE public.user_roles DROP CONSTRAINT IF EXISTS user_roles_user_id_fkey;