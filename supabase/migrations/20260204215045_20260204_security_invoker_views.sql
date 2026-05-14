-- Reconciliation file pulled from supabase_migrations.schema_migrations
-- (version 20260204215045, name 20260204_security_invoker_views) on 2026-05-14 via Supabase MCP.
-- Captures DDL applied directly to prod via dashboard/Lovable IDE.

-- =====================================================
-- Convert security definer views to SECURITY INVOKER
-- =====================================================

CREATE OR REPLACE VIEW public.daily_trade_summary
WITH (security_invoker = true) AS
 SELECT trade_log.user_id,
    date(trade_log.entry_time) AS trade_date,
    count(*) AS total_trades,
    count(*) FILTER (WHERE (trade_log.outcome = 'win'::text)) AS wins,
    count(*) FILTER (WHERE (trade_log.outcome = 'loss'::text)) AS losses,
    count(*) FILTER (WHERE (trade_log.outcome = 'breakeven'::text)) AS breakeven,
    (COALESCE(sum(trade_log.realized_pnl), (0)::double precision))::numeric AS total_pnl,
    (COALESCE(sum(trade_log.realized_pnl) FILTER (WHERE (trade_log.outcome = 'win'::text)), (0)::double precision))::numeric AS gross_profit,
    (COALESCE(sum(abs(trade_log.realized_pnl)) FILTER (WHERE (trade_log.outcome = 'loss'::text)), (0)::double precision))::numeric AS gross_loss,
        CASE
            WHEN (count(*) > 0) THEN round(((count(*) FILTER (WHERE (trade_log.outcome = 'win'::text)))::numeric / (count(*))::numeric), 4)
            ELSE (0)::numeric
        END AS win_rate,
        CASE
            WHEN (COALESCE(sum(abs(trade_log.realized_pnl)) FILTER (WHERE (trade_log.outcome = 'loss'::text)), (0)::double precision) > (0)::double precision) THEN round(((COALESCE(sum(trade_log.realized_pnl) FILTER (WHERE (trade_log.outcome = 'win'::text)), (0)::double precision) / NULLIF(COALESCE(sum(abs(trade_log.realized_pnl)) FILTER (WHERE (trade_log.outcome = 'loss'::text)), (0)::double precision), (0)::double precision)))::numeric, 2)
            ELSE NULL::numeric
        END AS profit_factor,
    round((avg(trade_log.duration_seconds))::numeric, 0) AS avg_duration_seconds,
    round((avg(trade_log.slippage_bps))::numeric, 2) AS avg_slippage_bps
   FROM public.trade_log
  WHERE (trade_log.exit_time IS NOT NULL)
  GROUP BY trade_log.user_id, (date(trade_log.entry_time))
  ORDER BY (date(trade_log.entry_time)) DESC;

CREATE OR REPLACE VIEW public.ml_training_data
WITH (security_invoker = true) AS
 SELECT trade_outcomes.id,
    trade_outcomes.symbol,
    trade_outcomes.strategy,
    trade_outcomes.signal_direction,
    trade_outcomes.signal_strength,
    trade_outcomes.regime,
    trade_outcomes.regime_confidence,
        CASE trade_outcomes.trend_direction
            WHEN 'bullish'::text THEN 1
            WHEN 'bearish'::text THEN '-1'::integer
            ELSE 0
        END AS trend_direction_encoded,
    trade_outcomes.adx,
    trade_outcomes.atr_percent,
    trade_outcomes.bb_width,
    trade_outcomes.choppiness,
    trade_outcomes.mtf_alignment,
    trade_outcomes.volume_ratio,
    trade_outcomes.meta_filter_score,
    (trade_outcomes.cold_streak_active)::integer AS cold_streak_encoded,
    trade_outcomes.position_multiplier,
    ((trade_outcomes.indicators_snapshot ->> 'rsi'::text))::double precision AS rsi,
    ((trade_outcomes.indicators_snapshot ->> 'macd'::text))::double precision AS macd,
    ((trade_outcomes.indicators_snapshot ->> 'macd_signal'::text))::double precision AS macd_signal,
    ((trade_outcomes.indicators_snapshot ->> 'macd_histogram'::text))::double precision AS macd_histogram,
    ((trade_outcomes.indicators_snapshot ->> 'ema9'::text))::double precision AS ema9,
    ((trade_outcomes.indicators_snapshot ->> 'ema21'::text))::double precision AS ema21,
    ((trade_outcomes.indicators_snapshot ->> 'vwap'::text))::double precision AS vwap,
    ((trade_outcomes.indicators_snapshot ->> 'bb_upper'::text))::double precision AS bb_upper,
    ((trade_outcomes.indicators_snapshot ->> 'bb_lower'::text))::double precision AS bb_lower,
    trade_outcomes.outcome_label,
    trade_outcomes.outcome_score,
    trade_outcomes.r_multiple,
        CASE trade_outcomes.outcome_label
            WHEN 'profitable'::text THEN 1
            WHEN 'unprofitable'::text THEN 0
            ELSE NULL::integer
        END AS profitable_binary,
    trade_outcomes.entry_time,
    trade_outcomes.hold_duration_seconds,
    trade_outcomes.pnl_percent
   FROM public.trade_outcomes
  WHERE (trade_outcomes.outcome_label IS NOT NULL)
  ORDER BY trade_outcomes.entry_time DESC;

CREATE OR REPLACE VIEW public.strategy_regime_performance
WITH (security_invoker = true) AS
 SELECT trade_outcomes.strategy,
    trade_outcomes.regime,
    count(*) AS total_trades,
    count(*) FILTER (WHERE (trade_outcomes.outcome_label = 'profitable'::text)) AS wins,
    count(*) FILTER (WHERE (trade_outcomes.outcome_label = 'unprofitable'::text)) AS losses,
    round(((count(*) FILTER (WHERE (trade_outcomes.outcome_label = 'profitable'::text)))::numeric / (NULLIF(count(*), 0))::numeric), 4) AS win_rate,
    round((avg(trade_outcomes.pnl_percent))::numeric, 4) AS avg_pnl_percent,
    round((avg(trade_outcomes.r_multiple))::numeric, 2) AS avg_r_multiple,
    round((avg(trade_outcomes.signal_strength))::numeric, 3) AS avg_signal_strength,
    round((avg(trade_outcomes.meta_filter_score))::numeric, 3) AS avg_meta_score,
    round(avg(trade_outcomes.hold_duration_seconds), 0) AS avg_hold_seconds
   FROM public.trade_outcomes
  WHERE (trade_outcomes.outcome_label IS NOT NULL)
  GROUP BY trade_outcomes.strategy, trade_outcomes.regime
  ORDER BY trade_outcomes.strategy, trade_outcomes.regime;
