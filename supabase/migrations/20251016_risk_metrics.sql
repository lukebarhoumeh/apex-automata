-- Create risk_metrics table for storing risk calculations and metrics
CREATE TABLE IF NOT EXISTS public.risk_metrics (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    symbol TEXT NOT NULL,
    
    -- Position metrics
    position_size DECIMAL(20, 8),
    position_value_usd DECIMAL(20, 2),
    unrealized_pnl_usd DECIMAL(20, 2),
    realized_pnl_usd DECIMAL(20, 2),
    
    -- Risk metrics
    var_95 DECIMAL(20, 2), -- Value at Risk 95%
    sharpe_ratio DECIMAL(10, 4),
    max_drawdown_pct DECIMAL(10, 4),
    win_rate DECIMAL(10, 4),
    profit_factor DECIMAL(10, 4),
    
    -- Exposure metrics
    total_exposure_usd DECIMAL(20, 2),
    long_exposure_usd DECIMAL(20, 2),
    short_exposure_usd DECIMAL(20, 2),
    net_exposure_usd DECIMAL(20, 2),
    
    -- Performance metrics
    daily_pnl_usd DECIMAL(20, 2),
    daily_return_pct DECIMAL(10, 4),
    rolling_7d_return_pct DECIMAL(10, 4),
    rolling_30d_return_pct DECIMAL(10, 4),
    
    -- Risk limits
    position_limit_used_pct DECIMAL(10, 4),
    daily_loss_limit_used_pct DECIMAL(10, 4),
    exposure_limit_used_pct DECIMAL(10, 4),
    
    -- Metadata
    calculated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Create indexes (idempotent for preview branch re-application)
CREATE INDEX IF NOT EXISTS idx_risk_metrics_user_symbol ON public.risk_metrics(user_id, symbol);
CREATE INDEX IF NOT EXISTS idx_risk_metrics_calculated_at ON public.risk_metrics(calculated_at DESC);

-- Enable RLS
ALTER TABLE public.risk_metrics ENABLE ROW LEVEL SECURITY;

-- Create RLS policies (idempotent)
DROP POLICY IF EXISTS "Users can view own risk metrics" ON public.risk_metrics;
CREATE POLICY "Users can view own risk metrics" ON public.risk_metrics
    FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Service role can manage all risk metrics" ON public.risk_metrics;
CREATE POLICY "Service role can manage all risk metrics" ON public.risk_metrics
    FOR ALL USING (auth.jwt()->>'role' = 'service_role');

-- Create update trigger (idempotent)
DROP TRIGGER IF EXISTS update_risk_metrics_updated_at ON public.risk_metrics;
CREATE TRIGGER update_risk_metrics_updated_at
    BEFORE UPDATE ON public.risk_metrics
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Add comment
COMMENT ON TABLE public.risk_metrics IS 'Stores calculated risk metrics for positions and portfolios';
