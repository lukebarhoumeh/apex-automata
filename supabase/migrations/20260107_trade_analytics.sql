-- Trade analytics schema.
--
-- NOTE (2026-04-21 reconciliation): the live Supabase `trading_sessions` table
-- was authored manually (not by any migration in this repo) with column names
-- `started_at` / `ended_at` and a trimmed column set. This file was never
-- applied against the live project (absent from the applied-migrations list).
-- We reshape it to match reality so a `supabase db reset` rebuilds an
-- identical schema. Backend code (`openTradingSession` / `closeTradingSession`)
-- uses `started_at` / `ended_at`.

-- Trade log table: per-trade records for analytics + ML features
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

-- Trading sessions table: session-level aggregated statistics.
-- Columns mirror the live Supabase schema exactly.
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
