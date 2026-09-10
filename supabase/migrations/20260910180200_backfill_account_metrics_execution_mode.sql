-- Stamp account_metrics rows with session_id + execution_mode and backfill
-- NULLs on account_metrics / trading_sessions.
--
-- Verified on prod 2026-09-10 (read-only):
--   * account_metrics.execution_mode  54/54 rows NULL, session_id 54/54 NULL
--   * trading_sessions.execution_mode 38/38 rows NULL (mode is NOT NULL,
--     CHECK IN ('paper','live'))
--   * live upsert_account_metrics body == 20251016000000_fix_trading_tables.sql
--     (equity = open-position notional; daily_pnl_r / risk_heat written as 0).
--     The body below is that live body plus session_id / execution_mode.
--     NOTE: repo file 20260303183623 describes a different body (50k base +
--     all-time realized PnL) that is NOT what is live; see handoff doc risk #4.
--
-- Column guards are idempotent no-ops on prod (columns already exist via
-- 20260203000002_step8_pnl_columns.sql); kept so the file is self-contained.
-- Handoff: Database Engineer, 2026-09-10 (see docs/db/HANDOFF_2026-09-10.md).

ALTER TABLE public.trading_sessions ADD COLUMN IF NOT EXISTS execution_mode text;
ALTER TABLE public.account_metrics ADD COLUMN IF NOT EXISTS execution_mode text;
ALTER TABLE public.account_metrics ADD COLUMN IF NOT EXISTS session_id text;

CREATE OR REPLACE FUNCTION public.upsert_account_metrics(p_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
    v_total_equity NUMERIC;
    v_daily_pnl NUMERIC;
    v_open_positions INTEGER;
    v_wins_today INTEGER;
    v_losses_today INTEGER;
    v_session_id text;
    v_execution_mode text;
BEGIN
    SELECT ts.session_id,
           COALESCE(ts.execution_mode, ts.mode, 'paper')
      INTO v_session_id, v_execution_mode
    FROM public.trading_sessions ts
    WHERE ts.user_id = p_user_id
    ORDER BY (ts.ended_at IS NULL) DESC, ts.started_at DESC NULLS LAST
    LIMIT 1;

    IF v_execution_mode IS NULL THEN
        v_execution_mode := 'paper';
    END IF;

    SELECT COALESCE(SUM(
            CASE
                WHEN p.closed_at IS NULL THEN
                    p.qty_open * COALESCE(latest_price.price, p.entry_price)
                ELSE 0
            END
        ), 0) INTO v_total_equity
    FROM positions p
    LEFT JOIN LATERAL (
        SELECT price
        FROM orders o
        WHERE o.symbol = p.symbol
          AND o.status = 'filled'
        ORDER BY o.updated_at DESC
        LIMIT 1
    ) latest_price ON true
    WHERE p.user_id = p_user_id;

    SELECT COALESCE(SUM(realized_pnl_usd), 0) INTO v_daily_pnl
    FROM positions
    WHERE user_id = p_user_id
      AND DATE(COALESCE(closed_at, opened_at)) = CURRENT_DATE;

    SELECT COUNT(*) INTO v_open_positions
    FROM positions
    WHERE user_id = p_user_id
      AND closed_at IS NULL
      AND qty_open > 0;

    SELECT
        COUNT(*) FILTER (WHERE realized_pnl_usd > 0),
        COUNT(*) FILTER (WHERE realized_pnl_usd < 0)
    INTO v_wins_today, v_losses_today
    FROM positions
    WHERE user_id = p_user_id
      AND closed_at IS NOT NULL
      AND DATE(closed_at) = CURRENT_DATE;

    INSERT INTO account_metrics (
        user_id, date, total_equity, daily_pnl, daily_pnl_r, risk_heat, spread_percentile,
        open_positions_count, wins_today, losses_today, session_id, execution_mode
    )
    VALUES (
        p_user_id, CURRENT_DATE, COALESCE(v_total_equity, 0), COALESCE(v_daily_pnl, 0),
        0, 0, 0, COALESCE(v_open_positions, 0), COALESCE(v_wins_today, 0), COALESCE(v_losses_today, 0),
        v_session_id, v_execution_mode
    )
    ON CONFLICT (user_id, date) DO UPDATE
    SET
        total_equity = EXCLUDED.total_equity,
        daily_pnl = EXCLUDED.daily_pnl,
        open_positions_count = EXCLUDED.open_positions_count,
        wins_today = EXCLUDED.wins_today,
        losses_today = EXCLUDED.losses_today,
        session_id = COALESCE(EXCLUDED.session_id, account_metrics.session_id),
        execution_mode = COALESCE(EXCLUDED.execution_mode, account_metrics.execution_mode, 'paper'),
        updated_at = NOW();
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.upsert_account_metrics(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.upsert_account_metrics(uuid) TO authenticated, service_role;

UPDATE public.trading_sessions
SET execution_mode = COALESCE(execution_mode, NULLIF(mode, ''), 'paper'),
    updated_at = COALESCE(updated_at, now())
WHERE execution_mode IS NULL;

UPDATE public.account_metrics am
SET
  session_id = COALESCE(am.session_id, s.session_id),
  execution_mode = COALESCE(am.execution_mode, s.execution_mode, s.mode, 'paper'),
  updated_at = now()
FROM (
  SELECT DISTINCT ON (ts.user_id, DATE(ts.started_at))
    ts.user_id, DATE(ts.started_at) AS session_day, ts.session_id, ts.execution_mode, ts.mode
  FROM public.trading_sessions ts
  ORDER BY ts.user_id, DATE(ts.started_at), (ts.ended_at IS NULL) DESC, ts.started_at DESC
) s
WHERE am.user_id = s.user_id
  AND am.date = s.session_day
  AND (am.execution_mode IS NULL OR am.session_id IS NULL);

UPDATE public.account_metrics
SET execution_mode = 'paper', updated_at = now()
WHERE execution_mode IS NULL;
