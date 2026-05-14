# Sprint 1 — Phase status brief (Luke)

> **Tracked location since 2026-05-14 (Wave 2 G7).** Previously at `atlas/var/tmp/monitor/` (gitignored).

**Date:** 2026-05-14  
**Repo:** `C:/Users/lukeb/apex-automata` (`lukebarhoumeh/apex-automata`)  
**Audience:** Operator handoff — single authoritative snapshot of where Sprint 1 stopped and what runs next.

---

## 1. Snapshot

### Branch truth

| Item | Status |
|------|--------|
| **`main` HEAD** | `1d37b70` — `perf(positions): debounce per-tick position UPDATE writes (D10) (#34)` |
| **Open PRs** (2026-05-14) | **#21** D5 RLS initplan migration; **#30** I3 backtest CI gate — see §3 |
| **`.github/` on `main` (local + `git ls-tree`)** | Only `PULL_REQUEST_TEMPLATE.md` — **no** `workflows/*.yml` on `main` in this tree |

### CI — Supabase Preview on `main`

- **Evidence:** GitHub Check Run on commit `1d37b70` — **`Supabase Preview` → `failure`** (completed).
- **Delivery mechanism:** This is the **Supabase GitHub integration** app check (`workflowName` empty in API), **not** a repo-owned Actions workflow checked into `main` here.
- **Typical triggers:** Integration fires on PRs/commits when configured (often scoped to **`supabase/**`** or migration-related paths per project settings). Expect it to evaluate **linked project / preview branch** migrations against **`supabase/migrations/`**.

### Root-cause hypothesis — `Remote migration versions not found in local migrations directory`

**Hypothesis:** **Migration-history drift** between what Supabase **remote** / **preview Postgres** thinks is applied versus what exists as SQL files under `supabase/migrations/` in git.

Likely contributing factors (not mutually exclusive):

