-- Reconciliation file pulled from supabase_migrations.schema_migrations
-- (version 20251013051846, name (empty)) on 2026-05-14 via Supabase MCP.
-- Captures DDL applied directly to prod via dashboard/Lovable IDE.

-- Create user roles enum
CREATE TYPE public.app_role AS ENUM ('admin', 'moderator', 'user');

-- Create user profiles table
CREATE TABLE public.profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Create user roles table
CREATE TABLE public.user_roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role app_role NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, role)
);

-- Create bot state table
CREATE TABLE public.bot_states (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK (state IN ('paper', 'live', 'paused')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id)
);

-- Create risk settings table
CREATE TABLE public.risk_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  per_trade_risk DECIMAL(5,2) NOT NULL DEFAULT 0.7 CHECK (per_trade_risk >= 0.3 AND per_trade_risk <= 1.5),
  max_heat DECIMAL(5,2) NOT NULL DEFAULT 3.0 CHECK (max_heat >= 1.0 AND max_heat <= 5.0),
  daily_stop_r DECIMAL(5,2) NOT NULL DEFAULT 2.0 CHECK (daily_stop_r >= 1.0 AND daily_stop_r <= 5.0),
  kill_switch_enabled BOOLEAN NOT NULL DEFAULT true,
  spread_threshold INTEGER NOT NULL DEFAULT 98 CHECK (spread_threshold >= 90 AND spread_threshold <= 100),
  atr_burst_multiplier DECIMAL(3,1) NOT NULL DEFAULT 3.0 CHECK (atr_burst_multiplier >= 2.0 AND atr_burst_multiplier <= 5.0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id)
);

-- Create strategy signals table
CREATE TABLE public.strategy_signals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT true,
  params JSONB NOT NULL DEFAULT '{}',
  win_rate DECIMAL(5,2),
  avg_r DECIMAL(5,2),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, name)
);

-- Create positions table
CREATE TABLE public.positions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('long', 'short')),
  entry_price DECIMAL(12,2) NOT NULL,
  current_price DECIMAL(12,2) NOT NULL,
  size DECIMAL(12,4) NOT NULL,
  pnl DECIMAL(12,2) NOT NULL DEFAULT 0,
  pnl_r DECIMAL(6,2) NOT NULL DEFAULT 0,
  meta_prob DECIMAL(4,2),
  strategy TEXT NOT NULL,
  stop_loss DECIMAL(12,2) NOT NULL,
  take_profit DECIMAL(12,2) NOT NULL,
  risk_progress INTEGER NOT NULL DEFAULT 0 CHECK (risk_progress >= 0 AND risk_progress <= 100),
  time_opened TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  time_closed TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Create account metrics table
CREATE TABLE public.account_metrics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  total_equity DECIMAL(12,2) NOT NULL DEFAULT 0,
  daily_pnl DECIMAL(12,2) NOT NULL DEFAULT 0,
  daily_pnl_r DECIMAL(6,2) NOT NULL DEFAULT 0,
  risk_heat DECIMAL(5,2) NOT NULL DEFAULT 0,
  spread_percentile INTEGER NOT NULL DEFAULT 0,
  open_positions_count INTEGER NOT NULL DEFAULT 0,
  wins_today INTEGER NOT NULL DEFAULT 0,
  losses_today INTEGER NOT NULL DEFAULT 0,
  date DATE NOT NULL DEFAULT CURRENT_DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, date)
);

-- Enable RLS on all tables
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bot_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.risk_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.strategy_signals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.positions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.account_metrics ENABLE ROW LEVEL SECURITY;

-- Create security definer function to check roles
CREATE OR REPLACE FUNCTION public.has_role(_user_id UUID, _role app_role)
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.user_roles
    WHERE user_id = _user_id
      AND role = _role
  )
$$;

-- RLS Policies for profiles
CREATE POLICY "Users can view their own profile"
  ON public.profiles FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can update their own profile"
  ON public.profiles FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own profile"
  ON public.profiles FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- RLS Policies for user_roles
CREATE POLICY "Users can view their own roles"
  ON public.user_roles FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Admins can manage all roles"
  ON public.user_roles FOR ALL
  USING (public.has_role(auth.uid(), 'admin'));

-- RLS Policies for bot_states
CREATE POLICY "Users can view their own bot state"
  ON public.bot_states FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can update their own bot state"
  ON public.bot_states FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own bot state"
  ON public.bot_states FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- RLS Policies for risk_settings
CREATE POLICY "Users can view their own risk settings"
  ON public.risk_settings FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can update their own risk settings"
  ON public.risk_settings FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own risk settings"
  ON public.risk_settings FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- RLS Policies for strategy_signals
CREATE POLICY "Users can view their own strategy signals"
  ON public.strategy_signals FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can manage their own strategy signals"
  ON public.strategy_signals FOR ALL
  USING (auth.uid() = user_id);

-- RLS Policies for positions
CREATE POLICY "Users can view their own positions"
  ON public.positions FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can manage their own positions"
  ON public.positions FOR ALL
  USING (auth.uid() = user_id);

-- RLS Policies for account_metrics
CREATE POLICY "Users can view their own metrics"
  ON public.account_metrics FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can manage their own metrics"
  ON public.account_metrics FOR ALL
  USING (auth.uid() = user_id);

-- Create updated_at trigger function
CREATE OR REPLACE FUNCTION public.handle_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

-- Add updated_at triggers to all tables
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.bot_states
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.risk_settings
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.strategy_signals
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.positions
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.account_metrics
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

-- Create function to handle new user signup
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Create profile
  INSERT INTO public.profiles (user_id, display_name)
  VALUES (NEW.id, NEW.raw_user_meta_data->>'display_name');
  
  -- Assign default user role
  INSERT INTO public.user_roles (user_id, role)
  VALUES (NEW.id, 'user');
  
  -- Create default bot state
  INSERT INTO public.bot_states (user_id, state)
  VALUES (NEW.id, 'paper');
  
  -- Create default risk settings
  INSERT INTO public.risk_settings (user_id)
  VALUES (NEW.id);
  
  -- Create default account metrics
  INSERT INTO public.account_metrics (user_id)
  VALUES (NEW.id);
  
  RETURN NEW;
END;
$$;

-- Create trigger for new user signup
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- Create indexes for better performance
CREATE INDEX idx_positions_user_id_status ON public.positions(user_id, status);
CREATE INDEX idx_positions_time_opened ON public.positions(time_opened DESC);
CREATE INDEX idx_account_metrics_user_date ON public.account_metrics(user_id, date DESC);
CREATE INDEX idx_strategy_signals_user_enabled ON public.strategy_signals(user_id, enabled);