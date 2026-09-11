-- =============================================================================
-- TASK_014 P5 (blotter side) — session_id / execution_mode on the four blotter
-- tables the paper UI reads: orders, fills, signals, positions
-- =============================================================================
-- Why: the dashboard reads these tables from Supabase with "last 100 / last
-- 50" queries and no session filter, so every blotter, fills table and
-- signal feed bleeds rows from prior paper sessions into the current one
-- (Frontend Lead contract #1, follow-up to TASK_016 / PR #58). The runtime
-- already opens one `trading_sessions` row per engine start
-- (`session_id = 'sess_<epoch>_<rand>'`) and now stamps that id plus the
-- session's execution mode on every order / fill / signal / position row it
-- writes, and serves session-scoped reads at
--   GET /api/orders    ?session_id=&execution_mode=&limit=
--   GET /api/fills     ?session_id=&execution_mode=&limit=
--   GET /api/signals   ?session_id=&execution_mode=&limit=
--   GET /api/positions ?session_id=&execution_mode=&status=&limit=
--
-- What this adds (all ADDITIVE, all NULLABLE, no key changes, no backfill):
--   orders    + session_id text, + execution_mode text  (CHECK paper|live)
--   fills     + session_id text, + execution_mode text  (CHECK paper|live)
--   signals   + session_id text, + execution_mode text  (CHECK paper|live)
--   positions + session_id text, + execution_mode text  (CHECK paper|live)
--   + one (user_id, session_id, <time col> DESC) index per table for the
--     session-scoped reads above.
--
-- NULLABLE on purpose: rows written before this migration is applied (and
-- rows written by a runtime deployed before the stamping code) have no
-- session and are NOT backfilled — there is no honest way to attribute a
-- historical order to a session after the fact, and the UI must treat
-- `session_id IS NULL` as "unscoped legacy row", never as "current session".
-- `session_id` is deliberately NOT a FK to `trading_sessions.session_id`:
-- the session row is written best-effort after engine start and must never
-- be able to reject an order/fill write.
--
-- Runtime contract (atlas/apps/core-node/src/api/server.ts,
-- src/persistence/session-stamp.ts, src/api/session-scope.ts): the code is
-- schema-tolerant. Until this file is applied
--   * writers detect PGRST204 / 42703 on `session_id` / `execution_mode`,
--     drop the two columns from the payload and retry (warned once per
--     table, re-probed every 5 min so applying under a running process is
--     picked up without a restart);
--   * the four GET endpoints fall back to the interim time-window filter
--     `<time col> >= trading_sessions.started_at [AND <= ended_at]` and say
--     so in the response (`scope.filter = 'time_window'`).
-- After apply, reads switch to `session_id = ? AND execution_mode = ?`
-- (`scope.filter = 'session_id'`).
--
-- Scope fence (docs/db/EXTERNAL_CONSUMERS.md): touches ONLY public.orders,
-- public.fills, public.signals, public.positions. Nothing here references
-- equity.agentic_heartbeats / public.agentic_heartbeats, the `equity` schema,
-- RLS policies, grants, views, functions or PostgREST exposed schemas.
-- Existing RLS policies on the four tables keep applying unchanged (new
-- columns inherit row-level policies).
--
-- Idempotent: one DO block per table, returns early when the table is absent;
-- every step is guarded (ADD COLUMN IF NOT EXISTS, catalog-checked CHECK
-- constraint, CREATE INDEX IF NOT EXISTS). Re-running is a no-op. Safe under
-- load: nullable ADD COLUMN without default is a catalog-only change in
-- Postgres >= 11; the indexes are small (sessions are hours long).
--
-- STAGED ONLY: no MCP apply, no `supabase db push` from this PR. Apply is a
-- separate Database Engineer / Apex Data step with Trading Master go, same
-- gate as the rest of the Sprint-9 DB handoff (docs/db/HANDOFF_2026-09-10.md).
-- If the MCP apply records its own apply-time version, reconcile it with a
-- `SELECT 1;` stub exactly as done for 20260910185138 / 20260910185148 —
-- do NOT copy this body into the stub.
--
-- Rollback (as postgres; drops columns + indexes, no data other than the
-- stamps is lost):
--   DROP INDEX IF EXISTS public.idx_orders_user_session_created;
--   DROP INDEX IF EXISTS public.idx_fills_user_session_filled;
--   DROP INDEX IF EXISTS public.idx_signals_user_session_created;
--   DROP INDEX IF EXISTS public.idx_positions_user_session_opened;
--   ALTER TABLE public.orders    DROP COLUMN IF EXISTS session_id, DROP COLUMN IF EXISTS execution_mode;
--   ALTER TABLE public.fills     DROP COLUMN IF EXISTS session_id, DROP COLUMN IF EXISTS execution_mode;
--   ALTER TABLE public.signals   DROP COLUMN IF EXISTS session_id, DROP COLUMN IF EXISTS execution_mode;
--   ALTER TABLE public.positions DROP COLUMN IF EXISTS session_id, DROP COLUMN IF EXISTS execution_mode;
--   (the runtime falls back to the interim time-window path automatically.)
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. orders
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF to_regclass('public.orders') IS NULL THEN
    RAISE NOTICE 'public.orders absent; skipping';
    RETURN;
  END IF;

  ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS session_id text;
  ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS execution_mode text;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.orders'::regclass AND conname = 'orders_execution_mode_check'
  ) THEN
    ALTER TABLE public.orders
      ADD CONSTRAINT orders_execution_mode_check
      CHECK (execution_mode IS NULL OR execution_mode IN ('paper', 'live'));
  END IF;

  -- GET /api/orders?session_id= : (user_id, session_id) ORDER BY created_at DESC
  CREATE INDEX IF NOT EXISTS idx_orders_user_session_created
    ON public.orders (user_id, session_id, created_at DESC)
    WHERE session_id IS NOT NULL;
