-- Reconciliation file pulled from supabase_migrations.schema_migrations
-- (version 20260303183623, name fix_upsert_account_metrics_equity_calculation) on 2026-05-14 via Supabase MCP.
-- Captures DDL applied directly to prod via dashboard/Lovable IDE.

CREATE OR REPLACE FUNCTION upsert_account_metrics(p_user_id UUID)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_base_equity NUMERIC := 50000;
    v_realized_pnl NUMERIC;
    v_open_position_value NUMERIC;
    v_total_equity NUMERIC;
    v_daily_pnl NUMERIC;
    v_open_positions INTEGER;
    v_wins_today INTEGER;
    v_losses_today INTEGER;
BEGIN
    -- Calculate all-time realized PnL from closed positions
    SELECT COALESCE(SUM(realized_pnl_usd), 0)
    INTO v_realized_pnl
    FROM positions
    WHERE user_id = p_user_id
      AND closed_at IS NOT NULL;

    -- Calculate value of open positions (mark-to-market)
    SELECT COALESCE(SUM(
        CASE
            WHEN p.closed_at IS NULL AND p.qty_open > 0 THEN
                p.qty_open * COALESCE(latest_price.price, p.entry_price)
            ELSE 0
        END
    ), 0)
    INTO v_open_position_value
    FROM positions p
    LEFT JOIN LATERAL (
        SELECT price
        FROM orders o
        WHERE o.symbol = p.symbol
          AND o.user_id = p_user_id
          AND o.status = 'filled'
        ORDER BY o.updated_at DESC
        LIMIT 1
    ) latest_price ON true
    WHERE p.user_id = p_user_id
      AND p.closed_at IS NULL;

    -- Total equity = base + realized PnL + open position value
    v_total_equity := v_base_equity + v_realized_pnl + v_open_position_value;

    -- Calculate daily P&L from positions closed today
    SELECT COALESCE(SUM(realized_pnl_usd), 0)
    INTO v_daily_pnl
    FROM positions
    WHERE user_id = p_user_id
      AND closed_at IS NOT NULL
      AND DATE(closed_at) = CURRENT_DATE;

    -- Count open positions
    SELECT COUNT(*)
    INTO v_open_positions
    FROM positions
    WHERE user_id = p_user_id
      AND closed_at IS NULL
      AND qty_open > 0;

    -- Count wins/losses today
    SELECT
        COUNT(*) FILTER (WHERE realized_pnl_usd > 0),
        COUNT(*) FILTER (WHERE realized_pnl_usd < 0)
    INTO v_wins_today, v_losses_today
    FROM positions
    WHERE user_id = p_user_id
      AND closed_at IS NOT NULL
      AND DATE(closed_at) = CURRENT_DATE;

    -- Upsert the metrics
    INSERT INTO account_metrics (
        user_id, date, total_equity, daily_pnl, daily_pnl_r,
        risk_heat, spread_percentile, open_positions_count,
        wins_today, losses_today
    )
    VALUES (
        p_user_id, CURRENT_DATE,
        COALESCE(v_total_equity, v_base_equity),
        COALESCE(v_daily_pnl, 0),
        CASE WHEN v_base_equity > 0
             THEN COALESCE(v_daily_pnl, 0) / (v_base_equity * 0.01)
             ELSE 0
        END,
        CASE WHEN v_total_equity > 0
             THEN (v_open_position_value / v_total_equity) * 100
             ELSE 0
        END,
        0,
        COALESCE(v_open_positions, 0),
        COALESCE(v_wins_today, 0),
        COALESCE(v_losses_today, 0)
    )
    ON CONFLICT (user_id, date) DO UPDATE
    SET
        total_equity = EXCLUDED.total_equity,
        daily_pnl = EXCLUDED.daily_pnl,
        daily_pnl_r = EXCLUDED.daily_pnl_r,
        risk_heat = EXCLUDED.risk_heat,
        open_positions_count = EXCLUDED.open_positions_count,
        wins_today = EXCLUDED.wins_today,
        losses_today = EXCLUDED.losses_today,
        updated_at = NOW();
END;
$$;