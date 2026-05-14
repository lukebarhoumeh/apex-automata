# Supabase Log Explorer — Saved Queries (Apex Automata operator runbook)

**Last updated:** 2026-05-14
**Sprint task:** [E2 — Saved log queries doc](../../atlas/var/tmp/monitor/SPRINT-PLAN-FINAL.md) (`SPRINT-PLAN-FINAL.md` §3 Workstream E2)
**Audience:** Operator on call. Each query is a saved view in Supabase Studio → **Logs** → **Saved**.
**Pro plan requirement:** all four queries depend on Pro's 7-day log retention (`supabase-pro-research.md` §19). Free tier only retains 1 day, which is insufficient for the slow-query and RLS-deny views.

## Why these four

| # | Query | What it catches | When it lights up = act |
|---|---|---|---|
| 1 | DB errors last 24h | `ERROR` / `FATAL` / `PANIC` from Postgres backend (constraint violations, OOM, replication lag) | Any non-empty result. One row of `FATAL` = page on-call. |
| 2 | Edge Function 5xx | Server-side exceptions in our four active functions (`runtime-health`, `journal-entry`, `risk-settings-update`, `strategy-signal-upsert`) | Any non-empty result. >5/hr = open Edge Function logs and triage. |
| 3 | Slow queries > 100ms | Postgres queries that exceeded 100ms — drift indicator for missing indexes or RLS init-plan misses | Sustained >10/hr = revisit the index advisor and the D5 RLS patch. |
| 4 | RLS policy denies | RLS rejections (`new row violates row-level security policy`) | Any non-empty result. Implies a backend write is hitting a table without `service_role` JWT, or a policy regression. |

## Engine + dialect

Supabase Logs uses **Logflare** under the hood, which exposes a BigQuery SQL dialect (NOT Postgres SQL). Key differences from Postgres:

| Concept | Postgres | Supabase Logs (Logflare) |
|---|---|---|
| Time math | `now() - interval '24 hours'` | `timestamp_sub(current_timestamp(), interval 24 hour)` |
| Cast to datetime | `(timestamp AT TIME ZONE 'UTC')::timestamptz` | `cast(timestamp as datetime)` |
| Nested metadata | `metadata->>'severity'` | `CROSS JOIN unnest(metadata) as metadata` then `metadata.severity` |
| Limits | `LIMIT 100` | `LIMIT 100` (same) |
| Timestamps | `timestamptz` | microsecond integer; cast to view |

Each query below uses the dialect Supabase Studio expects when pasted into the Logs explorer. They will **not** run unmodified in the SQL Editor (which uses Postgres SQL against the live DB).

## Query 1 — DB errors last 24h

**Intent:** Catch every Postgres-level `ERROR`, `FATAL`, or `PANIC` so we know within minutes when constraints are firing, OOM is killing backends, or replication is stuck.

**Save name (Supabase Studio):** `[Atlas] DB errors last 24h`

**Source table:** `postgres_logs`

```sql
select
  cast(postgres_logs.timestamp as datetime) as timestamp,
  parsed.error_severity,
  parsed.query,
  event_message
from postgres_logs
  cross join unnest(metadata) as metadata
  cross join unnest(metadata.parsed) as parsed
where
  parsed.error_severity in ('ERROR', 'FATAL', 'PANIC')
  and postgres_logs.timestamp >= timestamp_sub(current_timestamp(), interval 24 hour)
order by postgres_logs.timestamp desc
limit 200;
```

**Expected output (steady state):** zero rows. A clean paper run for 24h should produce no `ERROR`+ events outside of expected guardrail rejections (which write to `audit_log`, not Postgres logs).

**Action when non-empty:**

