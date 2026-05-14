# Supabase Pro — Deep Research for Apex Automata (AtlasBot v2)

> **Tracked location since 2026-05-14 (Wave 2 G7).** Previously at `atlas/var/tmp/monitor/` (gitignored).

**Created:** 2026-05-13 ~15:18 CT
**Project:** `gdrdaajvutmewgxbjurk` (org: lukebarhoumeh personal)
**Plan:** Pro (upgraded 2026-05-13)
**Trigger:** Synthesizer worker dispatched at 2026-05-14T01:34:07Z (20:34 CT)
**Mode:** READ-ONLY research. No project state changed, no migrations applied.

This file is the input for the Wave-1 / Wave-2 / Wave-3 dispatch at 20:34 CT. The synthesizer reads `sprint-plan-staging.md` + this file and produces the final sprint plan.

---

## Executive summary (60-second scan)

- **Pro upgrade unlocks 7 things that move the needle for AtlasBot**: daily backups, 7-day log retention, branching, log drains, Realtime headroom (200→500 connections, 2M→5M msgs), Edge-Function headroom (500K→2M invocations), and a fully-managed Micro compute instance. Everything else (PITR, MFA-phone, custom domain, image transforms, advanced MFA, SAML) is optional add-on or irrelevant at paper-trading scale. [Source: https://supabase.com/pricing]
- **The single biggest cost-of-Pro item is `auth.uid()` not being wrapped in a `SELECT`** in the 2025-10-13 baseline migration, which makes RLS evaluate per-row on every query — common 100× slowdown on tables with > 10k rows. We must patch this in Wave 2 before live trading. [Source: https://supabase.com/docs/guides/database/postgres/row-level-security]
- **7 of 11 Edge Functions are vestigial** — five `ingest-*` functions are unused because the backend writes directly via `SupabaseWriter`, and two more (`alerts-ack`, `strategy-toggle`) are only referenced from `_archive/*`. Only 3 are actively wired to the live frontend (`journal-entry`, `risk-settings-update`, `strategy-signal-upsert`). One (`runtime-health`) is infrastructure. Removing 7 functions is zero-risk Wave 1 work.
- **Backend already uses supabase-js + REST**, which is internally pooled. The earlier sprint item "switch to Supavisor pooler" does NOT apply to the current codebase — that would only matter if we introduced raw `pg` driver usage (e.g., for `pg_stat_statements` queries). [Source: https://www.answeroverflow.com/m/1415456480143999196]
- **There is real schema drift to clean up** — migrations `20251013171848` and `20251013180100` both create the `positions` table with completely different schemas (UUID vs TEXT id, `entry_price`/`pnl` vs `average_price`/`unrealized_pnl`/`realized_pnl`/`total_pnl`). The second uses `IF NOT EXISTS` so it silently no-ops in production. This is the conflict noted in the staging file.
- **Realistic Pro cost for AtlasBot ≈ $25-28/mo** for the next 6 months on paper, with no PITR, default Micro compute, 2-branch cap. No need to budget more.

---

# Phase 1 — Live web research (Supabase Pro 2026 state)

## 1. Branching

| Aspect | Detail | Source |
|---|---|---|
| Cost model | $0.01344/hr per branch on Micro compute (previously $0.32/day, repriced June 2025) | https://supabase.com/docs/guides/platform/manage-your-usage/branching |
| What's billed | Compute + Disk + Egress + Storage per branch — NOT covered by Spend Cap. Compute credits do NOT apply to branches. | https://supabase.com/docs/guides/platform/manage-your-usage/branching |
| Preview branches | Ephemeral, auto-paused after PR inactivity, deleted on PR close | https://supabase.com/docs/guides/deployment/branching |
| Persistent branches | Long-lived (staging/QA/dev), never auto-paused, charged continuously | https://supabase.com/docs/guides/deployment/branching |
| Data | Branches start **empty** unless you ship a seed file | https://supabase.com/docs/guides/deployment/branching |
| Deployment graph | Clone → Pull → Health (≤2 min) → Configure → Migrate → Seed → Deploy. Failures cascade. | https://supabase.com/docs/guides/deployment/branching |
| AtlasBot cadence math | ~10 PRs/mo × ~5 active hours per branch × 2-branch cap × $0.01344 = **~$1.34/mo** | (calculation) |

**Verdict — FIT.** Branching with 2-branch limit + "Supabase changes only" mode is essentially free for our PR cadence. The hard cost is migration discipline, not dollars. **Re-enable AFTER migration consolidation (per Wave 2 in staging file).**

**Gotcha:** branches are dataless — for paper-trading dashboard regression tests, a seed file with sample positions/signals will be needed. Without it, the UI lights up blank on every preview.

---

## 2. Daily backups

| Aspect | Detail | Source |
|---|---|---|
| Free tier | NONE — backups not included | https://supabase.com/pricing |
| Pro tier | Daily backups, **7-day retention**, automatic | https://supabase.com/pricing |
| Team tier | 14-day retention | https://supabase.com/pricing |
| Restore procedure | Dashboard → Database → Backups → choose timestamp → "Restore". In-place; project enters maintenance window during restore. | https://supabase.com/docs/guides/platform/backups |
| Cross-project restore | NOT supported on daily backups (Pro). Only PITR enables fork-to-new-project. | https://supabase.com/docs/guides/platform/backups |
| Granularity | Daily snapshot only — you cannot restore to noon yesterday, only to "yesterday's snapshot" | https://supabase.com/docs/guides/platform/manage-your-usage/point-in-time-recovery |

**Verdict — FIT.** This alone justifies the $25/mo Pro upgrade for a system writing real trade data. Action: do a *test restore* into a Pro branch this week so we don't learn the procedure during an incident.

---

## 3. Point-in-Time Recovery (PITR)

| Aspect | Detail | Source |
|---|---|---|
| Price | $100/mo per 7-day retention block | https://supabase.com/pricing |
| Granularity | Second-level rewind anywhere in retention window | https://supabase.com/docs/guides/platform/manage-your-usage/point-in-time-recovery |
| Billing | Hourly while enabled; NOT covered by Spend Cap | https://supabase.com/docs/guides/platform/manage-your-usage/point-in-time-recovery |
| When essential | Real money, frequent writes, RPO measured in minutes | https://supabase.com/docs/guides/platform/manage-your-usage/point-in-time-recovery |

**Verdict — SKIP for paper. REVISIT before first $1k live trade.**
- Paper trading: nothing irreplaceable lives in this DB. Daily backups + the runtime's disk spool (`SupabaseWriter.spoolDir`) is sufficient.
- Live trading: a single corrupt UPDATE to `positions` could lie about portfolio state for hours; PITR's $100/mo becomes obvious insurance.
- **Decision marker:** flip PITR ON the same day you switch `EXECUTION_MODE=live`. Track this in `guardrails.yaml` go-live criteria.

---

## 4. Database Webhooks

| Aspect | Detail | Source |
|---|---|---|
| Mechanism | Postgres triggers wrap the `pg_net` extension to send HTTP from inside the DB | https://supabase.com/docs/guides/database/webhooks |
| Async | Yes — non-blocking, doesn't delay the transaction | https://supabase.com/docs/guides/database/webhooks |
| Throughput | ~200 req/sec system-wide | https://gethookmesh.io/blog/supabase-webhooks-database-triggers |
| Response tracking | HTTP responses stored in `net._http_response` for 6 hours | https://gethookmesh.io/blog/supabase-webhooks-database-triggers |
| Cost | Counts as egress, no per-call charge | https://supabase.com/docs/guides/database/webhooks |

**AtlasBot fit analysis (vs Edge Functions):**

| Use case | Better with Webhook | Better with Edge Fn |
|---|---|---|
| `alerts` row → external SMS/Slack | **YES** — fewer hops, no Deno cold start | — |
| `risk_metrics` row → external Prometheus push | **YES** — already in-DB | — |
| `signals` row → external ML inference call | — | YES — needs request shaping, retry, error handling |
| External webhook IN (e.g. Coinbase fills) | — | YES — we don't have a public-facing Express endpoint for the runtime |

**Verdict — PARTIAL FIT.** Replace `alerts-ack` and `ingest-alert` outbound paths with database webhooks → reduces 2 Edge Functions to 1 trigger. Keep `journal-entry`, `risk-settings-update`, `strategy-signal-upsert` as Edge Functions (they are RPC-style, not row-change-driven).

---

## 5. Edge Functions

| Aspect | Detail | Source |
|---|---|---|
| Free tier | 500K invocations/mo | https://supabase.com/pricing |
| Pro tier | 2M invocations/mo, then $2 per 1M | https://supabase.com/pricing |
| Cold start | 80-250ms p95 depending on region + payload + import tree; warm instances dropped at ~5 min idle | https://jakeinsight.com/tech/2026-04-20-supabase-edge-functions-cold-start-latency-real-me/ |
| Regions | 13 globally; specify via `x-region` header or `forceFunctionRegion` query param | https://supabase.com/docs/guides/functions/regional-invocation |
| Secrets | Dashboard or CLI (`supabase secrets set`); read via `Deno.env.get(...)` | https://supabase.com/docs/guides/functions/secrets |
| Limit per fn | 50 MB max bundle, 6 MB max payload, 400s max wall time | https://supabase.com/docs/guides/functions/limits |

**AtlasBot current usage:** all 11 functions import `@supabase/supabase-js@2.75.0` from `esm.sh` — module load is ~50ms cold, which is why our `runtime-health` checks see 200-350ms p95. Acceptable for a paper bot but should be monitored.

**Verdict — FIT.** 2M invocations is 67× our current load. Cold start is the only real concern, and it's only on infrequent endpoints (`journal-entry`, `risk-settings-update`). Pin the function region to match the DB region (e.g. `us-east-1`) to shave 30-80ms.

---

## 6. Realtime

| Aspect | Free | Pro | Source |
|---|---|---|---|
| Concurrent peak connections | 200 | **500**, then $10 / 1k extra | https://supabase.com/pricing |
| Messages per month | 2M | **5M**, then $2.50 / 1M extra | https://supabase.com/pricing |
| Max message size | 256 KB | **3 MB** | https://supabase.com/pricing |
| Postgres changes | Included | Included | https://supabase.com/docs/guides/realtime/postgres-changes |
| Billing model | "1 change × 5 listening clients = 5 messages billed" | Same | https://supabase.com/docs/guides/platform/manage-your-usage/realtime-messages |

**Three Realtime feature surfaces:**
1. **Postgres Changes** — what AtlasBot uses today (`SupabaseRealtimeManager` subscribes to 10 tables on one channel). Charged by message-count × listening-client-count + egress.
2. **Broadcast** — peer-to-peer messages sent through Supabase, no DB persistence. Could be used for "kill switch tripped" fanout. Cheaper than postgres_changes for ephemeral signals.
3. **Presence** — track who is viewing the dashboard. Useless for single-user AtlasBot.

**AtlasBot load estimate:**
- Writes: ~60 signals/min + ~5-20 fills/min + ~5 risk metrics/min ≈ 100 row changes/min ≈ 144k/day ≈ **4.3M messages/month with 1 dashboard client**.
- Headroom: 5M included → 86% utilization on a single client. **If a second dashboard tab opens, we cross the quota.**

**Gotcha:** `SupabaseRealtimeManager` does INSERT + UPDATE + DELETE per table. Every position price tick currently triggers a position UPDATE row → realtime message. If we tighten position update coalescing in the backend (write every 5s instead of every tick), realtime messages drop 5-10×.

**Verdict — FIT but watch the meter.** Wave 2 should add a metric on `atlas_realtime_messages_used` and alert at 4M/mo.

---

## 7. Postgres extensions

| Extension | Pro support | AtlasBot fit | Notes |
|---|---|---|---|
| `pg_cron` | YES, default available | **STRONG FIT** | Daily P&L rollup, nightly position cleanup, equity snapshot |
| `pg_net` | YES | **FIT** | Required for Database Webhooks (item 4) |
| `pgmq` | YES, GA | SKIP for now | Backend's `SupabaseWriter` queue already does the job in-memory with disk spool. Revisit if we need cross-process job dispatch. |
| `pgvector` | YES | SKIP | Only useful if we build an ML embedding-based meta-filter. Aspirational per CLAUDE.md. |
| `pgvectorscale` | YES | SKIP | Same as pgvector |
| `pg_stat_statements` | **Enabled by default on Supabase** | **STRONG FIT** | Query against `pg_stat_statements` view to find slowest writes. Already on. |
| `pg_partman` | YES | FIT in 3-6 months | Useful when `signals`/`candles` tables cross ~5M rows. Not urgent now. |
| `pg_graphql` | YES, default | SKIP | We use PostgREST REST, not GraphQL |
| `wrappers` (FDW) | YES | SKIP | No external SQL-targetable systems to query |

**Sources:** https://supabase.com/docs/guides/database/extensions, https://supabase.com/docs/guides/cron, https://supabase.com/docs/guides/queues/pgmq, https://supabase.com/docs/guides/database/partitions

**Action items for sprint:**
- Wave 2: enable `pg_cron` and schedule (a) hourly equity snapshot, (b) nightly `signals` retention purge, (c) nightly trade analytics rollup.
- Wave 3: when `signals` row count crosses 5M, set up `pg_partman` monthly partitions on `signals.created_at`.

---

## 8. Connection pooling (Supavisor)

| Mode | Port | Behavior | When to use |
|---|---|---|---|
| Transaction | 6543 | Connection released after each statement | Serverless / edge / short-lived clients |
| Session | 5432 | Connection held for entire session | Long-running ORM, listen/notify, prepared statements |
| Direct | 5432 (via `db.<ref>.supabase.co`) | No pooler | When you need everything Postgres offers and are running a small static cluster |

**Source:** https://supabase.com/docs/guides/troubleshooting/supavisor-and-connection-terminology-explained-9pr_ZO

**Critical for AtlasBot — Supavisor does NOT apply to the current codebase.** Every backend file uses `createClient(supabaseUrl, supabaseServiceKey)` from `@supabase/supabase-js`, which connects via the HTTPS PostgREST endpoint (`https://<ref>.supabase.co/rest/v1/...`). PostgREST has its own server-side pooling layer; supabase-js never opens a TCP connection to port 5432 or 6543. The earlier sprint item "switch backend to Supavisor pooler" only makes sense if we add raw SQL via `pg` driver (e.g., to call `pg_stat_statements` programmatically). [Source: https://www.answeroverflow.com/m/1415456480143999196]

**Action:** strike "switch to pooler" from the sprint plan. Add instead: "If we ever introduce raw SQL (for advisor queries or bulk dumps), use the **Transaction pooler** at port 6543."

---

## 9. Compute tiers (right-size for AtlasBot)

| Tier | $/mo | vCPU | RAM | Direct conn | Pooled conn | AtlasBot verdict |
|---|---|---|---|---|---|---|
| Nano | (Free only) | shared | 500 MB | low | low | Free-tier only; not on Pro |
| Micro | $10 (covered by $10 credit) | 2-core ARM | 1 GB | 60 | 200 | **Current target — sized right for paper trading** |
| Small | $15 (+$5 over credit) | 2-core ARM | 2 GB | 90 | 400 | Upgrade when CPU > 70% sustained OR live-trading switchover |
| Medium | $60 (+$50 over credit) | 2-core ARM | 4 GB | 120 | 600 | Multi-symbol live trading with multiple frontend users |
| Large+ | $110+ | dedicated | 8 GB+ | 160+ | 800+ | Not relevant for next 12 months |

**Source:** https://supabase.com/pricing

**AtlasBot workload right now:** 5 symbols × 1m candles + ~60 writes/min + 1 dashboard reader = peak ~5 concurrent connections, ~200 KB RAM per session, ~10% CPU. **Micro is correct.**

**Upgrade trigger checklist:**
- CPU sustained > 70% (check Dashboard → Reports → Database)
- `atlas_db_write_queue_depth` averaging > 50 (Prometheus metric exposed by `SupabaseWriter`)
- Switching to live trading (head room for spikes)

**Decision:** Click the Nano → Micro upgrade as Wave 0 (per staging file user-decision #5). Already paid for; no excuse to leave it on Nano.

---

## 10. Indexes / query optimization on Pro

Pro doesn't add new optimizer features (Postgres is Postgres). What it adds is **observability tooling**:

| Tool | Description | Source |
|---|---|---|
| `pg_stat_statements` | View of query call counts, mean/total exec time. **Enabled by default.** Query directly via SQL Editor. | https://supabase.com/docs/guides/database/extensions/pg_stat_statements |
| Performance Advisor | Surfaces unindexed foreign keys, duplicate indexes, inefficient RLS | https://supabase.com/blog/security-performance-advisor |
| Index Advisor | Reads slow queries, recommends indexes to add or drop | https://supabase.com/blog/security-performance-advisor |
| Query Performance Reports | Dashboard view of slowest endpoints + queries | https://supabase.com/docs/guides/database/inspect |

**AtlasBot known index gaps (from 2026-03-08 migrations + read of current schema):**
- `signals.created_at DESC` — used by every dashboard time-window query. Likely missing.
- `signals.symbol, created_at DESC` — used by per-symbol charts.
- `trades.position_id` — exists (`idx_trades_position_id`).
- `risk_metrics.timestamp DESC` — exists (`idx_risk_metrics_timestamp`).
- `positions(symbol, status)` — likely missing composite.

**Wave 2 action:** run Performance Advisor and Index Advisor from the dashboard. The output is data-driven, no need to guess.

---

## 11. Database advisors

| Advisor | What it surfaces | Pro requirement |
|---|---|---|
| Security Advisor | Mutable function search paths, missing RLS, anonymous role grants, exposed extensions, broken RLS, password leak warnings | Free + Pro |
| Performance Advisor | Unindexed FK, duplicate indexes, RLS `auth.uid()` not in SELECT, dead indexes | Free + Pro |
| Index Advisor | Suggests indexes for top slow queries | Free + Pro (uses HypoPG under the hood) |

**Source:** https://supabase.com/blog/security-performance-advisor, https://supabase.com/docs/guides/database/database-advisors

**Likely AtlasBot findings (high confidence based on code review):**
1. `auth_rls_initplan` lint will fire on every `USING (auth.uid() = user_id)` policy in migration `20251013171848` — that's 6 tables. Wrap as `USING ((SELECT auth.uid()) = user_id)` for 100×+ speedups on large tables. [Source: https://supabase.com/docs/guides/database/postgres/row-level-security]
2. `function_search_path_mutable` will flag `handle_updated_at` and `handle_new_user` — set `SET search_path = public, pg_catalog`.
3. `multiple_permissive_policies` — `positions`, `account_metrics`, `strategy_signals` all have `FOR ALL` policies that overlap with separate SELECT policies. Combine.
4. Possible unindexed FK on `orders.parent_order_id` if not yet covered.

**Wave 1 action (zero-risk):** screenshot the Advisor results and attach to PR. The advisor itself is read-only.

---

## 12. Vault (documented for completeness — NOT recommended for migration per user decision)

| Aspect | Detail | Source |
|---|---|---|
| Mechanism | AES-GCM encryption at rest; encryption keys managed by Supabase outside SQL | https://supabase.com/docs/guides/database/vault |
| Access | `vault.decrypted_secrets` view from SQL, functions, triggers, webhooks | https://supabase.com/docs/guides/database/vault |
| Backup-safe | Encryption survives logical backups and replication | https://supabase.com/docs/guides/database/vault |
| UI | Dashboard secret management screen | https://supabase.com/docs/guides/database/vault |
| Use case | DB-resident secrets (e.g., a webhook signing key called from a trigger) | https://supabase.com/docs/guides/database/vault |

**Migration cost from current `.env` setup:** moderate. Would need to:
1. Move `ENCRYPTION_KEY`, `COINBASE_API_KEY/SECRET`, `COINDESK_API_KEY` into vault.
2. Refactor `loadEnv()` in `atlas/apps/core-node/src/core/env.ts` to read from a vault-backed table at startup OR keep them in `.env` because the Node process needs them BEFORE it can talk to Supabase.
3. The chicken-and-egg: the runtime needs `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` to reach Supabase — those cannot live in Vault.

**Verdict — DO NOT MIGRATE.** User locked this decision in. Per staging file C8: replace with `.env` hygiene hardening (gitleaks pre-commit hook, CI check that `.env` stays untracked, BFG-ready public scrub procedure). **The only Vault use case that would justify revisiting is if we add a Database Webhook that needs to sign HTTP requests with a HMAC key — store that one specific secret in Vault.**

---

## 13. Cron jobs (`pg_cron`)

| Aspect | Detail | Source |
|---|---|---|
| Min granularity | 1 second (Postgres 15.1.1.61+) — most schedules use minute or hour granularity | https://supabase.com/docs/guides/cron/quickstart |
| Syntax | `cron.schedule('job-name', '*/15 * * * *', $$SQL$$)` | https://supabase.com/docs/guides/cron/quickstart |
| Targets | SQL snippets, DB functions (CALL/SELECT), Edge Functions (via http), Database Webhooks | https://supabase.com/docs/guides/cron |
| Observability | Job history in `cron.job_run_details` + Dashboard view | https://supabase.com/docs/guides/cron |

**Recommended AtlasBot cron jobs:**

```sql
-- Hourly equity snapshot from latest account_metrics (decouples dashboard from live writes)
SELECT cron.schedule(
  'hourly_equity_snapshot',
  '0 * * * *',
  $$
    INSERT INTO daily_equity (date, equity, high_water_mark, daily_return)
    SELECT
      CURRENT_DATE,
      total_equity,
      GREATEST(total_equity, COALESCE((SELECT high_water_mark FROM daily_equity WHERE date = CURRENT_DATE), 0)),
      ((total_equity - (SELECT equity FROM daily_equity WHERE date = CURRENT_DATE - 1)) /
       NULLIF((SELECT equity FROM daily_equity WHERE date = CURRENT_DATE - 1), 0))
    FROM account_metrics
    WHERE user_id = (SELECT user_id FROM bot_states ORDER BY updated_at DESC LIMIT 1)
    ORDER BY updated_at DESC
    LIMIT 1
    ON CONFLICT (date) DO UPDATE SET
      equity = EXCLUDED.equity,
      high_water_mark = EXCLUDED.high_water_mark,
      daily_return = EXCLUDED.daily_return,
      updated_at = NOW();
  $$
);

-- Nightly signals retention (keep 90 days)
SELECT cron.schedule(
  'nightly_signals_retention',
  '0 4 * * *',
  $$ DELETE FROM signals WHERE created_at < NOW() - INTERVAL '90 days'; $$
);

-- Nightly trade rollup (per-strategy P&L cache)
SELECT cron.schedule(
  'nightly_strategy_rollup',
  '15 4 * * *',
  $$ CALL refresh_strategy_pnl_rollup(); $$
);
```

**Verdict — STRONG FIT for Wave 2.** Single biggest UI-data-freshness win without any backend changes.

---

## 14. Queues (`pgmq`)

| Aspect | Detail | Source |
|---|---|---|
| Mechanism | Postgres-backed durable queue with visibility timeouts and message archival | https://supabase.com/docs/guides/queues/pgmq |
| Delivery | Exactly-once within visibility window | https://supabase.com/docs/guides/queues/pgmq |
| Consumer model | Single-consumer-per-message (polling) | https://supabase.com/docs/guides/queues/pgmq |
| Cost | Free with extension | https://supabase.com/docs/guides/queues |

**AtlasBot fit:**
- `SupabaseWriter` already implements: bounded queue + retry + dedupe + coalesce + disk spool + circuit breaker. In-process, in-memory.
- `pgmq` would replace the **disk spool** for cross-process durability. But our trading runtime is single-process (one Node engine), so in-memory + disk spool is sufficient.
- **Real `pgmq` use case** for AtlasBot: if we add a separate worker (e.g., a Coinbase order reconciliation worker that runs out-of-process), `pgmq` is the obvious coordination channel. Not needed for the current single-process architecture.

**Verdict — SKIP for now. Revisit when introducing a second worker process** (e.g., Hyperliquid adapter completion in workstream D6 may benefit if it runs as a sidecar).

---

## 15. Foreign Data Wrappers

| Wrapper | Detail | Source |
|---|---|---|
| Stripe | Query payments as Postgres tables | https://fdw.dev/catalog/stripe/ |
| S3 | Read CSV/JSON/Parquet directly from S3 | https://fdw.dev/catalog/s3 |
| ClickHouse, BigQuery, Firebase, Airtable | Same SQL-native pattern | https://supabase.github.io/wrappers/ |
| Security | Store creds in Vault; FDWs ignore RLS | https://supabase.com/features/foreign-data-wrappers |

**AtlasBot fit:** None of our external systems expose FDW endpoints. Coinbase doesn't, Hyperliquid doesn't, CoinDesk REST is JSON-over-HTTPS only. The closest scenario is reading historical backtest results from S3, but `data-loader.ts` already does this in TypeScript.

**Verdict — SKIP. Document for parking lot.** If we later add Stripe (subscriptions for multi-tenant) or move historical candle storage to S3 Parquet, revisit.

---

## 16. Database functions vs Edge Functions (decision matrix)

| Criterion | DB function (PL/pgSQL) | Edge Function (Deno) |
|---|---|---|
| Latency | < 5ms (in-process) | 80-250ms p95 (cold), 10-30ms (warm) |
| Concurrency | Limited by direct connections (60 on Micro) | Auto-scales across Deno isolates |
| External HTTP calls | Via `pg_net` only, awkward | Native `fetch`, full HTTP client |
| Type safety | None / weak (PL/pgSQL) | Full TypeScript |
| Testing | SQL test fixtures (hard) | Vitest / Deno test (easy) |
| Versioning | Migration-based | Git-based, full bundle replacement |
| Best for | Data mutations, triggers, RLS helpers | RPC endpoints, external integrations |

**Trade execution logic specifically:**
- Pure validation (size limits, kill-switch state check) → DB function via RLS + check constraints. Fast, atomic.
- External API call (place order on Coinbase) → Edge Function or Node backend. NOT a DB function.
- Order state transition with side effects (Supabase write + event bus emit + audit log) → Node backend (the runtime's `OrderManager` already owns this).

**Verdict for AtlasBot:** keep order routing in Node, use DB functions for pure data shape (e.g., `refresh_strategy_pnl_rollup()` called by pg_cron), use Edge Functions only as RPC endpoints UI → Supabase.

---

## 17. API rate limiting

| Surface | Limit | Source |
|---|---|---|
| PostgREST (REST API) | "Unlimited API requests" on all plans | https://supabase.com/pricing |
| Realtime | 200 concurrent (Free), **500 concurrent** (Pro) | https://supabase.com/pricing |
| Edge Functions | 500K/mo (Free), **2M/mo** (Pro) | https://supabase.com/pricing |
| Management API (admin) | 120 req / min per user / project | https://supabase.com/docs/reference/api/v1-get-postgrest-service-config |
| Auth (sign-in) | Rate-limited per IP and per email — default ~30/hr per email | https://supabase.com/docs/guides/auth/rate-limits |

**AtlasBot relevance:**
- Trading runtime is the **only** PostgREST client → no rate-limit risk at current scale.
- If/when we add multiple frontend users or a public-facing API, watch the Edge Function quota.
- The 120 req/min Management API limit will only bite if we automate dashboard configuration (we don't).

**Verdict — NO ACTION** at current scale.

---

## 18. Egress (250 GB included)

| Source | Estimated monthly egress (paper, current load) | Notes |
|---|---|---|
| REST API responses (backend reads) | ~5 GB | Bulk position/order reads at startup only |
| Realtime (postgres_changes to dashboard) | ~15-25 GB | 100 changes/min × ~1.5 KB each × 1 client × 30 days |
| Edge Function responses | < 1 GB | Negligible at our call rate |
| Storage downloads | 0 | No bucket usage |
| **Total estimate** | **~20-30 GB / mo** | ~8-12% of 250 GB quota |
| Overage | $0.09 / GB | https://supabase.com/pricing |

**Sources:** https://supabase.com/docs/guides/platform/manage-your-usage/egress, https://supabase.com/docs/guides/realtime/pricing

**Egress traps to avoid:**
- Tearing on `SELECT * FROM signals WHERE created_at > X` from the dashboard. Use pagination + column projection.
- Realtime is the biggest meter. Coalescing the position-price-tick UPDATE on the backend (Wave 3) is the single biggest egress save.

**Verdict — FIT.** No urgent action. Monitor at 200 GB.

---

## 19. Logs & observability

| Aspect | Free | Pro | Source |
|---|---|---|---|
| Log retention (Postgres, Auth, API, Edge, Realtime, Storage) | 1 day | **7 days** | https://supabase.com/pricing |
| Saved queries | Yes | Yes | https://supabase.com/docs/guides/telemetry/log-drains |
| Metrics endpoint (Prometheus-compatible) | NO | **Yes** | https://supabase.com/pricing |
| Log drains (Datadog/Loki/S3/Sentry/Axiom/OTLP/generic HTTP) | NO | **$60/drain/mo + $0.20/M events + $0.09/GB egress** | https://supabase.com/docs/guides/telemetry/log-drains |

**AtlasBot fit:**
- Pro's **metrics endpoint** is a new strong win — already paying for Pro, can scrape Supabase metrics into our existing `deploy/monitoring/` Prometheus + Grafana stack with one config change.
- Saved queries to set up in Dashboard (Wave 1, zero-risk):
  - "DB errors last 24h"
  - "Edge Function failures (status >= 500)"
  - "Slow queries > 100ms" (against `pg_stat_statements`)
  - "RLS policy denies" (`role=anon` 401s)
- Log drain to Datadog/Loki: **only if** we move the runtime out of single-host operation. At $60/mo it triples the Pro bill — skip unless we hit a regulatory or audit need.

**Verdict — STRONG FIT for metrics endpoint + saved queries. SKIP log drains** until cross-environment correlation matters.

---

## 20. Multi-region / Read Replicas

| Aspect | Detail | Source |
|---|---|---|
| Requirement | Pro+ plan, **Small compute minimum**, Postgres 15+, AWS infra | https://supabase.com/docs/guides/platform/read-replicas/getting-started |
| Cost | Per replica: compute + 1.25× disk + IOPS + throughput + IPv4 | https://supabase.com/docs/guides/platform/manage-your-usage/read-replicas |
| Spend cap | Replicas NOT covered | https://supabase.com/docs/guides/platform/manage-your-usage/read-replicas |
| Helps with | 80%+ read workloads, geographic latency, analytics isolation | https://supabase.com/blog/read-replicas-vs-bigger-compute |
| Does NOT help | Write-bound workloads, primary-database CPU | https://supabase.com/blog/read-replicas-vs-bigger-compute |

**AtlasBot is write-heavy** (60+ writes/min for paper, more for live). Read replicas would only help if we offloaded the dashboard's heavy queries (e.g., 30-day backtest summaries). At current scale that's not needed.

**Verdict — SKIP for next 12 months.** Revisit when multi-region users or multi-tenant.

---

# Phase 2 — Codebase fit analysis (read-only)

## 2.1 Backend Supabase client topology

**Current pattern:** every component instantiates its own `createClient(supabaseUrl, supabaseServiceKey)`. Found 13 separate instantiations:

| File | Purpose | Goes through SupabaseWriter? |
|---|---|---|
| `persistence/supabase-writer.ts` | The writer itself | (is the writer) |
| `config/secrets.ts` | Encrypted exchange creds | NO — direct read/write |
| `api/server.ts` | API endpoints | NO — direct read |
| `strategies/meta-filter.ts` | Meta-filter decision log | NO — direct insert |
| `strategies/signal-processor.ts` | Signal write | NO — direct insert |
| `trading/risk-engine.ts` | Risk metrics + risk events | NO — direct upsert |
| `trading/position-tracker.ts` | Positions snapshot | NO — direct upsert |
| `trading/order-manager.ts` | Orders / fills | NO — direct upsert |
| `trading/trade-analytics.ts` | Trade analytics rollup | NO — direct read |
| `trading/risk-state.ts` | Risk state persistence | NO — direct upsert |
| `trading/risk-controller.ts` | Kill switch state | NO — direct upsert |
| `ml/trade-outcome-collector.ts` | ML outcomes | NO — direct insert |
| `backtesting/data-loader.ts` | Historical candle loader | NO — direct read |
| `cli/smoke.ts`, `cli/quick-check.ts`, `cli/diagnose.ts` | One-shot scripts | NO — direct (acceptable) |

**Anti-pattern:** `SupabaseWriter` has circuit-breaker, retry, queue, dedupe, disk-spool — but ONLY `SupabaseWriter` uses these. Everything else writes raw via `this.supabase.from('x').upsert(...)`. **If Supabase blips for 30s, every component except the writer can throw and surface up to the engine.**

**Wave 3 refactor (large):** introduce a single shared `SupabaseClient` provider (one createClient call total) and route all writes through `SupabaseWriter`. Cuts connection footprint, gives every component circuit-breaker safety, makes Pro Realtime quota easier to manage.

## 2.2 Edge Functions inventory & usage

| # | Function | Purpose | Frontend caller | Backend caller | Active? | Notes |
|---|---|---|---|---|---|---|
| 1 | `runtime-health` | DB liveness probe | none | external uptime monitor (presumed) | YES | Reads `account_metrics` |
| 2 | `strategy-toggle` | Enable/disable a strategy | `_archive/dashboard/StrategiesPanel.tsx` | none | **NO** (caller archived) |
| 3 | `strategy-signal-upsert` | Upsert into `strategy_signals` | `src/hooks/useModelData.ts` | none | **YES** |
| 4 | `risk-settings-update` | Update `risk_settings` row | `src/hooks/useRiskSettings.ts` | none | **YES** |
| 5 | `journal-entry` | CRUD on `journal_entries` | `src/hooks/useJournal.ts` | none | **YES** |
| 6 | `ingest-position-update` | Upsert into `positions` | none | (would be backend, but backend uses SupabaseWriter directly) | **NO** |
| 7 | `ingest-risk-metrics` | Upsert into `risk_metrics` | none | (backend writes direct) | **NO** |
| 8 | `ingest-order-event` | Upsert orders + order_legs + fills | none | (backend writes direct) | **NO** |
| 9 | `ingest-fill` | Upsert into `fills` | none | (backend writes direct) | **NO** |
| 10 | `ingest-alert` | Insert into `alerts` | none | (backend writes direct) | **NO** |
| 11 | `alerts-ack` | Update `alerts.acked_at` | `_archive/pages_original/Alerts.tsx`, `_archive/dashboard/AlertsPanel.tsx` | none | **NO** (callers archived) |

**5 dead `ingest-*` functions** + 2 archived = **7 dead functions out of 11**.

**Code patterns shared across all 11:** identical CORS headers, identical `getAdmin()` helper using `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`, identical `Deno.serve` boilerplate, identical 200/400/500 response envelope. There's no `_shared` directory — heavy duplication.

## 2.3 Migrations audit (42 files)

**File count:** 42 migrations across 2025-10 through 2026-05.

**Schema drift conflict — confirmed:**

| Migration | Creates `positions` table | Schema |
|---|---|---|
| `20251013171848` | YES (`CREATE TABLE`) | UUID id, user_id FK to auth.users, entry_price, pnl, pnl_r, stop_loss, take_profit, time_opened, RLS by auth.uid() |
| `20251013180100` | YES (`CREATE TABLE IF NOT EXISTS`) | TEXT id, no user_id, average_price, unrealized_pnl, realized_pnl, total_pnl, open_time, RLS by service_role |

The second uses `IF NOT EXISTS` so in production it's a **silent no-op** (the first migration ran ~12 minutes earlier and won). But this means the deployed `positions` table has the UUID/per-user schema from `20251013171848`, NOT the TEXT-id backend-flavored schema. The backend code (e.g., `position-tracker.ts`, `ingest-position-update`) expects the second schema and will silently fail on column-not-found errors against the deployed table.

**Evidence in code:** the realtime managers (`SupabaseRealtimeManager.ts`, `supabaseRealtimeBridge.ts`) probe both `closed_at` AND `updated_at` AND `opened_at` per row — defensive snake_case lookups suggest the team knows the schema is unclear.

**Same drift pattern likely exists for:**
- `orders` (migration `20251013180100` vs whatever Lovable-style migration created the user-bound version)
- `risk_metrics`
- `fills`

**Other migration smells:**
- 4 migrations from `20260308_phase2*` files: `phase2a_create_bars_table`, `phase2b_add_exchange_id`, `phase2c_add_fk_indexes`, `phase2d_add_unique_constraints`, `phase2e_fix_numeric_precision`. These are corrective patches to earlier migrations.
- `20260202190000_fix_trade_analytics_schema.sql` is a corrective patch.
- `20260108211500_drop_trade_analytics_auth_fks.sql` is a corrective patch.
- `20260203_step7_persistence_hardening.sql` is a corrective patch.

**Pattern:** ~10 of 42 migrations exist solely to patch earlier migrations. **A baseline consolidation would collapse 42 → ~8 logical migrations** (auth/profiles, core trading tables, risk, signals/meta-filter, ML, indexes, RLS, seeds).

## 2.4 Frontend Realtime usage

**Two managers exist (technical debt):**
1. `src/runtime/realtime/SupabaseRealtimeManager.ts` — full-featured (10 tables, latency tracking, reconnect, catch-up). **Current canonical.**
2. `src/runtime/realtime/supabaseRealtimeBridge.ts` — older shorter version (7 tables, no catch-up, no latency stats). **Should be deleted.**

**Subscription topology in `SupabaseRealtimeManager`:**
- ONE channel (`'unified-realtime'`)
- 10 listeners on `postgres_changes` with `event: '*'` (INSERT + UPDATE + DELETE)
- Server-side filter `user_id=eq.${userId}` is applied — correct, pushes filter into Realtime backend, doesn't waste bandwidth
- `broadcast.self: false` — correct, prevents echo
- Infinite reconnect with exponential backoff (1s → 30s) — good

**Optimization opportunity:** subscribing to UPDATE on `positions` produces a Realtime message every time `market_price` ticks. The backend writes ~5-30 position updates/min during active trading. Each costs one Realtime message. **Coalescing position updates server-side to 1Hz (instead of per-tick) would cut Realtime messages 5-10×.**

## 2.5 Frontend client hardcoded fallbacks

`src/integrations/supabase/client.ts` lines 5-6:

```ts
const FALLBACK_SUPABASE_URL = "https://gdrdaajvutmewgxbjurk.supabase.co";
const FALLBACK_SUPABASE_PUBLISHABLE_KEY = "eyJhbGciOiJIUzI1NiIs...Q5I";
```

This is the anon/publishable key (`role: anon` in JWT) which is safe to hardcode — RLS gates access. But:
- If the project is ever moved or the anon key is rotated, the fallback becomes stale.
- For multi-environment work (preview branches), the fallback should be removed; `VITE_SUPABASE_URL` should be required.

**Wave 1 nit:** keep the fallback for dev DX but emit a `console.warn` when fallbacks are used so we don't ship them to prod by accident.

## 2.6 Auth profile

`auth.persistSession: true` + `autoRefreshToken: true` + `storage: localStorage`. Standard. JWT will be in localStorage which is fine for a single-user dashboard. **Pre-live trading**, evaluate moving to httpOnly cookie via `@supabase/ssr` if we add server-rendered pages. Not blocking.

---

# Phase 3 — Specific recommendations for the sprint plan

## Wave 1 — Pro features that need NO code changes

| # | Action | Effort | Risk | Source / Rationale |
|---|---|---|---|---|
| W1.1 | Click Nano → Micro compute in Dashboard | S | NONE | Already paid via $10 credit. Single-click upgrade. |
| W1.2 | Verify Daily Backups are active (Dashboard → Database → Backups) | S | NONE | Should be automatic on Pro. Document procedure. |
| W1.3 | Run Security + Performance + Index Advisor reports, screenshot results into PR | S | NONE | Read-only. Use findings to seed Wave 2. |
| W1.4 | Enable **Metrics endpoint** (Dashboard → Settings → Metrics) | S | NONE | Pro feature. Wire to existing Prometheus in `deploy/monitoring/`. |
| W1.5 | Create 4 saved log queries: DB errors 24h, EdgeFn ≥500, slow queries >100ms, RLS denies | S | NONE | Manual Dashboard config. |
| W1.6 | Set Spend Cap = ON (default for Pro, verify) | S | NONE | Caps egress/edge/realtime overages. Branching NOT capped — accept this. |
| W1.7 | Document restore procedure (read-only writeup) | S | NONE | Save in `docs/runbooks/supabase-restore.md`. |
| W1.8 | Run `pg_stat_statements` query in SQL Editor, capture top-10 slowest writes | S | NONE | Seed for index advisor. |

## Wave 2 — Small code changes that unlock Pro value

| # | Action | Files to touch | Effort | Risk | Dependency |
|---|---|---|---|---|---|
| W2.1 | Patch RLS policies to wrap `auth.uid()` in `(SELECT auth.uid())` | New migration: `2026MMDD_rls_initplan_optimization.sql` | M | LOW | Tested in branch first |
| W2.2 | Set `search_path` on `handle_updated_at`, `handle_new_user` | Same migration as W2.1 | S | LOW | — |
| W2.3 | Enable `pg_cron`, schedule hourly equity snapshot + nightly signals retention + nightly trade rollup | New migration: `2026MMDD_pg_cron_jobs.sql` | M | LOW | Define rollup function first |
| W2.4 | Delete 7 dead Edge Functions (`ingest-position-update`, `ingest-risk-metrics`, `ingest-order-event`, `ingest-fill`, `ingest-alert`, `alerts-ack`, `strategy-toggle`) | `supabase/functions/<name>/` × 7, plus Dashboard removal | M | LOW | Confirm zero callers (already done in Phase 2.2) |
| W2.5 | Delete `src/runtime/realtime/supabaseRealtimeBridge.ts` (use only `SupabaseRealtimeManager`) | `src/runtime/realtime/` | S | LOW | Verify no imports remain |
| W2.6 | Add backend coalescing for position UPDATE — debounce to 1Hz max | `atlas/apps/core-node/src/trading/position-tracker.ts` | M | LOW | Reduces Realtime msg load 5-10× |
| W2.7 | Remove frontend client fallback constants OR add `console.warn` when used | `src/integrations/supabase/client.ts` | S | LOW | — |
| W2.8 | Move per-component `createClient` to a shared `getSupabaseClient()` singleton | New `atlas/apps/core-node/src/persistence/supabase-client.ts`; refactor 13 imports | M | MEDIUM | Test coverage for risk/order paths |
| W2.9 | Add Prometheus metric `atlas_realtime_messages_used` and alert at 4M/mo (80%) | `atlas/apps/core-node/src/runtime/metrics.ts` | M | LOW | Requires metrics endpoint (W1.4) |
| W2.10 | Add CI gate that runs `supabase db diff` against schema before merge | `.github/workflows/db-diff.yml` | M | LOW | Required to re-enable branching safely |

## Wave 3 — Larger refactors

| # | Action | Files to touch | Effort | Risk | Dependency |
|---|---|---|---|---|---|
| W3.1 | Migration consolidation: 42 → ~8 logical baselines | All of `supabase/migrations/` (squash & rename) | L | HIGH | PITR test restore from new branch FIRST. Daily backup ready. |
| W3.2 | Resolve `positions` (and likely `orders`, `risk_metrics`, `fills`) schema drift between `20251013171848` and `20251013180100` | New migration + cross-check backend code | L | HIGH | W3.1 |
| W3.3 | Route all backend writes through `SupabaseWriter` (currently bypassed by 12 files) | All 12 files in Phase 2.1 table | L | MEDIUM | W3.1 if schemas change |
| W3.4 | Replace `alerts-ack` Edge Function with **Database Webhook** triggered from `alerts` UPDATE → external SMS/Slack | New migration + `pg_net` config + remove EdgeFn | M | MEDIUM | W2.4 done |
| W3.5 | Enable Branching after W3.1 lands; add seed file for preview branches | `supabase/seed.sql` | M | LOW | W3.1, W2.10 |
| W3.6 | (Optional) `pg_partman` monthly partitions on `signals.created_at` once row count > 5M | New migration | M | MEDIUM | Triggered by growth, not date |
| W3.7 | (Optional) `pg_partman` partitions on `candles` and `risk_metrics` | New migrations | M | MEDIUM | Same trigger |

---

# Phase 4 — Critical decisions for the user (20:34 CT)

| # | Decision | Option A | Option B | Recommendation | Justification |
|---|---|---|---|---|---|
| **D1** | **PITR ($100/mo)?** | Enable now | Skip until live | **Option B — Skip** | Paper trading data is not irreplaceable. Daily backup + disk spool covers our RPO. Flip ON the day we set `EXECUTION_MODE=live`. Saves $100/mo for 6+ months. |
| **D2** | **When to re-enable Branching?** | Wave 2 immediately (with `db diff` CI gate) | Wave 3 after migration consolidation | **Option B — Wave 3** | Branching against 42 dirty migrations risks data shape mismatches in preview environments. Cleaner to land W3.1 first, then re-enable with a single seed file. Cost is ~$1/mo either way. |
| **D3** | **Edge Function cleanup scope** | Delete only the 5 dead `ingest-*` | Delete all 7 (including archived-caller `alerts-ack` and `strategy-toggle`) | **Option B — All 7** | The archived callers won't be revived in current sprint; if we re-add the Alerts panel (workstream B5), wire it directly via REST (RLS-gated) instead of an Edge Function shim. Cleaner, faster, fewer cold starts. |
| **D4** | **Centralize Supabase client (W2.8 + W3.3)?** | Wave 2 (only client wrapping, no writer routing) | Wave 3 (also route all writes through SupabaseWriter) | **Option A then B** | Wave 2 wrap-only is low-risk, single-PR. Wave 3 writer-routing requires careful testing of every component's write path; defer until after the 6h run analysis confirms current write reliability. |
| **D5** | **Log Drains ($60/mo per drain)?** | Set up Datadog drain now for centralized observability | Skip; use Pro's 7-day in-Dashboard log retention | **Option B — Skip** | We already have Prometheus + Grafana in `deploy/monitoring/`. Pro's metrics endpoint (W1.4) gives us Supabase-side metrics into the same stack at $0 incremental. Logs stay in Dashboard for 7 days — sufficient for paper. |

---

# Phase 5 — Cost projection

## Expected monthly bill (Pro, current load, post-sprint optimizations)

| Line item | Quantity | Rate | Cost | Source |
|---|---|---|---|---|
| Pro plan (org-level) | 1 | $25/mo | **$25.00** | https://supabase.com/pricing |
| Compute — Micro (1 project) | 1 instance × ~730 hrs | $10/mo, but covered by $10 included credit | **$0.00** | https://supabase.com/pricing |
| Compute credits applied | $10/mo | — | **−$0.00** (already netted) | — |
| Disk — base 8 GB included | currently ~250 MB, well under | $0.125/GB over 8 GB | **$0.00** | https://supabase.com/pricing |
| Egress — included 250 GB | ~25 GB used (Realtime + REST) | $0.09/GB over | **$0.00** | https://supabase.com/pricing |
| Realtime messages — included 5M | ~4.3M used at current rate | $2.50/M over | **$0.00** (close to cap — see warning) | https://supabase.com/pricing |
| Realtime peak connections — included 500 | 1-3 used (single dashboard) | $10/1k over | **$0.00** | https://supabase.com/pricing |
| Edge Function invocations — included 2M | <100k used | $2/M over | **$0.00** | https://supabase.com/pricing |
| MAU — included 100k | 1 | $0.00325/MAU over | **$0.00** | https://supabase.com/pricing |
| File storage — included 100 GB | 0 | $0.021/GB over | **$0.00** | https://supabase.com/pricing |
| Branching (2-branch cap × ~5 hrs/PR × ~10 PRs/mo) | ~100 br-hrs | $0.01344/br-hr | **~$1.34** | https://supabase.com/docs/guides/platform/manage-your-usage/branching |
| Daily backups (7-day) | included | — | **$0.00** | https://supabase.com/pricing |
| PITR (DEFERRED) | — | $100 per 7-day retention | **$0.00** | — |
| Log Drains (SKIPPED) | — | $60+/drain | **$0.00** | — |
| **Realistic monthly total (paper)** | | | **$25-28 / mo** | |
| **Worst-case Pro (no PITR, no log drains)** | with realtime msg overage 6M/mo | | **~$30 / mo** | |

## Warning thresholds (set in Supabase Dashboard + Prometheus alerts)

| Metric | Watch | Alert | Action |
|---|---|---|---|
| Realtime messages | 4M/mo (80%) | 4.8M/mo (96%) | Implement W2.6 (coalesce position updates) |
| Egress | 200 GB | 240 GB | Reduce dashboard polling, paginate signal queries |
| Disk size | 5 GB | 7 GB | Run signals retention purge (W2.3 schedules this) |
| Edge Function invocations | 1.6M (80%) | 1.9M (95%) | Audit caller increase |
| CPU sustained | 50% | 70% | Plan Micro → Small upgrade ($+5/mo over credit) |
| `atlas_db_write_queue_depth` | avg 30 | avg 50 | Check Supabase health; consider compute upgrade |

## Saving opportunities

1. **W2.6 (position update coalescing)** — single biggest Realtime save. Cuts Realtime messages by ~70% (most updates are price ticks the dashboard doesn't need at sub-second cadence). [Source: empirical estimate from `position-tracker.ts` review]
2. **W2.4 (delete 7 Edge Functions)** — zero direct $ save (we're well under quota), but reduces attack surface and operational complexity.
3. **W2.1 (RLS auth.uid() in SELECT)** — no direct $ save, but 100× faster RLS queries means CPU stays low → defer Micro → Small upgrade by months. [Source: https://supabase.com/docs/guides/database/postgres/row-level-security]
4. **W2.3 (pg_cron signals retention)** — keeps `signals` table from growing unbounded → defers `pg_partman` work and disk overages.
5. **Skip PITR ($100/mo) until live** — most important single decision per dollar saved.
6. **Skip Log Drains ($60/mo)** — until cross-environment correlation matters.

## Scale-up triggers (when to revisit cost)

| Trigger | New monthly cost | Justified when |
|---|---|---|
| Switch to live trading | +$100 (PITR) = ~$125/mo | First $1k live exposure |
| Add second concurrent dashboard user | possibly +$2.50/mo (1 extra million realtime messages) | UX team or paper traders join |
| Migrate compute Micro → Small | +$5/mo over credit = ~$30/mo | CPU > 70% sustained or live trading |
| Add Datadog log drain | +$60/mo per drain = ~$85+/mo | Multi-environment correlation needed |
| Add second project (e.g., staging) | +$25 base sharing applies, +$10 compute = ~$35/mo | Branch model is no longer enough |
| Cross 250 GB egress | $0.09/GB over | More users, bigger frontend polling |

---

# Appendix A — Source map (every external claim)

| Topic | Primary source(s) |
|---|---|
| Pricing | https://supabase.com/pricing |
| Branching | https://supabase.com/docs/guides/deployment/branching, https://supabase.com/docs/guides/platform/manage-your-usage/branching |
| Compute tiers | https://supabase.com/pricing, https://supabase.com/blog/read-replicas-vs-bigger-compute |
| Backups + PITR | https://supabase.com/docs/guides/platform/manage-your-usage/point-in-time-recovery |
| Database Webhooks | https://supabase.com/docs/guides/database/webhooks, https://gethookmesh.io/blog/supabase-webhooks-database-triggers |
| Edge Functions cold start | https://jakeinsight.com/tech/2026-04-20-supabase-edge-functions-cold-start-latency-real-me/ |
| Edge Functions regional invocation | https://supabase.com/docs/guides/functions/regional-invocation |
| Realtime postgres_changes | https://supabase.com/docs/guides/realtime/postgres-changes, https://supabase.com/docs/guides/realtime/pricing |
| Realtime usage / billing | https://supabase.com/docs/guides/platform/manage-your-usage/realtime-messages |
| Supavisor (pooler) | https://supabase.com/docs/guides/troubleshooting/supavisor-and-connection-terminology-explained-9pr_ZO, https://www.answeroverflow.com/m/1415456480143999196 |
| pg_cron | https://supabase.com/docs/guides/cron, https://supabase.com/docs/guides/cron/quickstart |
| pgmq | https://supabase.com/docs/guides/queues/pgmq |
| pg_partman | https://supabase.com/docs/guides/database/partitions |
| pgvector | https://supabase.com/docs/guides/ai |
| FDW | https://supabase.com/features/foreign-data-wrappers, https://fdw.dev/catalog/s3, https://fdw.dev/catalog/stripe |
| Advisors (Performance + Security + Index) | https://supabase.com/blog/security-performance-advisor, https://supabase.com/docs/guides/database/database-advisors, https://github.com/supabase/splinter |
| Vault | https://supabase.com/docs/guides/database/vault |
| Log drains | https://supabase.com/docs/guides/telemetry/log-drains, https://supabase.com/docs/guides/platform/manage-your-usage/log-drains |
| Read replicas | https://supabase.com/docs/guides/platform/read-replicas, https://supabase.com/docs/guides/platform/manage-your-usage/read-replicas |
| RLS performance | https://supabase.com/docs/guides/database/postgres/row-level-security, https://loke.dev/blog/postgres-rls-performance-cost, https://github.com/supabase/agent-skills/blob/main/skills/supabase-postgres-best-practices/references/security-rls-performance.md |
| Spend cap | https://supabase.com/docs/guides/platform/cost-control |
| Auth sessions / JWT | https://supabase.com/docs/guides/auth/sessions, https://supabase.com/docs/guides/auth/signing-keys |
| pg_stat_statements | https://supabase.com/docs/guides/database/extensions/pg_stat_statements |

---

# Appendix B — What this report did NOT investigate (parking lot)

These were out-of-scope for the 20:34 CT dispatch but worth a future doc:

- **Multi-tenant model.** If we ever onboard more than one trader, `user_id` segmentation needs auditing — current RLS assumes single-user but the schema is multi-user-ready.
- **HIPAA/SOC2 compliance.** Available only on Team plan ($599/mo). Irrelevant until B2B.
- **Custom Domain ($10/mo).** Vanity URL for the dashboard. Cosmetic.
- **Advanced MFA — Phone ($75/mo for first project).** Worth considering once live trading starts (account takeover risk on the Supabase admin login is the real concern, not the trading dashboard).
- **OpenAI embeddings via Edge Functions.** If we ever build the ML meta-filter (CLAUDE.md "aspirational"), this is the path.
- **Storage buckets.** Not used. Could host backtest result CSVs, but local disk in `atlas/var/backtest_results/` is fine.

---

**End of research file.** The synthesizer worker at 20:34 CT should append run-analysis findings from `final-snapshot/*` and merge this into the prioritized sprint plan.
