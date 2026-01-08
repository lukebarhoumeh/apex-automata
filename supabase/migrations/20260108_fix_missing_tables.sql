-- Fix missing tables migration
-- This migration ensures all required tables exist

-- Create trading_sessions table (was missing)
CREATE TABLE IF NOT EXISTS public.trading_sessions (
    session_id TEXT PRIMARY KEY,
    user_id UUID NOT NULL DEFAULT 'b7e8f9c2-4d6a-4c8b-9e2d-1a3b5c7d9e1f'::uuid,
    mode TEXT NOT NULL CHECK (mode IN ('paper', 'live')),
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ended_at TIMESTAMPTZ,
    initial_equity NUMERIC DEFAULT 0,
    final_equity NUMERIC,
    total_trades INTEGER DEFAULT 0,
    winning_trades INTEGER DEFAULT 0,
    losing_trades INTEGER DEFAULT 0,
    total_pnl NUMERIC DEFAULT 0,
    gross_profit NUMERIC DEFAULT 0,
    gross_loss NUMERIC DEFAULT 0,
    max_drawdown NUMERIC DEFAULT 0,
    sharpe_estimate NUMERIC,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Create exchange_credentials table if it doesn't exist
-- Using simpler schema that matches what the backend expects
CREATE TABLE IF NOT EXISTS public.exchange_credentials (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID NOT NULL DEFAULT 'b7e8f9c2-4d6a-4c8b-9e2d-1a3b5c7d9e1f'::uuid,
    exchange TEXT NOT NULL,
    environment TEXT NOT NULL DEFAULT 'production' CHECK (environment IN ('production', 'sandbox')),
    
    -- Encrypted API credentials
    api_key_encrypted TEXT,
    api_key_iv TEXT,
    api_key_tag TEXT,
    
    api_secret_encrypted TEXT,
    api_secret_iv TEXT,
    api_secret_tag TEXT,
    
    -- Optional passphrase
    api_passphrase_encrypted TEXT,
    api_passphrase_iv TEXT,
    api_passphrase_tag TEXT,
    
    -- Metadata
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    
    -- Ensure only one set of credentials per user/exchange/environment
    UNIQUE(user_id, exchange, environment)
);

-- Add indexes for trading_sessions
CREATE INDEX IF NOT EXISTS idx_trading_sessions_user_id ON public.trading_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_trading_sessions_mode ON public.trading_sessions(mode);
CREATE INDEX IF NOT EXISTS idx_trading_sessions_started_at ON public.trading_sessions(started_at);

-- Add indexes for exchange_credentials
CREATE INDEX IF NOT EXISTS idx_exchange_credentials_user_id ON public.exchange_credentials(user_id);
CREATE INDEX IF NOT EXISTS idx_exchange_credentials_exchange ON public.exchange_credentials(exchange);

-- Enable RLS on new tables
ALTER TABLE public.trading_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.exchange_credentials ENABLE ROW LEVEL SECURITY;

-- Drop existing policies if they exist (to avoid conflicts)
DROP POLICY IF EXISTS "Allow all for fixed user trading_sessions" ON public.trading_sessions;
DROP POLICY IF EXISTS "Allow all for fixed user exchange_credentials" ON public.exchange_credentials;

-- Create RLS policies for fixed user mode (single-user trading bot)
CREATE POLICY "Allow all for fixed user trading_sessions" ON public.trading_sessions
    FOR ALL USING (user_id = 'b7e8f9c2-4d6a-4c8b-9e2d-1a3b5c7d9e1f'::uuid);

CREATE POLICY "Allow all for fixed user exchange_credentials" ON public.exchange_credentials
    FOR ALL USING (user_id = 'b7e8f9c2-4d6a-4c8b-9e2d-1a3b5c7d9e1f'::uuid);

-- Create updated_at trigger function if not exists
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create updated_at triggers
DROP TRIGGER IF EXISTS update_trading_sessions_updated_at ON public.trading_sessions;
CREATE TRIGGER update_trading_sessions_updated_at
    BEFORE UPDATE ON public.trading_sessions
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_exchange_credentials_updated_at ON public.exchange_credentials;
CREATE TRIGGER update_exchange_credentials_updated_at
    BEFORE UPDATE ON public.exchange_credentials
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Add user_id column to risk_metrics if missing (for multi-user support)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'risk_metrics' AND column_name = 'user_id'
    ) THEN
        ALTER TABLE public.risk_metrics 
        ADD COLUMN user_id UUID DEFAULT 'b7e8f9c2-4d6a-4c8b-9e2d-1a3b5c7d9e1f'::uuid;
    END IF;
END $$;

-- Add exposure_usd column to risk_metrics if missing
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'risk_metrics' AND column_name = 'exposure_usd'
    ) THEN
        ALTER TABLE public.risk_metrics 
        ADD COLUMN exposure_usd NUMERIC DEFAULT 0;
    END IF;
END $$;
