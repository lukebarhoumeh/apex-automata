-- =============================================================================
-- Desk compatibility aliases on trading_sessions / risk_metrics (2026-09-29).
-- =============================================================================
-- Why: the desk monitor that polls this project through the Supabase MCP
-- endpoint (`POST /mcp`, OAuth user 3d0e1e1e-25ff-424c-81f8-142a80fb3df0,
-- every 10–15 min) reads the two TABLES by name and keeps guessing the same
-- column vocabulary (105× `column "id" does not exist`, 23× `status`, plus
-- `equity`, `trade_count`, `trades_count`, `pnl`, `starting_equity`,
-- `ending_equity` on trading_sessions; `kill_switch`, `exposure`, `halt` on
-- risk_metrics — all sqlstate 42703 in the 2026-09-28 log). The canonical
-- answer is the two `desk_*` views (previous migration), but the poller has
-- to be re-pointed for those to help. Until it is, these GENERATED columns
-- make its existing statements succeed with honest, derived values.
--
-- What this adds (ADDITIVE, GENERATED ALWAYS … STORED, read-only by nature):
--   trading_sessions + id              text     = session_id
--                    + status          text     = 'OPEN' while ended_at IS NULL else 'ENDED'
--                    + starting_equity numeric  = initial_equity
--                    + ending_equity   numeric  = final_equity
--                    + equity          numeric  = COALESCE(final_equity, initial_equity)
--                    + trade_count     integer  = total_trades
--                    + trades_count    integer  = total_trades
--                    + pnl             numeric  = total_pnl
--   risk_metrics     + kill_switch     boolean  = kill_switch_active
--                    + halt            boolean  = kill_switch_active
--                    + exposure        numeric  = exposure_usd
--
-- Deliberately NOT added: `session_id` on risk_metrics (the table has no
-- session stamp and RiskEngine has no session id — desk_risk_status derives
-- it from account_metrics), `unrealized_pnl` / `symbol` on trading_sessions
-- (no honest source on a session row).
--
-- Runtime safety: generated columns REJECT explicit writes, so this is only
-- safe because no writer sends these keys. Verified 2026-09-29 against
-- atlas/apps/core-node/src/api/server.ts (trading_sessions insert / update),
-- src/trading/trade-analytics.ts persistSessionSummary (upsert on
-- session_id), src/trading/risk-engine.ts persistMetrics (upsert on
-- user_id,execution_mode) and the frontend (src/runtime/realtime reads only).
-- Any future writer that spells one of these keys will get sqlstate 428C9 —
-- the fix is to drop the key from the payload, never to drop the column
-- under a running poller. `select *` readers simply see extra columns.
--
-- Scope fence (docs/db/EXTERNAL_CONSUMERS.md): touches ONLY
-- public.trading_sessions and public.risk_metrics. No RLS, grant, view,
-- function or exposed-schema change; new columns inherit the tables' RLS.
--
-- Idempotent: guarded ADD COLUMN IF NOT EXISTS inside one DO block per
-- table; re-running is a no-op. Safe under load: both tables are tiny (79
-- and 1 rows on 2026-09-29); the STORED rewrite is milliseconds.
--
-- Rollback (as postgres) — these are a shim, drop them once the desk
-- monitor reads desk_session_status / desk_risk_status:
--   ALTER TABLE public.trading_sessions
--     DROP COLUMN IF EXISTS id, DROP COLUMN IF EXISTS status,
--     DROP COLUMN IF EXISTS starting_equity, DROP COLUMN IF EXISTS ending_equity,
--     DROP COLUMN IF EXISTS equity, DROP COLUMN IF EXISTS trade_count,
--     DROP COLUMN IF EXISTS trades_count, DROP COLUMN IF EXISTS pnl;
--   ALTER TABLE public.risk_metrics
--     DROP COLUMN IF EXISTS kill_switch, DROP COLUMN IF EXISTS halt,
--     DROP COLUMN IF EXISTS exposure;
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. trading_sessions
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF to_regclass('public.trading_sessions') IS NULL THEN
    RAISE NOTICE 'public.trading_sessions absent; skipping';
    RETURN;
  END IF;

  ALTER TABLE public.trading_sessions
    ADD COLUMN IF NOT EXISTS id text
      GENERATED ALWAYS AS (session_id) STORED;
  ALTER TABLE public.trading_sessions
    ADD COLUMN IF NOT EXISTS status text
      GENERATED ALWAYS AS (CASE WHEN ended_at IS NULL THEN 'OPEN' ELSE 'ENDED' END) STORED;
  ALTER TABLE public.trading_sessions
    ADD COLUMN IF NOT EXISTS starting_equity numeric
      GENERATED ALWAYS AS (initial_equity) STORED;
  ALTER TABLE public.trading_sessions
    ADD COLUMN IF NOT EXISTS ending_equity numeric
      GENERATED ALWAYS AS (final_equity) STORED;
  ALTER TABLE public.trading_sessions
    ADD COLUMN IF NOT EXISTS equity numeric
      GENERATED ALWAYS AS (COALESCE(final_equity, initial_equity)) STORED;
  ALTER TABLE public.trading_sessions
    ADD COLUMN IF NOT EXISTS trade_count integer
      GENERATED ALWAYS AS (total_trades) STORED;
  ALTER TABLE public.trading_sessions
    ADD COLUMN IF NOT EXISTS trades_count integer
      GENERATED ALWAYS AS (total_trades) STORED;
  ALTER TABLE public.trading_sessions
    ADD COLUMN IF NOT EXISTS pnl numeric
      GENERATED ALWAYS AS (total_pnl) STORED;

  COMMENT ON COLUMN public.trading_sessions.id IS
    'GENERATED alias of session_id for external readers. Do not write. Canonical read surface: desk_session_status.';
  COMMENT ON COLUMN public.trading_sessions.status IS
    'GENERATED: OPEN while ended_at IS NULL, else ENDED. Do not write.';
  COMMENT ON COLUMN public.trading_sessions.starting_equity IS
    'GENERATED alias of initial_equity. Do not write.';
  COMMENT ON COLUMN public.trading_sessions.ending_equity IS
    'GENERATED alias of final_equity. Do not write.';
  COMMENT ON COLUMN public.trading_sessions.equity IS
    'GENERATED: COALESCE(final_equity, initial_equity). For an OPEN session this is the session-start equity; live equity is account_metrics.total_equity (desk_session_status.current_equity). Do not write.';
  COMMENT ON COLUMN public.trading_sessions.trade_count IS
    'GENERATED alias of total_trades. Do not write.';
  COMMENT ON COLUMN public.trading_sessions.trades_count IS
    'GENERATED alias of total_trades. Do not write.';
  COMMENT ON COLUMN public.trading_sessions.pnl IS
    'GENERATED alias of total_pnl. Do not write.';
