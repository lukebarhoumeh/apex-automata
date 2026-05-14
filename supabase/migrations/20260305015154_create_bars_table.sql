-- Reconciliation file pulled from supabase_migrations.schema_migrations
-- (version 20260305015154, name create_bars_table) on 2026-05-14 via Supabase MCP.
-- Captures DDL applied directly to prod via dashboard/Lovable IDE.

CREATE TABLE IF NOT EXISTS bars (
  id BIGSERIAL PRIMARY KEY,
  symbol TEXT NOT NULL,
  time BIGINT NOT NULL,
  open DOUBLE PRECISION NOT NULL,
  high DOUBLE PRECISION NOT NULL,
  low DOUBLE PRECISION NOT NULL,
  close DOUBLE PRECISION NOT NULL,
  volume DOUBLE PRECISION NOT NULL DEFAULT 0,
  exchange TEXT NOT NULL DEFAULT 'coinbase',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(symbol, time, exchange)
);

CREATE INDEX idx_bars_symbol_time ON bars(symbol, time DESC);
CREATE INDEX idx_bars_exchange ON bars(exchange);

ALTER TABLE bars ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role full access" ON bars FOR ALL USING (true);