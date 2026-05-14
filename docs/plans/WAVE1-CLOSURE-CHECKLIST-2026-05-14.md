# Wave 1 Closure Checklist — 2026-05-14

> **Tracked location since 2026-05-14 (Wave 2 G7).** Previously at `atlas/var/tmp/monitor/` (gitignored).

Operator runbook. Each `- [ ]` is one action. Run in order within each section. Decisions log at bottom.

Test floor: **548/548** in `atlas/apps/core-node/` (verified 2026-05-14).
Supabase projects: prod `gdrdaajvutmewgxbjurk` | preview `mborduabiejwjnfhdofl`.

---

## §1 Open PRs (merge order: #30 → #21)

### PR #30 — backtest CI gate
- [x] Repo secrets set 2026-05-14 17:08Z: `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` (per workflow `env:` block in `.github/workflows/backtest-gate.yml`).
  ```bash
  gh secret list --repo lukebarhoumeh/apex-automata
  ```
- [ ] Re-run latest failed CI on PR #30 (already triggered post-secret-set).
  ```bash
  gh pr checks 30 --repo lukebarhoumeh/apex-automata
  gh run list --repo lukebarhoumeh/apex-automata --workflow=backtest-gate.yml --limit 3
  ```
- [ ] When all checks green, merge.
  ```bash
  gh pr merge 30 --repo lukebarhoumeh/apex-automata --squash --delete-branch
  ```

### PR #21 — file-only / doc/asset PR
- [ ] Inspect diff scope; confirm no migration/runtime code changes.
  ```bash
  gh pr diff 21 --repo lukebarhoumeh/apex-automata | head -200
  gh pr view 21 --repo lukebarhoumeh/apex-automata --json files -q '.files[].path'
  ```
- [ ] If file-only: merge directly. If touches `supabase/migrations/` or runtime: gate on §4 drift reconcile first.
  ```bash
  gh pr merge 21 --repo lukebarhoumeh/apex-automata --squash --delete-branch
  ```
- [ ] Post-merge: verify `main` CI still green incl. `Supabase Preview` job.
  ```bash
  gh run list --repo lukebarhoumeh/apex-automata --branch main --limit 5
  ```

---

## §2 D9 — Supabase $50/mo budget alert

### Supabase dashboard (primary — required)
- [ ] Open prod project billing settings.
  - URL: `https://supabase.com/dashboard/project/gdrdaajvutmewgxbjurk/settings/billing`
- [ ] Navigate: **Settings → Billing → Usage Alerts → Add alert**.
- [ ] Configure: threshold `$50`, period `monthly cost`, notify `lukebarhoumeh11@gmail.com`.
- [ ] Save and confirm alert appears in Usage Alerts list.
- [ ] (Optional) Repeat for preview project `mborduabiejwjnfhdofl` at lower threshold (e.g. $10).

### Prometheus alert (secondary — no Supabase cost metric currently scraped)
- [ ] Inspect existing rules; no budget rule today.
  - File: `C:\Users\lukeb\apex-automata\deploy\monitoring\alertrules.yaml`
- [ ] Skip Prom rule unless a Supabase cost exporter is added later. Dashboard alert is authoritative for Wave 1.

---

## §3 I4 — Branch protection on `main` (pick ONE)

> **Locked sprint decision = (a).** Choose (b) or (c) only with explicit operator sign-off.

### (a) Accept I3+I5 substitute (current locked decision)
- [ ] Confirm #30 (I3 backtest CI gate) merged per §1.
- [ ] Confirm #32 (I5 PR template) merged.
  ```bash
  gh pr view 32 --repo lukebarhoumeh/apex-automata --json state,mergedAt
  ```
- [ ] Document risk in Decisions log: *PRs can still merge with red checks; relies on convention.*
- [ ] DONE (a).

### (b) GitHub Pro upgrade ($4/mo)
- [ ] Upgrade account: `https://github.com/settings/billing/plans` → select Pro.
- [ ] Apply protection (verify field names with `gh api repos/lukebarhoumeh/apex-automata/branches/main/protection` after first call):
  ```bash
  gh api -X PUT repos/lukebarhoumeh/apex-automata/branches/main/protection \
    -F required_status_checks.strict=true \
    -F 'required_status_checks.contexts[]=backtest-gate' \
    -F 'required_status_checks.contexts[]=Supabase Preview' \
    -F enforce_admins=true \
    -F required_pull_request_reviews.required_approving_review_count=1
  ```
