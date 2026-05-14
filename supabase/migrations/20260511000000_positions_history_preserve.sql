-- Migration: positions history preserve
-- Created: 2026-05-11
-- Author: platform-integrity PR
--
-- Problem
-- -------
-- Migration 20260203_step7_persistence_hardening.sql:135 added
--     UNIQUE (user_id, symbol)
-- on the positions table. The engine's syncPositionToSupabase upserts with
--     onConflict: 'user_id,symbol'
-- so every time a new position OPENS for a symbol that already has CLOSED
-- history, the upsert *overwrites* the previous closed row — every prior
-- trade for that symbol gets silently destroyed and replaced by the new
-- open row.
--
-- Fix
-- ---
-- Drop the unconditional unique constraint and replace it with a PARTIAL
-- unique index that only enforces uniqueness WHILE the row is open
-- (closed_at IS NULL). Once a position closes, multiple closed rows for
-- the same (user_id, symbol) are allowed and history is preserved.
--
-- This is the smallest-blast-radius option compared to splitting the
-- table into positions_open + positions_history.
--
-- The application code (atlas/apps/core-node/src/api/server.ts) reads
-- POSITIONS_HISTORY_PRESERVE to decide its conflict target — it stays at
-- `user_id,symbol` until this migration is applied, then flips to `id`.
-- Both work after this migration runs, but `id` is cleaner because the
-- new partial index is not a true unique constraint and PostgREST cannot
-- always infer it for ON CONFLICT.
--
-- DO NOT APPLY automatically. The Cursor Cloud Agent VM cannot reach
-- Supabase (see AGENTS.md "Cloud Agent VM cannot resolve external DNS").
-- See "Manual apply" below.
--
-- Manual apply
-- ------------
-- 1) Take a snapshot or pg_dump of `positions` first. This migration is
--    safe but a backup is cheap insurance against schema-divergence
--    surprises.
-- 2) Run via Supabase SQL editor OR `supabase db push` after the file is
--    committed to the migrations folder.
-- 3) After apply, set in .env:
--        POSITIONS_HISTORY_PRESERVE=true
--    and restart the backend (PM2 reload or `pnpm api`). The upsert in
--    syncPositionToSupabase will switch to onConflict='id'.
-- 4) Verify no application errors mentioning `positions_user_symbol_key`
--    or `duplicate key value`. Trade through one full open->close cycle
--    on a symbol that already has closed history (e.g. ETH-USD); inspect
--    that the prior closed row is still present.
--
-- Idempotency
-- -----------
-- All operations guard with IF EXISTS / IF NOT EXISTS. Safe to re-run.

BEGIN;

-- 1. Drop the existing unconditional unique constraint.
--    Named `positions_user_symbol_key` by the prior migration.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'positions_user_symbol_key'
      AND conrelid = 'public.positions'::regclass
  ) THEN
    ALTER TABLE public.positions
      DROP CONSTRAINT positions_user_symbol_key;
    RAISE NOTICE 'Dropped constraint positions_user_symbol_key';
  ELSE
    RAISE NOTICE 'Constraint positions_user_symbol_key not present — skipping drop';
  END IF;
END $$;

-- 2. Create the partial unique index.
--    Enforces uniqueness ONLY while the position is open. Closed positions
--    (closed_at IS NOT NULL) are exempt, so historical rows accumulate
--    instead of being overwritten.
CREATE UNIQUE INDEX IF NOT EXISTS positions_user_symbol_open_uidx
  ON public.positions (user_id, symbol)
  WHERE closed_at IS NULL;

-- 3. Supporting index for the open-position queries the engine runs on
--    startup (hydrateOpenPositions) and the observational session
--    reconcile in openTradingSession.
CREATE INDEX IF NOT EXISTS positions_user_open_idx
  ON public.positions (user_id)
  WHERE closed_at IS NULL;

-- 4. Sanity check — if any (user_id, symbol) currently has more than one
--    open row, the partial unique index above would have failed to build
--    and the migration would have aborted. We surface a clean error so
--    the operator knows to dedupe before retrying.
DO $$
DECLARE
  dup_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO dup_count
  FROM (
    SELECT user_id, symbol, COUNT(*) AS n
    FROM public.positions
    WHERE closed_at IS NULL
    GROUP BY user_id, symbol
    HAVING COUNT(*) > 1
  ) dupes;

  IF dup_count > 0 THEN
    RAISE EXCEPTION
      'positions has % (user_id, symbol) pair(s) with more than one open row. '
      'Resolve duplicates before applying this migration, e.g. mark stale rows '
      'closed_at = NOW(), exit_reason = ''session_end''.', dup_count;
  END IF;
END $$;

COMMIT;
