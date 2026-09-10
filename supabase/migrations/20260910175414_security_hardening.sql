-- =============================================================================
-- security_hardening (authored 2026-09-10, pre-live)
-- -----------------------------------------------------------------------------
-- Clears the Supabase security-advisor findings open on 2026-09-10:
--   ERROR security_definer_view          public.ml_training_data
--                                        public.strategy_regime_performance
--                                        public.daily_trade_summary
--   WARN  function_search_path_mutable   public.update_trade_outcomes_updated_at()
--   WARN  anon/authenticated can EXECUTE SECURITY DEFINER functions:
--         handle_new_user(), handle_updated_at(), has_role(uuid, app_role),
--         touch_updated_at(), update_updated_at_column(), upsert_account_metrics(uuid)
--
-- Why the views regressed: 20260204215045 set security_invoker = true, then
-- 20260305015408_fix_numeric_precision re-ran CREATE OR REPLACE VIEW without
-- WITH (security_invoker = true), which silently dropped the option.
-- RULE GOING FORWARD: every CREATE OR REPLACE VIEW in public must carry
-- WITH (security_invoker = true).
--
-- Privilege model after this migration:
--   has_role(uuid, app_role)      authenticated + service_role (user_roles RLS needs it)
--   upsert_account_metrics(uuid)  service_role only (core-node api/server.ts)
--   trigger functions             no API role (EXECUTE is not checked at trigger fire time)
--
-- Idempotent + defensive; final block asserts invariants.
-- Intentionally untouched: public.agentic_heartbeats (belongs to another system).
-- =============================================================================

-- 1. Views: SECURITY INVOKER, and no anon access.
DO $$
DECLARE
  v_name text;
BEGIN
  FOREACH v_name IN ARRAY ARRAY['ml_training_data', 'strategy_regime_performance', 'daily_trade_summary']
  LOOP
    IF EXISTS (
      SELECT 1
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = v_name AND c.relkind = 'v'
    ) THEN
      EXECUTE format('ALTER VIEW public.%I SET (security_invoker = true)', v_name);
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        EXECUTE format('REVOKE ALL ON public.%I FROM anon', v_name);
      END IF;
      RAISE NOTICE '[security_hardening] view public.%: security_invoker=true, anon revoked', v_name;
    ELSE
      RAISE NOTICE '[security_hardening] view public.% not found - skipped', v_name;
    END IF;
  END LOOP;
END $$;

-- 2. Pin search_path on every function in scope.
DO $$
DECLARE
  v_sig text;
  v_fn  regprocedure;
BEGIN
  FOREACH v_sig IN ARRAY ARRAY[
    'public.update_trade_outcomes_updated_at()',
    'public.handle_new_user()',
    'public.handle_updated_at()',
    'public.touch_updated_at()',
    'public.update_updated_at_column()',
    'public.has_role(uuid, public.app_role)',
    'public.upsert_account_metrics(uuid)'
  ]
  LOOP
    BEGIN
      v_fn := to_regprocedure(v_sig);
    EXCEPTION WHEN OTHERS THEN
      v_fn := NULL;
    END;
    IF v_fn IS NULL THEN
      RAISE NOTICE '[security_hardening] function % not found - skipped', v_sig;
      CONTINUE;
    END IF;
    EXECUTE format('ALTER FUNCTION %s SET search_path = public, pg_temp', v_fn);
  END LOOP;
END $$;

-- 3a. Trigger functions + service-only RPC: revoke from PUBLIC, anon, authenticated.
DO $$
DECLARE
  v_sig  text;
  v_fn   regprocedure;
  v_role text;
BEGIN
  FOREACH v_sig IN ARRAY ARRAY[
    'public.handle_new_user()',
    'public.handle_updated_at()',
    'public.touch_updated_at()',
    'public.update_updated_at_column()',
    'public.update_trade_outcomes_updated_at()',
    'public.upsert_account_metrics(uuid)'
  ]
  LOOP
    BEGIN
      v_fn := to_regprocedure(v_sig);
    EXCEPTION WHEN OTHERS THEN
      v_fn := NULL;
    END;
    IF v_fn IS NULL THEN
      CONTINUE;
    END IF;

    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', v_fn);
    FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated']
    LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_role) THEN
        EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM %I', v_fn, v_role);
      END IF;
    END LOOP;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', v_fn);
    END IF;
  END LOOP;
END $$;

-- 3b. has_role(uuid, app_role): keep authenticated (RLS needs it), revoke anon.
DO $$
DECLARE
  v_fn          regprocedure;
  v_pol         record;
  v_anon_users  text;
BEGIN
  BEGIN
    v_fn := to_regprocedure('public.has_role(uuid, public.app_role)');
  EXCEPTION WHEN OTHERS THEN
    v_fn := NULL;
  END;
  IF v_fn IS NULL THEN
    RAISE NOTICE '[security_hardening] has_role(uuid, app_role) not found - skipped';
    RETURN;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', v_fn);
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', v_fn);
  END IF;

  FOR v_pol IN
    SELECT policyname
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'user_roles'
      AND policyname IN ('user_roles_select', 'user_roles_insert_admin',
                         'user_roles_update_admin', 'user_roles_delete_admin')
      AND roles && ARRAY['public', 'anon']::name[]
  LOOP
    EXECUTE format('ALTER POLICY %I ON public.user_roles TO authenticated', v_pol.policyname);
    RAISE NOTICE '[security_hardening] policy public.user_roles.% scoped TO authenticated', v_pol.policyname;
  END LOOP;

  SELECT string_agg(format('%I.%I:%I', schemaname, tablename, policyname), ', ')
    INTO v_anon_users
  FROM pg_policies
  WHERE (coalesce(qual, '') ILIKE '%has_role(%' OR coalesce(with_check, '') ILIKE '%has_role(%')
    AND roles && ARRAY['public', 'anon']::name[];

  IF v_anon_users IS NOT NULL THEN
    RAISE WARNING '[security_hardening] has_role NOT revoked from anon; still evaluated for anon by: %', v_anon_users;
  ELSE
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', v_fn);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM anon', v_fn);
    END IF;
  END IF;
END $$;

-- 4. Post-conditions.
DO $$
DECLARE
  v_bad text;
  v_sig text;
  v_fn  regprocedure;
BEGIN
  SELECT string_agg(c.relname, ', ')
    INTO v_bad
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relkind = 'v'
    AND c.relname IN ('ml_training_data', 'strategy_regime_performance', 'daily_trade_summary')
    AND NOT EXISTS (
      SELECT 1 FROM unnest(coalesce(c.reloptions, '{}'::text[])) AS o(opt)
      WHERE lower(o.opt) IN ('security_invoker=true', 'security_invoker=on', 'security_invoker=1')
    );
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION '[security_hardening] views still SECURITY DEFINER: %', v_bad;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    FOREACH v_sig IN ARRAY ARRAY[
      'public.handle_new_user()',
      'public.handle_updated_at()',
      'public.touch_updated_at()',
      'public.update_updated_at_column()',
      'public.update_trade_outcomes_updated_at()',
      'public.upsert_account_metrics(uuid)'
    ]
    LOOP
      BEGIN
        v_fn := to_regprocedure(v_sig);
      EXCEPTION WHEN OTHERS THEN
        v_fn := NULL;
      END;
      IF v_fn IS NOT NULL AND has_function_privilege('anon', v_fn, 'EXECUTE') THEN
        RAISE EXCEPTION '[security_hardening] anon can still EXECUTE %', v_fn;
      END IF;
    END LOOP;
  END IF;
END $$;