- [ ] Verify:
  ```bash
  gh api repos/lukebarhoumeh/apex-automata/branches/main/protection
  ```
- [ ] DONE (b).

### (c) Make repo public (free branch protection)
- [ ] Audit secrets / committed env before flipping: `git log --all --full-history -- .env*` (HUMAN REVIEW).
- [ ] Flip visibility:
  ```bash
  gh repo edit lukebarhoumeh/apex-automata --visibility public --accept-visibility-change-consequences
  ```
- [ ] Apply same `gh api ... protection` payload as (b).
- [ ] Note implication: source publicly visible.
- [ ] DONE (c).

---

## §4 Supabase migration drift reconcile

> CLI not installed locally. Install first. Repair steps are HUMAN-REVIEW gated.

### Install + link
- [ ] Install Supabase CLI (pick one):
  ```bash
  scoop install supabase
  # or
  npm install -g supabase
  ```
- [ ] Authenticate (token already in env or 1Password):
  ```bash
  supabase login --token "$SUPABASE_ACCESS_TOKEN"
  ```
- [ ] Link to prod:
  ```bash
  cd /c/Users/lukeb/apex-automata && supabase link --project-ref gdrdaajvutmewgxbjurk
  ```

### Diagnose
- [ ] List migrations and capture drift:
  ```bash
  supabase migration list --linked > atlas/var/tmp/monitor/migration-drift-2026-05-14.txt
  ```
- [ ] Compare local `supabase/migrations/` (42 SQL files; newest `20260511_positions_history_preserve.sql`) vs remote.

### Repair — HUMAN REVIEW required
- [ ] Decide per-row: `repair --status applied <version>` (mark remote as applied) or `repair --status reverted <version>` (mark remote as not applied). Do **not** run blanket commands.
  ```bash
  # example — DO NOT run without reviewing diff first
  supabase migration repair --status applied 20260511 --linked
  ```
- [ ] Re-run `supabase migration list --linked`; confirm clean state.
- [ ] Re-trigger Supabase Preview on `main`; confirm green.

---

## §5 Doc sweep — "522→548" + "18→19 tasks"

- [ ] Find every stale reference:
  ```bash
  grep -rn "522/522\|522 tests\|522 passing\|18 tasks\|18/18" \
    C:/Users/lukeb/apex-automata/atlas/var/tmp/monitor/ \
    C:/Users/lukeb/apex-automata/CLAUDE.md \
    C:/Users/lukeb/apex-automata/docs/ 2>/dev/null
  ```
- [ ] Update each to `548/548` and `19 tasks` as appropriate. Files known to touch:
  - `atlas/var/tmp/monitor/SPRINT-PLAN-FINAL.md`
  - `atlas/var/tmp/monitor/SPRINT-PHASE-STATUS-2026-05-14.md` (line 137 — `522/522+` → `548/548+`)
  - `atlas/var/tmp/monitor/wave1-pr-adversarial-review.md`
  - `CLAUDE.md` Testing section — DONE 2026-05-14 (now `42 files / 548 tests`)
- [ ] Commit with message: `docs(wave1): bump test floor 522→548; task count 18→19`.
- [ ] Record commit SHA below: `Commit SHA: __________________`

---

## §6 Wave 2 GO criteria

**Quote — `SPRINT-PHASE-STATUS-2026-05-14.md` §6:**
> Wave 1 residual closure: `main` green incl. `Supabase Preview`; only Wave 1–class debt left in flight is #21, #30 (until merged); I4/ops items as above. Backend tests maintain 548+ passing.
> Wave 2 gate (plan verbatim): *F3+F4 backtests show ≥ 50 trades/run; D1 migration consolidation deployed cleanly; tests still 522/522+.* — Update test floor to match current repo reality (≥548) when executing.

