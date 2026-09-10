# TASK_014: Persistence Fixes for Live — positions, fills FK, monotonic status, mode stamping, durable writes

**Priority:** P0
**Status:** PENDING
**Depends on:** TASK_010 (fill/order event shapes)
**Created:** 2026-09-10 by Cowork (Architecture AI)
**Phase:** Sprint 9 / Stage 0
**Skills:** `supabase-migration` · **Subagents:** `supabase-dba` (implement migration), `risk-guardian` (review)

---

## Context (audit 2026-09-10, live DB `gdrdaajvutmewgxbjurk`)

| # | Defect | Evidence | Live impact |
|---|---|---|---|
| P1 | **Positions never persist.** Upsert `onConflict (user_id, symbol)` but the table only has a *partial* unique index `positions_user_symbol_open_uidx` → every write errors; `positions` has 0 rows | `api/server.ts:4365-4370` | No crash recovery from DB |
| P2 | **Live fills violate FK.** `fills.order_id` receives the *exchange* order id; FK targets `orders.id` (client UUID). `external_order_id` never written | `api/server.ts:4261-4275`, `trading/order-manager.ts:264-268` | Every live fill dropped |
| P3 | **Paper fill ids collide.** Simulator trade id is a per-process counter; upsert `(user_id, trade_id)` overwrites prior sessions (28 rows for 220 filled orders) | `trading/paper-trading-simulator.ts:561`, `trading-engine.ts:1207` | Corrupt history |
| P4 | **Order status can regress.** `order:created` and `order:filled` handlers race; last write wins; `hydrateOpenOrders` reloads `new` rows with no mode filter | `server.ts:1372-1395`, `order-manager.ts:656-689` | Phantom open orders at boot |
| P5 | **No paper/live discriminator.** Same `USER_ID` for both; risk state (kill switch, consecutive losses), daily equity, account metrics restored without mode filter | `risk-engine.ts:378-417`, `:459-490`, `:594-610`; `server.ts:280` | Paper risk state bleeds into live |
| P6 | **Hardened writer unused.** `persistence/supabase-writer.ts` (queue/retry/spool) only imported by its test; production writes are fire-and-forget `supabase.from()` | `__tests__/supabase-writer.test.ts:15` | DB blip = lost fills |
| P7 | Two session rows per run (TradeAnalytics generates its own id) | `trade-analytics.ts:239` vs `server.ts:389` | Broken joins |
| P8 | Trades spanning a restart never journaled | `position-tracker.ts:226`, `trade-analytics.ts:366-370` | Missing live trades |

## IMPORTANT CONSTRAINTS

1. Migrations: idempotent, defensive (`DO` blocks with existence checks), applied via Supabase MCP `apply_migration`, then the local file is named with the **version returned by `list_migrations`** (see skill `supabase-migration`).
2. Never touch `public.agentic_heartbeats` (another system).
3. Backend keeps using the service key; RLS changes must not break `/src/hooks/apex/*` reads (or ship with TASK_016 changes).
4. No new deps.

---

## Step 1 — Schema (one migration)

- `execution_mode text not null default 'paper' check (execution_mode in ('paper','live'))` on: `orders, fills, positions, trade_log, trade_outcomes, trading_sessions, account_metrics, daily_equity, risk_metrics, risk_events, signals`.
- `session_id text` on `orders, fills, positions` (nullable, indexed).
- Replace `risk_metrics` uniqueness `(user_id)` → `(user_id, execution_mode)`; `daily_equity` `(user_id, date)` → `(user_id, execution_mode, date)`.
- Trigger `orders_status_monotonic`: reject transitions from terminal (`filled, canceled, rejected, expired`) back to non-terminal; allow `new → open → partially_filled → filled`.
- Index `fills (execution_mode, filled_at desc)`, `orders (execution_mode, status) where status in ('new','open','partially_filled')`.

## Step 2 — Writers

- Positions: always `onConflict: 'id'`; remove `POSITIONS_HISTORY_PRESERVE` gate; stamp `execution_mode`, `session_id`, `exchange_id`.
- Fills: `syncFillToSupabase(order, fill)` → `order_id = order.id`, `external_order_id = fill.exchangeOrderId`, `trade_id = <exchange trade_id>` (live) or `paper-${sessionId}-${seq}` (paper).
- Orders: per-order serialized write queue (promise chain keyed by `order.id`); status merge = max(stateRank) client-side too.
- Route `orders, fills, positions, trade_log` through `SupabaseWriter` with disk spool (critical facts); others may stay direct.
- One session id: pass the server `sessionId` into `TradeAnalytics`.
- Restore paths (`risk-engine.ts`, `order-manager.hydrateOpenOrders`, `position-tracker.hydrateOpenPositions`) filter by `execution_mode = config.mode`.
- Journal exits for hydrated positions (build the entry from the position record when `position:opened` wasn't seen).

## Step 3 — Live isolation

- `USER_ID` from env (`LIVE_USER_ID` when `mode==='live'`, required); refuse live start if equal to the paper `USER_ID`.

## Step 4 — Tests

1. Position upsert uses `onConflict:'id'` and includes `execution_mode`.
2. Fill write maps `order_id`=client UUID, `external_order_id`=exchange id.
3. Out-of-order `filled` then `created` events ⇒ final status `filled`.
4. Risk state restore ignores paper rows in live (mock Supabase returns both).
5. Writer spool: simulated outage ⇒ fill persisted after recovery (existing writer test harness).

## Acceptance Criteria

- [ ] Migration applied via MCP; advisors: no new ERROR/WARN (`get_advisors security` + `performance`)
- [ ] Local file `supabase/migrations/<version>_live_persistence.sql` matches applied SQL
- [ ] Tests green; `node CURSOR_TASKS/verify/verify_sprint9.cjs --task 014` PASS
- [ ] Paper restart drill: open paper position → kill process → restart → position restored from DB
