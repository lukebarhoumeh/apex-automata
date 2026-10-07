-- Pulled 2026-10-07 from hosted supabase_migrations.schema_migrations (version 20260924171619)
-- for repo<->remote parity. Originally applied via MCP by the CB-TREND sleeve workstream.

alter table public.agentic_intents
  add column if not exists seq int not null default 0,
  add column if not exists depends_on text[] not null default '{}',
  add column if not exists snapshot_version bigint,
  add column if not exists expires_at timestamptz;
alter table public.agentic_intents drop constraint if exists agentic_intents_status_check;
alter table public.agentic_intents add constraint agentic_intents_status_check
  check (status in ('planned','submitted','acknowledged','open','filled','partial','cancelled','rejected','unknown','stale','expired','skipped','reconciled','unconfirmed'));

create or replace function public.submit_intent(p_sleeve text, p_client_order_id text, p_token uuid)
returns boolean language plpgsql security definer as $$
declare v_ok boolean;
begin
  select (c.lease_token = p_token and c.lease_expires_at > now()) into v_ok from public.agentic_control c where c.sleeve = p_sleeve;
  if not coalesce(v_ok, false) then return false; end if;
  update public.agentic_intents set status = 'submitted', lease_token = p_token, updated_at = now()
   where sleeve = p_sleeve and client_order_id = p_client_order_id and status = 'planned';
  return found;
end $$;

create or replace function public.expire_intents(p_sleeve text)
returns int language plpgsql security definer as $$
declare n int;
begin
  update public.agentic_intents set status = 'expired', updated_at = now()
   where sleeve = p_sleeve and status = 'planned' and expires_at is not null and expires_at < now();
  get diagnostics n = row_count; return n;
end $$;

create table if not exists public.cb_venue_snapshot (
  sleeve text primary key,
  version bigint not null default 0,
  snapshot jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.cb_venue_snapshot enable row level security;
create or replace function public.cb_snapshot_put(p_sleeve text, p_snapshot jsonb)
returns bigint language plpgsql security definer as $$
declare v bigint;
begin
  insert into public.cb_venue_snapshot(sleeve, version, snapshot) values (p_sleeve, 1, p_snapshot)
  on conflict (sleeve) do update set version = public.cb_venue_snapshot.version + 1, snapshot = excluded.snapshot, updated_at = now()
  returning version into v;
  return v;
end $$;

insert into public.agentic_control_log(sleeve, action, actor, reason, payload)
values ('coinbase', 'schema', 'claude-2026-09-24', 'plan v2.1: executor fence (submit_intent), expire_intents, cb_venue_snapshot, intent deps/TTL', jsonb_build_object('migration','003_executor_fence_snapshot'));