### Operator GO statement (fill in)
- [ ] `main` green on latest commit incl. `Supabase Preview`: **Y / N** — run SHA: `__________`
- [ ] PR #30 merged: **Y / N** — merge SHA: `__________`
- [ ] PR #21 merged (or explicitly deferred): **Y / N** — note: `__________`
- [ ] D9 budget alert configured in Supabase dashboard: **Y / N** — screenshot path: `__________`
- [ ] I4 path chosen: **(a) / (b) / (c)** — chosen on: `__________`
- [ ] `pnpm test` in `atlas/apps/core-node/` reports `548/548` (or higher): **Y / N** — count: `____`
- [ ] **GO for Wave 2:** **Y / N** — operator: `Luke` — datetime: `__________`

---

## Decisions log

| Date | Item | Outcome / Notes | Operator |
|------|------|-----------------|----------|
| 2026-05-14 17:08Z | Repo secrets set (#30 unblocker) | `SUPABASE_URL` + `SUPABASE_SERVICE_KEY` set; re-set 17:30Z without `.env` literal quotes (fixed `Invalid supabaseUrl` error) | Claude |
| 2026-05-14 17:14Z | `gh pr update-branch` on #30 + #21 | Merged main into both branches; exposed root-pnpm-lock workspace drift | Claude |
| 2026-05-14 17:18Z | CI fix 1 — workflow `--no-frozen-lockfile` | Commit `641b11e`; root pnpm-lock.yaml `importers:` missing `atlas/apps/core-node`; lockfile unification deferred to Wave 2 D1 | Claude |
| 2026-05-14 17:21Z | CI fix 2 — bypass `pnpm --` forwarding | Commit `6be524a`; yargs treats `--` as positional-args sentinel; switched to `pnpm exec tsx ...` | Claude |
| 2026-05-14 17:46Z | CI fix 3 — wrap with `timeout` + stdout check | Commit `fe66887`; backtest CLI doesn't `process.exit()`; bounded run to 240s + grep `Total Trades:`; follow-up: add explicit exit in CLI | Claude |
| 2026-05-14 17:50Z | PR #21 merged | Squash-merge SHA `8d733a9` (D5 RLS file-only landing); explanatory comment posted re: pre-existing preview drift | Claude |
| 2026-05-14 18:05Z | PR #30 merged | Squash-merge SHA `28491c3` (I3 backtest gate); final run produced 146 trades, gate PASSED in 5m7s | Claude |
| 2026-05-14 20:27Z | Drift reconciled | **DONE** — 11 commits (9126711 → 9b02470); pulled 31 orphan remote versions, deleted 23 duplicates, renamed 6 files to 14-digit + UPDATE schema_migrations 3x, stubbed `meta_filter_decisions` (Wave 2 D11), fixed `CREATE POLICY IF NOT EXISTS` syntax, added `DROP IF EXISTS` for `user_roles_*` policies; **Supabase Preview GREEN** | Claude |
| 2026-05-14 17:11Z | Doc sweep commit | SHA `3bc3e3e` on main (CLAUDE.md 529→548 tests, 38→42 files); SPRINT-PLAN-FINAL.md + adversarial review .md edits applied locally (gitignored at atlas/.gitignore: var/**/*.md — moved to Wave 2 G7 to commit to tracked location) | Claude |
| 2026-05-14 (user decision) | D9 budget alert | **DEFERRED** — user choice: "fine for now"; not blocking Wave 2 | Luke |
| 2026-05-14 (user decision) | I4 path chosen | **(a) Accept I3+I5 substitute** — locked decision per `wave1-pr-adversarial-review.md:114`. Risk: PRs can still merge red. Revisit at Wave 3 if Pro upgrade ($4/mo) is approved. | Luke |
| 2026-05-14 20:30Z | Wave 1 closure | **COMPLETE** — main @ `9b02470`, 19/19 task tracks landed, Supabase Preview GREEN, tests 548/548. Carryover added to Wave 2 plan: D11 (meta_filter_decisions schema gap), D12 (workspace lockfile unify), F6 (backtest CLI process.exit), G7 (promote plan docs to tracked location) | Claude |
| | Wave 2 GO | **GREEN-LIT** — proceed to Wave 2 per SPRINT-PLAN-FINAL.md §4 Wave 2 table (now 30 task rows including 4 Wave-1-carryover items) | Luke |
