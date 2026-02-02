-- ============================================================================
-- ML Trade Outcomes Table
-- Captures complete signal context and trade results for Meta-Label training
-- ============================================================================

-- Trade outcomes table: stores all context needed to train ML signal filter
CREATE TABLE IF NOT EXISTS trade_outcomes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  
  -- Signal identification
  signal_id TEXT NOT NULL,
  session_id TEXT,
  
  -- Symbol and timing
  symbol TEXT NOT NULL,
  entry_time TIMESTAMPTZ NOT NULL,
  exit_time TIMESTAMPTZ,
  hold_duration_seconds INTEGER,
  
  -- Strategy info
  strategy TEXT NOT NULL,
  signal_direction TEXT NOT NULL CHECK (signal_direction IN ('buy', 'sell')),
  signal_strength DOUBLE PRECISION NOT NULL,
  
  -- Entry context (what the model will use as features)
  entry_price DOUBLE PRECISION NOT NULL,
  
  -- Market regime at signal time
  regime TEXT NOT NULL,
  regime_confidence DOUBLE PRECISION,
  trend_direction TEXT,
  adx DOUBLE PRECISION,
  atr_percent DOUBLE PRECISION,
  bb_width DOUBLE PRECISION,
  choppiness DOUBLE PRECISION,
  mtf_alignment DOUBLE PRECISION,
  
  -- Indicators at signal time (stored as JSONB for flexibility)
  indicators_snapshot JSONB NOT NULL DEFAULT '{}',
  
  -- Volume context
  volume_ratio DOUBLE PRECISION,
  
  -- Meta filter score at entry
  meta_filter_score DOUBLE PRECISION,
  cold_streak_active BOOLEAN DEFAULT FALSE,
  
  -- Position sizing used
  position_multiplier DOUBLE PRECISION,
  position_size DOUBLE PRECISION,
  
  -- Exit info
  exit_price DOUBLE PRECISION,
  exit_reason TEXT,  -- 'stop_loss', 'take_profit', 'trailing_stop', 'time_stop', 'manual', 'signal_reversal'
  
  -- Trade result (what the model will predict)
  realized_pnl DOUBLE PRECISION,
  pnl_percent DOUBLE PRECISION,
  
  -- Risk metrics during trade
  max_favorable_excursion DOUBLE PRECISION,  -- Best unrealized P&L
  max_adverse_excursion DOUBLE PRECISION,    -- Worst unrealized P&L
  
  -- Binary label for classification (did this trade make money?)
  -- NULL until trade is closed
  outcome_label TEXT CHECK (outcome_label IN ('profitable', 'unprofitable', 'breakeven')),
  
  -- Continuous target for regression (scaled P&L)
  outcome_score DOUBLE PRECISION,  -- e.g., pnl_percent clamped to [-1, 1]
  
  -- R-multiple (risk-adjusted return)
  r_multiple DOUBLE PRECISION,  -- realized_pnl / initial_risk
  initial_risk DOUBLE PRECISION,  -- stop distance * size
  
  -- Execution quality
  slippage_bps DOUBLE PRECISION,
  fees DOUBLE PRECISION,
  
  -- Raw signal metadata (full context)
  signal_metadata JSONB DEFAULT '{}',
  
  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for common queries and ML export
CREATE INDEX IF NOT EXISTS idx_outcomes_symbol ON trade_outcomes(symbol);
CREATE INDEX IF NOT EXISTS idx_outcomes_strategy ON trade_outcomes(strategy);
CREATE INDEX IF NOT EXISTS idx_outcomes_regime ON trade_outcomes(regime);
CREATE INDEX IF NOT EXISTS idx_outcomes_entry_time ON trade_outcomes(entry_time DESC);
CREATE INDEX IF NOT EXISTS idx_outcomes_outcome ON trade_outcomes(outcome_label) WHERE outcome_label IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_outcomes_signal_id ON trade_outcomes(signal_id);

-- Composite index for ML training queries (filter by strategy, get labeled outcomes)
CREATE INDEX IF NOT EXISTS idx_outcomes_ml_training 
  ON trade_outcomes(strategy, outcome_label, entry_time) 
  WHERE outcome_label IS NOT NULL;

-- Enable Row Level Security
ALTER TABLE trade_outcomes ENABLE ROW LEVEL SECURITY;

