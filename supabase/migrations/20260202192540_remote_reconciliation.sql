-- Reconciliation file pulled from supabase_migrations.schema_migrations
-- (version 20260202192540, name (empty)) on 2026-05-14 via Supabase MCP.
-- Captures DDL applied directly to prod via dashboard/Lovable IDE.

-- Daily summary view with proper NUMERIC casts
-- Fresh-replay guard (2026-09-10, Supabase Preview): on a from-scratch chain the
-- view already exists from 20260202190000 with DOUBLE PRECISION columns, and
-- CREATE OR REPLACE VIEW cannot change a column's type. On prod the earlier
-- CREATE never took effect, so this was a fresh create there; mirror that.
DROP VIEW IF EXISTS public.daily_trade_summary;
CREATE OR REPLACE VIEW public.daily_trade_summary AS
SELECT
  user_id,
  DATE(entry_time) as trade_date,
  COUNT(*) as total_trades,
  COUNT(*) FILTER (WHERE outcome = 'win') as wins,
  COUNT(*) FILTER (WHERE outcome = 'loss') as losses,
  COUNT(*) FILTER (WHERE outcome = 'breakeven') as breakeven,
  COALESCE(SUM(realized_pnl), 0)::NUMERIC as total_pnl,
  COALESCE(SUM(realized_pnl) FILTER (WHERE outcome = 'win'), 0)::NUMERIC as gross_profit,
  COALESCE(SUM(ABS(realized_pnl)) FILTER (WHERE outcome = 'loss'), 0)::NUMERIC as gross_loss,
  CASE
    WHEN COUNT(*) > 0
    THEN ROUND(COUNT(*) FILTER (WHERE outcome = 'win')::NUMERIC / COUNT(*)::NUMERIC, 4)
    ELSE 0
  END as win_rate,
  CASE
    WHEN COALESCE(SUM(ABS(realized_pnl)) FILTER (WHERE outcome = 'loss'), 0) > 0
    THEN ROUND(
      (COALESCE(SUM(realized_pnl) FILTER (WHERE outcome = 'win'), 0) /
       NULLIF(COALESCE(SUM(ABS(realized_pnl)) FILTER (WHERE outcome = 'loss'), 0), 0))::NUMERIC, 2)
    ELSE NULL
  END as profit_factor,
  ROUND(AVG(duration_seconds)::NUMERIC, 0) as avg_duration_seconds,
  ROUND(AVG(slippage_bps)::NUMERIC, 2) as avg_slippage_bps
FROM public.trade_log
WHERE exit_time IS NOT NULL
GROUP BY user_id, DATE(entry_time)
ORDER BY trade_date DESC;