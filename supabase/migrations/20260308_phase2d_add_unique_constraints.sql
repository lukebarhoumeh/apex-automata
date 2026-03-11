-- Phase 2.4: Add unique constraints to prevent duplicate records

-- Prevent duplicate signals (same user, symbol, strategy, timestamp)
CREATE UNIQUE INDEX IF NOT EXISTS idx_signals_dedup
  ON signals(user_id, symbol, strategy, decided_at)
  WHERE decided_at IS NOT NULL;

-- Prevent duplicate fills (same order, trade, timestamp)
CREATE UNIQUE INDEX IF NOT EXISTS idx_fills_dedup
  ON fills(order_id, trade_id, filled_at)
  WHERE trade_id IS NOT NULL;
