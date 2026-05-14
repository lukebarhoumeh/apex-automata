-- Optional linkage from positions to the originating signal
ALTER TABLE public.positions
ADD COLUMN IF NOT EXISTS primary_signal_id uuid REFERENCES public.signals(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_positions_primary_signal_id ON public.positions(primary_signal_id);
