-- Single-user MVP: drop auth.users foreign keys on analytics tables
-- This repo uses a fixed USER_ID without requiring a real Supabase Auth user.
-- The Trade Analytics migration adds FKs to auth.users, which will block inserts
-- unless a corresponding auth user exists. We remove those constraints here.

ALTER TABLE IF EXISTS public.trade_log
  DROP CONSTRAINT IF EXISTS fk_user;

ALTER TABLE IF EXISTS public.trading_sessions
  DROP CONSTRAINT IF EXISTS fk_session_user;

ALTER TABLE IF EXISTS public.equity_snapshots
  DROP CONSTRAINT IF EXISTS fk_equity_user;

