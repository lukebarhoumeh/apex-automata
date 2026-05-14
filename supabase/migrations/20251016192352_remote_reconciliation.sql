-- Reconciliation file pulled from supabase_migrations.schema_migrations
-- (version 20251016192352, name (empty)) on 2026-05-14 via Supabase MCP.
-- Captures DDL applied directly to prod via dashboard/Lovable IDE.

-- Fix security invoker for views to resolve linter warnings
DROP VIEW IF EXISTS v_daily_r;
CREATE VIEW v_daily_r 
WITH (security_invoker=true)
AS 
SELECT 
  DATE(COALESCE(closed_at, opened_at)) as day,
  user_id,
  SUM(COALESCE(realized_r, 0)) as daily_r
FROM positions
WHERE closed_at IS NOT NULL
GROUP BY 1, 2
ORDER BY 1 DESC;

DROP VIEW IF EXISTS v_open_positions;
CREATE VIEW v_open_positions
WITH (security_invoker=true)
AS
SELECT 
  id as position_id,
  user_id,
  symbol,
  strategy,
  side,
  qty_open,
  entry_price,
  stop_price_at_entry,
  take_profit_price,
  opened_at
FROM positions
WHERE closed_at IS NULL
ORDER BY opened_at DESC;

DROP VIEW IF EXISTS v_recent_activity;
CREATE VIEW v_recent_activity
WITH (security_invoker=true)
AS
SELECT 
  o.id as order_id,
  o.symbol,
  o.side,
  o.type,
  o.quantity,
  o.price,
  o.status,
  o.created_at,
  COALESCE(SUM(f.quantity), 0) as filled_qty,
  COUNT(f.id) as fill_count
FROM orders o
LEFT JOIN fills f ON f.order_id = o.id
GROUP BY o.id, o.symbol, o.side, o.type, o.quantity, o.price, o.status, o.created_at
ORDER BY o.created_at DESC
LIMIT 100;

DROP VIEW IF EXISTS v_signal_funnel;
CREATE VIEW v_signal_funnel
WITH (security_invoker=true)
AS
SELECT 
  user_id,
  DATE_TRUNC('hour', decided_at) as hour,
  COUNT(*) FILTER (WHERE allowed = true) as allowed,
  COUNT(*) FILTER (WHERE allowed = false) as rejected
FROM signals
GROUP BY 1, 2
ORDER BY 2 DESC;

-- Fix touch_updated_at function to add search_path
CREATE OR REPLACE FUNCTION public.touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
begin
  new.updated_at = now();
  return new;
end $function$;

-- Add momentum strategy to enum
ALTER TYPE strategy_name ADD VALUE IF NOT EXISTS 'momentum';