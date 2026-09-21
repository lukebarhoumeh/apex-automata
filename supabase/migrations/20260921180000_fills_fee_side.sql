-- =============================================================================
-- Card SH-QMAKER-CFM-PAPER-v0 (Tier-A Eng infra, blocker 3) — explicit
-- maker / taker fee-side attribution on every fill.
-- =============================================================================
-- Why: `public.fills.maker` was written as `liquidity === 'M'`, so a fill whose
-- side the venue did NOT report was silently persisted as taker. The desk's
-- kill bars are written in fee-side terms ("any chase / taker fill → VOID",
-- "unlogged fee_side → VOID"), and the CFM book is priced per side (maker
-- 9.5 / taker 10 bps + $0.10/ct, cite CFM-NANO-COSTPLUS-ADV1), so an unknown
-- side must stay unknown. The runtime now writes `maker` tri-state
-- (true | false | NULL) and stamps the explicit vocabulary here.
--
-- What this adds (ADDITIVE, NULLABLE, no key changes, no backfill):
--   fills + fee_side        text  CHECK (NULL | 'maker' | 'taker')
--   fills + fee_side_source text  CHECK (NULL | 'exchange' | 'simulated' | 'inferred')
--
-- NULLABLE on purpose: rows written before this migration is applied (and by
-- a runtime deployed before the stamping code) have no attribution and are
-- NOT backfilled — `maker` on those rows was a coerced boolean and cannot be
-- trusted retroactively. Readers must treat `fee_side IS NULL` as "unlogged"
-- (VOID for the card), never as taker.
--
-- Runtime contract (atlas/apps/core-node/src/persistence/fill-row.ts,
-- src/persistence/optional-columns.ts, src/api/server.ts syncFillToSupabase):
-- the writer is schema-tolerant. Until this file is applied it detects
-- PGRST204 / 42703 on `fee_side` / `fee_side_source`, strips the two columns
-- and retries (warned once per table, re-probed every 5 min so applying under
-- a running process is picked up without a restart). `maker` is written
-- tri-state regardless (the column is already nullable).
--
-- Scope fence (docs/db/EXTERNAL_CONSUMERS.md): touches ONLY public.fills.
-- No RLS, grants, views, functions or exposed-schema changes. Existing RLS
-- policies keep applying (new columns inherit row-level policies).
--
-- Idempotent: guarded ADD COLUMN IF NOT EXISTS + catalog-checked CHECK
-- constraints; re-running is a no-op. Safe under load: nullable ADD COLUMN
-- without default is a catalog-only change in Postgres >= 11.
--
-- STAGED ONLY: no MCP apply, no `supabase db push` from this PR. Apply is a
-- separate Database Engineer / Apex Data step with Trading Master go.
--
-- Rollback (as postgres):
--   ALTER TABLE public.fills DROP CONSTRAINT IF EXISTS fills_fee_side_check;
--   ALTER TABLE public.fills DROP CONSTRAINT IF EXISTS fills_fee_side_source_check;
--   ALTER TABLE public.fills DROP COLUMN IF EXISTS fee_side, DROP COLUMN IF EXISTS fee_side_source;
--   (the runtime falls back to the legacy shape automatically.)
-- =============================================================================

DO $$
BEGIN
  IF to_regclass('public.fills') IS NULL THEN
    RAISE NOTICE 'public.fills absent; skipping';
    RETURN;
  END IF;

  ALTER TABLE public.fills ADD COLUMN IF NOT EXISTS fee_side text;
  ALTER TABLE public.fills ADD COLUMN IF NOT EXISTS fee_side_source text;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.fills'::regclass AND conname = 'fills_fee_side_check'
  ) THEN
    ALTER TABLE public.fills
      ADD CONSTRAINT fills_fee_side_check
      CHECK (fee_side IS NULL OR fee_side IN ('maker', 'taker'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.fills'::regclass AND conname = 'fills_fee_side_source_check'
  ) THEN
    ALTER TABLE public.fills
      ADD CONSTRAINT fills_fee_side_source_check
      CHECK (fee_side_source IS NULL OR fee_side_source IN ('exchange', 'simulated', 'inferred'));
  END IF;

  COMMENT ON COLUMN public.fills.fee_side IS
    'maker | taker | NULL (unlogged — VOID for SH-QMAKER-CFM-PAPER-v0). Explicit form of tri-state `maker`.';
  COMMENT ON COLUMN public.fills.fee_side_source IS
    'exchange (venue-reported) | simulated (paper simulator) | inferred (local heuristic) | NULL.';
END $$;

-- ---------------------------------------------------------------------------
-- Post-conditions (read-only; run after apply)
-- ---------------------------------------------------------------------------
-- SELECT column_name, is_nullable, column_default
--   FROM information_schema.columns
--  WHERE table_schema = 'public' AND table_name = 'fills'
--    AND column_name IN ('fee_side', 'fee_side_source');
--   -- expect 2 rows: YES | NULL
-- SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
--  WHERE conname IN ('fills_fee_side_check', 'fills_fee_side_source_check');
--   -- expect 2 rows
