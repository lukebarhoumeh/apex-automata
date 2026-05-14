# Apex Automata — Post-Run Sprint Plan (Staging)

> **Tracked location since 2026-05-14 (Wave 2 G7).** Previously at `atlas/var/tmp/monitor/` (gitignored).

**Created:** 2026-05-13 ~15:08 CT
**Triggers when:** Auto-stop fires at 2026-05-14T01:34:07Z (20:34:07 CT)
**Owner:** Synthesizer worker dispatched after end-of-run snapshot

This file accumulates all known sprint items between now and end-of-run so nothing is lost. The synthesizer worker will read this file plus the captured `final-snapshot/*` artifacts and produce a prioritized, ownership-assigned sprint plan with parallel subagent dispatch.

---

## Top-level workstreams (parallel-safe)

### A. Trading bot data analysis (run findings)
*Inputs:* `final-snapshot/01_pre-stop-snapshot.txt`, pulse log, alerts log, post-stop snapshot
*Output:* Run report — strategy performance, fee drag, signal funnel breakdown, regime distribution, anomalies
*Subagent type:* generalPurpose (analysis-only, read-only)

### B. UI bugs — Risk Desk + mock pages → real data
1. **Risk Desk (CRITICAL)** — drawdown shows 12.4% when actual is 0.07%; equity shows $1,522 when actual is $9,983; kill-switch ladder shows TRIPPED states that contradict backend `killSwitch=false`. Frontend miscalculation. Source: today's UI screenshot review.
2. **Model page** — currently displays XGBoost v2.4 mock per CLAUDE.md banner ("aspirational mocks"). Wire to actual rule-based meta-filter: cold-streak counter, time-of-day filter state, recent meta-filter decisions, real ROC AUC = N/A (acknowledge no ML), recent rejection rate.
3. **Backtest page** — displays "+24.38% Donchian Breakout" mock contradicting actual backtest data. Wire to real `pnpm backtest` CLI output (read from `atlas/var/backtest_results/*`), show actual recent runs.
4. **Trade Journal** — confirm if mock or real; if mock, either build feature or remove from sidebar.
5. **Alerts page** — wire trigger log to real alert events from backend's pulse alerts log; verify rule definitions (Large drawdown, Venue latency, Meta drift, Consecutive losses, Symbol exposure breach) are actually wired to backend evaluators or just UI configs.

*Subagent split:* one frontend agent per page (B1-B5 can run in parallel since each touches a different React component tree; shared types/utils require coordination).

### C. Supabase Pro plan optimization deep-dive *(NEW — Pro upgraded 2026-05-13)*
The user upgraded to Pro today. Audit + fully utilize what Pro offers.

**C1. Plan + billing health**
- Verify Pro is active on project `gdrdaajvutmewgxbjurk`
- Confirm Micro compute instance (included in $10 credit)
- Set budget alerts to avoid surprise overages
- Document monthly cost expectation (~$25-35)