END $$;

-- ---------------------------------------------------------------------------
-- 2. risk_metrics
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF to_regclass('public.risk_metrics') IS NULL THEN
    RAISE NOTICE 'public.risk_metrics absent; skipping';
    RETURN;
  END IF;

  ALTER TABLE public.risk_metrics
    ADD COLUMN IF NOT EXISTS kill_switch boolean
      GENERATED ALWAYS AS (kill_switch_active) STORED;
  ALTER TABLE public.risk_metrics
    ADD COLUMN IF NOT EXISTS halt boolean
      GENERATED ALWAYS AS (kill_switch_active) STORED;
  ALTER TABLE public.risk_metrics
    ADD COLUMN IF NOT EXISTS exposure numeric
      GENERATED ALWAYS AS (exposure_usd) STORED;

  COMMENT ON COLUMN public.risk_metrics.kill_switch IS
    'GENERATED alias of kill_switch_active for external readers. Do not write. Canonical read surface: desk_risk_status.';
  COMMENT ON COLUMN public.risk_metrics.halt IS
    'GENERATED alias of kill_switch_active. Do not write.';
  COMMENT ON COLUMN public.risk_metrics.exposure IS
    'GENERATED alias of exposure_usd. Do not write.';
END $$;

-- ---------------------------------------------------------------------------
-- Post-conditions (read-only; run after apply) — docs/db/verify/05_desk_status_views.sql
-- ---------------------------------------------------------------------------
-- SELECT table_name, column_name, is_generated, generation_expression
--   FROM information_schema.columns
--  WHERE table_schema = 'public'
--    AND ((table_name = 'trading_sessions' AND column_name IN
--          ('id','status','starting_equity','ending_equity','equity','trade_count','trades_count','pnl'))
--      OR (table_name = 'risk_metrics' AND column_name IN ('kill_switch','halt','exposure')))
--  ORDER BY table_name, column_name;
--   -- expect 11 rows, is_generated = ALWAYS
-- SELECT id, status, started_at, ended_at, equity, trade_count, pnl, execution_mode
--   FROM public.trading_sessions ORDER BY COALESCE(ended_at, started_at) DESC NULLS LAST LIMIT 3;
--   -- the poller's own statement; must return rows, not 42703
