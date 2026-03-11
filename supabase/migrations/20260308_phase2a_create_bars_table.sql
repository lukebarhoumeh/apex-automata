-- Phase 2.1: Create bars table for historical candle data
-- Applied to production DB during Phase 2 (March 2026)
-- 86,888 candles cached: BTC-USD, ETH-USD, SOL-USD (15m intervals)

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

CREATE INDEX IF NOT EXISTS idx_bars_symbol_time ON bars(symbol, time DESC);
CREATE INDEX IF NOT EXISTS idx_bars_exchange ON bars(exchange);

ALTER TABLE bars ENABLE ROW LEVEL SECURITY;

-- Note: USING(true) is overly permissive — flagged as tech debt for later
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'bars' AND policyname = 'Service role full access on bars') THEN
    CREATE POLICY "Service role full access on bars" ON bars FOR ALL USING (true);
  END IF;
END $$;
