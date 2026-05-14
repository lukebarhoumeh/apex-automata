-- Fix trading tables to match the actual schema and backend expectations

-- 1. Update positions table to match the real schema
-- The UI-created positions table has different structure than backend expects
-- We need to reconcile these differences

-- First check if user_id column exists, if not add it
DO $$ 
BEGIN
    IF NOT EXISTS (
        SELECT 1 
        FROM information_schema.columns 
        WHERE table_schema = 'public' 
        AND table_name = 'positions' 
        AND column_name = 'user_id'
    ) THEN
        ALTER TABLE public.positions ADD COLUMN user_id UUID NOT NULL DEFAULT 'b7e8f9c2-4d6a-4c8b-9e2d-1a3b5c7d9e1f'::uuid;
        ALTER TABLE public.positions ADD CONSTRAINT positions_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id);
    END IF;
END $$;

-- 2. Ensure fills table exists (it's in the real schema but not in backend migrations)
-- The table already exists in your schema, so we just need to ensure it's there
-- This is a no-op if it already exists

-- 3. Create the upsert_account_metrics function
CREATE OR REPLACE FUNCTION public.upsert_account_metrics(p_user_id UUID)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_total_equity NUMERIC;
    v_daily_pnl NUMERIC;
    v_open_positions INTEGER;
    v_wins_today INTEGER;
    v_losses_today INTEGER;
BEGIN
    -- Calculate total equity from positions
    SELECT 
        COALESCE(SUM(
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

    -- Calculate daily P&L
    SELECT 
        COALESCE(SUM(realized_pnl_usd), 0) INTO v_daily_pnl
    FROM positions
    WHERE user_id = p_user_id
    AND DATE(COALESCE(closed_at, opened_at)) = CURRENT_DATE;

    -- Count open positions
    SELECT COUNT(*) INTO v_open_positions
    FROM positions
    WHERE user_id = p_user_id
    AND closed_at IS NULL
    AND qty_open > 0;

    -- Count wins/losses today
    SELECT 
        COUNT(*) FILTER (WHERE realized_pnl_usd > 0) AS wins,
        COUNT(*) FILTER (WHERE realized_pnl_usd < 0) AS losses
    INTO v_wins_today, v_losses_today
    FROM positions
    WHERE user_id = p_user_id
    AND closed_at IS NOT NULL
    AND DATE(closed_at) = CURRENT_DATE;

    -- Upsert the metrics
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
        losses_today
    )
    VALUES (
        p_user_id,
        CURRENT_DATE,
        COALESCE(v_total_equity, 0),
        COALESCE(v_daily_pnl, 0),
        0, -- daily_pnl_r calculated separately
        0, -- risk_heat calculated by risk engine
        0, -- spread_percentile from market data
        COALESCE(v_open_positions, 0),
        COALESCE(v_wins_today, 0),
        COALESCE(v_losses_today, 0)
    )
    ON CONFLICT (user_id, date) DO UPDATE
    SET 
        total_equity = EXCLUDED.total_equity,
        daily_pnl = EXCLUDED.daily_pnl,
        open_positions_count = EXCLUDED.open_positions_count,
        wins_today = EXCLUDED.wins_today,
        losses_today = EXCLUDED.losses_today,
        updated_at = NOW();
END;
$$;

-- 4. Add unique constraint on account_metrics if it doesn't exist
DO $$ 
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'account_metrics_user_id_date_key'
    ) THEN
        ALTER TABLE public.account_metrics 
        ADD CONSTRAINT account_metrics_user_id_date_key 
        UNIQUE (user_id, date);
    END IF;
END $$;

-- 5. Ensure RLS policies exist for all tables
-- These might already exist, but let's ensure they're there

-- For account_metrics
DO $$ 
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies 
        WHERE tablename = 'account_metrics' 
        AND policyname = 'Users can view own metrics'
    ) THEN
        CREATE POLICY "Users can view own metrics" ON public.account_metrics
            FOR SELECT USING (auth.uid() = user_id);
    END IF;
END $$;

-- 6. Grant necessary permissions
GRANT EXECUTE ON FUNCTION public.upsert_account_metrics(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.upsert_account_metrics(UUID) TO authenticated;

-- 7. Add indexes for performance
CREATE INDEX IF NOT EXISTS idx_positions_user_id ON public.positions(user_id);
CREATE INDEX IF NOT EXISTS idx_positions_closed_at ON public.positions(closed_at);
CREATE INDEX IF NOT EXISTS idx_account_metrics_user_date ON public.account_metrics(user_id, date);
