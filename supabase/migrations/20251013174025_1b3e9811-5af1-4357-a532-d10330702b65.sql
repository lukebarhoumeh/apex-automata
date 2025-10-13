-- Extensions
create extension if not exists pgcrypto;

-- ========== ENUMS ==========
do $$ begin
  create type order_side as enum ('buy','sell');
exception when duplicate_object then null; end $$;

do $$ begin
  create type position_side as enum ('long','short');
exception when duplicate_object then null; end $$;

do $$ begin
  create type order_status as enum ('new','working','partially_filled','filled','canceled','rejected','expired');
exception when duplicate_object then null; end $$;

do $$ begin
  create type order_type as enum ('limit','market','ioc','twap_parent','twap_child','post_only','stop','take_profit');
exception when duplicate_object then null; end $$;

do $$ begin
  create type trade_exit_reason as enum ('take_profit','stop_loss','time_stop','manual_exit','daily_stop','kill_switch');
exception when duplicate_object then null; end $$;

do $$ begin
  create type strategy_name as enum ('breakout','vwap_mr','obi_scalper');
exception when duplicate_object then null; end $$;

do $$ begin
  create type alert_severity as enum ('info','warning','critical');
exception when duplicate_object then null; end $$;

-- ========== TABLES ==========

-- Symbols (tradable markets)
create table if not exists symbols (
  id uuid primary key default gen_random_uuid(),
  symbol text unique not null,
  base_asset text not null,
  quote_asset text not null,
  tick_size numeric not null default 0.01,
  lot_size numeric not null default 0.0001,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- Strategies registry
create table if not exists strategies (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name strategy_name not null,
  version integer not null default 1,
  enabled boolean not null default true,
  default_params jsonb not null default '{}',
  created_at timestamptz not null default now(),
  unique (user_id, name, version)
);

-- Signal decisions
create table if not exists signals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  symbol text not null references symbols(symbol),
  strategy strategy_name not null,
  decided_at timestamptz not null default now(),
  side position_side not null,
  score numeric not null,
  confidence numeric not null,
  meta_prob numeric,
  features jsonb,
  allowed boolean not null default false,
  reason text,
  created_at timestamptz not null default now()
);

-- Orders (parent level)
create table if not exists orders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  external_order_id text,
  signal_id uuid references signals(id) on delete set null,
  strategy strategy_name not null,
  symbol text not null references symbols(symbol),
  side order_side not null,
  type order_type not null,
  status order_status not null default 'new',
  price numeric,
  stop_price numeric,
  quantity numeric not null,
  post_only boolean not null default false,
  time_in_force text,
  meta_prob numeric,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Order legs (child orders)
create table if not exists order_legs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  order_id uuid not null references orders(id) on delete cascade,
  external_order_id text,
  type order_type not null,
  status order_status not null default 'new',
  price numeric,
  quantity numeric not null,
  slippage_bps numeric,
  maker boolean,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Exchange fills
create table if not exists fills (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  order_leg_id uuid references order_legs(id) on delete set null,
  order_id uuid not null references orders(id) on delete cascade,
  trade_id text,
  price numeric not null,
  quantity numeric not null,
  fee_currency text,
  fee_amount numeric default 0,
  maker boolean,
  slippage_bps numeric,
  filled_at timestamptz not null
);

-- Update positions table with new structure
drop table if exists positions cascade;
create table positions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  symbol text not null references symbols(symbol),
  strategy strategy_name not null,
  side position_side not null,
  qty_open numeric not null,
  entry_price numeric not null,
  stop_price_at_entry numeric not null,
  take_profit_price numeric,
  opened_at timestamptz not null default now(),
  closed_at timestamptz,
  exit_price numeric,
  exit_reason trade_exit_reason,
  realized_pnl_usd numeric,
  realized_r numeric generated always as (
    case
      when closed_at is null or stop_price_at_entry is null then null
      when side = 'long' and exit_price is not null
        then (exit_price - entry_price) / nullif(abs(entry_price - stop_price_at_entry), 0)
      when side = 'short' and exit_price is not null
        then (entry_price - exit_price) / nullif(abs(entry_price - stop_price_at_entry), 0)
      else null
    end
  ) stored,
  created_at timestamptz not null default now()
);

-- Risk events
create table if not exists risk_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  event_type text not null,
  details jsonb,
  active boolean not null default true,
  triggered_at timestamptz not null default now(),
  cleared_at timestamptz
);

-- Alerts
create table if not exists alerts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  severity alert_severity not null default 'info',
  title text not null,
  message text,
  data jsonb,
  created_at timestamptz not null default now(),
  acked_at timestamptz
);

