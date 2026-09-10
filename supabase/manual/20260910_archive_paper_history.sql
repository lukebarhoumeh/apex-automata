-- =============================================================================
-- 20260910000002_archive_paper_history.sql
-- -----------------------------------------------------------------------------
-- PURPOSE
--   Move all pre-live PAPER history (Feb-Sep 2026) out of the live tables before
--   the first real-money session. Reasons:
--     * risk_metrics, daily_equity and account_metrics are keyed by user/date only
--       (no execution_mode). risk-engine.ts:378-417 and :594-610 would otherwise
--       seed LIVE risk state (kill switch, consecutive losses, day-start equity)
--       from paper rows.
--     * order-manager.ts hydrateOpenOrders() re-hydrates every orders row with
--       status new/working/partially_filled. That includes the stuck paper order
--       (status 'new' since 2026-05-13), which is archived and removed below.
--     * trade_log, trade_outcomes and the analytics views start clean for live data.
--
-- NON-DESTRUCTIVE / REVERSIBLE
--   1. Every matching row is COPIED to archive.<table>_paper_2026 first. The copy
--      has the same columns, and rows are refreshed on re-run (ON CONFLICT DO
--      UPDATE), so the archive always equals what was removed.
--   2. A public row is deleted only if its timestamp is < CUTOFF AND a copy with
--      the same primary key exists in the archive (checked in the same statement).
--   3. Before any delete, rows in ANY public table whose single-column FK
--      references an archived row are snapshotted (full row as jsonb) into
--      archive.fk_links_paper_2026. Those FKs would otherwise be lost to
--      ON DELETE SET NULL (journal_entries, orders.signal_id, ...).
--   4. Children are deleted before parents, so ON DELETE CASCADE never removes an
--      unarchived row (a fill on a pre-cutoff order is archived even if the fill
--      itself is newer).
--   5. Per-table counts are written to archive.paper_2026_manifest.
--   All copy, snapshot and delete work runs in ONE DO block, so it is atomic.
--   Any error rolls the whole block back.
--
--   RESTORE (parents first; use explicit column lists if public gained columns):
--     INSERT INTO public.<t> SELECT * FROM archive.<t>_paper_2026 ON CONFLICT DO NOTHING;
--     order: trading_sessions, signals, positions, orders, order_legs, fills,
--            trade_log, trade_outcomes, account_metrics, daily_equity,
--            risk_events, risk_metrics
--     Then re-apply FKs from archive.fk_links_paper_2026, for example:
--     UPDATE public.<src_table> s SET <fk_column> = (l.src_row->>'<fk_column>')::uuid
--       FROM archive.fk_links_paper_2026 l
--      WHERE l.src_table = '<src_table>' AND l.fk_column = '<fk_column>'
--        AND s.id = (l.src_row->>'id')::uuid;
--   If a restored order still has status 'new', set it to 'canceled' before
--   starting the engine.
--
-- CUTOFF: '2026-09-10T00:00:00Z' (literal below). Rows at or after it are not touched.
-- Idempotent: a re-run copies and deletes nothing new.
-- RUN WITH THE TRADING ENGINE STOPPED.
-- Tables added beyond the original 10 (with reasons):
--   order_legs   FK child of orders with ON DELETE CASCADE. Must be archived first.
--   risk_metrics One row per user, restored by risk-engine.ts:378-417 with no mode filter.
-- =============================================================================

