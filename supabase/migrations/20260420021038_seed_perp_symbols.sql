-- Reconciliation file pulled from supabase_migrations.schema_migrations
-- (version 20260420021038, name seed_perp_symbols) on 2026-05-14 via Supabase MCP.
-- Captures DDL applied directly to prod via dashboard/Lovable IDE.

-- Phase 5A: Seed Coinbase INTX perpetual futures symbols
-- Fixes FK violations on signals/orders referencing *-PERP-INTX symbols.
-- quote_asset = 'USD' because Coinbase perps settle in USD-denominated collateral.

INSERT INTO public.symbols (symbol, base_asset, quote_asset, tick_size, lot_size, active)
VALUES
  ('BTC-PERP-INTX', 'BTC', 'USD', 0.01, 0.0001, true),
  ('ETH-PERP-INTX', 'ETH', 'USD', 0.01, 0.001, true),
  ('SOL-PERP-INTX', 'SOL', 'USD', 0.01, 0.01, true)
ON CONFLICT (symbol) DO UPDATE SET
  tick_size = EXCLUDED.tick_size,
  lot_size = EXCLUDED.lot_size,
  active = EXCLUDED.active;