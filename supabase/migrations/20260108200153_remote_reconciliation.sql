-- Reconciliation file pulled from supabase_migrations.schema_migrations
-- (version 20260108200153, name (empty)) on 2026-05-14 via Supabase MCP.
-- Captures DDL applied directly to prod via dashboard/Lovable IDE.

-- =============================================
-- PERFORMANCE INDEXES FOR TRADING SPEED
-- =============================================

-- Positions: Critical for open position queries and P&L calculations
CREATE INDEX IF NOT EXISTS idx_positions_user_open ON positions(user_id, opened_at DESC) WHERE closed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_positions_user_closed ON positions(user_id, closed_at DESC) WHERE closed_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_positions_symbol ON positions(symbol, opened_at DESC);

-- Orders: Critical for order blotter and fill tracking
CREATE INDEX IF NOT EXISTS idx_orders_user_status ON orders(user_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_user_created ON orders(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_symbol ON orders(symbol, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_external ON orders(external_order_id) WHERE external_order_id IS NOT NULL;

-- Signals: Fast signal history queries
CREATE INDEX IF NOT EXISTS idx_signals_user_decided ON signals(user_id, decided_at DESC);
CREATE INDEX IF NOT EXISTS idx_signals_allowed ON signals(user_id, allowed, decided_at DESC);
CREATE INDEX IF NOT EXISTS idx_signals_symbol ON signals(symbol, decided_at DESC);

-- Fills: Order fill lookups
CREATE INDEX IF NOT EXISTS idx_fills_order ON fills(order_id, filled_at DESC);
CREATE INDEX IF NOT EXISTS idx_fills_user ON fills(user_id, filled_at DESC);

-- Order Legs: Partial fill tracking
CREATE INDEX IF NOT EXISTS idx_order_legs_order ON order_legs(order_id, created_at DESC);

-- Risk Events: Active risk event queries
CREATE INDEX IF NOT EXISTS idx_risk_events_user_active ON risk_events(user_id, triggered_at DESC) WHERE active = true;

-- Alerts: Unacked alert queries
CREATE INDEX IF NOT EXISTS idx_alerts_user_unacked ON alerts(user_id, created_at DESC) WHERE acked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_alerts_severity ON alerts(user_id, severity, created_at DESC);

-- Account Metrics: Daily lookups
CREATE INDEX IF NOT EXISTS idx_account_metrics_user_date ON account_metrics(user_id, date DESC);

-- Daily Equity: Equity curve queries
CREATE INDEX IF NOT EXISTS idx_daily_equity_user_date ON daily_equity(user_id, date DESC);

-- Metrics Intraday: Time-series queries
CREATE INDEX IF NOT EXISTS idx_metrics_intraday_bucket ON metrics_intraday(user_id, metric, bucket_start DESC);

-- =============================================
-- ENABLE REALTIME (only for tables not already added)
-- =============================================

-- Enable REPLICA IDENTITY for realtime change tracking
ALTER TABLE orders REPLICA IDENTITY FULL;
ALTER TABLE fills REPLICA IDENTITY FULL;
ALTER TABLE signals REPLICA IDENTITY FULL;
ALTER TABLE risk_events REPLICA IDENTITY FULL;
ALTER TABLE alerts REPLICA IDENTITY FULL;

-- Add remaining tables to realtime publication (positions already added)
DO $$
BEGIN
  BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE orders;
  EXCEPTION WHEN duplicate_object THEN NULL;
  END;
  BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE fills;
  EXCEPTION WHEN duplicate_object THEN NULL;
  END;
  BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE signals;
  EXCEPTION WHEN duplicate_object THEN NULL;
  END;
  BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE risk_events;
  EXCEPTION WHEN duplicate_object THEN NULL;
  END;
  BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE alerts;
  EXCEPTION WHEN duplicate_object THEN NULL;
  END;
END $$;