1. **`schema_migrations` (Supabase)** lists versions applied on the dashboard or via CLI that **never became committed files**, or whose files were **renamed/deleted/superseded** after apply (see also `COWORK_HANDOFF.md` §10 item 5: *Phase 2 Batch A migrations applied directly to Supabase but don't exist as SQL files* — historical pattern in this codebase).
2. **Preview branching** builds a candidate DB expecting a **contiguous migration chain from repo`;** any orphaned remote version blows the guard with the quoted error.
3. partial alignment PR **#9** (`fix(supabase): align local migrations with remote (partial Preview fix)`) merged earlier — **Preview still red on `main` ⇒ alignment incomplete or preview/prod divergence remains.**

### Action items — diagnostics Luke runs locally

**Prereqs:** `SUPABASE_ACCESS_TOKEN` exported; CLI logged in (`supabase login` or token-only); project **linked** to the affected ref (production + whatever ref Preview targets — PR #21’s failed check dashboard URL used preview project slug `mborduabiejwjnfhdofl` vs prod `gdrdaajvutmewgxbjurk`).

1. **Compare local filesystem vs migration API state (remote):**  
   `supabase migration list`  
   (Shows **local** vs **remote** applied versions; identifies missing files or extra remote-only versions.)

2. **If remote has versions not on disk:** repair strategy (pick one coherent path — do not cherry-pick blindly):  
   - Restore equivalent SQL files from history / another machine **or**  
   - Use **`supabase migration repair`** (CLI) to reconcile `schema_migrations` **after** human confirmation **or**  
   - Regenerate authoritative SQL from introspection: **`supabase db dump`** / dashboard export, then refactor into committed migrations **with D1 oversight**.

3. **If local has files remote never applied:** normal deploy path **`supabase db push`** (non-prod preview first) once chain is validated.

4. **Dashboard corroboration:** Supabase Dashboard → Database → migrations / migration history UI should match **`supabase/migrations/`** file stamps (YYYYMMDD…).

Goal: **`Supabase Preview` green on `main`** before stacking more schema PRs on top.

---

## 2. Completed (Wave 0 + Wave 1 merged themes)

Themes now on **`main`** (recent history); not every PR enumerated.

| Theme | Evidence on `main` (examples) |
|-------|-------------------------------|
| **Pulse monitor (E5)** | #14 — drawdown regex / false-positive fix |
| **Perps fees (B5)** | #15 — route perps to `coinbase.perps_intx` tier |
| **Risk Desk + dashboard UI (C1, C6)** | #20, #23 |
| **Dead infra removal (D2, D3)** | #17 Edge Functions bundle; #19 `supabaseRealtimeBridge` |
| **Funnel parity (F1, F2)** | #24 bar-time threading; #35 BacktestEngine → MetaFilter outcomes |
| **Observability (E1/E2/E4/E6)** | #16 Prometheus scrape; #18 log queries doc; #22 audit-trades CLI; #31 gzipped archives / docs promotion |
| **Docs / hygiene (G1/G2/G6)** | #25 `env.example`; #26 rotation runbook; #27 CLAUDE/AGENTS refresh |
| **Research inputs (H2/H6)** | #28 min profitable trade size; #29 consec-loss quant |
| **Process (I5)** | #32 PR template |
| **D10 realtime write coalescing** | #34 position UPDATE debounce |
| PM2 baseline | #12 ecosystem config |

Historical context: **`#9`** attempted Supabase/local migration alignment (Preview still failing — §1).

---

## 3. Open / blocked

| PR | Symptom | Blocker detail | Unblock criteria |
|----|---------|----------------|------------------|
| **#21** (D5) | **Supabase Preview `FAILURE`** on PR head (`wave1/d5-rls-initplan-optimization`) | New RLS perf migration stresses Preview’s **migration graph integrity**; same class of **remote vs local version** failures as `main` if history is dirty | **Preview green**; explicit **decision** whether to **apply to prod** now vs keep **file-only** until controlled apply + `pg_policies` audit (adversarial review: partial skip if policy names drift) |
| **#30** (I3) | **`backtest-gate` job `Fast backtest (7d, ETH spot + perp)` → `FAILURE`**; Supabase Preview **SKIPPED** on that PR | Introduces **`.github/workflows/backtest-gate.yml`** (not on **`main` until this PR lands**). Gate couples to **stdout shape** (`Total Trades:` + `awk`), **hardcoded Rollup 4.53.3 pnpm path**, threshold **≥5 trades / 7d** (may be miscalibrated post-F1), path filters mean **PR #30 doesn’t self-exercise** the workflow reliably | Fix paths: **raise/retune threshold** post-F1; **parse structured output** (JSON artifact) instead of grep; **pin Rollup via install step** not fragile path; ensure **secrets** (`ENCRYPTION_KEY`, etc.) match CI contract; add **branch protection** so merge culture can’t bypass red gates |

### Risks folded from adversarial review (condensed)

- **#21 / D5:** Production `pg_policies` may differ from author snapshot → migration can “succeed” but leave hotspots.  
- **#30 / I3:** Brittle **stdout parsing**, **Rollup path** coupling, **branch protection off** ⇒ process risk > code risk.  
- **F1/F2 (merged):** Default `nowMs = Date.now()` on future callsites can **silently reintroduce** wall-clock latch; F1→F2 ordering was load-bearing before merge.  
- **D10 (merged):** **Shutdown / `stopUpdateLoop`** can **drop a pending debounced** position emit — last tick may not reach DB/UI if SIGTERM lands in the debounce window.

---

## 4. Operational verification (prior merge agent)

Already executed on operator machine:

- **PM2** restart of stack; **`/health`**, **`/api/status`** smoke OK.  
- **`pnpm test`** in `atlas/apps/core-node/` — **548** tests passing (reported).  
- **Caveat:** bind differences **`localhost` vs `127.0.0.1`** can matter for health clients and browser fetch policy — keep URLs consistent with `.env` / `VITE_*`.  
- **Lint:** **`pnpm lint`** reports **584** problems — treated as **known baseline**, not attributed to Wave 1 merges unless a PR changes touched files materially.

---

## 5. Next phase (ordered checklist)

### Immediate (this week)

1. **Fix Supabase migration ↔ repo sync** so **`Supabase Preview` passes on `main`** (§1 commands + dashboard cross-check). Treat as **P0** before landing more SQL.  
2. **Land #21** after Preview green + **explicit prod apply** decision (or merge **migration file only** with ticketed rollout).  
3. **Repair #30** CI: stabilize **backtest gate** (threshold, artifact parsing, Rollup/install, secrets contract) → merge to get **`backtest-gate.yml`** onto **`main`**.

### Wave 2 — headlines (from `SPRINT-PLAN-FINAL.md` §4 only)

Lifted verbatim scope from plan table **Wave 2 — Wave-1-dependent work**:

- **A1** Strategy param retune (HL-fee aware) · **A2** ATR multiplier tweak · **A3** Fee-adjusted min-position sizing · **A4** Loosen consec-loss kill 8→10 · **A6** Signal-arbiter regime-conditional gates  
- **B4** FeeModel reads `guardrails.yaml.fees` audit · **B5** Paper-mode perps fee accounting fix  
- **C2** Model page → real meta-filter · **C3** Backtest page → real CLI output (depends **F5**)  
- **D1** Migration consolidation (blocked on **DECISION D-MIG-CONSOL**) · **D7** `pg_cron` jobs · **F3** Re-run May 11 4-run matrix · **F4** HL fee-schedule backtest · **F5** Backtest CLI output → Supabase table  
- **G3** Supabase Pro setup runbook · **G4** CoinDesk A/B procedure docs · **H1** HL vs CB EV comparison · **H3** Regime-conditional strategy proposal · **H5** Signal-arbitration funnel (endpoint + UI)  
- **I1** PM2 ecosystem functional test · **I2** Cloud Agent VM secret-injection alternative · **I3** CI/CD pipeline review (partially overlaps open **#30**)  
- **J1** Risk-limit revalidation · **J3** Audit trail completeness · **J4** `flatten_on_shutdown` live test  

*(Plan marks **A5** as duplicate of **F2** — already merged in Wave 1.)*

### Manual still / plan gaps

- **D9:** Supabase **~$50/mo budget alert** — **dashboard** configuration (no PR in Wave 1 set).  
- **I4 branch protection:** called for in sprint plan — **enforce** alongside **#30** so CI gates aren’t ceremonial.

---

## 6. Success gates

- **Wave 1 residual closure:** **`main` green** incl. **`Supabase Preview`**; **only Wave 1–class debt** left in flight is **#21**, **#30** (until merged); **I4**/ops items as above. Backend tests maintain **548+** passing (repo docs may lag exact count).  
- **Wave 2 gate (plan verbatim):** *F3+F4 backtests show ≥ 50 trades/run; D1 migration consolidation deployed cleanly; tests still 522/522+.* — **Update test floor** to match current repo reality (≥548) when executing.

---

**File path:** `atlas/var/tmp/monitor/SPRINT-PHASE-STATUS-2026-05-14.md`

---

### Appendix — migrations folder (verification)

| Metric | Value |
|--------|-------|
| **Count** | **42** SQL files under `supabase/migrations/` |
| **Newest filename pattern (lexical)** | **`20260511_positions_history_preserve.sql`** (`20260511*` wins over `20260427*`, etc.) |

*No per-file forensic diff performed in this brief; `#9`/Preview failure implies **remote bookkeeping still disagrees with this list**.*
