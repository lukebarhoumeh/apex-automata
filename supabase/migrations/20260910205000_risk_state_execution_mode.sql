-- =============================================================================
-- TASK_014 P5 (risk side) — execution_mode discriminator on persisted risk state
-- =============================================================================
-- Paper and live share one Supabase project and (today) one USER_ID, so the
-- risk state RiskEngine restores at boot — kill switch, consecutive losses,
-- start-of-day equity, active halt events — had no paper/live discriminator:
-- a paper kill switch halted the next live boot; a paper
-- PAPER_RESET_RISK_STATE_ON_START boot flipped live halts to active=false.
--
-- This migration adds `execution_mode text NOT NULL DEFAULT 'paper' CHECK
-- (paper|live)` to the three risk tables the engine restores from / persists
-- to, and moves their uniqueness to include the mode so paper and live keep
-- separate rows:
--
--   risk_metrics   UNIQUE (user_id)        -> UNIQUE (user_id, execution_mode)
--   daily_equity   UNIQUE (user_id, date)  -> UNIQUE (user_id, execution_mode, date)
--   risk_events    (append-only audit)     -> column only, no key change
--
-- Backfill: every existing row is stamped 'paper'. Verified read-only on prod
-- 2026-09-10 ~20:45 UTC: risk_metrics 1 row, risk_events 16 rows (0 active),
-- daily_equity 23 rows, trading_sessions with execution_mode='live': 0 — no
-- live session has ever run, so 'paper' is the correct stamp for all of them.
-- account_metrics already carries execution_mode (20260910180200, #2 of the
-- Sprint-9 DB handoff) and is not touched here.
--
-- Runtime contract (atlas/apps/core-node/src/trading/risk-engine.ts,
-- risk-state.ts): reads add `.eq('execution_mode', <mode>)`, upserts stamp
-- the column and use the new ON CONFLICT targets. The code is
-- schema-tolerant — until this file is applied it falls back to the legacy
-- unscoped shape (warned once per table), so deploying the code before the
-- migration does not break paper kill-switch persistence (#36). Applying the
-- migration under a running process is also handled (42P10 on the legacy key
-- re-enables the mode-scoped path on the next tick).
--
-- Scope fence (docs/db/EXTERNAL_CONSUMERS.md): touches ONLY
-- public.risk_metrics, public.risk_events, public.daily_equity. Nothing here
-- references equity.agentic_heartbeats / public.agentic_heartbeats, the
-- `equity` schema, RLS policies, grants, or PostgREST exposed schemas.
--
-- Idempotent: each table is handled in one DO block that returns early when
-- the table is absent; every step inside is guarded (ADD COLUMN IF NOT
-- EXISTS, NULL-only backfill, catalog-checked constraint adds/drops).
-- Re-running is a no-op. Coexists with the full TASK_014
-- `*_live_persistence.sql` migration in either order: that file's IF NOT
-- EXISTS guards skip what already exists here and vice versa. The Supabase
-- runner wraps the file in one transaction, so there is no intermediate
-- state where the column exists without its unique key.
--
-- STAGED ONLY: no MCP apply, no `supabase db push` from this PR. Applying is
-- a separate, Trading-Master-authorised step (same gate as the rest of the
-- Sprint-9 DB handoff). If the MCP apply records its own apply-time version,
-- reconcile it with a `SELECT 1;` stub exactly as done for 20260910185138 /
-- 20260910185148 — do NOT copy this body into the stub.
--
-- Rollback (reverse order, as postgres):
--   ALTER TABLE public.daily_equity DROP CONSTRAINT IF EXISTS daily_equity_user_mode_date_key;
--   ALTER TABLE public.daily_equity ADD CONSTRAINT daily_equity_user_id_date_key UNIQUE (user_id, date);
--   ALTER TABLE public.risk_metrics DROP CONSTRAINT IF EXISTS risk_metrics_user_mode_key;
--   ALTER TABLE public.risk_metrics ADD CONSTRAINT risk_metrics_user_id_key UNIQUE (user_id);
--   DROP INDEX IF EXISTS public.idx_risk_events_user_mode_active;
--   ALTER TABLE public.{risk_metrics,risk_events,daily_equity} DROP COLUMN IF EXISTS execution_mode;
--   (the re-added unique keys require at most one row per user / per day —
--    delete any 'live' rows first if a live session has run in between.)
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. risk_metrics — one row per (user_id, execution_mode)
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF to_regclass('public.risk_metrics') IS NULL THEN
    RAISE NOTICE 'public.risk_metrics absent; skipping';
    RETURN;
  END IF;

  ALTER TABLE public.risk_metrics ADD COLUMN IF NOT EXISTS execution_mode text;
  UPDATE public.risk_metrics SET execution_mode = 'paper' WHERE execution_mode IS NULL;
  ALTER TABLE public.risk_metrics ALTER COLUMN execution_mode SET DEFAULT 'paper';
  ALTER TABLE public.risk_metrics ALTER COLUMN execution_mode SET NOT NULL;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.risk_metrics'::regclass AND conname = 'risk_metrics_execution_mode_check'
  ) THEN
    ALTER TABLE public.risk_metrics
      ADD CONSTRAINT risk_metrics_execution_mode_check CHECK (execution_mode IN ('paper', 'live'));
  END IF;

  -- Add the mode-aware key BEFORE dropping the legacy one so there is never a
  -- moment without a unique key for the upsert to target.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.risk_metrics'::regclass AND conname = 'risk_metrics_user_mode_key'
  ) THEN
    ALTER TABLE public.risk_metrics
      ADD CONSTRAINT risk_metrics_user_mode_key UNIQUE (user_id, execution_mode);
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.risk_metrics'::regclass AND conname = 'risk_metrics_user_id_key'
  ) THEN
    ALTER TABLE public.risk_metrics DROP CONSTRAINT risk_metrics_user_id_key;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. daily_equity — one row per (user_id, execution_mode, date)
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF to_regclass('public.daily_equity') IS NULL THEN
    RAISE NOTICE 'public.daily_equity absent; skipping';
    RETURN;
  END IF;

  ALTER TABLE public.daily_equity ADD COLUMN IF NOT EXISTS execution_mode text;
  UPDATE public.daily_equity SET execution_mode = 'paper' WHERE execution_mode IS NULL;
  ALTER TABLE public.daily_equity ALTER COLUMN execution_mode SET DEFAULT 'paper';
  ALTER TABLE public.daily_equity ALTER COLUMN execution_mode SET NOT NULL;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.daily_equity'::regclass AND conname = 'daily_equity_execution_mode_check'
  ) THEN
    ALTER TABLE public.daily_equity
      ADD CONSTRAINT daily_equity_execution_mode_check CHECK (execution_mode IN ('paper', 'live'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.daily_equity'::regclass AND conname = 'daily_equity_user_mode_date_key'
  ) THEN
    ALTER TABLE public.daily_equity
      ADD CONSTRAINT daily_equity_user_mode_date_key UNIQUE (user_id, execution_mode, date);
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.daily_equity'::regclass AND conname = 'daily_equity_user_id_date_key'
  ) THEN
    ALTER TABLE public.daily_equity DROP CONSTRAINT daily_equity_user_id_date_key;
  END IF;
