-- Reconciliation stub for migration version 20260902202325 (name
-- agentic_heartbeats) already recorded in supabase_migrations.schema_migrations
-- on the linked project. The table was created outside this repo by the
-- equity/agentic ops process; this file exists so the local chain matches the
-- remote history (Supabase Preview fails on remote-only versions).
--
-- Version stamp MUST stay 20260902202325 to match the applied orphan. Do not
-- rename. Body is idempotent (IF NOT EXISTS) so re-application is a no-op.
-- Follow-up 20260910180300 moves this table into the `equity` schema.

CREATE SEQUENCE IF NOT EXISTS public.agentic_heartbeats_id_seq;

CREATE TABLE IF NOT EXISTS public.agentic_heartbeats (
  id bigint NOT NULL DEFAULT nextval('public.agentic_heartbeats_id_seq'::regclass),
  ts timestamptz NOT NULL DEFAULT now(),
  cycle text NOT NULL,
  event text NOT NULL,
  session text NULL,
  fire_ts timestamptz NULL,
  positions integer NULL,
  stops_ok boolean NULL,
  fills_protected integer NULL DEFAULT 0,
  orders integer NULL DEFAULT 0,
  equity numeric(12,2) NULL,
  note text NULL,
  CONSTRAINT agentic_heartbeats_pkey PRIMARY KEY (id)
);

ALTER SEQUENCE public.agentic_heartbeats_id_seq OWNED BY public.agentic_heartbeats.id;

CREATE INDEX IF NOT EXISTS agentic_heartbeats_ts_idx ON public.agentic_heartbeats USING btree (ts DESC);
CREATE INDEX IF NOT EXISTS agentic_heartbeats_cycle_ts_idx ON public.agentic_heartbeats USING btree (cycle, ts DESC);

ALTER TABLE public.agentic_heartbeats ENABLE ROW LEVEL SECURITY;

GRANT ALL ON TABLE public.agentic_heartbeats TO postgres;
GRANT ALL ON TABLE public.agentic_heartbeats TO service_role;
GRANT ALL ON TABLE public.agentic_heartbeats TO authenticated;
GRANT ALL ON TABLE public.agentic_heartbeats TO anon;
GRANT USAGE, SELECT ON SEQUENCE public.agentic_heartbeats_id_seq TO postgres, service_role, authenticated, anon;
