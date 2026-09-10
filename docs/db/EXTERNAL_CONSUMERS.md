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

## Adding a new entry
1. Name consumer + owning desk
2. List exact `schema.object` + access path
3. State hard fence
4. Link contract migrations
5. PR via Apex Engineer (Fable); TM merge ownership
