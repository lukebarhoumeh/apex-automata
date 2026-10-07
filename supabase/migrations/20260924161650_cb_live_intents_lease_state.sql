-- Pulled 2026-10-07 from hosted supabase_migrations.schema_migrations (version 20260924161650)
-- for repo<->remote parity. Originally applied via MCP by the CB-TREND sleeve workstream.

-- cb_live plan v2.0 control plane (2026-09-24): order-authority lease, intent ledger, state document.
alter table public.agentic_control
  add column if not exists lease_holder text,
  add column if not exists lease_token uuid,
  add column if not exists lease_expires_at timestamptz;

create or replace function public.acquire_lease(p_sleeve text, p_holder text, p_ttl_seconds int)
returns uuid language plpgsql security definer as $$
declare v_token uuid := gen_random_uuid();
begin
  update public.agentic_control
     set lease_holder = p_holder, lease_token = v_token, lease_expires_at = now() + make_interval(secs => p_ttl_seconds), updated_at = now()
   where sleeve = p_sleeve
     and (lease_expires_at is null or lease_expires_at < now() or lease_holder = p_holder);
  if not found then return null; end if;
  insert into public.agentic_control_log(sleeve, action, actor, reason, payload)
       values (p_sleeve, 'lease_acquired', p_holder, null, jsonb_build_object('token', v_token, 'ttl_s', p_ttl_seconds));
  return v_token;
end $$;

create or replace function public.release_lease(p_sleeve text, p_token uuid)
returns boolean language plpgsql security definer as $$
begin
  update public.agentic_control set lease_holder = null, lease_token = null, lease_expires_at = null, updated_at = now()
   where sleeve = p_sleeve and lease_token = p_token;
  return found;
end $$;

create table if not exists public.agentic_intents (
  id bigserial primary key,
  sleeve text not null default 'coinbase',
  cycle_ts timestamptz not null,
  client_order_id text not null unique,
  action text not null check (action in ('ENTER','EXIT','PROTECT','CANCEL','ROLLCLOSE','ROLLOPEN','FLATTEN')),
  coin text not null, product_id text not null, side text not null, contracts int not null,
  ref_price numeric, stop_price numeric, tp_price numeric, limit_price numeric, notional_usd numeric,
  status text not null default 'planned' check (status in ('planned','submitted','acknowledged','open','filled','partial','cancelled','rejected','reconciled','unconfirmed')),
  venue_order_id text, child_order_ids jsonb, filled int, fill_vwap numeric, fees_usd numeric,
  submitted_by text, lease_token uuid, payload jsonb not null, result jsonb,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index if not exists agentic_intents_cycle_idx on public.agentic_intents (sleeve, cycle_ts desc);
create index if not exists agentic_intents_status_idx on public.agentic_intents (sleeve, status);

create table if not exists public.cb_state (
  sleeve text primary key,
  version int not null default 0,
  state jsonb not null,
  updated_by text, updated_at timestamptz not null default now()
);
create or replace function public.cb_state_put(p_sleeve text, p_expected_version int, p_state jsonb, p_by text)
returns int language plpgsql security definer as $$
declare v_new int;
begin
  insert into public.cb_state(sleeve, version, state, updated_by) values (p_sleeve, 1, p_state, p_by)
  on conflict (sleeve) do update set version = public.cb_state.version + 1, state = excluded.state, updated_by = excluded.updated_by, updated_at = now()
  where public.cb_state.version = p_expected_version
  returning version into v_new;
  if v_new is null then raise exception 'cb_state version conflict for % (expected %)', p_sleeve, p_expected_version; end if;
  return v_new;
end $$;

alter table public.agentic_intents enable row level security;
alter table public.cb_state enable row level security;

insert into public.cb_state(sleeve, version, state, updated_by)
values ('coinbase', 1, jsonb_build_object('version','2.0','positions','{}'::jsonb,'rule_long','{}'::jsonb,'closed_trades','[]'::jsonb,'ladder', jsonb_build_object('tier',0),'enacted_at',null), 'claude-2026-09-24')
on conflict (sleeve) do nothing;

insert into public.agentic_control_log(sleeve, action, actor, reason, payload)
values ('coinbase', 'schema', 'claude-2026-09-24', 'plan v2.0 control plane: lease, intents, state', jsonb_build_object('migration','002_intents_lease_state'));
