-- Meta Filter Decision Logs for ML Training Data
-- This table stores every filter decision for later analysis and ML model training

CREATE TABLE IF NOT EXISTS public.meta_filter_decisions (
    id TEXT PRIMARY KEY,
    timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    user_id UUID NOT NULL,
    
    -- Signal info
    signal_id TEXT NOT NULL,
    symbol TEXT NOT NULL,
    strategy TEXT NOT NULL,
    direction TEXT NOT NULL CHECK (direction IN ('buy', 'sell')),
    signal_strength DECIMAL(10, 6) NOT NULL,
    
    -- Context at decision time
    volume_ratio DECIMAL(10, 6),
    regime TEXT,
    hour_of_day INTEGER NOT NULL CHECK (hour_of_day >= 0 AND hour_of_day <= 23),
    day_of_week INTEGER NOT NULL CHECK (day_of_week >= 0 AND day_of_week <= 6),
    
    -- Decision result
    passed BOOLEAN NOT NULL,
    meta_score DECIMAL(10, 6) NOT NULL,
    rules_evaluated JSONB NOT NULL DEFAULT '[]'::jsonb,
    
    -- Outcome (populated later when trade completes)
    outcome TEXT CHECK (outcome IN ('win', 'loss', 'breakeven', NULL)),
    pnl DECIMAL(18, 8),
    
    -- Timestamps
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_mf_decisions_user_id ON public.meta_filter_decisions(user_id);
CREATE INDEX IF NOT EXISTS idx_mf_decisions_timestamp ON public.meta_filter_decisions(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_mf_decisions_strategy ON public.meta_filter_decisions(strategy);
CREATE INDEX IF NOT EXISTS idx_mf_decisions_passed ON public.meta_filter_decisions(passed);
CREATE INDEX IF NOT EXISTS idx_mf_decisions_outcome ON public.meta_filter_decisions(outcome) WHERE outcome IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_mf_decisions_signal_id ON public.meta_filter_decisions(signal_id);

-- Composite index for ML training data queries
CREATE INDEX IF NOT EXISTS idx_mf_decisions_ml_training 
    ON public.meta_filter_decisions(strategy, passed, outcome) 
    WHERE outcome IS NOT NULL;

-- Enable RLS
ALTER TABLE public.meta_filter_decisions ENABLE ROW LEVEL SECURITY;

-- RLS Policy for user isolation
CREATE POLICY "Users can only access their own decisions"
    ON public.meta_filter_decisions FOR ALL
    USING (auth.uid() = user_id);

-- Function to update outcome after trade completes
CREATE OR REPLACE FUNCTION update_filter_decision_outcome(
    p_signal_id TEXT,
    p_outcome TEXT,
    p_pnl DECIMAL
)
RETURNS void AS $$
BEGIN
    UPDATE public.meta_filter_decisions
    SET 
        outcome = p_outcome,
        pnl = p_pnl,
        updated_at = NOW()
    WHERE signal_id = p_signal_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- View for ML training data export
CREATE OR REPLACE VIEW public.ml_filter_training_data AS
SELECT 
    id,
    timestamp,
    symbol,
    strategy,
    direction,
    signal_strength,
    volume_ratio,
    regime,
    hour_of_day,
    day_of_week,
    passed,
    meta_score,
    rules_evaluated,
    outcome,
    pnl,
    -- Label: was the filter decision correct?
    CASE 
        WHEN passed AND outcome = 'win' THEN 1  -- Correctly passed
        WHEN passed AND outcome = 'loss' THEN 0  -- Incorrectly passed (should have blocked)
        WHEN NOT passed AND outcome = 'win' THEN 0  -- Incorrectly blocked (missed opportunity)
        WHEN NOT passed AND outcome = 'loss' THEN 1  -- Correctly blocked
        ELSE NULL
    END AS decision_correct
FROM public.meta_filter_decisions
WHERE outcome IS NOT NULL;

-- View for strategy performance analysis
CREATE OR REPLACE VIEW public.strategy_filter_analysis AS
SELECT 
    strategy,
    COUNT(*) as total_decisions,
    SUM(CASE WHEN passed THEN 1 ELSE 0 END) as signals_passed,
    SUM(CASE WHEN NOT passed THEN 1 ELSE 0 END) as signals_blocked,
    AVG(meta_score) as avg_meta_score,
    
    -- Passed trades analysis
    SUM(CASE WHEN passed AND outcome = 'win' THEN 1 ELSE 0 END) as passed_wins,
    SUM(CASE WHEN passed AND outcome = 'loss' THEN 1 ELSE 0 END) as passed_losses,
    
    -- Blocked trades analysis (what would have happened)
    SUM(CASE WHEN NOT passed AND outcome = 'win' THEN 1 ELSE 0 END) as blocked_would_win,
    SUM(CASE WHEN NOT passed AND outcome = 'loss' THEN 1 ELSE 0 END) as blocked_would_lose,
    
    -- Win rate of passed trades
    CASE 
        WHEN SUM(CASE WHEN passed AND outcome IS NOT NULL THEN 1 ELSE 0 END) > 0
        THEN SUM(CASE WHEN passed AND outcome = 'win' THEN 1 ELSE 0 END)::DECIMAL / 
             SUM(CASE WHEN passed AND outcome IS NOT NULL THEN 1 ELSE 0 END)
        ELSE NULL
    END as passed_win_rate,
    
    -- Value of blocked trades (negative = good filtering)
    SUM(CASE WHEN NOT passed THEN pnl ELSE 0 END) as blocked_pnl,
    
    -- Hourly breakdown
    jsonb_object_agg(
        hour_of_day::TEXT,
        jsonb_build_object(
            'total', COUNT(*),
            'passed', SUM(CASE WHEN passed THEN 1 ELSE 0 END),
            'wins', SUM(CASE WHEN outcome = 'win' THEN 1 ELSE 0 END)
        )
    ) FILTER (WHERE hour_of_day IS NOT NULL) as hourly_stats
FROM public.meta_filter_decisions
GROUP BY strategy;

-- Comments
COMMENT ON TABLE public.meta_filter_decisions IS 'Stores all meta-filter decisions for ML training and analysis';
COMMENT ON COLUMN public.meta_filter_decisions.rules_evaluated IS 'JSON array of rule evaluations: [{rule, passed, reason, weight}]';
COMMENT ON VIEW public.ml_filter_training_data IS 'Training data view for ML meta-labeling model';