**C2. Backups**
- Daily backups now active — verify in dashboard
- Document restore procedure (don't wait until disaster)
- Decide on PITR add-on ($100/mo for 7d retention) — almost certainly skip for paper, revisit at live

**C3. Branching (re-enable decision)**
- Currently disabled (we turned it off to unblock PR #9 today)
- Pro tier allows it; decide whether to re-enable WITH proper migration discipline going forward
- If yes: write a CONTRIBUTING note about migration hygiene; add a CI gate that runs `supabase db diff` against schema before merge
- If no: document decision in CLAUDE.md and keep off

**C4. Edge Functions audit (11 functions per CLAUDE.md)**
- Inventory all 11 in `supabase/functions/`
- For each: is it actually used? Cold start time? Error rate? Proper logging? Auth correctly configured?
- Identify dead functions to remove
- Identify hot functions to optimize
- Pro gives more invocation headroom — confirm we're not artificially throttled

**C5. Database optimization**
- **Indexes** — query plan analysis; identify missing indexes on hot paths (signals time-range queries, trades by session_id, positions by symbol). Drop unused indexes.
- **Migration consolidation** — 40+ migrations in `supabase/migrations/`. Consider Phase B from earlier ("squash to baseline") now that Pro gives us proper backup safety net.
- **Table partitioning for time-series** — `signals`, `candles`, `orders`, `trades` tables likely benefit from monthly partitions
- **RLS policy review** — correctness audit + performance impact (RLS can tank queries)
- **Connection pooling** — verify backend uses PgBouncer (Supavisor) connection string, not direct connection

**C6. Realtime optimization**
- Subscription pattern audit (frontend code)
- Channel limits + broadcast vs presence usage
- Filter pushdown (server-side filters vs client-side)

**C7. MCP connection refresh**
- Earlier we discovered the OAuth token's org doesn't include `gdrdaajvutmewgxbjurk` (only `ChromeEnterpriseProject` + `KalshiTradingBot`)
- Re-authenticate Supabase MCP with the Pro account so we can use `list_migrations`, `apply_migration`, `get_logs`, `get_advisors` against the actual project
- Once connected, run `get_advisors` for security + performance recommendations from Supabase itself

**C8. .env hygiene hardening** *(was Vault — user opted to keep .env)*
- Document rotation procedure for all secrets (Supabase service key, encryption key, Coinbase API)
- Add `.env` to a "scrub before public" checklist (BFG / git-filter-repo) in case repo ever opens
- Verify `.gitignore` rules survive (we just untracked `.env` today via PR #11)
- Add a CI check that fails if `.env` ever gets re-tracked
- Pre-commit hook with `gitleaks` to catch secret leaks before they land

**C9. Auth review**
- JWT lifetimes, refresh token rotation
- MFA on the user account that owns the Supabase project
- Service role key restrictions

**C10. Logs & observability**
- Pro gives 7-day log retention (vs 1 day on Free)
- Set up Supabase Studio log queries / saved views for common debugging:
 - "DB errors last 24h"
 - "Edge Function failures"
 - "Slow queries > 100ms"
 - "RLS policy denies"
- Wire Supabase logs to existing Prometheus/Grafana stack if using

**C11. Cost monitoring**
- Set up Supabase budget alerts at $40/mo ceiling
- Monitor egress (250 GB included; UI realtime polling can eat this)
- Track DB size growth rate

*Subagent type:* generalPurpose with read-only access initially (audit), then write access for selected wiring/migration changes. Can split into 2-3 sub-workers: (a) infra audit (C1-C4), (b) DB+Realtime optimization (C5-C6), (c) Vault+Auth+Logs (C8-C10).

### D. Code/infra cleanup tasks (carry-over from earlier work)
1. **Funnel-bug residuals** — 3 backtest-only `Date.now()` sites in `signal-processor.ts`, `meta-filter.ts`, `signal-arbiter.ts`. Per the funnel scope investigation, these don't affect live but pollute backtest. Separate small PR.
2. **`env.example` completion** — currently only has VITE_* + COINDESK_*. Add backend vars: `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `ENCRYPTION_KEY`, `COINBASE_API_KEY`, `COINBASE_API_SECRET`, `EXECUTION_MODE`, `MARKETDATA_ENV`, etc. With placeholders + comments.
3. **Secret rotation** — Supabase service key (now Pro account, fresh key advisable), encryption key, Coinbase keys. All were in git history of private repo.
4. **CoinDesk integration follow-through** — confirm tier with sales (free sunsets May 21, 8 days), rotate API key (was pasted in chat), prep for 4-week paper A/B once Risk Desk + Model pages show real data.
5. **Coinbase fee-drag analysis** — quantify $/trade fee burden from this 6h run; build conviction that Hyperliquid is the right move.
6. **Hyperliquid adapter completion** — currently inert (kill switches double-locked). Need adapter completion + signal routing wired in a separate PR per existing comment in `guardrails.yaml`.

### E. Documentation reconciliation
1. CLAUDE.md mentions ML aspirations on `/model` page — once Model page shows real rule-based data, update language to match.
2. AGENTS.md backend test count was reconciled in PR #13 (493/493) — verify it's still accurate post-CoinDesk merge (now 522/522).
3. README — does it cover the new Supabase Pro setup, secret rotation procedure, Vault usage if adopted?

---

## Already-known dependencies between workstreams

```
A (run analysis) → reveals which strategy/symbol pairs need attention → may add to D
C (Supabase Pro audit) → independent of A/B/D, can run fully in parallel
B (UI fixes) → depends on which UI panels need real backend data; some panels need new backend endpoints
 ├─ B1 Risk Desk → frontend-only fix (calculation bug)
 ├─ B2 Model → may need new backend endpoint /api/metafilter/decisions/feed (live rejections)
 ├─ B3 Backtest → may need new backend endpoint to read backtest_results dir
 ├─ B4 Trade Journal → likely net-new feature (DB schema + API + UI)
 └─ B5 Alerts → may need new alerts table + endpoint
D (cleanup) → mostly independent, but D3 (secret rotation) should happen BEFORE C (Pro audit) starts touching secrets
```

## Parallel-safe execution order (proposed)

**Wave 1 (immediate, fully parallel):**
- A — run analysis worker
- C1-C4 — Supabase plan/billing/branching/edge functions (read-only audit)
- D1 — funnel-bug residuals (small PR)
- D2 — env.example completion (small PR)
- E — documentation reconciliation (small PR)

**Wave 2 (after Wave 1 reveals issues + secret rotation prereq):**
- D3 — secret rotation (user-driven; I provide checklist)
- C5-C6 — DB + Realtime optimization (depends on rotated secrets)
- B1 — Risk Desk fix (frontend-only, can start in Wave 1 actually)

**Wave 3 (depends on Wave 2 backend changes):**
- B2-B5 — wire mock UI pages to real data (some need new backend endpoints from Wave 2)
- C8 — Vault migration
- C7 — MCP re-auth + advisor scan
- D4-D6 — CoinDesk follow-through, fee analysis, Hyperliquid completion

---

## User decisions (locked in 2026-05-13 ~15:16 CT)

1. **Secrets**: keep `.env` going forward (do NOT migrate to Vault). Sprint workstream C8 → SKIP / REPLACE with hardening of .env hygiene (BFG history scrub if going public, rotation procedure docs).
2. **Branching**: setup with Deploy-to-production OFF, Branch limit 2, "Supabase changes only" ON. Enable AFTER migration consolidation (Wave 2). Until then preview check is off.
3. **Trade Journal**: build as a REAL feature — schema + API + UI. Manually-curated trade thesis + post-mortem entries linked to actual `trades` table rows. Tag distribution, lessons, win/loss outcomes pulled from real data.
4. **Alerts**: REAL WIRING required.
 - Email channel: **lukebarhoumeh11@gmail.com**
 - SMS / phone: **224-343-4320**
 - Slack: confirm later (was placeholder `#trading-alerts`)
 - Trigger log: pull from real backend alert events
 - Rule definitions: Large drawdown > 3%, Venue latency > 500ms, Meta-filter drift, Consecutive losses ≥ 3, Symbol exposure > 80%
5. **Compute**: upgrade Nano → Micro (already paid for in Pro). Wave 0 task, do post-engine-stop. Adds dedicated 2-core ARM, 1GB RAM, eliminates noisy-neighbor.

## Open questions still to surface at end-of-run

1. Approve sprint plan as-is, or trim/reorder?
2. CoinDesk paid tier confirmation status — needed before May 21 deadline (8 days).
3. Hyperliquid completion scope/timing — separate sprint or fold into this one?
4. Slack channel for alerts — confirm `#trading-alerts` is real or replace.
5. SMS provider for the 224-343-4320 number — Twilio? Supabase doesn't natively SMS — need a transport choice.

---

## Parking lot (not in initial sprint, future)
- ML meta-filter implementation (replace rule-based) — per CLAUDE.md "aspirational"
- CoinDesk Phase 2 cross-venue funding rate divergence
- Live trading go-criteria (per `go_live_criteria` in guardrails.yaml)
- Mobile dashboard view (currently desktop-only)
- Multi-tenant support (currently single-user)

---

**End of staging file.** The synthesizer worker dispatched at 20:34 CT will:
1. Read this file
2. Read all `final-snapshot/*` captures
3. Read pulse log + alerts log
4. Add new findings discovered in run data
5. Update priorities based on what actually happened
6. Output the final sprint plan as a PR-able markdown doc + dispatch the Wave 1 subagents
