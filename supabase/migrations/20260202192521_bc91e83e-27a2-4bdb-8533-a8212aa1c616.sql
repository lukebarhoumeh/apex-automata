-- Trade log table
CREATE TABLE IF NOT EXISTS public.trade_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
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

-- Indexes
CREATE INDEX IF NOT EXISTS idx_trade_log_user_session ON public.trade_log(user_id, session_id);
CREATE INDEX IF NOT EXISTS idx_trade_log_symbol ON public.trade_log(symbol);
CREATE INDEX IF NOT EXISTS idx_trade_log_entry_time ON public.trade_log(entry_time DESC);
CREATE INDEX IF NOT EXISTS idx_trade_log_outcome ON public.trade_log(outcome) WHERE outcome IS NOT NULL;

-- RLS
ALTER TABLE public.trade_log ENABLE ROW LEVEL SECURITY;

-- User policy
DROP POLICY IF EXISTS trade_log_user_policy ON public.trade_log;
CREATE POLICY trade_log_user_policy ON public.trade_log
  FOR ALL USING (auth.uid() = user_id);

-- Service role policy
DROP POLICY IF EXISTS trade_log_service_policy ON public.trade_log;
CREATE POLICY trade_log_service_policy ON public.trade_log
  FOR ALL TO service_role USING (true);

-- Ensure trading_sessions has service_role policy
DROP POLICY IF EXISTS trading_sessions_service_policy ON public.trading_sessions;
CREATE POLICY trading_sessions_service_policy ON public.trading_sessions
  FOR ALL TO service_role USING (true);