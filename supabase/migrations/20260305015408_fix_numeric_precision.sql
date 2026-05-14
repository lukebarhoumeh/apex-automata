-- Reconciliation file pulled from supabase_migrations.schema_migrations
-- (version 20260305015408, name fix_numeric_precision) on 2026-05-14 via Supabase MCP.
-- Captures DDL applied directly to prod via dashboard/Lovable IDE.

-- Drop ALL dependent views
DROP VIEW IF EXISTS ml_training_data;
DROP VIEW IF EXISTS strategy_regime_performance;
DROP VIEW IF EXISTS daily_trade_summary;

-- trade_outcomes: convert P&L/fee columns from DOUBLE PRECISION to NUMERIC(20,8)
ALTER TABLE trade_outcomes ALTER COLUMN fees TYPE NUMERIC(20,8);
ALTER TABLE trade_outcomes ALTER COLUMN realized_pnl TYPE NUMERIC(20,8);
ALTER TABLE trade_outcomes ALTER COLUMN pnl_percent TYPE NUMERIC(20,8);
ALTER TABLE trade_outcomes ALTER COLUMN r_multiple TYPE NUMERIC(20,8);
ALTER TABLE trade_outcomes ALTER COLUMN initial_risk TYPE NUMERIC(20,8);
ALTER TABLE trade_outcomes ALTER COLUMN slippage_bps TYPE NUMERIC(20,8);
ALTER TABLE trade_outcomes ALTER COLUMN max_favorable_excursion TYPE NUMERIC(20,8);
ALTER TABLE trade_outcomes ALTER COLUMN max_adverse_excursion TYPE NUMERIC(20,8);

-- trade_log: convert P&L/fee columns
ALTER TABLE trade_log ALTER COLUMN realized_pnl TYPE NUMERIC(20,8);
ALTER TABLE trade_log ALTER COLUMN fees TYPE NUMERIC(20,8);
ALTER TABLE trade_log ALTER COLUMN slippage_bps TYPE NUMERIC(20,8);
ALTER TABLE trade_log ALTER COLUMN max_favorable_excursion TYPE NUMERIC(20,8);
ALTER TABLE trade_log ALTER COLUMN max_adverse_excursion TYPE NUMERIC(20,8);

-- Recreate ml_training_data view
CREATE OR REPLACE VIEW ml_training_data AS
SELECT id,
    symbol,
    strategy,
    signal_direction,
    signal_strength,
    regime,
    regime_confidence,
    CASE trend_direction
        WHEN 'bullish' THEN 1
        WHEN 'bearish' THEN -1
        ELSE 0
    END AS trend_direction_encoded,
    adx,
    atr_percent,
    bb_width,
    choppiness,
    mtf_alignment,
    volume_ratio,
    meta_filter_score,
    cold_streak_active::integer AS cold_streak_encoded,
    position_multiplier,
    (indicators_snapshot ->> 'rsi')::double precision AS rsi,
    (indicators_snapshot ->> 'macd')::double precision AS macd,
    (indicators_snapshot ->> 'macd_signal')::double precision AS macd_signal,
    (indicators_snapshot ->> 'macd_histogram')::double precision AS macd_histogram,
    (indicators_snapshot ->> 'ema9')::double precision AS ema9,
    (indicators_snapshot ->> 'ema21')::double precision AS ema21,
    (indicators_snapshot ->> 'vwap')::double precision AS vwap,
    (indicators_snapshot ->> 'bb_upper')::double precision AS bb_upper,
    (indicators_snapshot ->> 'bb_lower')::double precision AS bb_lower,
    outcome_label,
    outcome_score,
    r_multiple,
    CASE outcome_label
        WHEN 'profitable' THEN 1
        WHEN 'unprofitable' THEN 0
        ELSE NULL::integer
    END AS profitable_binary,
    entry_time,
    hold_duration_seconds,
    pnl_percent
FROM trade_outcomes
WHERE outcome_label IS NOT NULL
ORDER BY entry_time DESC;

-- Recreate strategy_regime_performance view
CREATE OR REPLACE VIEW strategy_regime_performance AS
SELECT strategy,
    regime,
    count(*) AS total_trades,
    count(*) FILTER (WHERE outcome_label = 'profitable') AS wins,
    count(*) FILTER (WHERE outcome_label = 'unprofitable') AS losses,
    round(count(*) FILTER (WHERE outcome_label = 'profitable')::numeric / NULLIF(count(*), 0)::numeric, 4) AS win_rate,
    round(avg(pnl_percent), 4) AS avg_pnl_percent,
    round(avg(r_multiple), 2) AS avg_r_multiple,
    round(avg(signal_strength)::numeric, 3) AS avg_signal_strength,
    round(avg(meta_filter_score)::numeric, 3) AS avg_meta_score,
    round(avg(hold_duration_seconds), 0) AS avg_hold_seconds
FROM trade_outcomes
WHERE outcome_label IS NOT NULL
GROUP BY strategy, regime
ORDER BY strategy, regime;

-- Recreate daily_trade_summary view (updated for NUMERIC types)
CREATE OR REPLACE VIEW daily_trade_summary AS
SELECT user_id,
    date(entry_time) AS trade_date,
    count(*) AS total_trades,
    count(*) FILTER (WHERE outcome = 'win') AS wins,
    count(*) FILTER (WHERE outcome = 'loss') AS losses,
    count(*) FILTER (WHERE outcome = 'breakeven') AS breakeven,
    COALESCE(sum(realized_pnl), 0) AS total_pnl,
    COALESCE(sum(realized_pnl) FILTER (WHERE outcome = 'win'), 0) AS gross_profit,
    COALESCE(sum(abs(realized_pnl)) FILTER (WHERE outcome = 'loss'), 0) AS gross_loss,
    CASE
        WHEN count(*) > 0 THEN round(count(*) FILTER (WHERE outcome = 'win')::numeric / count(*)::numeric, 4)
        ELSE 0::numeric
    END AS win_rate,
    CASE
        WHEN COALESCE(sum(abs(realized_pnl)) FILTER (WHERE outcome = 'loss'), 0) > 0 THEN round(COALESCE(sum(realized_pnl) FILTER (WHERE outcome = 'win'), 0) / NULLIF(COALESCE(sum(abs(realized_pnl)) FILTER (WHERE outcome = 'loss'), 0), 0), 2)
        ELSE NULL::numeric
    END AS profit_factor,
    round(avg(duration_seconds)::numeric, 0) AS avg_duration_seconds,
    round(avg(slippage_bps), 2) AS avg_slippage_bps
FROM trade_log
WHERE exit_time IS NOT NULL
GROUP BY user_id, date(entry_time)
ORDER BY date(entry_time) DESC;