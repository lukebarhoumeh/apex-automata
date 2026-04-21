-- Idempotent hardening for trade analytics tables.
--
-- NOTE (2026-04-21 reconciliation): the live `trading_sessions` table uses
-- `started_at` / `ended_at` (not `start_time` / `end_time`). The prior version
-- of this file declared the wrong column names — rewritten to match reality.
-- This file was never applied against cloud Supabase; it exists so fresh
-- dev instances (`supabase db reset`) produce the same schema the cloud has.

-- Trade log table (idempotent)
CREATE TABLE IF NOT EXISTS public.trade_log (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL,
  session_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('long', 'short')),
  entry_time TIMESTAMPTZ NOT NULL,
  exit_time TIMESTAMPTZ,
  duration_seconds DOUBLE PRECISION,
  entry_price DOUBLE PRECISION NOT NULL,
  exit_price DOUBLE PRECISION,
  size DOUBLE PRECISION NOT NULL,
  realized_pnl DOUBLE PRECISION,
  fees DOUBLE PRECISION DEFAULT 0,
  slippage_bps DOUBLE PRECISION,
  outcome TEXT CHECK (outcome IN ('win', 'loss', 'breakeven')),
  strategy TEXT,
  signal_id TEXT,
  exit_reason TEXT,
  reason_code TEXT,
  entry_order_id TEXT,
  exit_order_id TEXT,
  max_favorable_excursion DOUBLE PRECISION,
  max_adverse_excursion DOUBLE PRECISION,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Trading sessions table (idempotent) — columns match live schema.
CREATE TABLE IF NOT EXISTS public.trading_sessions (
  session_id TEXT PRIMARY KEY,
  user_id UUID NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('paper', 'live')),
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  initial_equity NUMERIC,
  final_equity NUMERIC,
  total_trades INTEGER,
  total_pnl NUMERIC,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Back-compat: if a dev instance was ever built from the prior version of this
-- file (which used start_time / end_time), rename those columns in place.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'trading_sessions' AND column_name = 'start_time'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'trading_sessions' AND column_name = 'started_at'
  ) THEN
    ALTER TABLE public.trading_sessions RENAME COLUMN start_time TO started_at;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'trading_sessions' AND column_name = 'end_time'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'trading_sessions' AND column_name = 'ended_at'
  ) THEN
    ALTER TABLE public.trading_sessions RENAME COLUMN end_time TO ended_at;
  END IF;
END $$;

-- Indexes
CREATE INDEX IF NOT EXISTS idx_trade_log_user_session ON public.trade_log(user_id, session_id);
CREATE INDEX IF NOT EXISTS idx_trade_log_symbol ON public.trade_log(symbol);
CREATE INDEX IF NOT EXISTS idx_trade_log_entry_time ON public.trade_log(entry_time DESC);
CREATE INDEX IF NOT EXISTS idx_trade_log_outcome ON public.trade_log(outcome) WHERE outcome IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sessions_user ON public.trading_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_started_at ON public.trading_sessions(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_mode ON public.trading_sessions(mode);

-- RLS
ALTER TABLE public.trade_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trading_sessions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS trade_log_user_policy ON public.trade_log;
CREATE POLICY trade_log_user_policy ON public.trade_log
  FOR ALL USING (auth.uid() = user_id);

DROP POLICY IF EXISTS trading_sessions_user_policy ON public.trading_sessions;
CREATE POLICY trading_sessions_user_policy ON public.trading_sessions
  FOR ALL USING (auth.uid() = user_id);

DROP POLICY IF EXISTS trade_log_service_policy ON public.trade_log;
CREATE POLICY trade_log_service_policy ON public.trade_log
  FOR ALL TO service_role USING (true);

DROP POLICY IF EXISTS trading_sessions_service_policy ON public.trading_sessions;
CREATE POLICY trading_sessions_service_policy ON public.trading_sessions
  FOR ALL TO service_role USING (true);

-- Daily summary view (unchanged)
CREATE OR REPLACE VIEW public.daily_trade_summary AS
SELECT
  user_id,
  DATE(entry_time) as trade_date,
  COUNT(*) as total_trades,
  COUNT(*) FILTER (WHERE outcome = 'win') as wins,
  COUNT(*) FILTER (WHERE outcome = 'loss') as losses,
  COUNT(*) FILTER (WHERE outcome = 'breakeven') as breakeven,
  COALESCE(SUM(realized_pnl), 0) as total_pnl,
  COALESCE(SUM(realized_pnl) FILTER (WHERE outcome = 'win'), 0) as gross_profit,
  COALESCE(SUM(ABS(realized_pnl)) FILTER (WHERE outcome = 'loss'), 0) as gross_loss,
  CASE
    WHEN COUNT(*) > 0
    THEN ROUND(COUNT(*) FILTER (WHERE outcome = 'win')::NUMERIC / COUNT(*)::NUMERIC, 4)
    ELSE 0
  END as win_rate,
  CASE
    WHEN COALESCE(SUM(ABS(realized_pnl)) FILTER (WHERE outcome = 'loss'), 0) > 0
    THEN ROUND(COALESCE(SUM(realized_pnl) FILTER (WHERE outcome = 'win'), 0) /
         COALESCE(SUM(ABS(realized_pnl)) FILTER (WHERE outcome = 'loss'), 1), 2)
    ELSE NULL
  END as profit_factor,
  ROUND(AVG(duration_seconds)::NUMERIC, 0) as avg_duration_seconds,
  ROUND(AVG(slippage_bps)::NUMERIC, 2) as avg_slippage_bps
FROM public.trade_log
WHERE exit_time IS NOT NULL
GROUP BY user_id, DATE(entry_time)
ORDER BY trade_date DESC;
