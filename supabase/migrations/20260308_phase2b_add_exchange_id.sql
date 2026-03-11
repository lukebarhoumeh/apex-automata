-- Phase 2.2: Add exchange_id to trading tables for multi-exchange support

ALTER TABLE positions ADD COLUMN IF NOT EXISTS exchange_id TEXT NOT NULL DEFAULT 'coinbase';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS exchange_id TEXT NOT NULL DEFAULT 'coinbase';
ALTER TABLE fills ADD COLUMN IF NOT EXISTS exchange_id TEXT NOT NULL DEFAULT 'coinbase';
ALTER TABLE trade_log ADD COLUMN IF NOT EXISTS exchange_id TEXT NOT NULL DEFAULT 'coinbase';
ALTER TABLE signals ADD COLUMN IF NOT EXISTS routed_exchange TEXT;

CREATE INDEX IF NOT EXISTS idx_positions_exchange ON positions(exchange_id);
CREATE INDEX IF NOT EXISTS idx_orders_exchange ON orders(exchange_id);
