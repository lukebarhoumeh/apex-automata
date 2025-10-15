-- Seed symbols table with tradable markets
INSERT INTO symbols (symbol, base_asset, quote_asset, tick_size, lot_size, active) 
VALUES 
  ('BTC-USD', 'BTC', 'USD', 0.01, 0.0001, true),
  ('ETH-USD', 'ETH', 'USD', 0.01, 0.001, true),
  ('SOL-USD', 'SOL', 'USD', 0.01, 0.01, true),
  ('MATIC-USD', 'MATIC', 'USD', 0.0001, 1, true),
  ('AVAX-USD', 'AVAX', 'USD', 0.01, 0.01, true)
ON CONFLICT (symbol) DO UPDATE SET
  tick_size = EXCLUDED.tick_size,
  lot_size = EXCLUDED.lot_size,
  active = EXCLUDED.active;
