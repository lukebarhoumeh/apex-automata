-- Reconciliation file for migration version 20260514210013 recorded in
-- supabase_migrations.schema_migrations on 2026-05-14 via Supabase Management API
-- (Wave 2 D11). Captures DDL applied directly to prod to restore the
-- meta_filter_decisions schema gap left by Wave 1 closure.
--
-- All statements are idempotent (ADD COLUMN IF NOT EXISTS, CREATE INDEX IF NOT
-- EXISTS) so Supabase Preview re-application is safe and a no-op against an
-- already-reconciled remote.

ALTER TABLE public.meta_filter_decisions
  ADD COLUMN IF NOT EXISTS user_id UUID NULL,
  ADD COLUMN IF NOT EXISTS outcome TEXT CHECK (outcome IN ('win', 'loss', 'breakeven') OR outcome IS NULL),
  ADD COLUMN IF NOT EXISTS pnl DECIMAL(18, 8),
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- Indexes for ML training queries (idempotent)
CREATE INDEX IF NOT EXISTS idx_mf_decisions_user_id        ON public.meta_filter_decisions(user_id);
CREATE INDEX IF NOT EXISTS idx_mf_decisions_timestamp      ON public.meta_filter_decisions(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_mf_decisions_strategy       ON public.meta_filter_decisions(strategy);
CREATE INDEX IF NOT EXISTS idx_mf_decisions_passed         ON public.meta_filter_decisions(passed);
CREATE INDEX IF NOT EXISTS idx_mf_decisions_signal_id      ON public.meta_filter_decisions(signal_id);
CREATE INDEX IF NOT EXISTS idx_mf_decisions_outcome
  ON public.meta_filter_decisions(outcome) WHERE outcome IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_mf_decisions_ml_training
  ON public.meta_filter_decisions(strategy, passed, outcome) WHERE outcome IS NOT NULL;
