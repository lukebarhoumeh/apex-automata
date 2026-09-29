# Supabase desk queries + the 2026-09-28 error storm (2026-09-29)

**Project:** `gdrdaajvutmewgxbjurk` (shared with the agentic-equity workflow — see `EXTERNAL_CONSUMERS.md`)
**Applied:** 2026-09-29 00:55–01:07 UTC via the Supabase MCP `apply_migration` (Luke's standing authorisation of 2026-09-29: "run the db changes necessary"). Repo files carry the recorded apply-time versions.
**Verify:** `docs/db/verify/05_desk_status_views.sql` (`pass = t` on prod 2026-09-29 01:08 UTC).

## 1. What the dashboard was showing and why

The Supabase dashboard on 2026-09-28 showed 182 requests / 21.4% success, Postgres 170 requests / 142 errors in 24 h.

Every one of those errors is the same thing: an **external reader** issuing guessed column names against two Apex tables. Postgres logs (`query_logs`, source `postgres_logs`, `parsed.error_severity = 'ERROR'`) show:

| Field | Value |
|---|---|
| Source | `POST /mcp` (Supabase MCP endpoint), OAuth user `3d0e1e1e-25ff-424c-81f8-142a80fb3df0` — the desk-monitor agent from the Grok Bot hand-off |
| Cadence | every 10–15 min, ~4–11 errors/hour across the soak window |
| sqlstate | `42703 column does not exist` — `id` ×105, `status` ×23, `session_id` (on risk_metrics) ×11, plus `equity`, `trade_count`, `trades_count`, `pnl`, `starting_equity`, `ending_equity`, `kill_switch`, `exposure`, `halt`, `unrealized_pnl`, `symbol` |
| Tables | `public.trading_sessions`, `public.risk_metrics` |
| Typical statement | `SELECT id, status, started_at, ended_at, equity, trade_count, pnl, execution_mode FROM trading_sessions WHERE status = 'OPEN' OR ended_at IS NULL ORDER BY started_at DESC LIMIT 5;` then `SELECT kill_switch, consecutive_losses, daily_pnl, max_drawdown, exposure, execution_mode, updated_at FROM risk_metrics ORDER BY updated_at DESC LIMIT 1;` |

Not in the error log: anything from the Apex runtime (service-role PostgREST writes), the frontend, or the Edge Functions. One unrelated error came from a second OAuth user (`4696f49e-…`, the side project) probing `cron.job` (`42P01`; pg_cron is not installed).

So the runtime was healthy; the "DB throwing errors" was the monitor asking questions in a vocabulary the schema did not have.

## 2. What was changed (4 migrations, all additive, all idempotent)

| Recorded version | File | What |
|---|---|---|
| `20260929005509` | `desk_status_views.sql` | v1 of the two views — superseded 12 min later by v2 (kept: it is recorded in `schema_migrations`; Preview branches need the file) |
| `20260929005512` | `desk_compat_alias_columns.sql` | GENERATED ALWAYS … STORED alias columns so the poller's existing statements succeed: `trading_sessions.{id,status,starting_equity,ending_equity,equity,trade_count,trades_count,pnl}`, `risk_metrics.{kill_switch,halt,exposure}` |
| `20260929005514` | `perf_advisor_cleanup.sql` | dropped 3 exact-duplicate indexes (`idx_account_metrics_user_date`, `idx_mf_decisions_timestamp`, `idx_mf_decisions_signal_id`); rewrote 2 policies to the `(select auth.*())` init-plan form (`trading_sessions.trading_sessions_user_policy`, `exchange_credentials."Service role full access"`), semantics unchanged |
| `20260929010733` | `desk_status_views_v2.sql` | **current** `desk_session_status` / `desk_risk_status`: honest equity columns, SELECT-only grants |

Scope fence respected: nothing under `agentic_*`, `cb_*`, `equity.*` or their policies/functions was touched (`public.agentic_heartbeats` still resolves as a view).

Rollback blocks are in each migration header. The alias columns are a shim: once the monitor is pointed at the views they can be dropped with the block in `20260929005512`.

### Post-apply advisor state
- Performance: `duplicate_index` and `auth_rls_initplan` findings **gone**. Remaining: 54 `unused_index` (INFO — the soak has barely traded; do not drop yet), 47 `multiple_permissive_policies` (WARN — Apex tables `account_metrics`, `equity_curve`, `exchange_credentials`, `trading_sessions` each carry a redundant second permissive policy; consolidating is a desk call, not done), auth connection strategy INFO.
- Security: unchanged — `rls_enabled_no_policy` on `agentic_control`, `agentic_control_log`, `agentic_intents`, `cb_state`, `cb_venue_snapshot` and `function_search_path_mutable` on 6 `cb_*` / lease functions are the side project's (fenced); `has_role()` is a SECURITY DEFINER callable by `authenticated` via `/rest/v1/rpc/has_role` — Apex-owned, only referenced from the FE generated types, worth a decision (revoke or SECURITY INVOKER).

## 3. Canonical desk queries (use these, not the tables)

Run as `postgres` (SQL editor / MCP) or as an authenticated user (RLS of the base tables applies through `security_invoker`). `anon` has no access.

**Is a paper session open? What did the last one do?**
```sql
SELECT id, status, mode, execution_mode, started_at, ended_at,
       equity, trade_count, pnl, realized_pnl, open_position_value
FROM public.desk_session_status
ORDER BY COALESCE(ended_at, started_at) DESC NULLS LAST
LIMIT 5;
-- status: 'OPEN' while ended_at IS NULL, else 'ENDED'
-- equity: final_equity once ended, else initial_equity (session-start equity; no intraday mark is persisted)
-- open_position_value: latest account_metrics.total_equity for the session = SUM(qty_open x latest fill) over OPEN positions, 0 when flat. NOT equity.

SELECT count(*) FILTER (WHERE status = 'OPEN') AS open_sessions FROM public.desk_session_status;
```

**Is the kill switch on / would the paper boot guard refuse a start?**
```sql
SELECT status, kill_switch, active_halts, latest_halt_type, latest_halt_at,
       consecutive_losses, daily_pnl, daily_pnl_r, max_drawdown, exposure,
       day_start_equity, day_start_equity_date, session_id, execution_mode, updated_at
FROM public.desk_risk_status
ORDER BY updated_at DESC NULLS LAST;
-- status: 'HALTED' when kill_switch_active OR active_halts > 0, else 'OK'
-- active_halts mirrors paper-boot-guard.ts isOpenHaltRiskEvent(): real halt codes only (never
--   size_down_consec / size_down_daily_r / strategy_freeze / regime_pause / sleeve_halt), not cleared,
--   not active=false, not a resume audit row. > 0 => a paper start is refused without RISK_CLEAR=YES.
-- session_id: newest account_metrics.session_id for the user/mode (risk_metrics has no session stamp)
-- day_start_equity: daily_equity.start_equity of the latest day (the risk engine's anchor)
```

**The poller's own statements now also work** (thanks to the alias columns) — but they answer less:
```sql
SELECT id, status, started_at, ended_at, equity, trade_count, pnl, execution_mode
FROM trading_sessions ORDER BY COALESCE(ended_at, started_at) DESC NULLS LAST LIMIT 3;
SELECT kill_switch, halt, consecutive_losses, daily_pnl, max_drawdown, exposure, execution_mode, updated_at
FROM risk_metrics ORDER BY updated_at DESC NULLS LAST LIMIT 1;
```
Still **not** available anywhere, on purpose: `risk_metrics.session_id` (no honest source), `trading_sessions.unrealized_pnl` / `symbol` (a session row has neither), a live "current equity" (the runtime persists none — `daily_equity.end_equity/high/low` are never written).

**Re-check the error log** (MCP `query_logs`, ClickHouse dialect — different from the Studio/Logflare dialect in `docs/runbooks/supabase-log-queries.md`):
```sql
select log_attributes['parsed.sql_state_code'] as code, event_message,
       log_attributes['parsed.query'] as q, timestamp
from logs
where source = 'postgres_logs' and log_attributes['parsed.error_severity'] = 'ERROR'
order by timestamp desc limit 40
```
The `q` field carries the statement plus the MCP trailer (`-- source: POST /mcp`, `-- user: oauth:<id>`), which is how the poller was identified.

## 4. Semantics worth knowing (found while verifying)

1. **`account_metrics.total_equity` is not equity.** `public.upsert_account_metrics(p_user_id)` (SECURITY DEFINER, called from `api/server.ts updateAccountMetrics()`) writes `SUM(qty_open * latest filled price)` over OPEN positions — open-position market value, `0.00` when flat (rows on 2026-09-22/23/24 are all 0.00; 2026-09-21 shows 4759.99 with 3 positions open). The views label it `open_position_value`. Anything that reads it as equity is wrong today:
   - `risk-engine.ts` runs `void this.loadDailyStartEquity().then(() => this.loadRiskState())` (~line 452, deliberately ordered — see the comment there), so the `loadRiskState()` restore of `weeklyStartEquity` from `account_metrics.total_equity` for the date 7 days ago (~line 954) is the **final** assignment whenever such a row exists. On those boots the weekly-loss guardrail (`weeklyLoss = weeklyStartEquity - currentEquity`, ~line 1687) is computed against position value — `0.00` on a flat day, so `weeklyLoss` is negative and the `weekly_stop` halt cannot trip; when the engine ran 7 days ago the anchor is that day's open-position value, still not equity. Mode-agnostic (paper and live). Not changed in PR #82 (risk-engine logic needs a Risk OK); proposed fix: read `daily_equity.start_equity` for the earliest row within the last 7 days for the user/mode, or delete the account_metrics restore so `loadDailyStartEquity()`'s anchor stands.
2. **`daily_equity` only ever gets `start_equity`.** `end_equity`, `high_equity`, `low_equity`, realized/unrealized are NULL on every row. If the desk wants an intraday equity mark in the DB it has to be written first (`equity_snapshots` / `equity_curve` exist with 0 rows).
3. **`risk_metrics` has one row per `(user_id, execution_mode)`** (unique `risk_metrics_user_mode_key`); `id` is a uuid PK unrelated to sessions.
4. **`trading_sessions.session_id` is the text PK** (`sess_<epoch>_<rand>`); the new `id` column is a generated copy of it, nothing more.

## 5. Items for Luke (not actioned)

- **Point the desk monitor at the views.** Its prompt lives outside this repo. Until then the alias columns keep it green.
- **Supabase GitHub-integration branches `main` and `fix/supabase-preview-migration-stubs` are `MIGRATIONS_FAILED` since 2026-05-13** (`list_branches`). Stale preview branches; the failure reason is not visible from the MCP. The repo files for the four new versions are named after the recorded versions so a fresh preview run would not trip on them. Diffing `schema_migrations` against the repo on 2026-09-29 (79 remote versions vs 73 files before this PR): Apex's own missing stamp `20260921185202 fills_fee_side` (MCP re-stamp of `20260921180000`) now has a `SELECT 1;` reconciliation stub in the repo, same pattern as `20260910213833`; the other five remote-only versions (`20260923210349 agentic_control_kill_latch`, `20260924161650`, `20260924171619`, `20260925021711`, `20260928183106 cb_live_*`) were applied by the side project's OAuth user (`4696f49e-…`) and are deliberately not stubbed from the Apex side — Preview will keep refusing until they are, which is a call for you and the equity desk. The Supabase Preview check on this PR reports `skipped`.
- **`has_role()` SECURITY DEFINER executable by `authenticated`** (security advisor). Apex-owned; decide revoke vs SECURITY INVOKER.
- **`weeklyStartEquity` restore** reads position value as equity (§4.1).
- **`strategy_name` enum** lacks `donchian_daily_s3` (round-2 Task B finding) — STAGED in round 3: `supabase/migrations/20260929120000_add_donchian_daily_s3_to_strategy_name_enum.sql` (`ALTER TYPE … ADD VALUE IF NOT EXISTS`, single statement, placeholder version until applied; verify with `docs/db/verify/06_strategy_name_enum.sql`). The runtime no longer depends on the apply: `signals.strategy` is normalised like orders/positions (`persistence/signal-row.ts`) and all three writers fall back to `system` on a 22P02 for a label the deployed enum lacks (`persistence/strategy-enum-fallback.ts`, warned once per process). Still: apply the migration before ever enabling the plugin in paper so its rows are attributed to it, not to `system`.
- **Legacy destructive reconcile** (`STARTUP_RECONCILE=false`) — FIXED (round 3, Task E): the orphan-zero UPDATE is now scoped to the session's `execution_mode` (`persistence/session-reconcile.ts` `selectRowsForDestructiveReconcile`, targeted by `id`): a paper start touches paper + legacy NULL-mode rows only, a live start touches rows stamped `live` only (never NULL-mode rows), rows of the other mode are skipped and logged (`skippedForeignMode`), and without the `execution_mode` column the update is skipped entirely with an error-level log instead of running unscoped. Removing the env var altogether remains a desk call.
- **47 multiple-permissive-policy warnings** on Apex tables: each has a redundant second permissive policy (e.g. `trading_sessions_user_policy` duplicates the four "Allow individual …" policies). Consolidation is semantics-preserving but is a desk call.
- FE `src/integrations/supabase/types.ts` was not regenerated (a regen would also pull the side project's `cb_*` / `agentic_*` tables into the diff). The new columns are read-only extras; nothing in the FE types them.