1. Eyeball `parsed.error_severity` — `FATAL`/`PANIC` always pages.
2. Group by `event_message` to see if it's a single repeating fault (e.g. duplicate-key on `signals.id` = stale insert retry) vs many distinct issues.
3. Cross-reference timestamp with `atlas/var/logs/atlas_app.jsonl` to find the originating engine call.
4. If the fault is a constraint violation on a write path, check the corresponding `syncXxxToSupabase` function in `atlas/apps/core-node/src/api/server.ts`.

## Query 2 — Edge Function 5xx

**Intent:** Surface server-side failures from the four active Edge Functions. Per `supabase-pro-research.md` §2.2 / §1.9 only `runtime-health`, `journal-entry`, `risk-settings-update`, `strategy-signal-upsert` are wired. Anything else 5xx-ing = drift.

**Save name (Supabase Studio):** `[Atlas] Edge Function 5xx`

**Source table:** `function_edge_logs`

```sql
select
  cast(function_edge_logs.timestamp as datetime) as timestamp,
  metadata.function_id,
  request.method,
  request.url,
  response.status_code,
  metadata.execution_time_ms,
  event_message
from function_edge_logs
  cross join unnest(metadata) as metadata
  cross join unnest(metadata.request) as request
  cross join unnest(metadata.response) as response
where
  response.status_code >= 500
  and function_edge_logs.timestamp >= timestamp_sub(current_timestamp(), interval 24 hour)
order by function_edge_logs.timestamp desc
limit 200;
```

**Expected output (steady state):** zero rows. Our four active functions either succeed (200/204) or 4xx (validation). 5xx = unhandled exception in the Deno runtime.

**Action when non-empty:**

1. Note `metadata.function_id` — find the matching folder in `supabase/functions/<name>/`.
2. Open the function's full log via Supabase Studio → Edge Functions → `<name>` → Logs (the explorer view shows the truncated `event_message` only).
3. If it's our four active fns, file a hot-fix; if it's one of the seven dead fns from D2 cleanup, the function should already be deleted — re-confirm cleanup landed.
4. >5 in 1h sustained = page (potential dependency rot, e.g. `esm.sh` unavailable).

## Query 3 — Slow queries > 100ms

**Intent:** Index advisor's leading indicator. Postgres logs the duration when `log_min_duration_statement` is hit (Supabase default = 500ms; the 100ms threshold below catches slow patterns before they become slow queries). We parse the duration out of `event_message` because Postgres logs duration as a free-form string.

**Save name (Supabase Studio):** `[Atlas] Slow queries > 100ms`

**Source table:** `postgres_logs`

```sql
select
  cast(postgres_logs.timestamp as datetime) as timestamp,
  parsed.application_name,
  -- Postgres logs the duration in milliseconds inside event_message, e.g.
  --   "duration: 152.314 ms  statement: SELECT ..."
  -- pull the float out of the string for sortability.
  regexp_extract(event_message, r'duration: ([0-9.]+) ms') as duration_ms,
  event_message
from postgres_logs
  cross join unnest(metadata) as metadata
  cross join unnest(metadata.parsed) as parsed
where
  event_message like '%duration:%'
  and regexp_extract(event_message, r'duration: ([0-9.]+) ms') is not null
  and cast(regexp_extract(event_message, r'duration: ([0-9.]+) ms') as float64) > 100.0
  and postgres_logs.timestamp >= timestamp_sub(current_timestamp(), interval 24 hour)
order by cast(regexp_extract(event_message, r'duration: ([0-9.]+) ms') as float64) desc
limit 200;
```

**Expected output (steady state):** 0–10 rows in 24h, mostly one-off cold-cache fetches.

**Action when non-empty:**

1. Sustained >10/hr from the same query template = open SQL Editor and run the matching `pg_stat_statements` lookup:
   ```sql
   select calls, mean_exec_time, total_exec_time, rows, query
   from pg_stat_statements
   order by total_exec_time desc
   limit 20;
   ```