-- Models registry
create table if not exists models (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null default 'metalabel',
  version text not null,
  path text not null,
  sha256 text,
  input_schema jsonb,
  metrics jsonb,
  active boolean not null default false,
  created_at timestamptz not null default now(),
  unique (user_id, name, version)
);

-- Journal entries
create table if not exists journal_entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  position_id uuid references positions(id) on delete set null,
  order_id uuid references orders(id) on delete set null,
  signal_id uuid references signals(id) on delete set null,
  title text,
  note text,
  attachments text[],
  created_at timestamptz not null default now()
);

-- Metrics intraday (optional, for charts)
create table if not exists metrics_intraday (
  id bigserial primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  symbol text references symbols(symbol),
  metric text not null,
  value numeric not null,
  bucket_start timestamptz not null,
  created_at timestamptz not null default now()
);

-- ========== INDEXES ==========
create index if not exists idx_signals_user_time on signals(user_id, decided_at desc);
create index if not exists idx_signals_symbol on signals(symbol);
create index if not exists idx_orders_user_time on orders(user_id, created_at desc);
create index if not exists idx_orders_symbol on orders(symbol);
create index if not exists idx_orders_status on orders(status);
create index if not exists idx_order_legs_order on order_legs(order_id);
create index if not exists idx_fills_order on fills(order_id);
create index if not exists idx_fills_time on fills(filled_at desc);
create index if not exists idx_positions_open on positions(user_id, symbol) where closed_at is null;
create index if not exists idx_positions_closed on positions(user_id, closed_at desc);
create index if not exists idx_risk_events_active on risk_events(user_id, active);
create index if not exists idx_alerts_time on alerts(user_id, created_at desc);
create index if not exists idx_metrics_user_series on metrics_intraday(user_id, symbol, metric, bucket_start desc);

-- ========== RLS ==========
alter table symbols enable row level security;
alter table strategies enable row level security;
alter table signals enable row level security;
alter table orders enable row level security;
alter table order_legs enable row level security;
alter table fills enable row level security;
alter table positions enable row level security;
alter table risk_events enable row level security;
alter table alerts enable row level security;
alter table models enable row level security;
alter table journal_entries enable row level security;
alter table metrics_intraday enable row level security;

-- Symbols are globally readable
create policy "symbols_read_all" on symbols
  for select using (true);

-- User-scoped policies
create policy "strategies_rw_own" on strategies
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy "signals_rw_own" on signals
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy "orders_rw_own" on orders
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy "order_legs_rw_own" on order_legs
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy "fills_rw_own" on fills
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy "positions_rw_own" on positions
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy "risk_events_rw_own" on risk_events
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy "alerts_rw_own" on alerts
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy "models_rw_own" on models
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy "journal_entries_rw_own" on journal_entries
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy "metrics_intraday_rw_own" on metrics_intraday
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ========== VIEWS ==========
create or replace view v_open_positions as
select
  p.id as position_id,
  p.user_id,
  p.symbol,
  p.strategy,
  p.side,
  p.qty_open,
  p.entry_price,
  p.stop_price_at_entry,
  p.take_profit_price,
  p.opened_at
from positions p
where p.closed_at is null;

create or replace view v_recent_activity as
select
  o.id as order_id,
  o.created_at,
  o.symbol,
  o.side,
  o.type,
  o.status,
  o.price,
  o.quantity,
  coalesce(sum(f.quantity), 0) as filled_qty,
  count(f.id) as fill_count
from orders o
left join fills f on f.order_id = o.id
group by o.id
order by o.created_at desc;

create or replace view v_daily_r as
select
  user_id,
  date_trunc('day', coalesce(closed_at, opened_at))::date as day,
  sum(coalesce(realized_r, 0)) as daily_r
from positions
where closed_at is not null
group by 1,2
order by 2 desc;

create or replace view v_signal_funnel as
select
  user_id,
  date_trunc('hour', decided_at) as hour,
  count(*) filter (where allowed = false) as rejected,
  count(*) filter (where allowed = true) as allowed
from signals
group by 1,2
order by 2 desc;

-- ========== TRIGGERS ==========
create or replace function touch_updated_at() returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists trg_orders_touch on orders;
create trigger trg_orders_touch before update on orders
for each row execute procedure touch_updated_at();

drop trigger if exists trg_order_legs_touch on order_legs;
create trigger trg_order_legs_touch before update on order_legs
for each row execute procedure touch_updated_at();

-- Enable realtime for key tables
alter publication supabase_realtime add table positions;
alter publication supabase_realtime add table orders;
alter publication supabase_realtime add table fills;
alter publication supabase_realtime add table risk_events;
alter publication supabase_realtime add table alerts;