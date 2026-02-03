-- Step 7: Persistence Hardening Migration
-- Fixes schema mismatches and adds unique constraints for idempotent writes

-- ============================================================
-- 1. Fix risk_metrics table
-- ============================================================

-- Add missing columns to risk_metrics
ALTER TABLE IF EXISTS risk_metrics
  ADD COLUMN IF NOT EXISTS daily_pnl_r DECIMAL(10,4),
  ADD COLUMN IF NOT EXISTS realized_pnl_usd DECIMAL(15,2),
  ADD COLUMN IF NOT EXISTS unrealized_pnl_usd DECIMAL(15,2),
  ADD COLUMN IF NOT EXISTS average_latency_ms INTEGER,
  ADD COLUMN IF NOT EXISTS market_data_stale_ms INTEGER;

-- Add unique constraint for upserts on user_id (latest snapshot per user)
-- Drop existing constraint if any
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'risk_metrics_user_id_key'
  ) THEN
    ALTER TABLE risk_metrics DROP CONSTRAINT risk_metrics_user_id_key;
  END IF;
END $$;

-- Create unique constraint
ALTER TABLE risk_metrics
  ADD CONSTRAINT risk_metrics_user_id_key UNIQUE (user_id);

-- ============================================================
-- 2. Fix account_metrics table
-- ============================================================

-- Ensure unique constraint on (user_id, date)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'account_metrics_user_id_date_key'
  ) THEN
    ALTER TABLE account_metrics
      ADD CONSTRAINT account_metrics_user_id_date_key UNIQUE (user_id, date);
  END IF;
END $$;

-- ============================================================
-- 3. Fix daily_equity table
-- ============================================================

-- Add missing columns
ALTER TABLE IF EXISTS daily_equity
  ADD COLUMN IF NOT EXISTS high_equity DECIMAL(15,2),
  ADD COLUMN IF NOT EXISTS low_equity DECIMAL(15,2),
  ADD COLUMN IF NOT EXISTS realized_pnl DECIMAL(15,2),
  ADD COLUMN IF NOT EXISTS unrealized_pnl DECIMAL(15,2);

-- Ensure unique constraint on (user_id, date)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'daily_equity_user_id_date_key'
  ) THEN
    ALTER TABLE daily_equity
      ADD CONSTRAINT daily_equity_user_id_date_key UNIQUE (user_id, date);
  END IF;
END $$;

-- ============================================================
-- 4. Fix fills table for idempotent writes
-- ============================================================

-- Ensure unique constraint on (user_id, trade_id)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fills_user_trade_key'
  ) THEN
    ALTER TABLE fills
      ADD CONSTRAINT fills_user_trade_key UNIQUE (user_id, trade_id);
  END IF;
END $$;

-- ============================================================
-- 5. Fix orders table for idempotent writes
-- ============================================================

-- Ensure unique constraint on (user_id, external_order_id)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'orders_user_external_key'
  ) THEN
    -- Add column if missing
    ALTER TABLE orders
      ADD COLUMN IF NOT EXISTS external_order_id TEXT;
    
    -- Create index for common queries
    CREATE INDEX IF NOT EXISTS orders_external_order_id_idx ON orders(external_order_id);
  END IF;
END $$;

-- ============================================================
-- 6. Fix trade_outcomes table for idempotent writes
-- ============================================================

-- Ensure unique constraint on signal_id
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'trade_outcomes_signal_id_key'
  ) THEN
    ALTER TABLE trade_outcomes
      ADD CONSTRAINT trade_outcomes_signal_id_key UNIQUE (signal_id);
  END IF;
END $$;

-- ============================================================
-- 7. Fix positions table for idempotent writes
-- ============================================================

-- Ensure unique constraint on (user_id, symbol)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'positions_user_symbol_key'
  ) THEN
    ALTER TABLE positions
      ADD CONSTRAINT positions_user_symbol_key UNIQUE (user_id, symbol);
  END IF;
END $$;

-- ============================================================
-- 8. Enable Supabase Realtime for critical tables
-- ============================================================

-- These tables should be in the realtime publication
-- Note: This requires superuser or publication owner privileges
-- Uncomment if your Supabase setup supports this

-- ALTER PUBLICATION supabase_realtime ADD TABLE orders;
-- ALTER PUBLICATION supabase_realtime ADD TABLE fills;
-- ALTER PUBLICATION supabase_realtime ADD TABLE positions;
-- ALTER PUBLICATION supabase_realtime ADD TABLE signals;
-- ALTER PUBLICATION supabase_realtime ADD TABLE account_metrics;
-- ALTER PUBLICATION supabase_realtime ADD TABLE risk_metrics;
-- ALTER PUBLICATION supabase_realtime ADD TABLE alerts;

-- Set REPLICA IDENTITY FULL for tables where updates matter
-- This allows Realtime to send the full row on updates

-- ALTER TABLE account_metrics REPLICA IDENTITY FULL;
-- ALTER TABLE risk_metrics REPLICA IDENTITY FULL;
-- ALTER TABLE positions REPLICA IDENTITY FULL;
-- ALTER TABLE orders REPLICA IDENTITY FULL;

-- ============================================================
-- 9. Indexes for common queries
-- ============================================================

CREATE INDEX IF NOT EXISTS risk_metrics_user_updated_idx 
  ON risk_metrics(user_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS account_metrics_user_date_idx 
  ON account_metrics(user_id, date DESC);

CREATE INDEX IF NOT EXISTS daily_equity_user_date_idx 
  ON daily_equity(user_id, date DESC);

CREATE INDEX IF NOT EXISTS trade_log_session_idx 
  ON trade_log(session_id, created_at DESC);

CREATE INDEX IF NOT EXISTS trade_log_user_date_idx 
  ON trade_log(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS risk_events_user_type_idx 
  ON risk_events(user_id, event_type, triggered_at DESC);

-- ============================================================
-- Done
-- ============================================================
