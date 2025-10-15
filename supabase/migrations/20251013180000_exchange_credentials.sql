-- Create exchange_credentials table for secure API key storage
CREATE TABLE IF NOT EXISTS public.exchange_credentials (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    exchange TEXT NOT NULL,
    environment TEXT NOT NULL CHECK (environment IN ('production', 'sandbox')),
    
    -- Encrypted API credentials
    api_key_encrypted TEXT NOT NULL,
    api_key_iv TEXT NOT NULL,
    api_key_tag TEXT NOT NULL,
    
    api_secret_encrypted TEXT NOT NULL,
    api_secret_iv TEXT NOT NULL,
    api_secret_tag TEXT NOT NULL,
    
    -- Optional passphrase (for Coinbase Pro)
    api_passphrase_encrypted TEXT,
    api_passphrase_iv TEXT,
    api_passphrase_tag TEXT,
    
    -- Metadata
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    
    -- Ensure only one set of credentials per exchange/environment
    UNIQUE(exchange, environment)
);

-- Add RLS policies
ALTER TABLE public.exchange_credentials ENABLE ROW LEVEL SECURITY;

-- Only service role can access credentials
CREATE POLICY "Service role full access" ON public.exchange_credentials
    FOR ALL USING (auth.jwt() ->> 'role' = 'service_role');

-- Create updated_at trigger
CREATE TRIGGER update_exchange_credentials_updated_at
    BEFORE UPDATE ON public.exchange_credentials
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Add indexes
CREATE INDEX idx_exchange_credentials_exchange ON public.exchange_credentials(exchange);
CREATE INDEX idx_exchange_credentials_environment ON public.exchange_credentials(environment);
