# External DB consumers (shared Supabase)

**Project:** `gdrdaajvutmewgxbjurk` (Apex Automata / AtlasBot v2 crypto + co-hosted Robinhood) <!-- pragma: allowlist secret -->


> **HARD FENCE:** Before any DDL that touches listed objects (ALTER/MOVE/DROP/re-GRANT, schema moves, RLS rewrites, PostgREST expose-list changes), read this file and get Trading Master sign-off. Apex crypto schema must stay clean vs Robinhood.

## 1. Robinhood — `agentic_heartbeats`

| Field | Value |
|---|---|
| Consumer | Robinhood equity / agentic session system (co-hosted on this Supabase project) |
| Physical table | `equity.agentic_heartbeats` (moved by `20260910180300_quarantine_agentic_heartbeats_to_equity_schema`) |
| Compatibility surface | `public.agentic_heartbeats` **VIEW** → `SELECT … FROM equity.agentic_heartbeats` |
| Restored by | `20260910193453_compat_public_agentic_heartbeats_view` |
| Purpose | Cycle heartbeats (`open_sweep`, `morning`, `midmorning`, `midday`, `power_hour`, `sunday`, …) |

### Do NOT
- ALTER / MOVE / DROP `equity.agentic_heartbeats` or `public.agentic_heartbeats`
- Revoke / re-GRANT privileges on either object without TM + Robinhood desk confirmation
- Remove `equity` from API exposed schemas (if exposed) or break the public view name
- Add Apex crypto FKs into heartbeats

### Safe Apex practice
- Treat heartbeats as **out of Apex crypto ownership**
- Prefer new Apex tables in `public` (or dedicated `apex` schema later) — never overload heartbeats
- Verify `public.agentic_heartbeats` still resolves after any migration that touches `equity` or views

### Live check
```sql
SELECT n.nspname, c.relkind
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relname = 'agentic_heartbeats';
-- Expect: equity r + public v
```

**Privilege note (flag under fence — do not “fix” without TM):** 2026-09-10 verify showed `public.agentic_heartbeats` SELECT true for `service_role` only (anon/authenticated false). Equity table allows authenticated SELECT under RLS. Confirm Robinhood’s role before any grant change.

## 2. Desk monitor — Supabase MCP poller (read-only)

| Field | Value |
|---|---|
| Consumer | Desk monitor agent (the Grok Bot desk hand-off) reading through the Supabase MCP endpoint — Postgres logs show `POST /mcp`, OAuth user `3d0e1e1e-25ff-424c-81f8-142a80fb3df0`, every 10–15 min during the soak window. Runs as `postgres`, so grants and RLS do not apply to it. |
| What it asks | "Is a paper session open, what did the last one do, is the kill switch on" — `SELECT id, status, started_at, ended_at, equity, trade_count, pnl, execution_mode FROM trading_sessions …` and `SELECT kill_switch, …, exposure FROM risk_metrics …`. Until 2026-09-29 every one of those failed with `42703` (142 Postgres errors on 2026-09-28). |
| Contract surface | `public.desk_session_status`, `public.desk_risk_status` (read-only, `security_invoker`, SELECT for `authenticated` + `service_role`) — `20260929010733_desk_status_views_v2`. Compatibility GENERATED columns on `public.trading_sessions` (`id`, `status`, `starting_equity`, `ending_equity`, `equity`, `trade_count`, `trades_count`, `pnl`) and `public.risk_metrics` (`kill_switch`, `halt`, `exposure`) — `20260929005512_desk_compat_alias_columns`. |
| Owner | Apex crypto (Luke). The poller's prompt is outside this repo; point it at the two views (`docs/db/DESK_QUERIES_2026-09-29.md`) and the alias columns can be dropped with the rollback block in that migration. |

### Do NOT
- Rename or drop the two views, or the alias columns, while the poller still targets the tables by name
- Write to any of the alias columns from the runtime (they are `GENERATED ALWAYS`; a payload key with one of those names fails with `428C9`)
- Treat `account_metrics.total_equity` as equity anywhere new: `upsert_account_metrics()` writes open-position market value there (0.00 when flat)

### Live check
```sql
SELECT id, status, equity, trade_count, pnl, execution_mode
FROM public.desk_session_status ORDER BY COALESCE(ended_at, started_at) DESC NULLS LAST LIMIT 1;
SELECT status, kill_switch, active_halts, consecutive_losses, exposure FROM public.desk_risk_status;
-- and the poller's own shape must not 42703:
SELECT id, status, equity, trade_count, pnl FROM public.trading_sessions LIMIT 1;
```

## Adding a new entry
1. Name consumer + owning desk
2. List exact `schema.object` + access path
3. State hard fence
4. Link contract migrations
5. PR via Apex Engineer (Fable); TM merge ownership