-- Service role bypass for backend operations
DROP POLICY IF EXISTS trade_outcomes_service_policy ON trade_outcomes;
CREATE POLICY trade_outcomes_service_policy ON trade_outcomes
  FOR ALL TO service_role USING (true);

-- Trigger to update updated_at
CREATE OR REPLACE FUNCTION update_trade_outcomes_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS update_trade_outcomes_timestamp ON trade_outcomes;
CREATE TRIGGER update_trade_outcomes_timestamp
  BEFORE UPDATE ON trade_outcomes
  FOR EACH ROW
  EXECUTE FUNCTION update_trade_outcomes_updated_at();

-- ============================================================================
-- ML Training Export View
-- Pre-formats data for ML training pipeline
-- ============================================================================

CREATE OR REPLACE VIEW ml_training_data AS
SELECT 
  id,
  symbol,
  strategy,
  signal_direction,
  signal_strength,
  
  -- Regime features
  regime,
  regime_confidence,
  CASE trend_direction 
    WHEN 'bullish' THEN 1 
    WHEN 'bearish' THEN -1 
    ELSE 0 
  END as trend_direction_encoded,
  adx,
  atr_percent,
  bb_width,
  choppiness,
  mtf_alignment,
  
  -- Volume features
  volume_ratio,
  
  -- Meta filter features
  meta_filter_score,
  cold_streak_active::INTEGER as cold_streak_encoded,
  position_multiplier,
  
  -- Indicator snapshots (extract common ones)
  (indicators_snapshot->>'rsi')::DOUBLE PRECISION as rsi,
  (indicators_snapshot->>'macd')::DOUBLE PRECISION as macd,
  (indicators_snapshot->>'macd_signal')::DOUBLE PRECISION as macd_signal,
  (indicators_snapshot->>'macd_histogram')::DOUBLE PRECISION as macd_histogram,
  (indicators_snapshot->>'ema9')::DOUBLE PRECISION as ema9,
  (indicators_snapshot->>'ema21')::DOUBLE PRECISION as ema21,
  (indicators_snapshot->>'vwap')::DOUBLE PRECISION as vwap,
  (indicators_snapshot->>'bb_upper')::DOUBLE PRECISION as bb_upper,
  (indicators_snapshot->>'bb_lower')::DOUBLE PRECISION as bb_lower,
  
  -- Labels
  outcome_label,
  outcome_score,
  r_multiple,
  
  -- Binary target (for classification)
  CASE outcome_label
    WHEN 'profitable' THEN 1
    WHEN 'unprofitable' THEN 0
    ELSE NULL
  END as profitable_binary,
  
  -- Metadata
  entry_time,
  hold_duration_seconds,
  pnl_percent
  
FROM trade_outcomes
WHERE outcome_label IS NOT NULL
ORDER BY entry_time DESC;

COMMENT ON TABLE trade_outcomes IS 'Complete trade context and outcomes for ML Meta-Label training';
COMMENT ON VIEW ml_training_data IS 'Pre-formatted view for exporting ML training data';

-- ============================================================================
-- Strategy Performance Aggregation View
-- Helps identify which strategies work best in which regimes
-- ============================================================================

CREATE OR REPLACE VIEW strategy_regime_performance AS
SELECT 
  strategy,
  regime,
  COUNT(*) as total_trades,
  COUNT(*) FILTER (WHERE outcome_label = 'profitable') as wins,
  COUNT(*) FILTER (WHERE outcome_label = 'unprofitable') as losses,
  ROUND(
    COUNT(*) FILTER (WHERE outcome_label = 'profitable')::NUMERIC / 
    NULLIF(COUNT(*), 0)::NUMERIC, 
    4
  ) as win_rate,
  ROUND(AVG(pnl_percent)::NUMERIC, 4) as avg_pnl_percent,
  ROUND(AVG(r_multiple)::NUMERIC, 2) as avg_r_multiple,
  ROUND(AVG(signal_strength)::NUMERIC, 3) as avg_signal_strength,
  ROUND(AVG(meta_filter_score)::NUMERIC, 3) as avg_meta_score,
  ROUND(AVG(hold_duration_seconds)::NUMERIC, 0) as avg_hold_seconds
FROM trade_outcomes
WHERE outcome_label IS NOT NULL
GROUP BY strategy, regime
ORDER BY strategy, regime;

COMMENT ON VIEW strategy_regime_performance IS 'Aggregated strategy performance by market regime for analysis';
