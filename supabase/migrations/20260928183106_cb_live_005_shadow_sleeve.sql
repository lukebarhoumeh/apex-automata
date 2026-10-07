-- Pulled 2026-10-07 from hosted supabase_migrations.schema_migrations (version 20260928183106)
-- for repo<->remote parity. Originally applied via MCP by the CB-TREND sleeve workstream.

-- 005_shadow_sleeve.sql — cb_live v2.4 (Astra v4 audit 2026-09-25, inspection item "separate shadow from live state"; applied 2026-09-28)
-- The paper shadow service runs on its OWN sleeve ('coinbase-shadow'): its own control row (halt=false, dial=1.0 so paper entries are allowed),
-- its own versioned state document, and — through the existing sleeve-keyed tables — its own intents, venue snapshots, heartbeats and log rows.
-- The live sleeve 'coinbase' is untouched by this migration and stays halt=true, dial=0.0.
-- Rollback: delete from public.cb_state where sleeve='coinbase-shadow'; delete from public.agentic_control where sleeve='coinbase-shadow';

insert into public.agentic_control (sleeve, halt, flatten, dial, reason, set_by, set_at, updated_at)
values ('coinbase-shadow', false, false, 1.0, 'paper shadow namespace (v2.4): paper venue, no venue key, entries allowed at dial 1.0', 'claude', now(), now())
on conflict (sleeve) do nothing;

insert into public.cb_state (sleeve, version, state, updated_by, updated_at)
values ('coinbase-shadow', 1,
        jsonb_build_object('version', '2.4', 'positions', '{}'::jsonb, 'rule_long', '{}'::jsonb, 'closed_trades', '[]'::jsonb,
                           'ladder', jsonb_build_object('hwm', 5000, 'flatten_hwm', 5000, 'lifetime_hwm', 5000, 'tier', 0),
                           'regime', jsonb_build_object('on', false, 'at', null), 'gen', 0, 'halt_reasons', '{}'::jsonb, 'pending_flatten', '{}'::jsonb,
                           'enacted_at', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"+00:00"')),
        'claude', now())
on conflict (sleeve) do nothing;

insert into public.agentic_control_log (sleeve, action, actor, reason)
values ('coinbase-shadow', 'sleeve_created', 'claude', 'migration 005: paper shadow namespace, halt=false dial=1.0; live sleeve untouched');
