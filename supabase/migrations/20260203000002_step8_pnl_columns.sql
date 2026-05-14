-- Step 8: P&L Single Source of Truth - Schema Updates
-- Adds columns needed for canonical P&L persistence

-- ============================================================
-- 1. Update account_metrics for canonical P&L
-- ============================================================

ALTER TABLE IF EXISTS account_metrics
  ADD COLUMN IF NOT EXISTS session_id TEXT,
  ADD COLUMN IF NOT EXISTS session_start_equity DECIMAL(15,2),
  ADD COLUMN IF NOT EXISTS day_start_equity DECIMAL(15,2),
  ADD COLUMN IF NOT EXISTS realized_pnl DECIMAL(15,2),
  ADD COLUMN IF NOT EXISTS unrealized_pnl DECIMAL(15,2),
  ADD COLUMN IF NOT EXISTS total_equity DECIMAL(15,2),
  ADD COLUMN IF NOT EXISTS daily_pnl DECIMAL(15,2),
  ADD COLUMN IF NOT EXISTS daily_pnl_r DECIMAL(10,4),
  ADD COLUMN IF NOT EXISTS risk_unit_usd DECIMAL(15,2),
  ADD COLUMN IF NOT EXISTS open_positions_count INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS exposure_usd DECIMAL(15,2),
  ADD COLUMN IF NOT EXISTS execution_mode TEXT,
  ADD COLUMN IF NOT EXISTS risk_day TEXT;

-- ============================================================
-- 2. Update daily_equity for canonical P&L
-- ============================================================

ALTER TABLE IF EXISTS daily_equity
  ADD COLUMN IF NOT EXISTS session_realized_pnl DECIMAL(15,2),
  ADD COLUMN IF NOT EXISTS session_unrealized_pnl DECIMAL(15,2),
  ADD COLUMN IF NOT EXISTS open_positions_count INTEGER DEFAULT 0;

-- ============================================================
-- 3. Create equity_curve table if not exists
-- ============================================================

CREATE TABLE IF NOT EXISTS equity_curve (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id),
  ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  session_id TEXT,
  total_equity_usd DECIMAL(15,2) NOT NULL,
  realized_pnl_usd DECIMAL(15,2),
  unrealized_pnl_usd DECIMAL(15,2),
  day_start_equity_usd DECIMAL(15,2),
  open_positions_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Unique constraint for idempotent writes
CREATE UNIQUE INDEX IF NOT EXISTS equity_curve_user_ts_idx 
  ON equity_curve(user_id, ts);

-- Index for time-series queries
CREATE INDEX IF NOT EXISTS equity_curve_user_date_idx 
  ON equity_curve(user_id, ts DESC);

-- RLS policies
ALTER TABLE equity_curve ENABLE ROW LEVEL SECURITY;

CREATE POLICY IF NOT EXISTS "Users can view own equity curve"
  ON equity_curve FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY IF NOT EXISTS "Service role can manage equity curve"
  ON equity_curve FOR ALL
  USING (auth.role() = 'service_role');

-- ============================================================
-- 4. Update trading_sessions for canonical P&L
-- ============================================================

ALTER TABLE IF EXISTS trading_sessions
  ADD COLUMN IF NOT EXISTS initial_equity DECIMAL(15,2),
  ADD COLUMN IF NOT EXISTS final_equity DECIMAL(15,2),
  ADD COLUMN IF NOT EXISTS realized_pnl DECIMAL(15,2),
  ADD COLUMN IF NOT EXISTS execution_mode TEXT;

-- ============================================================
-- Done
-- ============================================================
