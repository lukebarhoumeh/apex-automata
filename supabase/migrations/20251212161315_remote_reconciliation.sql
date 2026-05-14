-- Reconciliation file pulled from supabase_migrations.schema_migrations
-- (version 20251212161315, name (empty)) on 2026-05-14 via Supabase MCP.
-- Captures DDL applied directly to prod via dashboard/Lovable IDE.

-- Seed profile for fixed USER_ID
INSERT INTO public.profiles (user_id, display_name)
VALUES ('b7e8f9c2-4d6a-4c8b-9e2d-1a3b5c7d9e1f', 'Atlas Trader')
ON CONFLICT (user_id) DO UPDATE SET display_name = EXCLUDED.display_name;

-- Seed symbols
INSERT INTO public.symbols (symbol, base_asset, quote_asset, tick_size, lot_size, active)
VALUES 
  ('BTC-USD', 'BTC', 'USD', 0.01, 0.0001, true),
  ('ETH-USD', 'ETH', 'USD', 0.01, 0.001, true),
  ('SOL-USD', 'SOL', 'USD', 0.01, 0.01, true)
ON CONFLICT (symbol) DO UPDATE SET
  tick_size = EXCLUDED.tick_size,
  lot_size = EXCLUDED.lot_size,
  active = EXCLUDED.active;

-- Seed strategies
INSERT INTO public.strategies (user_id, name, enabled, default_params, version)
VALUES 
  ('b7e8f9c2-4d6a-4c8b-9e2d-1a3b5c7d9e1f', 'breakout', true, '{"adxMin": 25, "donchianN": 20, "atrPctileMin": 50}', 1),
  ('b7e8f9c2-4d6a-4c8b-9e2d-1a3b5c7d9e1f', 'vwap_mr', true, '{"zAbsMin": 2.0, "adxMax": 20}', 1),
  ('b7e8f9c2-4d6a-4c8b-9e2d-1a3b5c7d9e1f', 'momentum', true, '{"rsiOversold": 30, "rsiOverbought": 70}', 1)
ON CONFLICT DO NOTHING;

-- Seed default risk settings
INSERT INTO public.risk_settings (user_id, per_trade_risk, max_heat, daily_stop_r, kill_switch_enabled, spread_threshold, atr_burst_multiplier)
VALUES ('b7e8f9c2-4d6a-4c8b-9e2d-1a3b5c7d9e1f', 0.7, 3.0, 2.0, true, 98, 3.0)
ON CONFLICT (user_id) DO UPDATE SET
  per_trade_risk = EXCLUDED.per_trade_risk,
  max_heat = EXCLUDED.max_heat;

-- Seed initial account metrics
INSERT INTO public.account_metrics (user_id, date, total_equity, daily_pnl, daily_pnl_r, risk_heat, open_positions_count)
VALUES ('b7e8f9c2-4d6a-4c8b-9e2d-1a3b5c7d9e1f', CURRENT_DATE, 50000.00, 0, 0, 0, 0)
ON CONFLICT (user_id, date) DO UPDATE SET
  total_equity = EXCLUDED.total_equity;

-- Seed bot state (paper mode)
INSERT INTO public.bot_states (user_id, state)
VALUES ('b7e8f9c2-4d6a-4c8b-9e2d-1a3b5c7d9e1f', 'paper')
ON CONFLICT DO NOTHING;