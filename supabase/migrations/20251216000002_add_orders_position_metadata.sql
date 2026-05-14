-- Add position linkage and metadata to orders
-- Ensures single-join lineage: positions -> orders -> fills

-- Add metadata jsonb for order context
ALTER TABLE public.orders
ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Add position_id linking orders to positions
ALTER TABLE public.orders
ADD COLUMN IF NOT EXISTS position_id uuid REFERENCES public.positions(id) ON DELETE SET NULL;

-- Index for position lookups
CREATE INDEX IF NOT EXISTS idx_orders_position_id ON public.orders(position_id);
