-- Reconciliation file pulled from supabase_migrations.schema_migrations
-- (version 20251212155123, name (empty)) on 2026-05-14 via Supabase MCP.
-- Captures DDL applied directly to prod via dashboard/Lovable IDE.

-- Create risk_metrics table for tracking runtime risk state
CREATE TABLE IF NOT EXISTS public.risk_metrics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  daily_pnl NUMERIC DEFAULT 0,
  max_drawdown NUMERIC DEFAULT 0,
  consecutive_losses INTEGER DEFAULT 0,
  error_rate NUMERIC DEFAULT 0,
  kill_switch_active BOOLEAN DEFAULT false,
  exposure_usd NUMERIC DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Enable RLS
ALTER TABLE public.risk_metrics ENABLE ROW LEVEL SECURITY;

-- Allow all access for single-user MVP
CREATE POLICY "Allow all access to risk_metrics" ON public.risk_metrics
  FOR ALL USING (true) WITH CHECK (true);

-- Add to realtime publication
ALTER PUBLICATION supabase_realtime ADD TABLE public.risk_metrics;

-- Create index for user lookups
CREATE INDEX idx_risk_metrics_user_id ON public.risk_metrics(user_id);

-- Create daily_equity table for tracking equity over time
CREATE TABLE IF NOT EXISTS public.daily_equity (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  date DATE NOT NULL,
  start_equity NUMERIC NOT NULL,
  end_equity NUMERIC,
  daily_pnl NUMERIC DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, date)
);

-- Enable RLS
ALTER TABLE public.daily_equity ENABLE ROW LEVEL SECURITY;

-- Allow all access for single-user MVP
CREATE POLICY "Allow all access to daily_equity" ON public.daily_equity
  FOR ALL USING (true) WITH CHECK (true);

-- Add to realtime publication
ALTER PUBLICATION supabase_realtime ADD TABLE public.daily_equity;

-- Create index for user/date lookups
CREATE INDEX idx_daily_equity_user_date ON public.daily_equity(user_id, date);