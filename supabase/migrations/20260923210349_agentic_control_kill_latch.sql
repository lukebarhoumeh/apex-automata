-- Pulled 2026-10-07 from hosted supabase_migrations.schema_migrations (version 20260923210349)
-- for repo<->remote parity. Originally applied via MCP by the CB-TREND sleeve workstream.

-- Kill latch + dial for the autonomous sleeves. Written by the external watchdog (Apex-hosted) and by Luke via Claude;
-- read by every CB-Trend / CB-Protect cycle at start. A latched halt can only be cleared by a human (cleared_by).
create table if not exists public.agentic_control (
  sleeve        text primary key,                  -- 'coinbase' | 'robinhood'
  halt          boolean not null default false,    -- true = no new entries (exits/stops still run); latched until cleared
  flatten       boolean not null default false,    -- true = close everything at the next cycle, then stay halted
  dial          numeric not null default 1.0,      -- gross-notional dial: 0.5 ramp / 1.0 default / 1.5 promotion
  reason        text,
  set_by        text,                              -- 'watchdog' | 'claude' | 'luke'
  set_at        timestamptz not null default now(),
  cleared_by    text,
  cleared_at    timestamptz,
  hwm_equity    numeric,                           -- high-water mark since the last CLEAR (ladder reference)
  hwm_set_at    timestamptz,
  updated_at    timestamptz not null default now()
);
create table if not exists public.agentic_control_log (
  id          bigserial primary key,
  ts          timestamptz not null default now(),
  sleeve      text not null,
  action      text not null,                        -- 'halt' | 'flatten' | 'clear' | 'dial' | 'hwm'
  actor       text not null,
  reason      text,
  payload     jsonb
);
alter table public.agentic_control enable row level security;
alter table public.agentic_control_log enable row level security;
insert into public.agentic_control (sleeve, halt, flatten, dial, reason, set_by, hwm_equity)
values ('coinbase', true, false, 0.0, 'pre-enactment: canary not run, no live cycles authorised', 'claude', null)
on conflict (sleeve) do nothing;
insert into public.agentic_control_log (sleeve, action, actor, reason) values ('coinbase', 'halt', 'claude', 'table created; sleeve halted until canary + Luke go');