END $$;

-- ---------------------------------------------------------------------------
-- 2. fills
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF to_regclass('public.fills') IS NULL THEN
    RAISE NOTICE 'public.fills absent; skipping';
    RETURN;
  END IF;

  ALTER TABLE public.fills ADD COLUMN IF NOT EXISTS session_id text;
  ALTER TABLE public.fills ADD COLUMN IF NOT EXISTS execution_mode text;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.fills'::regclass AND conname = 'fills_execution_mode_check'
  ) THEN
    ALTER TABLE public.fills
      ADD CONSTRAINT fills_execution_mode_check
      CHECK (execution_mode IS NULL OR execution_mode IN ('paper', 'live'));
  END IF;

  -- GET /api/fills?session_id= : (user_id, session_id) ORDER BY filled_at DESC
  -- (fills has no created_at; filled_at is the row's time column.)
  CREATE INDEX IF NOT EXISTS idx_fills_user_session_filled
    ON public.fills (user_id, session_id, filled_at DESC)
    WHERE session_id IS NOT NULL;
END $$;

-- ---------------------------------------------------------------------------
-- 3. signals
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF to_regclass('public.signals') IS NULL THEN
    RAISE NOTICE 'public.signals absent; skipping';
    RETURN;
  END IF;

  ALTER TABLE public.signals ADD COLUMN IF NOT EXISTS session_id text;
  ALTER TABLE public.signals ADD COLUMN IF NOT EXISTS execution_mode text;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.signals'::regclass AND conname = 'signals_execution_mode_check'
  ) THEN
    ALTER TABLE public.signals
      ADD CONSTRAINT signals_execution_mode_check
      CHECK (execution_mode IS NULL OR execution_mode IN ('paper', 'live'));
  END IF;

  -- GET /api/signals?session_id= : (user_id, session_id) ORDER BY created_at DESC
  CREATE INDEX IF NOT EXISTS idx_signals_user_session_created
    ON public.signals (user_id, session_id, created_at DESC)
    WHERE session_id IS NOT NULL;
END $$;

-- ---------------------------------------------------------------------------
-- 4. positions
-- ---------------------------------------------------------------------------
-- Semantics: `session_id` on a position is the session that OPENED it. The
-- runtime omits the stamp when it re-writes a position it hydrated from a
-- prior session (metadata.hydratedFromSupabase), so the opening session's
-- stamp survives the close. Positions open across a restart therefore show
-- up in the session that opened them, not in the one that closed them.
DO $$
BEGIN
  IF to_regclass('public.positions') IS NULL THEN
    RAISE NOTICE 'public.positions absent; skipping';
    RETURN;
  END IF;

  ALTER TABLE public.positions ADD COLUMN IF NOT EXISTS session_id text;
  ALTER TABLE public.positions ADD COLUMN IF NOT EXISTS execution_mode text;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.positions'::regclass AND conname = 'positions_execution_mode_check'
  ) THEN
    ALTER TABLE public.positions
      ADD CONSTRAINT positions_execution_mode_check
      CHECK (execution_mode IS NULL OR execution_mode IN ('paper', 'live'));
  END IF;

  -- GET /api/positions?session_id= : (user_id, session_id) ORDER BY opened_at DESC
  CREATE INDEX IF NOT EXISTS idx_positions_user_session_opened
    ON public.positions (user_id, session_id, opened_at DESC)
    WHERE session_id IS NOT NULL;
END $$;

-- ---------------------------------------------------------------------------
-- Post-conditions (read-only; run after apply)
-- ---------------------------------------------------------------------------
-- SELECT table_name, column_name, is_nullable, column_default
--   FROM information_schema.columns
--  WHERE table_schema = 'public'
--    AND table_name IN ('orders','fills','signals','positions')
--    AND column_name IN ('session_id','execution_mode')
--  ORDER BY table_name, column_name;
--   -- expect 8 rows: YES | NULL (nullable, no default)
-- SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
--  WHERE conname IN ('orders_execution_mode_check','fills_execution_mode_check',
--                    'signals_execution_mode_check','positions_execution_mode_check');
--   -- expect 4 rows
-- SELECT indexname FROM pg_indexes
--  WHERE schemaname = 'public'
--    AND indexname IN ('idx_orders_user_session_created','idx_fills_user_session_filled',
--                      'idx_signals_user_session_created','idx_positions_user_session_opened');
--   -- expect 4 rows
-- SELECT n.nspname, c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
--  WHERE c.relname = 'agentic_heartbeats';                                   -- unchanged: equity r + public v
