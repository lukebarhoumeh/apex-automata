-- Preserve exchange order identifiers on fills while keeping internal order_id FK
ALTER TABLE public.fills
ADD COLUMN IF NOT EXISTS external_order_id text;

CREATE INDEX IF NOT EXISTS idx_fills_external_order_id ON public.fills(external_order_id);