CREATE SCHEMA IF NOT EXISTS archive;
REVOKE ALL ON SCHEMA archive FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON SCHEMA archive FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON SCHEMA archive FROM authenticated;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS archive.paper_2026_manifest (
  table_name          text        NOT NULL,
  cutoff              timestamptz NOT NULL,
  archived_row_count  bigint      NOT NULL,
  deleted_row_count   bigint      NOT NULL,
  run_at              timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS archive.fk_links_paper_2026 (
  src_table    text        NOT NULL,
  fk_column    text        NOT NULL,
  ref_table    text        NOT NULL,
  ref_value    text        NOT NULL,
  src_row      jsonb       NOT NULL,
  captured_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS fk_links_paper_2026_uidx
  ON archive.fk_links_paper_2026 (src_table, fk_column, ref_value, md5(src_row::text));

ALTER TABLE archive.paper_2026_manifest ENABLE ROW LEVEL SECURITY;
ALTER TABLE archive.fk_links_paper_2026 ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- Helpers (dropped at the end of this file)
-- ---------------------------------------------------------------------------

-- Primary-key column names of a table, in key order.
CREATE OR REPLACE FUNCTION archive._p26_pk(p_src regclass)
RETURNS text[]
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $fn$
  SELECT array_agg(a.attname::text ORDER BY k.ord)
  FROM pg_index i
  CROSS JOIN LATERAL unnest(i.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord)
  JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
  WHERE i.indrelid = p_src
    AND i.indisprimary
$fn$;

-- Row predicate over alias "t": first existing timestamp column < cutoff,
-- optionally OR'ed with an extra predicate.
CREATE OR REPLACE FUNCTION archive._p26_pred(
  p_src           regclass,
  p_ts_candidates text[],
  p_cutoff        timestamptz,
  p_extra_or      text
)
RETURNS text
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_ts text;
BEGIN
  SELECT u.c
    INTO v_ts
  FROM unnest(p_ts_candidates) WITH ORDINALITY AS u(c, ord)
  WHERE EXISTS (
    SELECT 1 FROM pg_attribute a
    WHERE a.attrelid = p_src AND a.attname = u.c AND a.attnum > 0 AND NOT a.attisdropped
  )
  ORDER BY u.ord
  LIMIT 1;

  IF v_ts IS NULL THEN
    RAISE EXCEPTION '[archive] % has none of the timestamp columns %', p_src, p_ts_candidates;
  END IF;

  RETURN format(
    '((t.%I < %L::timestamptz)%s)',
    v_ts,
    p_cutoff,
    CASE WHEN p_extra_or IS NULL THEN '' ELSE format(' OR (%s)', p_extra_or) END
  );
END
$fn$;

-- Copy matching rows into archive.<table>_paper_2026 (created on first use).
CREATE OR REPLACE FUNCTION archive._p26_copy(
  p_table         text,
  p_ts_candidates text[],
  p_cutoff        timestamptz,
  p_extra_or      text DEFAULT NULL
)
RETURNS bigint
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_src   regclass := to_regclass(format('public.%I', p_table));
  v_arch  text     := p_table || '_paper_2026';
  v_pk    text[];
  v_keys  text;
  v_cols  text;
  v_tcols text;
  v_set   text;
  v_col   record;
  v_n     bigint;
BEGIN
  IF v_src IS NULL THEN
    RAISE NOTICE '[archive] public.% not found - skipped', p_table;
    RETURN 0;
  END IF;

  v_pk := archive._p26_pk(v_src);
  IF v_pk IS NULL THEN
    RAISE EXCEPTION '[archive] public.% has no primary key - refusing to archive', p_table;
  END IF;
  SELECT string_agg(quote_ident(k), ', ') INTO v_keys FROM unnest(v_pk) AS k;

  EXECUTE format('CREATE TABLE IF NOT EXISTS archive.%I AS SELECT * FROM public.%I WHERE false',
                 v_arch, p_table);

  -- Schema-drift safety on re-run: add columns that public gained since.
  FOR v_col IN
    SELECT a.attname, format_type(a.atttypid, a.atttypmod) AS typ
    FROM pg_attribute a
    WHERE a.attrelid = v_src AND a.attnum > 0 AND NOT a.attisdropped
      AND NOT EXISTS (
        SELECT 1 FROM pg_attribute b
        WHERE b.attrelid = to_regclass(format('archive.%I', v_arch))
          AND b.attname = a.attname AND b.attnum > 0 AND NOT b.attisdropped
      )
    ORDER BY a.attnum
  LOOP
    EXECUTE format('ALTER TABLE archive.%I ADD COLUMN %I %s', v_arch, v_col.attname, v_col.typ);
  END LOOP;

  EXECUTE format('ALTER TABLE archive.%I ENABLE ROW LEVEL SECURITY', v_arch);
  EXECUTE format('CREATE UNIQUE INDEX IF NOT EXISTS %I ON archive.%I (%s)',
                 v_arch || '_pk_uidx', v_arch, v_keys);

  SELECT string_agg(quote_ident(a.attname), ', ' ORDER BY a.attnum),
         string_agg('t.' || quote_ident(a.attname), ', ' ORDER BY a.attnum),
         string_agg(CASE WHEN a.attname::text = ANY (v_pk) THEN NULL
                         ELSE format('%1$I = EXCLUDED.%1$I', a.attname) END,
                    ', ' ORDER BY a.attnum)
    INTO v_cols, v_tcols, v_set
  FROM pg_attribute a
  WHERE a.attrelid = v_src AND a.attnum > 0 AND NOT a.attisdropped;

  EXECUTE format(
    'INSERT INTO archive.%I (%s) SELECT %s FROM public.%I t WHERE %s ON CONFLICT (%s) DO %s',
    v_arch, v_cols, v_tcols, p_table,
    archive._p26_pred(v_src, p_ts_candidates, p_cutoff, p_extra_or),
    v_keys,
    coalesce('UPDATE SET ' || v_set, 'NOTHING')
  );
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RAISE NOTICE '[archive] public.% -> archive.%: % row(s) copied', p_table, v_arch, v_n;
  RETURN v_n;
END
$fn$;

-- Delete matching rows from public, but only those whose PK exists in the archive.
CREATE OR REPLACE FUNCTION archive._p26_purge(
  p_table         text,
  p_ts_candidates text[],
  p_cutoff        timestamptz,
  p_extra_or      text DEFAULT NULL
)
RETURNS bigint
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_src  regclass := to_regclass(format('public.%I', p_table));
  v_arch text     := p_table || '_paper_2026';
  v_join text;
  v_n    bigint;
BEGIN
  IF v_src IS NULL OR to_regclass(format('archive.%I', v_arch)) IS NULL THEN
    RETURN 0;
  END IF;

  SELECT string_agg(format('a.%1$I = t.%1$I', k), ' AND ')
    INTO v_join
  FROM unnest(archive._p26_pk(v_src)) AS k;

  EXECUTE format(
    'DELETE FROM public.%I t WHERE %s AND EXISTS (SELECT 1 FROM archive.%I a WHERE %s)',
    p_table,
    archive._p26_pred(v_src, p_ts_candidates, p_cutoff, p_extra_or),
    v_arch,
    v_join
  );
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RAISE NOTICE '[archive] public.%: % row(s) deleted', p_table, v_n;
  RETURN v_n;
END
$fn$;

-- ---------------------------------------------------------------------------
-- Main work: copy -> FK snapshot -> delete (children first) -> manifest -> asserts
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  c_cutoff     CONSTANT timestamptz := '2026-09-10T00:00:00Z';
  v_old_orders text;
  p            record;
  fk           record;
  r            record;
  v_n          bigint;
BEGIN
  -- Children of orders are archived if THEY are old OR their parent order is old.
  -- This prevents ON DELETE CASCADE from removing an unarchived row.
  IF to_regclass('public.orders') IS NOT NULL THEN
    v_old_orders := format(
      't.order_id IN (SELECT o.id FROM public.orders o WHERE o.created_at < %L::timestamptz)',
      c_cutoff);
  END IF;

  IF to_regclass('pg_temp.p26_plan') IS NOT NULL THEN DROP TABLE pg_temp.p26_plan; END IF;
  CREATE TEMP TABLE p26_plan (
    ord           int PRIMARY KEY,
    table_name    text   NOT NULL,
    ts_candidates text[] NOT NULL,
    extra_or      text,
    archived      bigint NOT NULL DEFAULT 0,
    deleted       bigint NOT NULL DEFAULT 0
  ) ON COMMIT DROP;

  INSERT INTO p26_plan (ord, table_name, ts_candidates, extra_or) VALUES
    ( 1, 'trading_sessions', ARRAY['created_at', 'started_at'],         NULL),
    ( 2, 'signals',          ARRAY['created_at', 'decided_at'],         NULL),
    ( 3, 'positions',        ARRAY['created_at', 'opened_at'],          NULL),
    ( 4, 'orders',           ARRAY['created_at'],                       NULL),
    ( 5, 'order_legs',       ARRAY['created_at'],                       v_old_orders),
    ( 6, 'fills',            ARRAY['filled_at', 'created_at'],          v_old_orders),
    ( 7, 'trade_log',        ARRAY['created_at', 'entry_time'],         NULL),
    ( 8, 'trade_outcomes',   ARRAY['created_at', 'entry_time'],         NULL),
    ( 9, 'account_metrics',  ARRAY['created_at', 'updated_at', 'date'], NULL),
    (10, 'daily_equity',     ARRAY['created_at', 'date'],               NULL),
    (11, 'risk_events',      ARRAY['created_at', 'ts', 'occurred_at'],  NULL),
    (12, 'risk_metrics',     ARRAY['updated_at', 'created_at'],         NULL);

  -- Only apply the parent-order predicate where the child really has order_id.
  UPDATE p26_plan pl
     SET extra_or = NULL
   WHERE pl.extra_or IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM pg_attribute a
       WHERE a.attrelid = to_regclass(format('public.%I', pl.table_name))
         AND a.attname = 'order_id' AND a.attnum > 0 AND NOT a.attisdropped
     );

  -- Explicitly surface non-terminal paper orders (incl. the 'new' row stuck since
  -- 2026-05-13). hydrateOpenOrders() would load these into the live engine.
  IF to_regclass('public.orders') IS NOT NULL THEN
    FOR r IN
      SELECT id, status::text AS status, created_at
      FROM public.orders
      WHERE status::text IN ('new', 'working', 'partially_filled')
        AND created_at < c_cutoff
    LOOP
      RAISE NOTICE '[archive] non-terminal pre-live order archived + removed: id=% status=% created_at=%',
        r.id, r.status, r.created_at;
    END LOOP;
  END IF;

  -- Phase 1: copy.
  FOR p IN SELECT * FROM p26_plan ORDER BY ord LOOP
    v_n := archive._p26_copy(p.table_name, p.ts_candidates, c_cutoff, p.extra_or);
    UPDATE p26_plan SET archived = v_n WHERE ord = p.ord;
  END LOOP;

  -- Phase 2: snapshot every single-column FK that points at an archived row.
  FOR fk IN
    SELECT src.relname AS src_table, a_src.attname AS src_col,
           ref.relname AS ref_table, a_ref.attname AS ref_col
    FROM pg_constraint con
    JOIN pg_class src       ON src.oid  = con.conrelid
    JOIN pg_namespace nsrc  ON nsrc.oid = src.relnamespace
    JOIN pg_class ref       ON ref.oid  = con.confrelid
    JOIN pg_namespace nref  ON nref.oid = ref.relnamespace
    JOIN pg_attribute a_src ON a_src.attrelid = con.conrelid  AND a_src.attnum = con.conkey[1]
    JOIN pg_attribute a_ref ON a_ref.attrelid = con.confrelid AND a_ref.attnum = con.confkey[1]
    WHERE con.contype = 'f'
      AND nsrc.nspname = 'public'
      AND nref.nspname = 'public'
      AND cardinality(con.conkey) = 1
      AND ref.relname IN (SELECT table_name FROM p26_plan)
      AND to_regclass(format('archive.%I', ref.relname || '_paper_2026')) IS NOT NULL
  LOOP
    EXECUTE format(
      'INSERT INTO archive.fk_links_paper_2026 (src_table, fk_column, ref_table, ref_value, src_row)
       SELECT %L, %L, %L, s.%I::text, to_jsonb(s)
       FROM public.%I s
       WHERE s.%I IS NOT NULL
         AND EXISTS (SELECT 1 FROM archive.%I a WHERE a.%I = s.%I)
       ON CONFLICT DO NOTHING',
      fk.src_table, fk.src_col, fk.ref_table, fk.src_col,
      fk.src_table,
      fk.src_col,
      fk.ref_table || '_paper_2026', fk.ref_col, fk.src_col
    );
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n > 0 THEN
      RAISE NOTICE '[archive] FK snapshot %.% -> %: % row(s)', fk.src_table, fk.src_col, fk.ref_table, v_n;
    END IF;
  END LOOP;

  -- Phase 3: delete, children before parents (reverse plan order).
  FOR p IN SELECT * FROM p26_plan ORDER BY ord DESC LOOP
    -- Nested IFs: the EXISTS must not be planned when a table is missing.
    IF p.table_name = 'orders'
       AND to_regclass('public.orders') IS NOT NULL
       AND to_regclass('public.fills') IS NOT NULL
    THEN
      IF EXISTS (
        SELECT 1 FROM public.fills f
        JOIN public.orders o ON o.id = f.order_id
        WHERE o.created_at < c_cutoff
      ) THEN
        RAISE EXCEPTION '[archive] fills still reference pre-cutoff orders; refusing cascade delete';
      END IF;
    END IF;

    v_n := archive._p26_purge(p.table_name, p.ts_candidates, c_cutoff, p.extra_or);
    UPDATE p26_plan SET deleted = v_n WHERE ord = p.ord;
  END LOOP;

  -- Phase 4: manifest.
  INSERT INTO archive.paper_2026_manifest (table_name, cutoff, archived_row_count, deleted_row_count)
  SELECT table_name, c_cutoff, archived, deleted
  FROM p26_plan
  ORDER BY ord;

  -- Phase 5: post-conditions.
  -- Within one run every copied row must also be deleted. A mismatch means RLS
  -- (FORCE), a DELETE trigger or a rule suppressed deletes: roll back.
  IF EXISTS (SELECT 1 FROM p26_plan WHERE deleted <> archived) THEN
    RAISE EXCEPTION '[archive] archived/deleted mismatch: %',
      (SELECT string_agg(format('%s(archived=%s deleted=%s)', table_name, archived, deleted), ', ')
       FROM p26_plan WHERE deleted <> archived);
  END IF;

  IF to_regclass('public.orders') IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM public.orders WHERE created_at < c_cutoff) THEN
      RAISE EXCEPTION '[archive] pre-cutoff rows remain in public.orders';
    END IF;
    FOR r IN
      SELECT id, status::text AS status, created_at
      FROM public.orders
      WHERE status::text IN ('new', 'working', 'partially_filled')
    LOOP
      RAISE WARNING '[archive] non-terminal order at/after cutoff remains (hydrateOpenOrders will load it): id=% status=% created_at=%',
        r.id, r.status, r.created_at;
    END LOOP;
  END IF;
END $$;

-- Lock the archive down. It is not exposed via PostgREST, so this is defense in depth.
DO $$
BEGIN
  REVOKE ALL ON ALL TABLES IN SCHEMA archive FROM PUBLIC;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON ALL TABLES IN SCHEMA archive FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON ALL TABLES IN SCHEMA archive FROM authenticated;
  END IF;
END $$;

DROP FUNCTION IF EXISTS archive._p26_purge(text, text[], timestamptz, text);
DROP FUNCTION IF EXISTS archive._p26_copy(text, text[], timestamptz, text);
DROP FUNCTION IF EXISTS archive._p26_pred(regclass, text[], timestamptz, text);
DROP FUNCTION IF EXISTS archive._p26_pk(regclass);
