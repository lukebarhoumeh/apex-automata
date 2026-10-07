-- Pulled 2026-10-07 from hosted supabase_migrations.schema_migrations (version 20260925021711)
-- for repo<->remote parity. Originally applied via MCP by the CB-TREND sleeve workstream.

create or replace function public.request_halt(p_sleeve text, p_reason text, p_actor text default 'executor')
returns boolean language plpgsql security definer set search_path = public as $$
begin
  update public.agentic_control set halt = true, reason = p_reason, set_by = p_actor, set_at = now(), updated_at = now() where sleeve = p_sleeve;
  if not found then return false; end if;
  insert into public.agentic_control_log (sleeve, action, actor, reason) values (p_sleeve, 'halt_latched', p_actor, p_reason);
  return true;
end $$;

create or replace function public.clear_halt(p_sleeve text, p_by text, p_dial numeric default null)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  update public.agentic_control set halt = false, flatten = false, cleared_by = p_by, cleared_at = now(), dial = coalesce(p_dial, dial), updated_at = now() where sleeve = p_sleeve;
  if not found then return false; end if;
  insert into public.agentic_control_log (sleeve, action, actor, reason) values (p_sleeve, 'halt_cleared', p_by, coalesce('dial ' || p_dial::text, 'dial unchanged'));
  return true;
end $$;

revoke execute on function public.acquire_lease(text, text, integer) from public, anon, authenticated;
revoke execute on function public.release_lease(text, uuid) from public, anon, authenticated;
revoke execute on function public.submit_intent(text, text, uuid) from public, anon, authenticated;
revoke execute on function public.expire_intents(text) from public, anon, authenticated;
revoke execute on function public.cb_snapshot_put(text, jsonb) from public, anon, authenticated;
revoke execute on function public.cb_state_put(text, integer, jsonb, text) from public, anon, authenticated;
revoke execute on function public.request_halt(text, text, text) from public, anon, authenticated;
revoke execute on function public.clear_halt(text, text, numeric) from public, anon, authenticated;
grant execute on function public.acquire_lease(text, text, integer), public.release_lease(text, uuid), public.submit_intent(text, text, uuid), public.expire_intents(text),
  public.cb_snapshot_put(text, jsonb), public.cb_state_put(text, integer, jsonb, text), public.request_halt(text, text, text), public.clear_halt(text, text, numeric) to service_role;
