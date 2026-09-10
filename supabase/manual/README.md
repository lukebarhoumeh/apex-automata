# supabase/manual — hand-run scripts

Scripts here are **not migrations**. `supabase db push` and MCP `apply_migration` must never run them automatically. Each changes data, not schema, and has a specific moment to run.

| Script | When | Preconditions | Verify |
|---|---|---|---|
| `20260910_archive_paper_history.sql` | Right before the first live session (Sprint 9, Stage 1) | Engine **stopped** (no PM2/tsx process); edit `c_cutoff` to the go-live timestamp (UTC); check `select updated_at from public.risk_metrics` for unexpected recent writes | `select * from archive.paper_2026_manifest order by run_at desc;` shows archived = deleted per table; `select count(*) from public.orders where status in ('new','open','partially_filled');` = 0 |

## How to run
1. Supabase Dashboard → SQL Editor → paste the file → Run. Or use the write-enabled MCP server (`supabase-admin`) with `execute_sql`.
2. The script is one atomic block. Any error rolls back everything.
3. It's idempotent: a re-run copies and deletes nothing new.

## Restore
See the header of each script (parents-first insert order + FK snapshot table `archive.fk_links_paper_2026`).

## Scope
- Covers: `trading_sessions, signals, positions, orders, order_legs, fills, trade_log, trade_outcomes, account_metrics, daily_equity, risk_events, risk_metrics`
- Never touches: `agentic_heartbeats` (Robinhood agentic system), `bars`, `symbols`, `strategies`, `profiles`, `user_roles`
