-- ============================================================================
-- Trade Analytics Tables
-- HFT-grade trade logging and session statistics
-- ============================================================================

-- Trade log table: individual trade records with full execution details
CREATE TABLE IF NOT EXISTS trade_log (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL,
  session_id TEXT NOT NULL,
  
  -- Trade identification
  symbol TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('long', 'short')),
  
  -- Timing
  entry_time TIMESTAMPTZ NOT NULL,
  exit_time TIMESTAMPTZ,
  duration_seconds DOUBLE PRECISION,
  
  -- Prices
  entry_price DOUBLE PRECISION NOT NULL,
  exit_price DOUBLE PRECISION,
  size DOUBLE PRECISION NOT NULL,
  
  -- P&L
  realized_pnl DOUBLE PRECISION,
  fees DOUBLE PRECISION DEFAULT 0,
  
  -- Execution quality
  slippage_bps DOUBLE PRECISION,
  
  -- Outcome
  outcome TEXT CHECK (outcome IN ('win', 'loss', 'breakeven')),
  
  -- Strategy metadata
  strategy TEXT,
  signal_id TEXT,
  exit_reason TEXT,
  reason_code TEXT,
  
  -- Order references
  entry_order_id TEXT,
  exit_order_id TEXT,
  
  -- Risk metrics
  max_favorable_excursion DOUBLE PRECISION,
  max_adverse_excursion DOUBLE PRECISION,
  
  created_at TIMESTAMPTZ DEFAULT NOW(),
  
  CONSTRAINT fk_user FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_trade_log_user_session ON trade_log(user_id, session_id);
CREATE INDEX IF NOT EXISTS idx_trade_log_symbol ON trade_log(symbol);
CREATE INDEX IF NOT EXISTS idx_trade_log_entry_time ON trade_log(entry_time DESC);
CREATE INDEX IF NOT EXISTS idx_trade_log_outcome ON trade_log(outcome) WHERE outcome IS NOT NULL;

-- Trading sessions table: session-level aggregated statistics
CREATE TABLE IF NOT EXISTS trading_sessions (
  session_id TEXT PRIMARY KEY,
  user_id UUID NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('paper', 'live')),
  
  -- Timing
  start_time TIMESTAMPTZ NOT NULL,
  end_time TIMESTAMPTZ,
  
  -- Equity
  initial_equity DOUBLE PRECISION NOT NULL,
  final_equity DOUBLE PRECISION,
  
  -- P&L
  total_pnl DOUBLE PRECISION DEFAULT 0,
  gross_profit DOUBLE PRECISION DEFAULT 0,
  gross_loss DOUBLE PRECISION DEFAULT 0,
  
  -- Trade counts
  total_trades INTEGER DEFAULT 0,
  winning_trades INTEGER DEFAULT 0,
  losing_trades INTEGER DEFAULT 0,
  
  -- Ratios
  win_rate DOUBLE PRECISION,
  profit_factor DOUBLE PRECISION,
  avg_win DOUBLE PRECISION,
  avg_loss DOUBLE PRECISION,
  expectancy DOUBLE PRECISION,
  
  -- Risk metrics
  max_drawdown DOUBLE PRECISION,
  max_drawdown_pct DOUBLE PRECISION,
  sharpe_estimate DOUBLE PRECISION,
  
  -- Execution metrics
  avg_duration_seconds DOUBLE PRECISION,
  avg_slippage_bps DOUBLE PRECISION,
  
  created_at TIMESTAMPTZ DEFAULT NOW(),
  
  CONSTRAINT fk_session_user FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON trading_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_start_time ON trading_sessions(start_time DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_mode ON trading_sessions(mode);

-- Equity curve snapshots (for historical equity curve visualization)
CREATE TABLE IF NOT EXISTS equity_snapshots (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL,
  session_id TEXT NOT NULL,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  equity DOUBLE PRECISION NOT NULL,
  cumulative_pnl DOUBLE PRECISION NOT NULL,
  trade_id UUID, -- Optional: reference to trade that caused this snapshot
  
  CONSTRAINT fk_equity_user FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_equity_user_session ON equity_snapshots(user_id, session_id);
CREATE INDEX IF NOT EXISTS idx_equity_timestamp ON equity_snapshots(timestamp DESC);

-- Enable Row Level Security
ALTER TABLE trade_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE trading_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE equity_snapshots ENABLE ROW LEVEL SECURITY;

-- RLS policies (users can only see their own data)
DROP POLICY IF EXISTS trade_log_user_policy ON trade_log;
CREATE POLICY trade_log_user_policy ON trade_log
  FOR ALL USING (auth.uid() = user_id);

DROP POLICY IF EXISTS trading_sessions_user_policy ON trading_sessions;
CREATE POLICY trading_sessions_user_policy ON trading_sessions
  FOR ALL USING (auth.uid() = user_id);

DROP POLICY IF EXISTS equity_snapshots_user_policy ON equity_snapshots;
CREATE POLICY equity_snapshots_user_policy ON equity_snapshots
  FOR ALL USING (auth.uid() = user_id);

-- Service role bypass for backend operations
DROP POLICY IF EXISTS trade_log_service_policy ON trade_log;
CREATE POLICY trade_log_service_policy ON trade_log
  FOR ALL TO service_role USING (true);

DROP POLICY IF EXISTS trading_sessions_service_policy ON trading_sessions;
CREATE POLICY trading_sessions_service_policy ON trading_sessions
  FOR ALL TO service_role USING (true);

DROP POLICY IF EXISTS equity_snapshots_service_policy ON equity_snapshots;
CREATE POLICY equity_snapshots_service_policy ON equity_snapshots
  FOR ALL TO service_role USING (true);

-- View for daily trade summary
CREATE OR REPLACE VIEW daily_trade_summary AS
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
FROM trade_log
WHERE exit_time IS NOT NULL
GROUP BY user_id, DATE(entry_time)
ORDER BY trade_date DESC;

COMMENT ON TABLE trade_log IS 'Individual trade records with full execution details for HFT-grade analytics';
COMMENT ON TABLE trading_sessions IS 'Aggregated session-level trading statistics';
COMMENT ON TABLE equity_snapshots IS 'Time-series equity curve data points';
COMMENT ON VIEW daily_trade_summary IS 'Daily aggregated trading statistics by user';

