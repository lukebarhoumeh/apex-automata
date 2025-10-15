-- Seed initial account metrics for testing
-- This creates initial data to prevent 406 errors

-- First, ensure we have a test user (if using auth)
-- For now, we'll use a hardcoded user_id for testing

-- Insert initial account metrics
INSERT INTO account_metrics (
  user_id, 
  date, 
  total_equity, 
  daily_pnl, 
  daily_pnl_r,
  risk_heat,
  spread_percentile,
  open_positions_count,
  wins_today,
  losses_today,
  win_rate,
  total_trades
)
VALUES (
  '00000000-0000-0000-0000-000000000000', -- Default user ID for testing
  CURRENT_DATE, 
  52450.00, 
  1800.00,
  2.0,
  2.1,
  42.0,
  2,
  6,
  2,
  0.75,
  24
)
ON CONFLICT (user_id, date) DO UPDATE SET
  total_equity = EXCLUDED.total_equity,
  daily_pnl = EXCLUDED.daily_pnl,
  daily_pnl_r = EXCLUDED.daily_pnl_r,
  risk_heat = EXCLUDED.risk_heat,
  spread_percentile = EXCLUDED.spread_percentile,
  open_positions_count = EXCLUDED.open_positions_count,
  wins_today = EXCLUDED.wins_today,
  losses_today = EXCLUDED.losses_today,
  win_rate = EXCLUDED.win_rate,
  total_trades = EXCLUDED.total_trades;

-- Insert initial symbols if not exists
INSERT INTO symbols (symbol, base_asset, quote_asset, tick_size, lot_size, active) 
VALUES 
  ('BTC-USD', 'BTC', 'USD', 0.01, 0.0001, true),
  ('ETH-USD', 'ETH', 'USD', 0.01, 0.001, true),
  ('SOL-USD', 'SOL', 'USD', 0.01, 0.01, true)
ON CONFLICT (symbol) DO UPDATE SET
  tick_size = EXCLUDED.tick_size,
  lot_size = EXCLUDED.lot_size,
  active = EXCLUDED.active;

-- Create initial risk settings if table exists
INSERT INTO risk_settings (
  user_id,
  per_trade_risk,
  portfolio_heat_cap,
  daily_stop_loss,
  kill_switch_enabled,
  spread_percentile_threshold,
  atr_burst_multiplier
)
VALUES (
  '00000000-0000-0000-0000-000000000000',
  0.007, -- 0.7%
  0.038, -- 3.8%
  -0.02, -- -2%
  true,
  98,
  3.0
)
ON CONFLICT (user_id) DO UPDATE SET
  per_trade_risk = EXCLUDED.per_trade_risk,
  portfolio_heat_cap = EXCLUDED.portfolio_heat_cap,
  daily_stop_loss = EXCLUDED.daily_stop_loss,
  kill_switch_enabled = EXCLUDED.kill_switch_enabled,
  spread_percentile_threshold = EXCLUDED.spread_percentile_threshold,
  atr_burst_multiplier = EXCLUDED.atr_burst_multiplier;
