-- Phase 1 (2026-10-19): market_context_bars — per-closed-bar context snapshot
-- for CFM paper venue. The engine writes one row per closed bar with basis,
-- funding, and price context for post-trade analysis.
-- DO NOT APPLY — ships as a migration file only (no DDL applied to Supabase).

create table if not exists public.market_context_bars (
  id              bigint generated always as identity primary key,
  symbol          text        not null,
  venue           text        not null,
  timeframe       int         not null,
  bar_ts          timestamptz not null,
  funding_rate    numeric(20,8),
  spot_price      numeric(20,8),
  futures_price   numeric(20,8),
  basis_bps       numeric(12,4),
  session_id      uuid,
  execution_mode  text        not null default 'paper',
  created_at      timestamptz not null default now()
);

comment on table public.market_context_bars is
  'Per-closed-bar market context snapshot (Phase 1 CFM paper venue). One row per closed bar per symbol.';

alter table public.market_context_bars enable row level security;

create policy market_context_bars_read_public
  on public.market_context_bars for select
  to authenticated
  using (true);

create index if not exists idx_market_context_bars_symbol_bar_ts
  on public.market_context_bars (symbol, bar_ts desc);

create index if not exists idx_market_context_bars_session
  on public.market_context_bars (session_id)
  where session_id is not null;
