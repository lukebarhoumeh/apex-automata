-- Create trades table
CREATE TABLE IF NOT EXISTS public.trades (
    id TEXT PRIMARY KEY,
    position_id TEXT NOT NULL,
    order_id TEXT NOT NULL,
    side TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
    size DECIMAL NOT NULL,
    price DECIMAL NOT NULL,
    fee DECIMAL NOT NULL DEFAULT 0,
    realized_pnl DECIMAL DEFAULT 0,
    timestamp TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Create positions table (if not exists from UI)
CREATE TABLE IF NOT EXISTS public.positions (
    id TEXT PRIMARY KEY,
    symbol TEXT NOT NULL,
    side TEXT NOT NULL CHECK (side IN ('long', 'short', 'flat')),
    size DECIMAL NOT NULL DEFAULT 0,
    average_price DECIMAL NOT NULL DEFAULT 0,
    market_price DECIMAL NOT NULL DEFAULT 0,
    unrealized_pnl DECIMAL NOT NULL DEFAULT 0,
    realized_pnl DECIMAL NOT NULL DEFAULT 0,
    total_pnl DECIMAL NOT NULL DEFAULT 0,
    open_time TIMESTAMPTZ NOT NULL,
    last_update_time TIMESTAMPTZ NOT NULL,
    max_size DECIMAL NOT NULL DEFAULT 0,
    max_drawdown DECIMAL NOT NULL DEFAULT 0,
    trade_count INTEGER NOT NULL DEFAULT 0,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Create orders table (extending existing if needed)
CREATE TABLE IF NOT EXISTS public.orders (
    id TEXT PRIMARY KEY,
    client_order_id TEXT UNIQUE NOT NULL,
    exchange_order_id TEXT,
    product_id TEXT NOT NULL,
    side TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
    type TEXT NOT NULL,
    size DECIMAL NOT NULL,
    price DECIMAL,
    status TEXT NOT NULL,
    filled_size DECIMAL NOT NULL DEFAULT 0,
    executed_value DECIMAL NOT NULL DEFAULT 0,
    fees DECIMAL NOT NULL DEFAULT 0,
    parent_order_id TEXT,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Create risk_metrics table
CREATE TABLE IF NOT EXISTS public.risk_metrics (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    current_exposure DECIMAL NOT NULL,
    daily_pnl DECIMAL NOT NULL,
    daily_loss_percentage DECIMAL NOT NULL,
    max_drawdown DECIMAL NOT NULL,
    open_order_count INTEGER NOT NULL,
    consecutive_losses INTEGER NOT NULL,
    error_rate DECIMAL NOT NULL,
    average_latency DECIMAL NOT NULL,
    kill_switch_active BOOLEAN NOT NULL DEFAULT FALSE,
    timestamp TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Create daily_equity table
CREATE TABLE IF NOT EXISTS public.daily_equity (
    date DATE PRIMARY KEY,
    equity DECIMAL NOT NULL,
    high_water_mark DECIMAL,
    daily_return DECIMAL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Create audit_log table
CREATE TABLE IF NOT EXISTS public.audit_log (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    level TEXT NOT NULL CHECK (level IN ('info', 'warn', 'error', 'critical')),
    category TEXT NOT NULL,
    message TEXT NOT NULL,
    details JSONB DEFAULT '{}',
    user_id TEXT,
    ip_address INET,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Add indexes (idempotent for preview branch re-application)
CREATE INDEX IF NOT EXISTS idx_trades_position_id ON public.trades(position_id);
CREATE INDEX IF NOT EXISTS idx_trades_order_id ON public.trades(order_id);
CREATE INDEX IF NOT EXISTS idx_trades_timestamp ON public.trades(timestamp);

CREATE INDEX IF NOT EXISTS idx_positions_symbol ON public.positions(symbol);
CREATE INDEX IF NOT EXISTS idx_positions_side ON public.positions(side);
CREATE INDEX IF NOT EXISTS idx_positions_updated_at ON public.positions(updated_at);

CREATE INDEX IF NOT EXISTS idx_orders_product_id ON public.orders(product_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON public.orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_parent_order_id ON public.orders(parent_order_id);
CREATE INDEX IF NOT EXISTS idx_orders_created_at ON public.orders(created_at);

CREATE INDEX IF NOT EXISTS idx_risk_metrics_timestamp ON public.risk_metrics(timestamp);
CREATE INDEX IF NOT EXISTS idx_risk_metrics_kill_switch ON public.risk_metrics(kill_switch_active);

CREATE INDEX IF NOT EXISTS idx_audit_log_timestamp ON public.audit_log(timestamp);
CREATE INDEX IF NOT EXISTS idx_audit_log_category ON public.audit_log(category);
CREATE INDEX IF NOT EXISTS idx_audit_log_level ON public.audit_log(level);

-- Add RLS policies
ALTER TABLE public.trades ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.positions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.risk_metrics ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.daily_equity ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY;

-- Service role has full access (idempotent guard for preview branch re-application)
DROP POLICY IF EXISTS "Service role full access" ON public.trades;
CREATE POLICY "Service role full access" ON public.trades
    FOR ALL USING (auth.jwt() ->> 'role' = 'service_role');

DROP POLICY IF EXISTS "Service role full access" ON public.positions;
CREATE POLICY "Service role full access" ON public.positions
    FOR ALL USING (auth.jwt() ->> 'role' = 'service_role');

DROP POLICY IF EXISTS "Service role full access" ON public.orders;
CREATE POLICY "Service role full access" ON public.orders
    FOR ALL USING (auth.jwt() ->> 'role' = 'service_role');

DROP POLICY IF EXISTS "Service role full access" ON public.risk_metrics;
CREATE POLICY "Service role full access" ON public.risk_metrics
    FOR ALL USING (auth.jwt() ->> 'role' = 'service_role');

DROP POLICY IF EXISTS "Service role full access" ON public.daily_equity;
CREATE POLICY "Service role full access" ON public.daily_equity
    FOR ALL USING (auth.jwt() ->> 'role' = 'service_role');

DROP POLICY IF EXISTS "Service role full access" ON public.audit_log;
CREATE POLICY "Service role full access" ON public.audit_log
    FOR ALL USING (auth.jwt() ->> 'role' = 'service_role');

-- Create updated_at triggers (idempotent)
DROP TRIGGER IF EXISTS update_positions_updated_at ON public.positions;
CREATE TRIGGER update_positions_updated_at
    BEFORE UPDATE ON public.positions
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_orders_updated_at ON public.orders;
CREATE TRIGGER update_orders_updated_at
    BEFORE UPDATE ON public.orders
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_daily_equity_updated_at ON public.daily_equity;
CREATE TRIGGER update_daily_equity_updated_at
    BEFORE UPDATE ON public.daily_equity
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
