-- =============================================================================
-- Define public.update_updated_at_column() — was historically missing from the
-- repo's migration set.
--
-- Three later migrations reference this function in BEFORE UPDATE triggers:
--   - 20251013180000_exchange_credentials.sql
--   - 20251013180100_trading_tables.sql
--   - 20251016_risk_metrics.sql
--
-- The remote project (gdrdaajvutmewgxbjurk) has had this function present since
-- early 2026, presumably created via the dashboard's SQL editor outside the
-- migration pipeline. Supabase Preview's per-PR fresh-database apply trips on
-- "function update_updated_at_column() does not exist" because the function was
-- never declared in any migration file.
--
-- This back-dated migration (version 20251013175000) sits BETWEEN
-- 20251013174025 (trading types/tables) and 20251013180000 (first reference),
-- so it runs first when migrations are applied in version order on a fresh
-- database. CREATE OR REPLACE makes it idempotent on the remote, where the
-- function already exists with the same body.
--
-- Functionally equivalent to the existing public.handle_updated_at() defined
-- in 20251013171848 — both NULL out updated_at to NOW() in a BEFORE UPDATE
-- trigger. Keeping the two names because each is referenced by different
-- triggers already deployed on remote.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;