END $$;

-- The two pre-existing non-unique lookup indexes (daily_equity_user_date_idx,
-- idx_daily_equity_user_date) keep serving the dashboard's
-- `user_id=eq.&date=gte.` reads unchanged.

-- ---------------------------------------------------------------------------
-- 3. risk_events — append-only audit log, column only
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF to_regclass('public.risk_events') IS NULL THEN
    RAISE NOTICE 'public.risk_events absent; skipping';
    RETURN;
  END IF;

  ALTER TABLE public.risk_events ADD COLUMN IF NOT EXISTS execution_mode text;
  UPDATE public.risk_events SET execution_mode = 'paper' WHERE execution_mode IS NULL;
  ALTER TABLE public.risk_events ALTER COLUMN execution_mode SET DEFAULT 'paper';
  ALTER TABLE public.risk_events ALTER COLUMN execution_mode SET NOT NULL;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.risk_events'::regclass AND conname = 'risk_events_execution_mode_check'
  ) THEN
    ALTER TABLE public.risk_events
      ADD CONSTRAINT risk_events_execution_mode_check CHECK (execution_mode IN ('paper', 'live'));
  END IF;

  -- Supports RiskEngine.clearStaleRiskEvents (user_id, execution_mode, active)
  -- and the dashboard's active-halt panel once it filters by mode.
  CREATE INDEX IF NOT EXISTS idx_risk_events_user_mode_active
    ON public.risk_events (user_id, execution_mode, triggered_at DESC)
    WHERE active = true;
END $$;

-- ---------------------------------------------------------------------------
-- Post-conditions (read-only; run after apply)
-- ---------------------------------------------------------------------------
-- SELECT table_name, is_nullable, column_default
--   FROM information_schema.columns
--  WHERE table_schema = 'public' AND column_name = 'execution_mode'
--    AND table_name IN ('risk_metrics','risk_events','daily_equity');
--   -- expect 3 rows: NO | 'paper'::text
-- SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
--  WHERE conrelid IN ('public.risk_metrics'::regclass, 'public.daily_equity'::regclass)
--    AND contype = 'u';
--   -- expect risk_metrics_user_mode_key (user_id, execution_mode)
--   --        daily_equity_user_mode_date_key (user_id, execution_mode, date)
--   -- and NOT risk_metrics_user_id_key / daily_equity_user_id_date_key
-- SELECT count(*) FILTER (WHERE execution_mode IS NULL) FROM public.risk_metrics;   -- 0
-- SELECT n.nspname, c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
--  WHERE c.relname = 'agentic_heartbeats';                                           -- unchanged: equity r + public v
