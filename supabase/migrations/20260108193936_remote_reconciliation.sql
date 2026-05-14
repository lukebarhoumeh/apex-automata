-- Reconciliation file pulled from supabase_migrations.schema_migrations
-- (version 20260108193936, name (empty)) on 2026-05-14 via Supabase MCP.
-- Captures DDL applied directly to prod via dashboard/Lovable IDE.

-- Create exchange_credentials table
CREATE TABLE IF NOT EXISTS public.exchange_credentials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  exchange TEXT NOT NULL,
  environment TEXT NOT NULL DEFAULT 'production',
  api_key_encrypted TEXT,
  api_secret_encrypted TEXT,
  api_passphrase_encrypted TEXT,
  api_key_iv TEXT,
  api_key_tag TEXT,
  api_secret_iv TEXT,
  api_secret_tag TEXT,
  api_passphrase_iv TEXT,
  api_passphrase_tag TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, exchange, environment)
);

ALTER TABLE public.exchange_credentials ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow individual read access" ON public.exchange_credentials FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Allow individual insert access" ON public.exchange_credentials FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Allow individual update access" ON public.exchange_credentials FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Allow individual delete access" ON public.exchange_credentials FOR DELETE USING (auth.uid() = user_id);

-- Create trading_sessions table
CREATE TABLE IF NOT EXISTS public.trading_sessions (
  session_id TEXT PRIMARY KEY,
  user_id UUID NOT NULL,
  mode TEXT NOT NULL,
  started_at TIMESTAMPTZ DEFAULT NOW(),
  ended_at TIMESTAMPTZ,
  initial_equity NUMERIC,
  final_equity NUMERIC,
  total_trades INTEGER DEFAULT 0,
  total_pnl NUMERIC DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.trading_sessions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow individual read access" ON public.trading_sessions FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Allow individual insert access" ON public.trading_sessions FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Allow individual update access" ON public.trading_sessions FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Allow individual delete access" ON public.trading_sessions FOR DELETE USING (auth.uid() = user_id);