2. Run the **Index Advisor** report (Supabase Studio → Reports → Database → Index Advisor) to see the suggested index.
3. If the slow query touches RLS-protected tables and uses `auth.uid() = user_id`, this is the classic init-plan miss — D5 (`2026MMDD_rls_initplan_optimization.sql`) is the targeted fix.

**Alternative (if pg_stat_statements is preferred):** the same intent can be served from the SQL Editor (Postgres-native, NOT log explorer) without parsing log text:

```sql
-- Run from SQL Editor, NOT Logs. Postgres SQL, not Logflare.
select
  calls,
  round(mean_exec_time::numeric, 2) as mean_ms,
  round(total_exec_time::numeric, 2) as total_ms,
  rows,
  query
from pg_stat_statements
where mean_exec_time > 100
order by total_exec_time desc
limit 50;
```

Save this in SQL Editor as `[Atlas] pg_stat_statements > 100ms mean` for the same purpose with structured (not regex-parsed) output.

## Query 4 — RLS policy denies

**Intent:** Any write hitting an RLS deny is either a backend bug (writing without `service_role` JWT) or a policy regression. Either is a real correctness issue — the data is being silently dropped.

**Save name (Supabase Studio):** `[Atlas] RLS policy denies`

**Source table:** `postgres_logs`

```sql
select
  cast(postgres_logs.timestamp as datetime) as timestamp,
  parsed.error_severity,
  parsed.user_name,
  parsed.application_name,
  event_message
from postgres_logs
  cross join unnest(metadata) as metadata
  cross join unnest(metadata.parsed) as parsed
where
  parsed.error_severity = 'ERROR'
  and (
    event_message like '%new row violates row-level security policy%'
    or event_message like '%row-level security policy for table%'
  )
  and postgres_logs.timestamp >= timestamp_sub(current_timestamp(), interval 24 hour)
order by postgres_logs.timestamp desc
limit 200;
```

**Expected output (steady state):** zero rows. The backend connects with `service_role` (bypasses RLS) so all engine writes succeed. Any deny implies a frontend or anon-keyed caller hitting a write without the right policy.

**Action when non-empty:**

1. `parsed.user_name` tells you which role tripped — `anon` = public frontend, `authenticated` = signed-in user, `service_role` should never appear here.
2. `parsed.application_name` narrows the source (e.g. `PostgREST`, `supabase-js`).
3. Check whether the failing table is one we recently migrated. If yes, audit its RLS in `supabase/migrations/` — likely a policy was dropped without a replacement.
4. After D5 lands (`(SELECT auth.uid())` rewrite), this query is also the regression test — any new row here means D5 broke a policy.

## Saved-query checklist (post-merge)

Apply once in Supabase Studio (project `gdrdaajvutmewgxbjurk`):

| # | Save name | Source table | Verified empty on save? |
|---|---|---|---|
| 1 | `[Atlas] DB errors last 24h` | `postgres_logs` | yes / no |
| 2 | `[Atlas] Edge Function 5xx` | `function_edge_logs` | yes / no |
| 3 | `[Atlas] Slow queries > 100ms` | `postgres_logs` | yes / no |
| 4 | `[Atlas] RLS policy denies` | `postgres_logs` | yes / no |

For each, take a screenshot of the empty-state result panel and drop into `docs/runbooks/screenshots/supabase-log-queries/<n>.png` (gitignored under existing `*.png` policy if present, otherwise track for completeness).

## References

- Sprint plan: `atlas/var/tmp/monitor/SPRINT-PLAN-FINAL.md` §3 Workstream E2, dispatch table §10
- Research: `atlas/var/tmp/monitor/supabase-pro-research.md` §19 (logs & observability)
- Logflare BigQuery SQL dialect: https://supabase.com/docs/guides/telemetry/logs
- Supabase Postgres advisors (companion to query 3): https://supabase.com/blog/security-performance-advisor
- RLS init-plan optimization (companion to query 4): https://supabase.com/docs/guides/database/postgres/row-level-security
